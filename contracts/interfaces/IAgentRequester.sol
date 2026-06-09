// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * Somnia Agent Platform interfaces
 * Official spec from https://docs.somnia.network/agents
 *
 * Testnet platform: 0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776
 */

enum ResponseStatus { Pending, Success, Failed, TimedOut }

struct Response {
    bytes   result;
    address validator;
}

struct Request {
    uint256 agentId;
    address requester;
    bytes4  callbackSelector;
    bytes   payload;
}

interface IAgentRequester {
    function createRequest(
        uint256 agentId,
        address handler,
        bytes4  callbackSelector,
        bytes   calldata payload
    ) external payable returns (uint256 requestId);

    function getRequestDeposit() external view returns (uint256);
}

interface IAgentRequesterHandler {
    function handleResponse(
        uint256          requestId,
        Response[] memory responses,
        ResponseStatus   status,
        Request   memory details
    ) external;
}

/** JSON API Agent — fetch + parse public HTTP endpoints */
interface IJsonApiAgent {
    function fetchUint(string calldata url, string calldata selector, uint8 decimals)
        external returns (uint256);
    function fetchString(string calldata url, string calldata selector)
        external returns (string memory);
}

/** LLM Inference Agent — deterministic onchain Qwen3-30B */
interface ILlmAgent {
    function inferString(string calldata prompt, string[] calldata allowedValues)
        external returns (string memory);
    function inferNumber(string calldata prompt, int256 min, int256 max)
        external returns (int256);
}

/** LLM Parse Website Agent — scrape + extract structured data */
interface ILlmParseAgent {
    function parseWebsite(string calldata url, string calldata extractionPrompt)
        external returns (string memory);
    function searchAndParse(string calldata domain, string calldata query, string calldata extractionPrompt)
        external returns (string memory);
}
