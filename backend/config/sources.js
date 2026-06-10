/**
 * SOMIPROPHET — Wallet Admission Config
 * Locked rules for wallet qualification
 */

const WALLET_CONFIG = {
  target:           10,     // ideal wallet count for vote
  minViable:        5,      // minimum for a FULL-strength vote
  partialFloor:     2,      // 2-4 strong wallets = PARTIAL signal (not discarded)
  startingGate:     0.70,   // 70% win rate starting threshold
  stepDown:         0.05,   // 5% decrements
  floor:            0.45,   // never go below 45%
  lowConfFlag:      0.55,   // flag if threshold drops below this
  minMarketsTraded: 20,     // wallet must have traded ≥ 20 markets
  windowDays:       30,     // use 30-day win rate window
};

function getGateLabel(threshold) {
  const pct = threshold * 100;
  if (pct >= 70) return "🟢 HIGH CONFIDENCE";
  if (pct >= 60) return "🟡 MODERATE CONFIDENCE";
  if (pct >= 50) return "🟠 LOW CONFIDENCE";
  return              "🔴 VERY LOW CONFIDENCE";
}

function getOnchainWeight(gateLabel, baseWeight = 0.70) {
  if (gateLabel.includes("HIGH"))      return baseWeight;
  if (gateLabel.includes("MODERATE"))  return baseWeight - 0.05;
  if (gateLabel.includes("LOW") && !gateLabel.includes("VERY")) return baseWeight - 0.10;
  return baseWeight - 0.15;
}

const PROPHET_MESSAGES = {
  strong: (count) =>
    `The oracle speaks with clarity. ${count} elite wallets have been summoned. The Prophet's confidence is HIGH.`,
  moderate: (count) =>
    `The Prophet sees a clear but limited signal. ${count} elite wallets have spoken — signal preserved over quantity.`,
  stepped: (threshold) =>
    `Elite trader activity on this market is limited. The Prophet has lowered the gate to ${Math.round(threshold * 100)}% to gather signals. Proceed with measured caution.`,
  poor: () =>
    `The Prophet cannot speak with confidence on this market. Too few experienced traders have taken position. The oracle recommends patience — wait for stronger hands to move before seeking guidance.`,
  shortMarket: () =>
    `This market resolves soon. News signals may be incomplete. The Prophet leans heavily on onchain wisdom for this reading.`
};

const APPROVED_SOURCES = {
  onchain: {
    polymarket: {
      gamma: "https://gamma-api.polymarket.com",
      clob:  "https://clob.polymarket.com",
      data:  "https://data-api.polymarket.com",
    },
    falcon: {
      topTraders: { agent_id: 579 },
      wallet360:  { agent_id: 581 },
    }
  },
  offchain: {
    falcon: {
      socialPulse: { agent_id: 585 },
    },
    approvedOutlets: (process.env.APPROVED_OUTLETS || "reuters.com,bbc.com,apnews.com,coindesk.com,theblock.co,decrypt.co,bloomberg.com,ft.com").split(",")
  }
};

module.exports = {
  WALLET_CONFIG,
  getGateLabel,
  getOnchainWeight,
  PROPHET_MESSAGES,
  APPROVED_SOURCES
};
