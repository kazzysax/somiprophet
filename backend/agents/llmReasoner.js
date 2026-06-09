/**
 * SOMIPROPHET — LLM Reasoning Engine
 * Uses Claude API to compute weighted prophecy
 */

const Anthropic = require("@anthropic-ai/sdk").default;

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

/**
 * Run LLM reasoning over all signals
 */
async function runLLM({
  marketName,
  resolutionCriteria,
  category,
  resolutionDate,
  matchResult,
  voteResult,
  sentimentResult,
  onchainWeight,
  offchainWeight,
  isShortMarket,
  walletDiagnostics,
  walletMessage
}) {
  // ── DETERMINE WHAT DATA WE ACTUALLY HAVE ──────────────
  const hasOnchain  = !!(voteResult && voteResult.total > 0);
  const hasSentiment = !!(sentimentResult &&
                          typeof sentimentResult.score === "number" &&
                          sentimentResult.score !== null &&
                          sentimentResult.postsAnalysed > 0);

  // ── ONCHAIN PROBABILITY (0..1 toward YES) ─────────────
  // If 7 of 10 wallets say YES → 0.70 toward YES
  // If 7 of 10 say NO          → 0.30 toward YES
  let onchainYesProb = null;
  if (hasOnchain) {
    onchainYesProb = voteResult.yesCount / voteResult.total;
  }

  // ── OFFCHAIN PROBABILITY (0..1 toward YES) ────────────
  // sentimentResult.score is already 0..1 (1 = bullish/YES)
  let offchainYesProb = null;
  if (hasSentiment) {
    offchainYesProb = sentimentResult.score;
  }

  // ── COMBINE INTO A DIRECTIONAL PROBABILITY ────────────
  // Re-normalise weights based on which signals exist, so a
  // missing signal does NOT drag the result toward 50%.
  let finalYesProb;
  let dataConfidence; // how much real data backs this

  if (hasOnchain && hasSentiment) {
    finalYesProb = (onchainYesProb * onchainWeight) +
                   (offchainYesProb * offchainWeight);
    dataConfidence = "HIGH";
  } else if (hasOnchain) {
    finalYesProb = onchainYesProb;          // onchain only
    dataConfidence = "MODERATE";
  } else if (hasSentiment) {
    finalYesProb = offchainYesProb;         // sentiment only
    dataConfidence = "LOW";
  } else {
    finalYesProb = null;                    // NO DATA AT ALL
    dataConfidence = "NONE";
  }

  // ── DERIVE VERDICT + PROBABILITY ──────────────────────
  let verdict, probabilityPct, confidence;

  if (finalYesProb === null) {
    // Genuinely no data — do NOT pretend it's a 50/50 call
    verdict        = "INSUFFICIENT_DATA";
    probabilityPct = null;
    confidence     = "NONE";
  } else {
    // Probability is the chance of YES
    probabilityPct = Math.round(finalYesProb * 100);
    // Verdict is the SIDE the probability favours
    verdict = finalYesProb >= 0.5 ? "YES" : "NO";
    // The displayed probability should match the verdict direction
    if (verdict === "NO") probabilityPct = 100 - probabilityPct;

    // Confidence from how far from 50/50 AND how much data
    const conviction = Math.abs(finalYesProb - 0.5) * 2; // 0..1
    if (dataConfidence === "HIGH" && conviction >= 0.5)      confidence = "HIGH";
    else if (conviction >= 0.3)                              confidence = "MODERATE";
    else                                                     confidence = "LOW";
  }

  // Scores for display (directional)
  const onchainScore  = hasOnchain  ? Math.round(onchainYesProb  * 100) : 0;
  const offchainScore = hasSentiment ? Math.round(offchainYesProb * 100) : 0;
  const finalScore    = probabilityPct !== null ? probabilityPct : 50;

  // Build a precise onchain status report for the briefing
  let onchainReport;
  if (hasOnchain) {
    onchainReport = `${voteResult.yesCount} YES / ${voteResult.noCount} NO across ${voteResult.total} elite wallets (leaning ${onchainYesProb >= 0.5 ? "YES" : "NO"}).`;
  } else if (walletDiagnostics) {
    const d = walletDiagnostics;
    onchainReport = `VOTE DID NOT PROCEED. ${walletMessage || ""} ` +
      `[${d.totalWalletsOnMarket ?? 0} wallets on market, ` +
      `${d.qualifiedAfterFilters ?? 0} passed quality filters, ` +
      `${d.admittedToVote ?? 0} admitted — need ${d.minViableNeeded ?? 5} minimum].`;
  } else {
    onchainReport = "No onchain wallet data available (no Polymarket market matched).";
  }

  const prompt = `You are SOMIPROPHET — an ancient oracle and prediction market analyst on the Somnia blockchain.

You have analysed a prediction market using a multi-signal consensus model. The scoring has ALREADY been computed for you. Your job is to explain it in the oracle's voice — NOT to recompute or second-guess the numbers.

MARKET DETAILS:
  Name:                ${marketName}
  Category:            ${category}
  Resolution Criteria: ${resolutionCriteria}
  Resolution Date:     ${new Date(resolutionDate).toDateString()}
  Short Duration:      ${isShortMarket ? "YES — resolves < 24 hours" : "NO"}

COMPUTED SIGNALS:
  Data available:      onchain=${hasOnchain ? "YES" : "NO"}, sentiment=${hasSentiment ? "YES" : "NO"}
  Onchain (wallets):   ${hasOnchain ? `${onchainScore}% lean toward YES` : "no wallet data"}
  Offchain (sentiment):${hasSentiment ? `${offchainScore}% lean toward YES` : "no sentiment data"}
  News read:           ${sentimentResult.summary || "no news summary"}
  Key news signal:     ${sentimentResult.keySignal || "none"}
  ONCHAIN REPORT:      ${onchainReport}

ALREADY-DECIDED OUTCOME (do not change these):
  VERDICT:      ${verdict}
  PROBABILITY:  ${verdict === "INSUFFICIENT_DATA" ? "N/A" : probabilityPct + "%"}
  CONFIDENCE:   ${confidence}
  DATA BACKING: ${dataConfidence}

RULES:
1. If VERDICT is INSUFFICIENT_DATA, you MUST say plainly that the Prophet cannot make a call because there is no onchain wallet data and no usable sentiment. Do NOT invent a 50/50 prediction. Tell the user to wait for more market activity.
2. If VERDICT is YES or NO, commit to it with conviction matching the CONFIDENCE level. Do NOT hedge into neutrality.
3. The "onchain_briefing" MUST factually state what happened onchain (wallet counts, whether the vote proceeded, why) using the ONCHAIN REPORT. No vague poetry there.

Respond ONLY with this exact JSON (no markdown, no extra text):
{
  "verdict": "${verdict}",
  "probability": "${verdict === "INSUFFICIENT_DATA" ? "N/A" : probabilityPct + "%"}",
  "confidence": "${confidence}",
  "onchain_briefing": "Plain factual statement of what happened onchain — wallet counts, whether vote proceeded, and why",
  "assessment": "2-3 sentence analysis in oracle voice that MATCHES the verdict above",
  "factors": ["factor 1", "factor 2", "factor 3"],
  "prophecy": "One bold direct sentence in oracle voice that commits to the verdict (or states clearly that no reading is possible)",
  "risks": ["risk 1", "risk 2"],
  "onchainScore": ${onchainScore},
  "offchainScore": ${offchainScore},
  "finalScore": ${finalScore},
  "gateLevel": "${hasOnchain ? `${voteResult.total} wallets voted` : "Vote did not proceed"}"
}`;

  const response = await client.messages.create({
    model:      process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 800,
    messages:   [{ role: "user", content: prompt }]
  });

  const raw  = response.content[0].text;
  const clean = raw.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(clean);
    // Force the computed verdict/probability — never let the LLM
    // override the math back into a vague neutral call
    parsed.verdict     = verdict;
    parsed.probability = verdict === "INSUFFICIENT_DATA" ? "N/A" : `${probabilityPct}%`;
    parsed.confidence  = confidence;
    parsed.onchainScore  = onchainScore;
    parsed.offchainScore = offchainScore;
    parsed.finalScore    = finalScore;
    return parsed;
  } catch (e) {
    // Fallback if JSON parse fails
    return {
      verdict,
      probability:  verdict === "INSUFFICIENT_DATA" ? "N/A" : `${probabilityPct}%`,
      confidence,
      onchain_briefing: onchainReport,
      assessment:   verdict === "INSUFFICIENT_DATA"
        ? "The Prophet sees neither onchain consensus nor clear sentiment. No reading can be made — wait for the market to gather more activity."
        : `The signals lean ${verdict}. The Prophet commits to this reading at ${confidence} confidence.`,
      factors:      [onchainReport, `Sentiment: ${sentimentResult.label || "no data"}`],
      prophecy:     verdict === "INSUFFICIENT_DATA"
        ? "The scrolls are blank — the Prophet cannot speak on a market with no signal."
        : `The Prophet declares: ${verdict}.`,
      risks:        ["Signal strength may shift as the market matures"],
      onchainScore,
      offchainScore,
      finalScore,
      gateLevel:    hasOnchain ? `${voteResult.total} wallets voted` : "Vote did not proceed"
    };
  }
}

module.exports = { runLLM };
