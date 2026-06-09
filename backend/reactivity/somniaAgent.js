/**
 * SOMIPROPHET — Somnia Agent Manager
 *
 * This module manages the connection between our model
 * and the Somnia network via:
 *   1. WebSocket Reactivity (event listening + streaming)
 *   2. Somnia Agent execution (consensus-validated data fetch)
 *   3. Treasury gas management (SomiTreasury contract)
 *
 * Somnia Testnet WSS: wss://api.infra.testnet.somnia.network/ws
 * Somnia Mainnet WSS: wss://api.infra.mainnet.somnia.network/ws
 *
 * AgentRegistry: 0xaD3101C37F091593fEe7cb471e92b5E9A1205194
 * SomniaAgents:  0x5E5205CF39E766118C01636bED000A54D93163E6
 */

require("dotenv").config();
const WebSocket = require("ws");
const axios     = require("axios");

// ── NETWORK CONFIG ────────────────────────────────────────
const NETWORK = {
  testnet: {
    rpc: "https://api.infra.testnet.somnia.network/",
    wss: "wss://api.infra.testnet.somnia.network/ws",
    chainId: 50312,
    symbol: "STT"
  },
  mainnet: {
    rpc: "https://api.infra.mainnet.somnia.network/",
    wss: "wss://api.infra.mainnet.somnia.network/ws",
    chainId: 5031,
    symbol: "SOMI"
  }
};

const ACTIVE = NETWORK[process.env.ACTIVE_NETWORK || "testnet"];

// ── SOMNIA AGENT DEFINITIONS ──────────────────────────────
// Each agent is a named compute job that runs with consensus
const AGENTS = {

  // AGENT 1: Market Data Fetcher
  // Fetches Polymarket market data with validator consensus
  MARKET_FETCHER: {
    name:    "SOMIPROPHET_MARKET_FETCHER",
    version: "1.0.0",
    sources: [
      `${process.env.POLYMARKET_GAMMA || "https://gamma-api.polymarket.com"}/markets`,
      `${process.env.POLYMARKET_CLOB  || "https://clob.polymarket.com"}/markets`
    ],
    // What field validators compare to reach consensus
    consensusField: "condition_id",
    // Gas estimate per execution (in wei)
    gasEstimate: "0.001"
  },

  // AGENT 2: Wallet Intelligence Fetcher
  // Fetches wallet positions + win rates with validator consensus
  WALLET_FETCHER: {
    name:    "SOMIPROPHET_WALLET_FETCHER",
    version: "1.0.0",
    sources: [
      `${process.env.POLYMARKET_DATA || "https://data-api.polymarket.com"}/positions`,
      process.env.FALCON_BASE_URL
    ],
    consensusField: "win_rate",
    gasEstimate: "0.002"
  },

  // AGENT 3: Sentiment Fetcher
  // Fetches news + social data with validator consensus
  SENTIMENT_FETCHER: {
    name:    "SOMIPROPHET_SENTIMENT_FETCHER",
    version: "1.0.0",
    sources: [
      process.env.FALCON_BASE_URL
    ],
    consensusField: "acceleration",
    gasEstimate: "0.001"
  },

  // AGENT 4: LLM Reasoning Agent
  // Runs Claude with fixed seed for deterministic output
  LLM_AGENT: {
    name:    "SOMIPROPHET_LLM_REASONER",
    version: "1.0.0",
    sources: ["https://api.anthropic.com/v1/messages"],
    // Fixed seed ensures all validators get same LLM output
    seed:    42,
    consensusField: "verdict",
    gasEstimate: "0.003"
  }
};

// ── WEBSOCKET REACTIVITY ──────────────────────────────────
class SomniaReactivity {
  constructor() {
    this.ws            = null;
    this.reconnectTimer = null;
    this.subscriptionId = null;
    this.listeners     = new Map();
    this.isConnected   = false;
    this.RECONNECT_MS  = 5000;
  }

  // Connect to Somnia WebSocket
  connect() {
    console.log(`[Somnia] Connecting to: ${ACTIVE.wss}`);
    this.ws = new WebSocket(ACTIVE.wss);

    this.ws.on("open", () => {
      this.isConnected = true;
      console.log(`[Somnia] ✅ Connected to Somnia ${process.env.ACTIVE_NETWORK || "testnet"}`);
      this._subscribeToProphecyEvents();
      this._keepAlive();
    });

    this.ws.on("message", (data) => {
      this._handleMessage(data);
    });

    this.ws.on("error", (err) => {
      console.error(`[Somnia] WebSocket error: ${err.message}`);
    });

    this.ws.on("close", () => {
      this.isConnected = false;
      console.log(`[Somnia] Disconnected. Reconnecting in ${this.RECONNECT_MS / 1000}s...`);
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), this.RECONNECT_MS);
    });
  }

  // Subscribe to ProphecyRequest events onchain
  _subscribeToProphecyEvents() {
    this.ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id:      1,
      method:  "eth_subscribe",
      params:  [
        "newHeads" // Subscribe to new blocks — update to logs after contract deploy
      ]
    }));
    console.log("[Somnia] Subscribed to network events");
  }

  // Handle incoming WebSocket messages
  _handleMessage(data) {
    try {
      const msg = JSON.parse(data.toString());

      // Subscription confirmed
      if (msg.id === 1 && msg.result) {
        this.subscriptionId = msg.result;
        console.log(`[Somnia] Subscription active: ${msg.result}`);
        return;
      }

      // New event received
      if (msg.method === "eth_subscription") {
        const event = msg.params?.result;
        if (event) {
          this._routeEvent(event);
        }
      }

      // JSON-RPC response
      if (msg.id && msg.result !== undefined) {
        const listener = this.listeners.get(msg.id);
        if (listener) {
          listener(null, msg.result);
          this.listeners.delete(msg.id);
        }
      }

    } catch (err) {
      // Ignore parse errors on non-JSON messages
    }
  }

  // Route events to correct handler
  _routeEvent(event) {
    console.log("[Somnia] 🔔 Network event received");
    // After contract deploy — route ProphecyRequest events here
    // For now logs block updates to confirm connection is live
  }

  // Keep connection alive with pings
  _keepAlive() {
    setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 30000);
  }

  // Make JSON-RPC call to Somnia node
  async rpcCall(method, params = []) {
    return new Promise((resolve, reject) => {
      if (!this.isConnected) {
        return reject(new Error("Not connected to Somnia"));
      }
      const id = Date.now();
      this.listeners.set(id, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
      this.ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params
      }));
      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.listeners.has(id)) {
          this.listeners.delete(id);
          reject(new Error("RPC timeout"));
        }
      }, 10000);
    });
  }

  // Get current block number
  async getBlockNumber() {
    try {
      const result = await this.rpcCall("eth_blockNumber");
      return parseInt(result, 16);
    } catch {
      return null;
    }
  }

  // Get SOMI balance of treasury
  async getTreasuryBalance(treasuryAddress) {
    try {
      const result = await this.rpcCall("eth_getBalance", [
        treasuryAddress,
        "latest"
      ]);
      // Convert from wei to SOMI
      const wei    = BigInt(result);
      const somi   = Number(wei) / 1e18;
      return somi.toFixed(4);
    } catch {
      return "0";
    }
  }
}

// ── SOMNIA AGENT EXECUTOR ─────────────────────────────────
class SomniaAgentExecutor {
  constructor(reactivity) {
    this.reactivity  = reactivity;
    this.treasury    = process.env.TREASURY_ADDRESS ||
                       "0x0EC904AeB3F145e8846e00174789e4885477289F";
    this.agentWallet = process.env.AGENT_WALLET_ADDRESS || null;
    this.gasLog      = [];
  }

  /**
   * Execute a Somnia Agent with consensus validation
   * This is the core function that makes data trustless
   *
   * HOW IT WORKS:
   * 1. Agent job is submitted to Somnia network
   * 2. Multiple validator nodes fetch same data independently
   * 3. Validators compare results — majority hash wins
   * 4. Consensus result is returned
   * 5. Gas charged to treasury
   */
  async executeAgent(agentName, fetchFn, params) {
    const agent = AGENTS[agentName];
    if (!agent) throw new Error(`Unknown agent: ${agentName}`);

    console.log(`[SomniaAgent] Executing: ${agent.name}`);
    console.log(`[SomniaAgent] Sources: ${agent.sources.join(", ")}`);

    try {
      // PHASE 1 (NOW): Execute off-chain with Reactivity tracking
      // PHASE 2 (LATER): Submit to AgentRegistry for full consensus
      const startTime = Date.now();

      // Fetch data using the provided function
      const result = await fetchFn(params);

      const duration = Date.now() - startTime;

      // Log agent execution for treasury tracking
      this.gasLog.push({
        agent:     agent.name,
        timestamp: new Date().toISOString(),
        duration,
        gasEstimate: agent.gasEstimate,
        success:   true
      });

      console.log(`[SomniaAgent] ✅ ${agent.name} completed in ${duration}ms`);
      console.log(`[SomniaAgent] Gas estimate: ${agent.gasEstimate} SOMI`);

      return {
        success:    true,
        data:       result,
        agent:      agent.name,
        duration,
        gasUsed:    agent.gasEstimate,
        // In Phase 2: this will include consensus proof
        consensus:  "off-chain-validated"
      };

    } catch (err) {
      console.error(`[SomniaAgent] ❌ ${agent.name} failed: ${err.message}`);

      this.gasLog.push({
        agent:     agent.name,
        timestamp: new Date().toISOString(),
        gasEstimate: "0",
        success:   false,
        error:     err.message
      });

      throw err;
    }
  }

  // Get total estimated gas used in session
  getGasReport() {
    const total = this.gasLog.reduce((sum, log) => {
      return sum + (log.success ? parseFloat(log.gasEstimate) : 0);
    }, 0);

    return {
      operations:   this.gasLog.length,
      totalGasSomi: total.toFixed(4),
      log:          this.gasLog
    };
  }

  // Check treasury has enough SOMI to run
  async checkTreasury() {
    const balance = await this.reactivity.getTreasuryBalance(this.treasury);
    const balanceNum = parseFloat(balance);

    return {
      address:     this.treasury,
      balance:     `${balance} ${process.env.ACTIVE_NETWORK === "mainnet" ? "SOMI" : "STT"}`,
      isSafe:      balanceNum >= 10,
      canOperate:  balanceNum > 0,
      warning:     balanceNum < 10 ? "⚠️ Treasury below 10 SOMI minimum" : null
    };
  }
}

// ── EXPORTS ───────────────────────────────────────────────
// Singleton instances shared across the app
const reactivity = new SomniaReactivity();
const agentExecutor = new SomniaAgentExecutor(reactivity);

module.exports = {
  reactivity,
  agentExecutor,
  AGENTS,
  ACTIVE,
  SomniaReactivity,
  SomniaAgentExecutor
};
