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
    // Prefer conviction-weighted probability (skill × stake); fall back to raw count
    onchainYesProb = (typeof voteResult.weightedYesProb === "number")
      ? voteResult.weightedYesProb
      : voteResult.yesCount / voteResult.total;
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

  // ── SIGNAL STRENGTH (how decisive each side is, 0-100%) ──
  // 50/50 lean = 0% strength; 100/0 lean = 100% strength; no data = 0%
  const onchainStrength  = hasOnchain   ? Math.round(Math.abs(onchainYesProb  - 0.5) * 200) : 0;
  const offchainStrength = hasSentiment ? Math.round(Math.abs(offchainYesProb - 0.5) * 200) : 0;
  const onchainLean  = hasOnchain   ? (onchainYesProb  >= 0.5 ? "YES" : "NO") : null;
  const offchainLean = hasSentiment ? (offchainYesProb >= 0.5 ? "YES" : "NO") : null;

  const prompt = `You are SOMIPROPHET — an oracle and prediction market analyst on the Somnia blockchain.

The scoring has ALREADY been computed. Your job is to explain it in NATURAL, PLAIN LANGUAGE — the way a sharp human analyst would brief a friend. Not robotic stat-dumps, not vague poetry. Specific, factual, conversational.

MARKET DETAILS:
  Name:                ${marketName}
  Category:            ${category}
  Resolution Criteria: ${resolutionCriteria}
  Resolution Date:     ${new Date(resolutionDate).toDateString()}
  Short Duration:      ${isShortMarket ? "YES — resolves < 24 hours" : "NO"}

WHAT HAPPENED ONCHAIN (raw facts):
  ${onchainReport}
  Wallet diagnostics: ${walletDiagnostics ? JSON.stringify(walletDiagnostics) : "n/a"}
  Onchain lean: ${onchainLean || "none"} · signal strength ${onchainStrength}%

WHAT HAPPENED OFFCHAIN (raw facts):
  News read: ${sentimentResult.summary || "no news summary"}
  Key signal: ${sentimentResult.keySignal || "none"}
  Articles analysed: ${sentimentResult.postsAnalysed ?? 0} · basis: ${sentimentResult.basis || "n/a"}
  Offchain lean: ${offchainLean || "none"} · signal strength ${offchainStrength}%

ALREADY-DECIDED OUTCOME (do not change these):
  VERDICT:      ${verdict}
  PROBABILITY:  ${verdict === "INSUFFICIENT_DATA" ? "N/A" : probabilityPct + "%"}
  CONFIDENCE:   ${confidence}

HOW TO WRITE THE BRIEFINGS (this matters):
- onchain_briefing: Say what the model actually FOUND, naturally. Examples of the right tone:
  "The model found no credible wallet strength on this market — only ${walletDiagnostics?.totalWalletsOnMarket ?? 0} wallets hold positions and none passed the quality bar, so no decisive onchain conclusion can be drawn."
  "The model found only two wallets of good strength, both leaning NO — too few for a confident consensus, but a mild bearish hint."
  "Eleven elite wallets are positioned here and nine of them are on the YES side — a strong onchain consensus."
- offchain_briefing: Read the news like a human. Examples of the right tone:
  "The news gives Senegal the stronger stance — recent reports highlight their unbeaten run, while Norway's coverage centres on injury doubts."
  "Coverage is thin; the few credible pieces lean slightly NO, but nothing decisive."
- conclusion: One or two plain sentences tying it together. Examples:
  "With onchain silent and the news only mildly directional, there is no strong signal here — the Prophet withholds a call."
  "Both signals point the same way; this is a confident NO."
Use the ACTUAL numbers and facts above. Never invent wallets or articles that don't exist.

Respond ONLY with this exact JSON (no markdown, no extra text):
{
  "verdict": "${verdict}",
  "probability": "${verdict === "INSUFFICIENT_DATA" ? "N/A" : probabilityPct + "%"}",
  "confidence": "${confidence}",
  "onchain_briefing": "natural-language onchain read as described above",
  "offchain_briefing": "natural-language news read as described above",
  "assessment": "2-3 sentence overall analysis in a clear, human voice that MATCHES the verdict",
  "factors": ["factor 1", "factor 2", "factor 3"],
  "prophecy": "One bold direct sentence committing to the verdict (or stating clearly that no reading is possible)",
  "risks": ["risk 1", "risk 2"],
  "conclusion": "1-2 plain sentences tying both signals together as described above",
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
    parsed.onchainStrength  = onchainStrength;
    parsed.offchainStrength = offchainStrength;
    parsed.onchainLean  = onchainLean;
    parsed.offchainLean = offchainLean;
    return parsed;
  } catch (e) {
    // Fallback if JSON parse fails — still natural, never robotic
    const d = walletDiagnostics || {};
    const fbOnchain = hasOnchain
      ? `The model found ${voteResult.total} credible wallets on this market — ${voteResult.yesCount} positioned YES, ${voteResult.noCount} NO. The onchain lean is ${onchainLean} at ${onchainStrength}% strength.`
      : `The model found no credible wallet strength on this market — ${d.totalWalletsOnMarket ?? 0} wallets present, ${d.admittedToVote ?? 0} met the quality bar (minimum ${d.minViableNeeded ?? 5}). No decisive onchain conclusion can be drawn.`;
    const fbOffchain = hasSentiment
      ? (sentimentResult.summary || `The news leans ${offchainLean} at ${offchainStrength}% strength.`)
      : "No usable news signal was found within the lookback window.";
    const fbConclusion = verdict === "INSUFFICIENT_DATA"
      ? `Position scoring — Onchain: ${onchainStrength}%, Offchain: ${offchainStrength}%. Neither signal is strong enough; the Prophet withholds a call.`
      : `Position scoring — Onchain: ${onchainStrength}%, Offchain: ${offchainStrength}%. The combined read points ${verdict} at ${confidence} confidence.`;
    return {
      verdict,
      probability:  verdict === "INSUFFICIENT_DATA" ? "N/A" : `${probabilityPct}%`,
      confidence,
      onchain_briefing: fbOnchain,
      offchain_briefing: fbOffchain,
      assessment:   verdict === "INSUFFICIENT_DATA"
        ? "Neither the wallets nor the news offer a usable signal here. No reading can be made — return when the market gathers more activity."
        : `The signals lean ${verdict}. The Prophet commits to this reading at ${confidence} confidence.`,
      factors:      [fbOnchain, fbOffchain],
      prophecy:     verdict === "INSUFFICIENT_DATA"
        ? "The scrolls are blank — the Prophet cannot speak on a market with no signal."
        : `The Prophet declares: ${verdict}.`,
      risks:        ["Signal strength may shift as the market matures"],
      conclusion:   fbConclusion,
      onchainScore,
      offchainScore,
      finalScore,
      onchainStrength,
      offchainStrength,
      onchainLean,
      offchainLean,
      gateLevel:    hasOnchain ? `${voteResult.total} wallets voted` : "Vote did not proceed"
    };
  }
}

module.exports = { runLLM };
