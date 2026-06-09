/**
 * SOMIPROPHET — Sentiment / News Agent
 *
 * Primary source: GNews API (credible, real-time, 60k+ sources)
 * Fallback:       Falcon social pulse
 * Aggregation:    LLM reads the actual headlines and returns a
 *                 DECISIVE directional call — never a vague 50.
 *
 * GNews: https://gnews.io/api/v4/search  (free tier 100/day)
 *   Get a free key at https://gnews.io
 */

const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const { APPROVED_SOURCES } = require("../config/sources");

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

const GNEWS_KEY  = process.env.GNEWS_API_KEY;
const GNEWS_URL  = "https://gnews.io/api/v4/search";
const FALCON_BASE = process.env.FALCON_BASE_URL;
const FALCON_KEY  = process.env.FALCON_API_TOKEN;

/**
 * PRIMARY: fetch real news from GNews
 */
async function fetchGNews(query, isShortMarket) {
  if (!GNEWS_KEY) return [];
  try {
    const from = new Date(Date.now() - (isShortMarket ? 2 : 14) * 86400000)
      .toISOString().split("T")[0];

    const resp = await axios.get(GNEWS_URL, {
      params: {
        apikey: GNEWS_KEY,
        q:      query,
        lang:   "en",
        from,
        sortby: "relevance",
        max:    10
      },
      timeout: 10000
    });

    const articles = resp.data?.articles || [];
    return articles.map(a => ({
      title:   a.title,
      content: a.description || a.content || "",
      url:     a.url,
      source:  a.source?.name || "",
      date:    a.publishedAt
    }));
  } catch (err) {
    console.error("[SentimentFetcher] GNews error:", err.message);
    return [];
  }
}

/**
 * FALLBACK: Falcon social pulse
 */
async function fetchFalconSocialPulse(keywords, hoursBack = 48) {
  if (!FALCON_KEY) return [];
  try {
    const resp = await axios.post(
      FALCON_BASE,
      {
        agent_id: APPROVED_SOURCES.offchain.falcon.socialPulse.agent_id,
        parameters: { keywords: `{${keywords}}`, hours_back: hoursBack.toString() }
      },
      { headers: { Authorization: `Bearer ${FALCON_KEY}` }, timeout: 10000 }
    );
    const posts = resp.data?.posts || resp.data || [];
    return Array.isArray(posts) ? posts.map(p => ({
      title:   p.title || "",
      content: p.content || p.text || "",
      url:     p.url || "",
      source:  p.url ? p.url.split("/")[2] : "social"
    })) : [];
  } catch (err) {
    console.error("[SentimentFetcher] Falcon fallback error:", err.message);
    return [];
  }
}

/**
 * LLM AGGREGATION — decisive directional read.
 * Works WITH or WITHOUT articles. If no news, it reasons from
 * the question itself + base rates. It must NOT return null.
 */
async function aggregateMarket(marketName, category, articles, resolutionCriteria) {
  const digest = articles.length > 0
    ? articles.slice(0, 10).map((a, i) =>
        `${i + 1}. [${a.source}] ${a.title}. ${(a.content || "").slice(0, 180)}`
      ).join("\n")
    : "NO NEWS ARTICLES FOUND.";

  const prompt = `You are SOMIPROPHET's market analyst. Give a DECISIVE directional read on whether this prediction market resolves YES.

MARKET: ${marketName}
CATEGORY: ${category}
RESOLUTION CRITERIA: ${resolutionCriteria || "(not provided)"}

NEWS (${articles.length} articles):
${digest}

INSTRUCTIONS:
- You MUST give a probability 0-100 (chance of YES). Never return null.
- If there are news articles, base your read on them.
- If there are NO articles, reason from: the nature of the question, historical base rates for this kind of event, and known facts. Most "will a specific thing happen by date X" markets resolve NO unless there is positive evidence.
- Be decisive. Only use 45-55 if it is genuinely a coin flip.

Respond ONLY with JSON (no markdown):
{
  "yes_probability": <integer 0-100>,
  "direction": "YES" or "NO",
  "summary": "2 sentences: what the evidence (or base rate) says and why",
  "key_signal": "the single most important factor",
  "basis": "news" or "reasoning"
}`;

  try {
    const response = await client.messages.create({
      model:      process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 400,
      messages:   [{ role: "user", content: prompt }]
    });
    const clean = response.content[0].text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
  } catch (err) {
    console.error("[SentimentFetcher] LLM aggregation error:", err.message);
    return null;
  }
}

/**
 * Main entry — always returns a decisive directional call
 */
async function fetchSentiment({ marketName, category, isShortMarket, resolutionCriteria }) {
  const hoursBack = isShortMarket ? 12 : 48;
  const query     = marketName.replace(/[?"']/g, "").split(/\s+/).slice(0, 6).join(" ");

  // 1. Try GNews first (credible news)
  let articles = await fetchGNews(query, isShortMarket);
  let sourceUsed = articles.length > 0 ? "GNews" : null;

  // 2. Fallback to Falcon social pulse
  if (articles.length === 0) {
    articles = await fetchFalconSocialPulse(`${marketName},${category}`, hoursBack);
    if (articles.length > 0) sourceUsed = "Falcon";
  }

  // 3. LLM aggregates into a decisive call (works even with 0 articles)
  const llm = await aggregateMarket(marketName, category, articles, resolutionCriteria);

  let score, label, direction, summary, keySignal, basis;

  if (llm && typeof llm.yes_probability === "number") {
    score     = Math.min(Math.max(llm.yes_probability / 100, 0.02), 0.98);
    direction = llm.direction || (score >= 0.5 ? "YES" : "NO");
    summary   = llm.summary || "";
    keySignal = llm.key_signal || null;
    basis     = llm.basis || (articles.length > 0 ? "news" : "reasoning");
    label     = score >= 0.65 ? `LEANS YES (${Math.round(score*100)}%)`
              : score <= 0.35 ? `LEANS NO (${Math.round((1-score)*100)}%)`
              : score >= 0.5  ? `SLIGHT YES (${Math.round(score*100)}%)`
              :                 `SLIGHT NO (${Math.round((1-score)*100)}%)`;
  } else {
    // Last-resort base rate — still decisive, not 50
    score     = 0.40;
    direction = "NO";
    label     = "LEANS NO (base rate)";
    summary   = "No news available and analysis inconclusive; most speculative markets resolve NO absent positive evidence.";
    keySignal = "base rate";
    basis     = "base-rate";
  }

  return {
    score,
    label,
    direction,
    summary,
    keySignal,
    basis,
    sourceUsed: sourceUsed || "none",
    postsAnalysed: articles.length,
    hoursBack,
    isShortMarket
  };
}

module.exports = { fetchSentiment };
