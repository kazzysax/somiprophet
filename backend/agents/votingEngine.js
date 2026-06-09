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
 * Run the vote across all admitted wallets
 * Streams each vote live to UI
 */
async function runVote({ wallets, marketId, pushUpdate, requestId }) {
  let yesCount = 0;
  let noCount  = 0;
  let yesWallets = [];
  let noWallets  = [];

  for (const wallet of wallets) {
    // Prefer the position we already learned from /holders
    // (wallet.position is "YES"/"NO" from the holders endpoint).
    // Only re-fetch if it's unknown.
    let vote = null;
    if (wallet.position === "YES" || wallet.position === "NO") {
      vote = wallet.position;
    } else {
      const position = await getWalletPosition(wallet.address, marketId);
      vote = position?.vote || null;
    }

    if (vote === "YES") {
      yesCount++;
      yesWallets.push(wallet);
    } else if (vote === "NO") {
      noCount++;
      noWallets.push(wallet);
    }

    // Stream vote live to UI
    pushUpdate(requestId, {
      type:     "vote",
      wallet:   wallet.address.slice(0, 6) + "..." + wallet.address.slice(-4),
      win_rate: `${Math.round(wallet.win_rate * 100)}%`,
      vote:     vote || "NO POSITION",
      yesCount,
      noCount
    });

    await new Promise(r => setTimeout(r, 200));
  }

  const total   = yesCount + noCount;
  const verdict = yesCount > noCount ? "YES"
    : noCount  > yesCount ? "NO"
    : "INCONCLUSIVE";

  const voteConfidence = total > 0
    ? Math.round((Math.max(yesCount, noCount) / total) * 100)
    : 0;

  return {
    yesCount,
    noCount,
    total,
    verdict,
    voteConfidence,
    voteSplit:  `${yesCount}/${total}`,
    yesWallets,
    noWallets,
  };
}

module.exports = { runVote };
