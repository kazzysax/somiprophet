// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {
    IAgentRequester,
    IAgentRequesterHandler,
    IJsonApiAgent,
    ILlmAgent,
    Response,
    Request,
    ResponseStatus
} from "./interfaces/IAgentRequester.sol";

/**
 * @title SomiProphetAgent
 * @notice The onchain Somnia Agent layer for SOMIPROPHET.
 *
 *  HYBRID MODEL:
 *  - Off-chain server does the heavy matching/voting logic
 *  - THIS contract calls REAL Somnia base agents for the
 *    trustless, consensus-verified onchain pieces:
 *      1. JSON API Agent  → fetch Polymarket price/odds
 *      2. LLM Inference    → deterministic final verdict
 *
 *  Funded with STT on testnet. Each agent call is executed
 *  by a subcommittee of Somnia validators and verified by
 *  consensus before the callback fires.
 *
 *  Testnet platform: 0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776
 */

interface ILlmInferenceAgentLocal {
    function inferString(string calldata prompt, string[] calldata allowedValues)
        external returns (string memory);
}

contract SomiProphetAgent is IAgentRequesterHandler {

    // ── PLATFORM ──────────────────────────────────────────
    IAgentRequester public immutable platform;
    address public owner;

    // Official base agent IDs (same on testnet + mainnet)
    uint256 public constant JSON_API_AGENT_ID = 13174292974160097713;
    // NOTE: LLM agent ID — confirm from agents.testnet.somnia.network explorer
    uint256 public llmAgentId;

    uint256 public constant SUBCOMMITTEE_SIZE   = 3;
    uint256 public constant JSON_PRICE_PER_AGENT = 0.03 ether;
    uint256 public constant LLM_PRICE_PER_AGENT  = 0.07 ether;

    // ── PROPHECY STATE ────────────────────────────────────
    struct ProphecyData {
        address requester;
        string  marketName;
        string  polymarketUrl;   // CLOB/Gamma endpoint for this market
        uint256 polymarketOdds;  // fetched onchain (scaled 1e8)
        string  verdict;         // "YES"/"NO" from onchain LLM
        bool    oddsReceived;
        bool    verdictReceived;
        bool    complete;
    }

    mapping(uint256 => uint256)       public requestToProphecy; // requestId → prophecyId
    mapping(uint256 => ProphecyData)  public prophecies;
    mapping(uint256 => bool)          public pendingRequests;
    uint256 public prophecyCounter;

    // ── EVENTS ────────────────────────────────────────────
    event ProphecyStarted(uint256 indexed prophecyId, address requester, string marketName);
    event OddsReceived(uint256 indexed prophecyId, uint256 odds);
    event VerdictReceived(uint256 indexed prophecyId, string verdict);
    event ProphecyComplete(uint256 indexed prophecyId, string verdict, uint256 odds);

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address platform_) {
        platform = IAgentRequester(platform_);
        owner    = msg.sender;
    }

    function setLlmAgentId(uint256 _id) external onlyOwner {
        llmAgentId = _id;
    }

    // ── STEP 1: FETCH POLYMARKET ODDS ONCHAIN ─────────────
    /**
     * @notice Start a prophecy by fetching the Polymarket odds
     *         via the Somnia JSON API agent (validator-verified)
     * @param _marketName   Display name
     * @param _oddsUrl      Polymarket CLOB/Gamma price endpoint
     * @param _oddsSelector JSON path to the YES price (e.g. "0.price")
     */
    function startProphecy(
        string calldata _marketName,
        string calldata _oddsUrl,
        string calldata _oddsSelector
    ) external payable returns (uint256 prophecyId) {
        uint256 deposit = platform.getRequestDeposit()
                        + JSON_PRICE_PER_AGENT * SUBCOMMITTEE_SIZE;
        require(msg.value >= deposit, "Underfunded: need >= deposit + 0.03*3 STT");

        prophecyId = prophecyCounter++;
        prophecies[prophecyId] = ProphecyData({
            requester:       msg.sender,
            marketName:      _marketName,
            polymarketUrl:   _oddsUrl,
            polymarketOdds:  0,
            verdict:         "",
            oddsReceived:    false,
            verdictReceived: false,
            complete:        false
        });

        bytes memory payload = abi.encodeWithSelector(
            IJsonApiAgent.fetchUint.selector,
            _oddsUrl,
            _oddsSelector,
            uint8(8)
        );

        uint256 requestId = platform.createRequest{value: deposit}(
            JSON_API_AGENT_ID,
            address(this),
            this.handleResponse.selector,
            payload
        );

        pendingRequests[requestId]   = true;
        requestToProphecy[requestId] = prophecyId;

        emit ProphecyStarted(prophecyId, msg.sender, _marketName);
    }

    // ── STEP 2: ASK ONCHAIN LLM FOR VERDICT ───────────────
    /**
     * @notice After odds are fetched, ask the Somnia LLM agent
     *         for a deterministic YES/NO verdict, given the
     *         off-chain computed signals passed in the prompt.
     * @param _prophecyId  The prophecy to finalize
     * @param _prompt      Full reasoning prompt (built off-chain
     *                     with wallet vote + sentiment summary)
     */
    function requestVerdict(
        uint256 _prophecyId,
        string calldata _prompt
    ) external payable {
        require(llmAgentId != 0, "LLM agent not set");
        require(prophecies[_prophecyId].oddsReceived, "Odds not yet received");

        uint256 deposit = platform.getRequestDeposit()
                        + LLM_PRICE_PER_AGENT * SUBCOMMITTEE_SIZE;
        require(msg.value >= deposit, "Underfunded: need >= deposit + 0.07*3 STT");

        string[] memory allowed = new string[](2);
        allowed[0] = "YES";
        allowed[1] = "NO";

        bytes memory payload = abi.encodeWithSelector(
            ILlmInferenceAgentLocal.inferString.selector,
            _prompt,
            allowed
        );

        uint256 requestId = platform.createRequest{value: deposit}(
            llmAgentId,
            address(this),
            this.handleResponse.selector,
            payload
        );

        pendingRequests[requestId]   = true;
        requestToProphecy[requestId] = _prophecyId;
    }

    // ── CALLBACK (validator consensus result lands here) ──
    function handleResponse(
        uint256          requestId,
        Response[] memory responses,
        ResponseStatus   status,
        Request   memory /* details */
    ) external override {
        require(msg.sender == address(platform), "Only platform");
        require(pendingRequests[requestId],       "Unknown request");
        delete pendingRequests[requestId];

        uint256 prophecyId = requestToProphecy[requestId];
        ProphecyData storage p = prophecies[prophecyId];

        // Only decode on success
        if (status != ResponseStatus.Success || responses.length == 0) {
            return;
        }

        if (!p.oddsReceived) {
            // First callback = odds from JSON API agent
            p.polymarketOdds = abi.decode(responses[0].result, (uint256));
            p.oddsReceived   = true;
            emit OddsReceived(prophecyId, p.polymarketOdds);
        } else if (!p.verdictReceived) {
            // Second callback = verdict from LLM agent
            p.verdict         = abi.decode(responses[0].result, (string));
            p.verdictReceived = true;
            p.complete        = true;
            emit VerdictReceived(prophecyId, p.verdict);
            emit ProphecyComplete(prophecyId, p.verdict, p.polymarketOdds);
        }
    }

    // ── READ ──────────────────────────────────────────────
    function getProphecy(uint256 _prophecyId)
        external view returns (ProphecyData memory)
    {
        return prophecies[_prophecyId];
    }

    // Rebates are pushed automatically on finalisation
    receive() external payable {}
}
