// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";

/**
 * @title SomiTreasury
 * @notice Simple SOMI treasury for SOMIPROPHET agent gas fees.
 *
 *  Owner:   Your deployer wallet
 *  Approved: Your backend agent wallet (pays gas for agents)
 *
 *  HOW IT WORKS:
 *  1. You deposit SOMI into this contract
 *  2. Backend agent wallet calls payGas() for each agent run
 *  3. Contract pays gas to Somnia network
 *  4. You can withdraw anytime as owner
 *
 *  RULES:
 *  - Always keeps 10 SOMI minimum reserve
 *  - Max 100 SOMI per single withdrawal
 *  - Only approved wallets can call payGas
 *  - Owner can pause in emergency
 */
contract SomiTreasury is Ownable, ReentrancyGuard {

    // ── CONSTANTS ─────────────────────────────────────────
    uint256 public constant MIN_BALANCE  = 10 ether;   // 10 SOMI minimum kept
    uint256 public constant MAX_PER_TX   = 100 ether;  // 100 SOMI max per payGas call

    // ── STATE ─────────────────────────────────────────────
    uint256 public totalReceived;
    uint256 public totalSpent;
    uint256 public operationCount;
    bool    public isPaused;

    // Approved backend agent wallets that can request gas
    mapping(address => bool)   public isApproved;
    // Track spend per agent wallet
    mapping(address => uint256) public agentSpend;

    // ── EVENTS ────────────────────────────────────────────
    event Deposited(address indexed from,   uint256 amount, uint256 newBalance);
    event GasPaid(address indexed agent,    address indexed to, uint256 amount, string reason);
    event Withdrawn(address indexed to,     uint256 amount);
    event AgentApproved(address indexed agent, bool approved);
    event EmergencyPause(bool state);

    // ── CONSTRUCTOR ───────────────────────────────────────
    constructor() {}

    // ── RECEIVE SOMI ──────────────────────────────────────
    receive() external payable {
        require(msg.value > 0, "Treasury: Zero deposit");
        totalReceived += msg.value;
        emit Deposited(msg.sender, msg.value, address(this).balance);
    }

    function deposit() external payable {
        require(msg.value > 0, "Treasury: Zero deposit");
        totalReceived += msg.value;
        emit Deposited(msg.sender, msg.value, address(this).balance);
    }

    // ── PAY GAS FOR AGENT EXECUTION ───────────────────────
    /**
     * @notice Called by approved backend agent wallet to pay
     *         gas for Somnia Agent execution
     * @param _to     Address to send gas payment to
     * @param _amount Amount of SOMI for gas
     * @param _reason Agent name/reason (for logging)
     */
    function payGas(
        address payable _to,
        uint256         _amount,
        string calldata _reason
    )
        external
        nonReentrant
    {
        require(!isPaused,                                              "Treasury: Paused");
        require(isApproved[msg.sender],                                 "Treasury: Not approved agent");
        require(_to != address(0),                                      "Treasury: Zero address");
        require(_amount > 0,                                            "Treasury: Zero amount");
        require(_amount <= MAX_PER_TX,                                  "Treasury: Exceeds max per tx");
        require(address(this).balance > _amount + MIN_BALANCE,         "Treasury: Would breach minimum");

        totalSpent           += _amount;
        agentSpend[msg.sender] += _amount;
        operationCount++;

        (bool success,) = _to.call{value: _amount}("");
        require(success, "Treasury: Payment failed");

        emit GasPaid(msg.sender, _to, _amount, _reason);
    }

    // ── OWNER FUNCTIONS ───────────────────────────────────
    function approveAgent(address _agent, bool _approved) external onlyOwner {
        require(_agent != address(0), "Treasury: Zero address");
        isApproved[_agent] = _approved;
        emit AgentApproved(_agent, _approved);
    }

    function withdraw(uint256 _amount) external onlyOwner nonReentrant {
        require(_amount > 0,                      "Treasury: Zero amount");
        require(_amount <= address(this).balance, "Treasury: Insufficient balance");
        (bool success,) = payable(owner()).call{value: _amount}("");
        require(success, "Treasury: Withdraw failed");
        emit Withdrawn(owner(), _amount);
    }

    function withdrawAll() external onlyOwner nonReentrant {
        uint256 balance = address(this).balance;
        require(balance > 0, "Treasury: Empty");
        (bool success,) = payable(owner()).call{value: balance}("");
        require(success, "Treasury: Withdraw failed");
        emit Withdrawn(owner(), balance);
    }

    function setPaused(bool _paused) external onlyOwner {
        isPaused = _paused;
        emit EmergencyPause(_paused);
    }

    // ── READ FUNCTIONS ────────────────────────────────────
    function getBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function isSafe() external view returns (bool) {
        return address(this).balance >= MIN_BALANCE && !isPaused;
    }

    function getStats() external view returns (
        uint256 balance,
        uint256 received,
        uint256 spent,
        uint256 operations,
        bool    isStopped,
        bool    safe
    ) {
        return (
            address(this).balance,
            totalReceived,
            totalSpent,
            operationCount,
            isPaused,
            address(this).balance >= MIN_BALANCE && !isPaused
        );
    }
}
