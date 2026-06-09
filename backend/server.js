/**
 * SOMIPROPHET v2 — Backend Server
 * Somnia Reactivity Agent Model
 * Treasury-funded gas for all agent operations
 */
require("dotenv").config();
const express   = require("express");
const cors      = require("cors");
const http      = require("http");
const WebSocket = require("ws");
const path      = require("path");

const { runProphecy }  = require("./agents/orchestrator");
const { reactivity, agentExecutor } = require("./reactivity/somniaAgent");
const trackRecord = require("./trackRecord");

// Seed initial track record (only if empty)
trackRecord.seedIfEmpty();

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));

// ── CLIENT WEBSOCKET MAP ──────────────────────────────────
const clients = new Map();

wss.on("connection", (ws) => {
  ws.on("message", (msg) => {
    try {
      const { type, requestId } = JSON.parse(msg);
      if (type === "subscribe" && requestId) {
        clients.set(requestId, ws);
        ws.requestId = requestId;
      }
    } catch (e) {}
  });
  ws.on("close", () => {
    if (ws.requestId) clients.delete(ws.requestId);
  });
});

function pushUpdate(requestId, data) {
  const ws = clients.get(requestId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

// ── CONNECT TO SOMNIA REACTIVITY ──────────────────────────
reactivity.connect();

// ── ROUTES ────────────────────────────────────────────────

// Health + network status
app.get("/api/health", async (req, res) => {
  const treasury = await agentExecutor.checkTreasury();
  const block    = await reactivity.getBlockNumber();
  res.json({
    status:    "online",
    version:   "2.0.0",
    model:     "SOMIPROPHET Reactivity Agent v2",
    network:   process.env.ACTIVE_NETWORK || "testnet",
    somnia: {
      connected:   reactivity.isConnected,
      latestBlock: block,
      rpc:         process.env.ACTIVE_NETWORK === "mainnet"
                     ? "https://api.infra.mainnet.somnia.network/"
                     : "https://api.infra.testnet.somnia.network/",
      wss:         process.env.ACTIVE_NETWORK === "mainnet"
                     ? "wss://api.infra.mainnet.somnia.network/ws"
                     : "wss://api.infra.testnet.somnia.network/ws"
    },
    treasury,
    time: new Date().toISOString()
  });
});

// Treasury status
app.get("/api/treasury", async (req, res) => {
  const stats = await agentExecutor.checkTreasury();
  const gas   = agentExecutor.getGasReport();
  res.json({ ...stats, gasReport: gas });
});

// ── ACCOUNTABILITY / TRACK RECORD ─────────────────────
// Homepage stats (prophecies made, accuracy, etc.)
app.get("/api/stats", (req, res) => {
  res.json(trackRecord.getStats());
});

// Full public track record (past prophecies + outcomes)
app.get("/api/track-record", (req, res) => {
  res.json({ prophecies: trackRecord.getAllProphecies(100) });
});

// Resolve a prophecy with its real outcome (admin/manual)
app.post("/api/resolve", (req, res) => {
  const { id, outcome } = req.body;
  if (!id || !["YES", "NO"].includes(outcome)) {
    return res.status(400).json({ error: "Need id and outcome (YES/NO)" });
  }
  const updated = trackRecord.resolveProphecy(id, outcome);
  if (!updated) return res.status(404).json({ error: "Prophecy not found" });
  res.json(updated);
});

// Run prophecy — free for all users, treasury pays gas
app.post("/api/prophecy", async (req, res) => {
  const {
    marketName, marketUrl,
    resolutionCriteria, category, resolutionDate
  } = req.body;

  if (!marketName || !resolutionCriteria || !category || !resolutionDate) {
    return res.status(400).json({
      error: "Required: marketName, resolutionCriteria, category, resolutionDate"
    });
  }

  if (marketUrl && !marketUrl.startsWith("https://prophecy.social/event/")) {
    return res.status(400).json({
      error: "Market URL format: https://prophecy.social/event/{id}"
    });
  }

  const requestId = `prophecy_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;

  // Return immediately — stream updates via WebSocket
  res.json({ requestId, status: "running" });

  console.log(`\n[PROPHECY] ${requestId}`);
  console.log(`  Market:   ${marketName}`);
  console.log(`  Category: ${category}`);

  runProphecy({
    requestId, marketName, marketUrl,
    resolutionCriteria, category,
    resolutionDate, pushUpdate
  }).catch(err => {
    pushUpdate(requestId, {
      type:    "error",
      message: "The oracle encountered an error. Please try again."
    });
  });
});

// ── START ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = "0.0.0.0";  // Render requires binding to 0.0.0.0
server.listen(PORT, HOST, async () => {
  const treasury = await agentExecutor.checkTreasury();

  console.log("\n🔱 SOMIPROPHET v2 — Reactivity Agent Model");
  console.log("============================================");
  console.log(`Server:   http://localhost:${PORT}`);
  console.log(`Network:  ${process.env.ACTIVE_NETWORK || "testnet"}`);
  console.log(`Somnia:   ${reactivity.isConnected ? "✅ Connected" : "⏳ Connecting..."}`);
  console.log(`Treasury: ${treasury.balance}`);
  console.log(`Status:   ${treasury.isSafe ? "✅ Safe" : "⚠️  Low balance"}`);
  console.log("============================================\n");
});

module.exports = { pushUpdate };
