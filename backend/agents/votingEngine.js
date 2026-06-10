/**
 * SOMIPROPHET — Voting Engine
 * Tallies wallet positions as votes
 * Streams each vote live via Reactivity
 */

const axios = require("axios");
const { APPROVED_SOURCES } = require("../config/sources");

/**
 * Fetch wallet position on specific market
 */
async function getWalletPosition(walletAddress, marketId) {
  try {
    const resp = await axios.get(
      `${APPROVED_SOURCES.onchain.polymarket.data}/positions`,
      {
        params: {
          user:   walletAddress,
          market: marketId
        }
      }
    );
    const positions = resp.data?.data || [];
    if (positions.length === 0) return null;

    // Find YES or NO position
    const yesPos = positions.find(p =>
      p.outcome?.toLowerCase() === "yes" && p.size > 0
    );
    const noPos = positions.find(p =>
      p.outcome?.toLowerCase() === "no" && p.size > 0
    );

    if (yesPos)  return { vote: "YES", size: yesPos.size };
    if (noPos)   return { vote: "NO",  size: noPos.size };
    return null;

  } catch (err) {
    console.error(`[VotingEngine] Position fetch error for ${walletAddress}:`, err.message);
    return null;
  }
}

/**
 * Run the vote across all admitted wallets — CONVICTION-WEIGHTED.
 *
 * Not 1-wallet-1-vote. Each wallet's influence =
 *   skillEdge × (1 + stakeWeight)
 * where skillEdge = max(win_rate - 0.5, 0.01) and
 *       stakeWeight = ln(1 + $size).
 * A 75%-win whale with $40k outweighs a 55% trader with $20.
 * Raw counts still tracked for display.
 */
async function runVote({ wallets, marketId, pushUpdate, requestId }) {
  let yesCount = 0, noCount = 0;
  let yesWeight = 0, noWeight = 0;
  let yesWallets = [], noWallets = [];

  for (const wallet of wallets) {
    let vote = null;
    let size = wallet.amount || wallet.size || 0;

    if (wallet.position === "YES" || wallet.position === "NO") {
      vote = wallet.position;
    } else {
      const position = await getWalletPosition(wallet.address, marketId);
      vote = position?.vote || null;
      if (position?.size) size = position.size;
    }

    const skillEdge   = Math.max((wallet.win_rate || 0.5) - 0.5, 0.01);
    const stakeWeight = Math.log(1 + Math.max(size, 1));
    const influence   = skillEdge * (1 + stakeWeight);

    if (vote === "YES") {
      yesCount++; yesWeight += influence; yesWallets.push(wallet);
    } else if (vote === "NO") {
      noCount++;  noWeight  += influence; noWallets.push(wallet);
    }

    pushUpdate(requestId, {
      type:     "vote",
      wallet:   wallet.address.slice(0, 6) + "..." + wallet.address.slice(-4),
      win_rate: `${Math.round((wallet.win_rate || 0) * 100)}%`,
      vote:     vote || "NO POSITION",
      yesCount, noCount
    });

    await new Promise(r => setTimeout(r, 200));
  }

  const total       = yesCount + noCount;
  const totalWeight = yesWeight + noWeight;

  const verdict = totalWeight === 0 ? "INCONCLUSIVE"
    : yesWeight > noWeight ? "YES"
    : noWeight  > yesWeight ? "NO"
    : "INCONCLUSIVE";

  const voteConfidence = totalWeight > 0
    ? Math.round((Math.max(yesWeight, noWeight) / totalWeight) * 100)
    : 0;

  const weightedYesProb = totalWeight > 0 ? yesWeight / totalWeight : 0.5;

  return {
    yesCount, noCount, total,
    yesWeight: Math.round(yesWeight * 100) / 100,
    noWeight:  Math.round(noWeight * 100) / 100,
    weightedYesProb,
    verdict,
    voteConfidence,
    voteSplit: `${yesCount}/${total}`,
    yesWallets, noWallets,
  };
}

module.exports = { runVote };
