/**
 * SOMIPROPHET — Somnia Agent Bridge
 *
 * Connects the off-chain orchestrator to the REAL on-chain
 * Somnia Agent contract (SomiProphetAgent.sol).
 *
 * HYBRID FLOW:
 *   1. Off-chain server does matching + wallet voting + sentiment
 *   2. This bridge calls the onchain contract which invokes
 *      REAL Somnia base agents (validator-executed):
 *        - JSON API agent  → fetches Polymarket odds onchain
 *        - LLM agent        → deterministic YES/NO verdict
 *   3. Validators reach consensus, callback fires onchain
 *   4. Bridge reads the verified result back
 *
 * Requires:
 *   SOMNIA_AGENT_CONTRACT = deployed SomiProphetAgent address
 *   AGENT_CALLER_KEY      = key of wallet that funds STT calls
 */

require("dotenv").config();
const { ethers } = require("ethers");

const PLATFORM_TESTNET = "0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776";
const RPC = process.env.ACTIVE_NETWORK === "mainnet"
  ? "https://api.infra.mainnet.somnia.network/"
  : "https://api.infra.testnet.somnia.network/";

// Minimal ABI for our SomiProphetAgent contract
const AGENT_ABI = [
  "function startProphecy(string marketName, string oddsUrl, string oddsSelector) payable returns (uint256)",
  "function requestVerdict(uint256 prophecyId, string prompt) payable",
  "function getProphecy(uint256 prophecyId) view returns (tuple(address requester, string marketName, string polymarketUrl, uint256 polymarketOdds, string verdict, bool oddsReceived, bool verdictReceived, bool complete))",
  "event ProphecyStarted(uint256 indexed prophecyId, address requester, string marketName)",
  "event OddsReceived(uint256 indexed prophecyId, uint256 odds)",
  "event VerdictReceived(uint256 indexed prophecyId, string verdict)",
  "event ProphecyComplete(uint256 indexed prophecyId, string verdict, uint256 odds)"
];

class SomniaAgentBridge {
  constructor() {
    this.enabled  = false;
    this.contract = null;
    this.provider = null;
    this.wallet   = null;

    const contractAddr = process.env.SOMNIA_AGENT_CONTRACT;
    const callerKey    = process.env.AGENT_CALLER_KEY;

    if (contractAddr && callerKey) {
      try {
        this.provider = new ethers.JsonRpcProvider(RPC);
        this.wallet   = new ethers.Wallet(callerKey, this.provider);
        this.contract = new ethers.Contract(contractAddr, AGENT_ABI, this.wallet);
        this.enabled  = true;
        console.log(`[SomniaBridge] ✅ Connected to onchain agent: ${contractAddr}`);
      } catch (err) {
        console.log(`[SomniaBridge] ⚠️ Could not connect: ${err.message}`);
      }
    } else {
      console.log("[SomniaBridge] ⚠️ Onchain agent not configured — running off-chain only");
      console.log("[SomniaBridge]    Set SOMNIA_AGENT_CONTRACT + AGENT_CALLER_KEY to enable");
    }
  }

  /**
   * Fetch Polymarket odds via the REAL onchain Somnia JSON API agent.
   * Returns { prophecyId, odds } once validators reach consensus.
   */
  async fetchOddsOnchain(marketName, oddsUrl, oddsSelector) {
    if (!this.enabled) {
      return { onchain: false, reason: "Onchain agent not configured" };
    }

    try {
      // 0.12 STT covers deposit + JSON agent (0.03 × 3 subcommittee)
      const value = ethers.parseEther("0.12");
      const tx = await this.contract.startProphecy(
        marketName, oddsUrl, oddsSelector, { value }
      );
      console.log(`[SomniaBridge] startProphecy tx: ${tx.hash}`);
      const receipt = await tx.wait();

      // Extract prophecyId from ProphecyStarted event
      let prophecyId = null;
      for (const log of receipt.logs) {
        try {
          const parsed = this.contract.interface.parseLog(log);
          if (parsed.name === "ProphecyStarted") {
            prophecyId = parsed.args.prophecyId;
          }
        } catch (e) {}
      }

      // Wait for the OddsReceived callback (validator consensus)
      const odds = await this._waitForOdds(prophecyId);

      return {
        onchain:    true,
        prophecyId: prophecyId?.toString(),
        odds,
        txHash:     tx.hash,
        consensus:  "validator-verified"
      };
    } catch (err) {
      console.error(`[SomniaBridge] fetchOddsOnchain error: ${err.message}`);
      return { onchain: false, reason: err.message };
    }
  }

  /**
   * Request a deterministic YES/NO verdict via the onchain LLM agent.
   */
  async requestVerdictOnchain(prophecyId, prompt) {
    if (!this.enabled) {
      return { onchain: false, reason: "Onchain agent not configured" };
    }

    try {
      const value = ethers.parseEther("0.28"); // deposit + LLM (0.07 × 3)
      const tx = await this.contract.requestVerdict(prophecyId, prompt, { value });
      console.log(`[SomniaBridge] requestVerdict tx: ${tx.hash}`);
      await tx.wait();

      const verdict = await this._waitForVerdict(prophecyId);
      return { onchain: true, verdict, txHash: tx.hash, consensus: "validator-verified" };
    } catch (err) {
      console.error(`[SomniaBridge] requestVerdictOnchain error: ${err.message}`);
      return { onchain: false, reason: err.message };
    }
  }

  // Poll the contract until the odds callback has fired
  async _waitForOdds(prophecyId, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const p = await this.contract.getProphecy(prophecyId);
      if (p.oddsReceived) {
        return Number(p.polymarketOdds) / 1e8;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error("Timed out waiting for onchain odds");
  }

  // Poll the contract until the verdict callback has fired
  async _waitForVerdict(prophecyId, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const p = await this.contract.getProphecy(prophecyId);
      if (p.verdictReceived) {
        return p.verdict;
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    throw new Error("Timed out waiting for onchain verdict");
  }
}

module.exports = { SomniaAgentBridge };
