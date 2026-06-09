# 🔱 SOMIPROPHET — Somnia Agents (Hybrid Model)

This document explains EXACTLY what runs off-chain vs on-chain,
and how the REAL Somnia base agents are integrated.

---

## THE HONEST ARCHITECTURE

```
OFF-CHAIN (your server)        ON-CHAIN (real Somnia Agents)
─────────────────────          ─────────────────────────────
8-model market matching        JSON API Agent
Wallet discovery + step-down     → fetches Polymarket odds
Vote tallying                    → validator-executed
Sentiment aggregation            → consensus-verified
Orchestration + UI             LLM Inference Agent
                                 → deterministic YES/NO verdict
                                 → Qwen3-30B onchain
                                 → temperature=0, fixed seed
                                 → all validators agree
```

**Why hybrid:** the matching/voting logic is too complex and
multi-step to run economically onchain. But the two pieces that
benefit most from trustlessness — the market odds and the final
verdict — run as REAL Somnia agents with validator consensus.

---

## THE REAL SOMNIA BASE AGENTS USED

From official docs (https://docs.somnia.network/agents):

| Agent | Cost/validator | We use it for |
|---|---|---|
| JSON API Request | 0.03 STT | Fetch Polymarket odds onchain |
| LLM Inference | 0.07 STT | Deterministic YES/NO verdict |

Platform (testnet): `0x037Bb9C718F3f7fe5eCBDB0b600D607b52706776`
Agent Explorer: https://agents.testnet.somnia.network/

---

## HOW A PROPHECY FLOWS NOW

```
1. User submits market (off-chain)
2. Server: match market on Polymarket (8 models)
3. Server: discover wallets + tally votes
4. Server: fetch sentiment
5. ONCHAIN: SomiProphetAgent.startProphecy()
   → Somnia JSON API agent fetches the live
     Polymarket odds
   → 3 validators fetch independently
   → consensus locks the number onchain
6. ONCHAIN: SomiProphetAgent.requestVerdict()
   → Server builds a prompt with the vote +
     sentiment summary
   → Somnia LLM agent returns YES/NO
   → deterministic, all validators agree
   → verdict committed onchain
7. Server reads verified result, streams to UI
```

---

## COST PER PROPHECY (testnet STT)

```
JSON API agent:  0.03 × 3 validators = 0.09 STT
  + deposit floor                    ≈ 0.03 STT
  → startProphecy needs ~0.12 STT

LLM agent:       0.07 × 3 validators = 0.21 STT
  + deposit floor                    ≈ 0.07 STT
  → requestVerdict needs ~0.28 STT

TOTAL per full onchain prophecy: ~0.40 STT
Paid from your STT-funded caller wallet.
Unused deposit is auto-rebated.
```

---

## SETUP (testnet)

```
1. Deploy the agent contract:
   npm run deploy:agent:testnet

2. Add to .env:
   SOMNIA_AGENT_CONTRACT=<deployed address>
   AGENT_CALLER_KEY=<STT-funded wallet key>

3. Find the LLM agent ID on the explorer:
   https://agents.testnet.somnia.network/
   Then call setLlmAgentId(<id>) on your contract

4. Fund the caller wallet with STT from:
   https://testnet.somnia.network/

5. Restart backend:
   npm run dev
   → bridge auto-connects, onchain agents active
```

---

## OFF-CHAIN-ONLY MODE (default until you deploy)

If SOMNIA_AGENT_CONTRACT is not set, the model runs
fully off-chain (free, fast) and the bridge logs:

```
[SomniaBridge] ⚠️ Onchain agent not configured — running off-chain only
```

This lets you test the full model first, then turn on
real onchain agents when ready. Honest and incremental.
