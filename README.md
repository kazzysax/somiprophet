# 🔱 SOMIPROPHET

**An AI-powered prediction market oracle built on Somnia's Agentic Layer-1.**

SOMIPROPHET advises users on prediction markets by unifying the two signals that actually decide outcomes — **on-chain wallet positioning** and **off-chain news sentiment** — into a single, honest verdict: *YES or NO, with a probability and the reasoning behind it.*

> Prediction markets were built for people to make money off their real-world knowledge — not lose it. Studies show only about **1 in 3** participants are ever profitable. SOMIPROPHET exists to move users into that profitable third.

---

## ✨ What It Does

For any market a user is considering, the Prophet:

1. **Finds the equivalent market** on Polymarket (entity-aware matching + LLM logic confirmation)
2. **Tracks the elite wallets** on that market, ranked by real win rates (via Falcon analytics)
3. **Tallies their positions** into a weighted on-chain vote (≈70% of the signal)
4. **Reads credible news** and produces a decisive sentiment read (≈30% of the signal)
5. **Delivers a prophecy** — verdict, probability, and plain-language explanation, streamed live

Every prophecy is recorded, every resolved outcome tracked, and the model's accuracy shown openly in **The Prophet's Ledger**.

---

## 🏗️ Architecture — Hybrid Somnia Model

```
⏱  User Request
       │
🖥  OFF-CHAIN · Server          ← heavy intelligence (speed)
     🔍 Market Matcher
     🐋 Wallet Tracker (Falcon)
     🗳️  Vote + News (70 / 30)
       │
⛓️  ONCHAIN · Somnia Agents     ← trust-critical (verifiable)
     📡 JSON API Agent  → fetches odds on-chain
     🧠 LLM Agent       → deterministic verdict
       │
✓  Validators                   ← consensus seals the result
       │
🔱  The Prophet Speaks → Scroll
```

- **Somnia Reactivity** is the engine: it wakes the agents on request, coordinates them, and streams results live.
- **Somnia Agents** are the trust layer: validator-executed, consensus-verified compute paid in STT from a treasury — never charged to the user.

---

## 🧰 Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js · Express · WebSocket (`ws`) |
| AI Reasoning | Claude API |
| On-chain | Somnia testnet/mainnet · Solidity · ethers v6 |
| Data sources | Polymarket (Gamma/CLOB/Data) · Falcon Analytics · GNews |
| Database | Supabase (PostgreSQL) |
| Frontend | Vanilla HTML/CSS/JS (dark-luxury theme) |

---

## 📁 Project Structure

```
somiprophet/
├── backend/
│   ├── server.js                 # Express + WebSocket server
│   ├── trackRecord.js            # Accountability / track record
│   ├── agents/
│   │   ├── orchestrator.js       # Pipeline coordinator
│   │   ├── marketMatcher.js      # 8-model market matching
│   │   ├── walletFetcher.js      # Falcon-first wallet discovery
│   │   ├── votingEngine.js       # On-chain vote tally
│   │   ├── sentimentFetcher.js   # GNews + LLM sentiment
│   │   └── llmReasoner.js        # Weighted final verdict
│   ├── reactivity/
│   │   ├── somniaAgent.js        # Reactivity WebSocket engine
│   │   └── somniaAgentBridge.js  # Bridge to on-chain agents
│   └── config/
│       ├── sources.js
│       └── database.js           # Supabase client
├── contracts/
│   ├── SomiTreasury.sol          # Gas treasury for agents
│   ├── SomiProphetAgent.sol      # On-chain Somnia agent caller
│   └── interfaces/IAgentRequester.sol
├── frontend/
│   └── index.html                # Full single-file UI
├── database/
│   └── schema.sql                # Supabase schema
├── scripts/
│   ├── deploy.js                 # Deploy treasury
│   └── deployAgent.js            # Deploy agent contract
└── hardhat.config.js
```

---

## 🚀 Getting Started

### Prerequisites
- Node.js ≥ 18
- A Claude API key ([console.anthropic.com](https://console.anthropic.com))
- A Falcon API token ([api.polymarketanalytics.com](https://api.polymarketanalytics.com))
- A GNews API key ([gnews.io](https://gnews.io)) — free tier
- (Optional) A Supabase project for persistence

### Install & Run

```bash
# 1. Clone
git clone https://github.com/kazzysax/somiprophet.git
cd somiprophet

# 2. Install
npm install

# 3. Configure
cp .env.example .env
#   then fill in your keys (see below)

# 4. Run
npm run dev          # development (auto-reload)
# or
npm start            # production

# 5. Open
http://localhost:3000
```

### Environment Variables

```env
ACTIVE_NETWORK=testnet
CLAUDE_API_KEY=your_claude_api_key
CLAUDE_MODEL=claude-sonnet-4-6
FALCON_API_TOKEN=your_falcon_token
FALCON_BASE_URL=https://narrative.agent.heisenberg.so/api/v2/semantic/retrieve/parameterized
FALCON_DASHBOARD_URL=https://narrative.agent.heisenberg.so/v2
GNEWS_API_KEY=your_gnews_key
DATABASE_URL=your_supabase_connection_string   # optional
PORT=3000
```

---

## ⛓️ Deploying the On-Chain Agents (optional)

The app runs fully in **free off-chain mode** until you deploy the agent contract.

```bash
# 1. Fund a deployer wallet with testnet STT
#    faucet: https://testnet.somnia.network/

# 2. Add DEPLOYER_PRIVATE_KEY to .env, then:
npm run deploy:agent:testnet

# 3. Add the printed address to .env:
#    SOMNIA_AGENT_CONTRACT=0x...
#    AGENT_CALLER_KEY=<STT-funded wallet key>

# 4. Set the LLM agent ID from agents.testnet.somnia.network
#    by calling setLlmAgentId(<id>) on the contract

# 5. Restart — the bridge auto-connects, agents go live on-chain
```

**Somnia network details**

| | Testnet (Shannon) | Mainnet |
|---|---|---|
| Chain ID | 50312 | 5031 |
| Symbol | STT | SOMI |
| RPC | `https://api.infra.testnet.somnia.network/` | `https://api.infra.mainnet.somnia.network/` |

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Server + Somnia + treasury status |
| `POST` | `/api/prophecy` | Start a prophecy (streams via WebSocket) |
| `GET` | `/api/stats` | Homepage stats (prophecies, accuracy) |
| `GET` | `/api/track-record` | Full public track record |
| `POST` | `/api/resolve` | Mark a prophecy resolved with its outcome |

---

## 🧮 The Weighting Model

- **On-chain wallet vote** is the dominant signal (~70%), adjusted down for lower-confidence gates.
- **Off-chain sentiment** carries the rest (~30%), and rises when on-chain data is thin.
- If neither signal is usable, the Prophet honestly returns **"No Reading"** rather than a fake coin-flip.

---

## 🗺️ Roadmap

- [x] Off-chain prediction pipeline (matching, wallets, voting, sentiment)
- [x] Somnia Reactivity live streaming
- [x] Hybrid on-chain agent contracts (treasury + agent caller)
- [x] Accountability / track record system
- [ ] On-chain agents live on Somnia mainnet
- [ ] Sealed tier + prophecy NFT certificates
- [ ] Self-learning memory matcher (competitive moat)
- [ ] Integration of prophecy API to track wallets
- [ ] Automated agents who trade on users variables

---

## ⚠️ Disclaimer

SOMIPROPHET is an **advisory** tool. It provides probabilistic guidance based on available data and does not guarantee outcomes. It is not financial advice. Always do your own research.

---

## 📄 License

MIT © kazzysax
