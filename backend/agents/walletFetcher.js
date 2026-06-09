/**
 * SOMIPROPHET — Wallet Fetcher Agent
 * Fetches top wallets on a Polymarket market
 * Applies step-down admission logic
 */

const axios  = require("axios");
const { WALLET_CONFIG, getGateLabel, APPROVED_SOURCES } = require("../config/sources");

const FALCON_BASE = process.env.FALCON_BASE_URL;
const FALCON_KEY  = process.env.FALCON_API_TOKEN;
// Falcon Polymarket Analytics dashboard base (trader intelligence)
const FALCON_DASH = process.env.FALCON_DASHBOARD_URL || "https://narrative.agent.heisenberg.so/v2";

/**
 * Call Falcon parameterized agent API
 */
async function callFalcon(agentId, params) {
  const resp = await axios.post(
    FALCON_BASE,
    { agent_id: agentId, parameters: params },
    { headers: { Authorization: `Bearer ${FALCON_KEY}` } }
  );
  return resp.data;
}

/**
 * Call Falcon dashboard REST endpoint (trader intelligence layer)
 * e.g. /v2/traders/stats, /v2/markets/retrieve
 */
async function callFalconDash(path, body) {
  const resp = await axios.post(
    `${FALCON_DASH}${path}`,
    body,
    { headers: { Authorization: `Bearer ${FALCON_KEY}`, "Content-Type": "application/json" } }
  );
  return resp.data;
}

/**
 * Get definitive trader stats from the Falcon dashboard
 * Returns real win_rate, pnl, roi, total_trades for a wallet.
 * This is the BEST source — Polymarket Analytics' own tracker.
 */
async function getTraderStats(walletAddress) {
  try {
    const data = await callFalconDash("/traders/stats", {
      wallet:    walletAddress,
      metrics:   ["pnl", "roi", "win_rate", "drawdown"],
      timeframe: `${WALLET_CONFIG.windowDays}d`
    });
    return {
      win_rate:       data.win_rate ?? 0,
      total_pnl:      data.total_pnl ?? 0,
      roi:            data.roi ?? 0,
      total_trades:   data.total_trades ?? 0,
      max_drawdown:   data.max_drawdown ?? 0,
      active_positions: data.active_positions ?? 0,
      source:         "falcon_dashboard"
    };
  } catch (err) {
    console.error(`[WalletFetcher] traders/stats error for ${walletAddress}:`, err.message);
    return null;
  }
}

/**
 * PRIMARY WALLET DISCOVERY via Falcon Top Traders.
 * Falcon is purpose-built for trader intelligence — it returns
 * the best traders ON a specific market with win rates already
 * attached, so we discover + score in one call.
 *
 * @param marketSlug  Polymarket market slug (from matcher)
 * @param conditionId Polymarket conditionId (fallback key)
 */
async function fetchWalletsFromFalcon(marketSlug, conditionId) {
  if (!FALCON_KEY) return [];
  try {
    const body = {
      agent_id: APPROVED_SOURCES.onchain.falcon.topTraders.agent_id, // 579
      params: {
        ...(marketSlug   && { market_slug: marketSlug }),
        ...(conditionId  && { condition_id: conditionId }),
        min_markets: WALLET_CONFIG.minMarketsTraded.toString(),
        limit:       "50",
        sort:        "win_rate"
      },
      pagination: { limit: 50, offset: 0 },
      formatter_config: { format_type: "raw" }
    };

    const resp = await axios.post(`${FALCON_DASH}/markets/retrieve`, body, {
      headers: { Authorization: `Bearer ${FALCON_KEY}`, "Content-Type": "application/json" },
      timeout: 15000
    });

    // Falcon returns traders with stats attached
    const traders = resp.data?.traders || resp.data?.top_traders || resp.data?.data || [];
    const wallets = traders
      .filter(t => t.wallet || t.proxy_wallet || t.address)
      .map(t => ({
        proxy_wallet:  t.wallet || t.proxy_wallet || t.address,
        win_rate:      t.win_rate ?? null,        // already provided by Falcon
        markets_traded: t.total_trades || t.markets_traded || 0,
        pnl:           t.total_pnl || t.pnl || 0,
        outcome:       t.position || t.outcome || "UNKNOWN",
        name:          t.name || t.pseudonym || null,
        fromFalcon:    true
      }));

    if (wallets.length > 0) {
      console.log(`[WalletFetcher] Falcon Top Traders returned ${wallets.length} wallets`);
    }
    return wallets;
  } catch (err) {
    console.error("[WalletFetcher] Falcon Top Traders error:", err.message);
    return [];
  }
}

/**
 * Fetch all wallets holding positions on a Polymarket market.
 * ROUTE ORDER:
 *   1. Falcon Top Traders (best — discovery + scoring in one)
 *   2. Polymarket /holders
 *   3. Polymarket /positions
 *   4. Polymarket /trades
 */
async function fetchMarketWallets(marketId, marketSlug) {
  // ROUTE 1: Falcon Top Traders (primary)
  const falconWallets = await fetchWalletsFromFalcon(marketSlug, marketId);
  if (falconWallets.length > 0) return falconWallets;

  const data = APPROVED_SOURCES.onchain.polymarket.data;
  try {
    // ROUTE 2: Polymarket /holders
    const resp = await axios.get(`${data}/holders`, {
      params: { market: marketId, limit: 100 }
    });

    const tokenGroups = resp.data || [];
    const wallets = [];

    // Flatten holders across both outcome tokens (YES + NO)
    for (const group of tokenGroups) {
      const holders = group.holders || [];
      for (const h of holders) {
        if (h.proxyWallet) {
          wallets.push({
            proxy_wallet: h.proxyWallet,
            amount:       h.amount || 0,
            outcomeIndex: h.outcomeIndex,   // 0 = first outcome, 1 = second
            outcome:      h.outcomeIndex === 0 ? "YES" : "NO",
            name:         h.name || h.pseudonym || null
          });
        }
      }
    }

    if (wallets.length > 0) {
      console.log(`[WalletFetcher] /holders returned ${wallets.length} wallets`);
      return wallets;
    }
  } catch (err) {
    console.error("[WalletFetcher] /holders error:", err.message);
  }

  // ROUTE 3: /positions endpoint
  try {
    const resp = await axios.get(`${data}/positions`, {
      params: { market: marketId, limit: 100 }
    });
    const positions = resp.data?.data || resp.data || [];
    const wallets = positions
      .filter(p => p.proxyWallet || p.proxy_wallet)
      .map(p => ({
        proxy_wallet: p.proxyWallet || p.proxy_wallet,
        amount:       p.size || p.amount || 0,
        outcome:      p.outcome || (p.outcomeIndex === 0 ? "YES" : "NO"),
        name:         p.name || null
      }));
    if (wallets.length > 0) {
      console.log(`[WalletFetcher] /positions returned ${wallets.length} wallets`);
      return wallets;
    }
  } catch (err) {
    console.error("[WalletFetcher] /positions fallback error:", err.message);
  }

  // ROUTE 4: recent /trades to discover active wallets
  try {
    const resp = await axios.get(`${data}/trades`, {
      params: { market: marketId, limit: 100 }
    });
    const trades = resp.data?.data || resp.data || [];
    const seen = new Set();
    const wallets = [];
    for (const t of trades) {
      const w = t.proxyWallet || t.proxy_wallet || t.maker || t.taker;
      if (w && !seen.has(w)) {
        seen.add(w);
        wallets.push({
          proxy_wallet: w,
          amount:       t.size || 0,
          outcome:      t.outcome || "UNKNOWN",
          name:         null
        });
      }
    }
    console.log(`[WalletFetcher] /trades discovered ${wallets.length} wallets`);
    return wallets;
  } catch (err) {
    console.error("[WalletFetcher] /trades fallback error:", err.message);
    return [];
  }
}

/**
 * Get win rate for a wallet — tries the Falcon dashboard tracker
 * first (most accurate), then falls back to the Wallet360 agent.
 */
async function getWalletWinRate(walletAddress) {
  // PRIMARY: Falcon dashboard trader stats (best tracker)
  const dash = await getTraderStats(walletAddress);
  if (dash && dash.total_trades > 0) {
    return {
      win_rate:                 dash.win_rate,
      markets_traded:           dash.total_trades,
      pnl:                      dash.total_pnl,
      roi:                      dash.roi,
      sybil_risk_flag:          false,
      // Flag suspiciously perfect records as risky
      suspicious_win_rate_flag: dash.win_rate >= 0.98 && dash.total_trades < 10,
      performance_trend:        dash.roi > 0 ? "positive" : "negative",
      risk_level:               dash.max_drawdown < -0.5 ? "HIGH" : "NORMAL",
      sharpe_ratio:             0,
      source:                   "falcon_dashboard"
    };
  }

  // FALLBACK: Wallet360 parameterized agent
  try {
    const data = await callFalcon(
      APPROVED_SOURCES.onchain.falcon.wallet360.agent_id,
      { proxy_wallet: walletAddress, window_days: WALLET_CONFIG.windowDays.toString() }
    );
    return {
      win_rate:                 data.win_rate || 0,
      markets_traded:           data.markets_traded || 0,
      sybil_risk_flag:          data.sybil_risk_flag || false,
      suspicious_win_rate_flag: data.suspicious_win_rate_flag || false,
      performance_trend:        data.performance_trend || "unknown",
      risk_level:               data.risk_level || "UNKNOWN",
      sharpe_ratio:             data.sharpe_ratio || 0,
      source:                   "wallet360"
    };
  } catch (err) {
    console.error(`[WalletFetcher] Wallet360 fallback error for ${walletAddress}:`, err.message);
    return null;
  }
}

/**
 * Main wallet admission with step-down logic
 * RULE: Quality over quantity
 * - Start at 70% win rate
 * - Step down 5% if < 5 wallets found
 * - If 5-9 wallets at current gate → vote holds (no step down)
 * - If < 5 at floor → insufficient signal
 */
async function fetchWallets({ marketId, marketSlug, pushUpdate, requestId }) {
  let threshold    = WALLET_CONFIG.startingGate;
  let stepDownCount = 0;
  let lowConfidence = false;
  let admittedWallets = [];

  // Get all wallets on market first (Falcon-first, then Polymarket)
  const rawWallets = await fetchMarketWallets(marketId, marketSlug);

  if (rawWallets.length === 0) {
    return {
      success:       false,
      wallets:       [],
      thresholdUsed: threshold,
      gateLabel:     "🔴 VERY LOW CONFIDENCE",
      stepDownCount: 0,
      lowConfidence: true,
      diagnostics: {
        totalWalletsOnMarket:  0,
        walletsAnalysed:       0,
        qualifiedAfterFilters: 0,
        admittedToVote:        0
      },
      message: "No wallets hold positions on this Polymarket market yet. The Prophet cannot read onchain consensus."
    };
  }

  // Get win rates for all wallets (parallel)
  pushUpdate(requestId, {
    type:  "progress",
    label: `Analysing ${rawWallets.length} wallets...`
  });

  const walletDetails = await Promise.all(
    rawWallets.slice(0, 50).map(async (w) => {
      const addr = w.proxy_wallet || w.wallet;

      // If Falcon Top Traders already gave us a win_rate, use it
      // directly — no need for a second scoring call.
      if (w.fromFalcon && typeof w.win_rate === "number" && w.win_rate !== null) {
        return {
          address:             addr,
          position:            w.outcome || "UNKNOWN",
          win_rate:            w.win_rate,
          markets_traded:      w.markets_traded || 0,
          sybil_risk_flag:     false,
          suspicious_win_rate: w.win_rate >= 0.98 && (w.markets_traded || 0) < 10,
          risk_level:          "NORMAL",
          performance_trend:   (w.pnl || 0) > 0 ? "positive" : "negative",
        };
      }

      // Otherwise score the wallet (Falcon dashboard → Wallet360)
      const details = await getWalletWinRate(addr);
      if (!details) return null;
      return {
        address:              addr,
        position:             w.outcome || "UNKNOWN",
        win_rate:             details.win_rate,
        markets_traded:       details.markets_traded,
        sybil_risk_flag:      details.sybil_risk_flag,
        suspicious_win_rate:  details.suspicious_win_rate_flag,
        risk_level:           details.risk_level,
        performance_trend:    details.performance_trend,
      };
    })
  );

  // Filter out nulls and disqualified wallets
  const validWallets = walletDetails.filter(w =>
    w !== null &&
    !w.sybil_risk_flag &&
    !w.suspicious_win_rate &&
    w.markets_traded >= WALLET_CONFIG.minMarketsTraded
  );

  // Step-down loop
  while (threshold >= WALLET_CONFIG.floor) {
    const qualified = validWallets
      .filter(w => w.win_rate >= threshold)
      .sort((a, b) => b.win_rate - a.win_rate);

    const top = qualified.slice(0, WALLET_CONFIG.target);

    if (top.length >= WALLET_CONFIG.minViable) {
      // KEY RULE: If 5-9 wallets at current gate → DO NOT step down
      // Vote holds to preserve signal quality
      admittedWallets = top;
      if (threshold <= WALLET_CONFIG.lowConfFlag) lowConfidence = true;
      break;
    }

    // Not enough — step down
    if (stepDownCount > 0) {
      pushUpdate(requestId, {
        type:  "progress",
        label: `Only ${top.length} wallets at ≥${Math.round(threshold * 100)}%. Stepping down...`
      });
    }

    threshold     -= WALLET_CONFIG.stepDown;
    stepDownCount++;
  }

  const gateLabel = getGateLabel(threshold + WALLET_CONFIG.stepDown);

  // Build a clear onchain diagnostic report
  const diagnostics = {
    totalWalletsOnMarket:  rawWallets.length,
    walletsAnalysed:       walletDetails.filter(w => w !== null).length,
    qualifiedAfterFilters: validWallets.length,
    admittedToVote:        admittedWallets.length,
    finalThreshold:        Math.round((threshold + WALLET_CONFIG.stepDown) * 100),
    stepDowns:             stepDownCount,
    minMarketsRequired:    WALLET_CONFIG.minMarketsTraded,
    minViableNeeded:       WALLET_CONFIG.minViable
  };

  if (admittedWallets.length < WALLET_CONFIG.minViable) {
    // Build a precise human-readable reason
    let reason;
    if (rawWallets.length === 0) {
      reason = "No wallets hold positions on this Polymarket market yet.";
    } else if (validWallets.length === 0) {
      reason = `${rawWallets.length} wallets hold positions, but none passed quality filters (need ≥${WALLET_CONFIG.minMarketsTraded} markets traded, no sybil flags).`;
    } else {
      reason = `Only ${validWallets.length} qualified wallet${validWallets.length === 1 ? "" : "s"} found (need ${WALLET_CONFIG.minViable} minimum). Vote cannot proceed due to poor onchain signal.`;
    }

    return {
      success:       false,
      wallets:       admittedWallets,
      thresholdUsed: threshold,
      gateLabel:     "🔴 VERY LOW CONFIDENCE",
      stepDownCount,
      lowConfidence: true,
      diagnostics,
      message:       reason
    };
  }

  return {
    success:       true,
    wallets:       admittedWallets,
    thresholdUsed: threshold + WALLET_CONFIG.stepDown,
    gateLabel,
    stepDownCount,
    lowConfidence,
    totalAnalysed: validWallets.length,
    diagnostics,
    message:       `${admittedWallets.length} elite wallets admitted at ≥${diagnostics.finalThreshold}% win rate${stepDownCount > 0 ? ` (stepped down ${stepDownCount}×)` : ""}.`
  };
}

module.exports = { fetchWallets };
