/**
 * SOMIPROPHET — Market Matcher Agent
 * Implements all 8 matching models:
 * 1. Memory check first
 * 2. Structured criteria parser
 * 3. Resolution logic normaliser
 * 4. Broad Polymarket search
 * 5. Hard rejection filters
 * 6. Weighted scoring (50/20/15/10/5)
 * 7. LLM logic comparator
 * 8. Resolution simulation
 */

const axios     = require("axios");
const Anthropic  = require("@anthropic-ai/sdk").default;
const { APPROVED_SOURCES } = require("../config/sources");

const client   = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const GAMMA    = APPROVED_SOURCES.onchain.polymarket.gamma;

/**
 * MODEL 1 — Memory check (Supabase-backed, with in-RAM fallback)
 * If DATABASE_URL is set, confirmed matches persist to Supabase
 * and are reused across restarts. Otherwise falls back to RAM.
 */
const memoryCache = new Map();
let db = null;
try {
  if (process.env.DATABASE_URL) {
    db = require("../config/database");
  }
} catch (e) {
  console.error("[MarketMatcher] DB module load failed, using RAM:", e.message);
}

async function checkMemory(criteriaHash) {
  // RAM first (fast)
  if (memoryCache.has(criteriaHash)) return memoryCache.get(criteriaHash);
  // Supabase next
  if (db) {
    try {
      const row = await db.findCachedMatch(criteriaHash);
      if (row) {
        return {
          success: true,
          confidence: row.match_confidence,
          marketId: row.pm_market_id,
          polymarketName: row.pm_market_name,
          fromMemory: true
        };
      }
    } catch (e) { /* fall through */ }
  }
  return null;
}

async function writeMemory(criteriaHash, result) {
  memoryCache.set(criteriaHash, { ...result, cachedAt: Date.now() });
  if (db) {
    try {
      await db.writeMarketMatch({
        ps_criteria_hash: criteriaHash,
        ps_market_name:   result.polymarketName || "",
        ps_criteria_raw:  result.criteriaRaw || "",
        pm_market_id:     result.marketId,
        pm_market_name:   result.polymarketName,
        match_confidence: result.confidence,
        match_method:     "llm",
        llm_verdict:      result.llmVerdict,
        llm_explanation:  result.llmExplanation,
        user_confirmed:   false
      });
    } catch (e) { /* RAM still holds it */ }
  }
}

/**
 * NEW — Extract a smart SEARCH PLAN from the user's market.
 * Pulls key entities (teams/people/countries), event type, and date
 * so we search Polymarket the way a human would: find the entities,
 * then find where they appear TOGETHER.
 */
async function extractSearchPlan(marketName, resolutionCriteria, category) {
  try {
    const resp = await client.messages.create({
      model:      process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
      max_tokens: 350,
      messages:   [{
        role: "user",
        content: `Analyse this prediction market and extract a search plan to find it on Polymarket.

Market: "${marketName}"
Criteria: "${resolutionCriteria}"
Category: "${category}"

Extract:
- entities: the key named subjects (teams, people, countries, assets). For a match between two teams, list BOTH (e.g. ["Portugal","Spain"]).
- event: the event they belong to (e.g. "World Cup", "2026 election", "Bitcoin price")
- eventType: one of MATCH_BETWEEN_TWO | SINGLE_OUTCOME | PRICE_LEVEL | ELECTION | OTHER
- date: the resolution/event date in YYYY-MM-DD if known, else null
- searchQueries: 3-5 SHORT search strings (1-4 words), best first. For a two-entity match include each entity AND the pair (e.g. ["Portugal Spain","Portugal","Spain World Cup","World Cup score"]).

Respond ONLY with JSON:
{ "entities": [], "event": "", "eventType": "", "date": null, "searchQueries": [] }`
      }]
    });
    return JSON.parse(resp.content[0].text.replace(/```json|```/g, "").trim());
  } catch (err) {
    console.error("[MarketMatcher] extractSearchPlan error:", err.message);
    return null;
  }
}

/**
 * MODEL 2+3 — Parse and normalise resolution criteria via LLM
 */
async function parseCriteria(criteria) {
  const resp = await client.messages.create({
    model:      process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 300,
    messages:   [{
      role:    "user",
      content: `Extract structured fields from this prediction market resolution criteria.
Respond ONLY with JSON, no extra text:

Criteria: "${criteria}"

{
  "entity": "the subject (e.g. BTC, Donald Trump, Arsenal FC)",
  "event": "what must happen (e.g. price exceeds, wins election, scores goal)",
  "metric": "how measured (e.g. closing price, vote count, match score)",
  "operator": "GREATER_THAN | LESS_THAN | EQUAL_TO | WINS | HAPPENS",
  "threshold": "the value or condition (e.g. 100000, majority, first place)",
  "location": "where applicable (e.g. USA, UK, Global, N/A)",
  "deadline": "resolution deadline if mentioned",
  "type": "THRESHOLD | EVENT | COMPARATIVE | TIME_BOUND | BINARY",
  "resolution_source": "who decides YES/NO (e.g. CoinGecko, AP News, FIFA, N/A)",
  "resolves_yes_if": "plain English summary of YES condition"
}`
    }]
  });
  try {
    return JSON.parse(resp.content[0].text.replace(/```json|```/g, "").trim());
  } catch {
    return null;
  }
}

/**
 * MODEL 4 — Broad Polymarket search (keyword-driven)
 * Uses the dedicated /search endpoint for full-text keyword search,
 * which searches across markets, events, and profiles.
 * Falls back to high-volume active markets if search returns nothing.
 */
async function searchPolymarket(searchTerms, resolutionDate) {
  const allResults = [];
  const seen = new Set();

  const queries = searchTerms.filter(Boolean).slice(0, 5);

  for (const query of queries) {
    try {
      // Dedicated full-text search endpoint
      const resp = await axios.get(`${GAMMA}/public-search`, {
        params: { q: query, limit_per_type: 20 }
      });

      // Search returns { events: [...], markets: [...], profiles: [...] }
      const markets = resp.data?.markets || [];
      const events  = resp.data?.events  || [];

      // Markets directly
      for (const m of markets) {
        const id = m.conditionId || m.condition_id || m.id;
        if (id && !seen.has(id)) { seen.add(id); allResults.push(m); }
      }
      // Markets nested inside events
      for (const ev of events) {
        const evMarkets = ev.markets || [];
        for (const m of evMarkets) {
          const id = m.conditionId || m.condition_id || m.id;
          if (id && !seen.has(id)) {
            seen.add(id);
            // attach event question for context
            allResults.push({ ...m, question: m.question || ev.title });
          }
        }
      }
    } catch (err) {
      console.error(`[MarketMatcher] Search "${query}" error:`, err.message);
    }
  }

  // Fallback: high-volume active markets
  if (allResults.length === 0) {
    try {
      const resp = await axios.get(`${GAMMA}/markets`, {
        params: { active: true, closed: false, limit: 100, order: "volume24hr", ascending: false }
      });
      const markets = resp.data?.data || resp.data || [];
      markets.forEach(m => {
        const id = m.conditionId || m.condition_id || m.id;
        if (id && !seen.has(id)) { seen.add(id); allResults.push(m); }
      });
    } catch (err) {
      console.error("[MarketMatcher] Fallback search error:", err.message);
    }
  }

  console.log(`[MarketMatcher] Found ${allResults.length} candidate markets`);
  return allResults;
}

/**
 * MODEL 5 — Hard rejection filters
 * Returns true ONLY for clear, unambiguous mismatches.
 * Conservative — when in doubt, let it through to the LLM judge.
 */
function hardReject(userParsed, candidateParsed) {
  if (!userParsed || !candidateParsed) return false;

  // Entity mismatch — use word overlap, not strict substring
  // "US" should match "United States", "BTC" should match "Bitcoin"
  if (userParsed.entity && candidateParsed.entity) {
    const userEntity = userParsed.entity.toLowerCase();
    const candEntity = candidateParsed.entity.toLowerCase();

    // Known aliases that should never be rejected
    const aliases = [
      ["us", "u.s.", "usa", "united states", "america", "american"],
      ["btc", "bitcoin"],
      ["eth", "ethereum"],
      ["uk", "u.k.", "united kingdom", "britain", "british"]
    ];

    let aliasMatch = false;
    for (const group of aliases) {
      const userIn = group.some(a => userEntity.includes(a));
      const candIn = group.some(a => candEntity.includes(a));
      if (userIn && candIn) { aliasMatch = true; break; }
    }

    if (!aliasMatch) {
      // Check word overlap
      const sim = stringSimilarity(userEntity, candEntity);
      const substringMatch = userEntity.includes(candEntity) ||
                             candEntity.includes(userEntity);
      // Only reject if NO overlap at all
      if (sim === 0 && !substringMatch) {
        return true;
      }
    }
  }

  // NOTE: Removed rigid type check — the LLM parser labels the same
  // event inconsistently (EVENT vs BINARY vs TIME_BOUND), causing
  // false rejections. The LLM logic comparator handles type nuance.

  return false;
}

/**
 * MODEL 6 — Weighted scoring
 * Resolution: 50% | Event: 20% | Entity: 15% | Timeframe: 10% | Title: 5%
 */
function scoreCandidate(userParsed, candidate, candidateParsed, userTitle, resolutionDate) {
  let score = 0;

  // Resolution logic similarity (50%)
  if (userParsed?.resolves_yes_if && candidateParsed?.resolves_yes_if) {
    const sim = stringSimilarity(
      userParsed.resolves_yes_if.toLowerCase(),
      candidateParsed.resolves_yes_if.toLowerCase()
    );
    score += sim * 50;
  }

  // Event match (20%)
  if (userParsed?.event && candidateParsed?.event) {
    const sim = stringSimilarity(
      userParsed.event.toLowerCase(),
      candidateParsed.event.toLowerCase()
    );
    score += sim * 20;
  }

  // Entity match (15%)
  if (userParsed?.entity && candidateParsed?.entity) {
    const sim = stringSimilarity(
      userParsed.entity.toLowerCase(),
      candidateParsed.entity.toLowerCase()
    );
    score += sim * 15;
  }

  // Timeframe (10%) — wider, more forgiving window
  // Markets often have buffer end dates weeks after the event date
  if (resolutionDate && candidate.end_date_iso) {
    const userDate = new Date(resolutionDate).getTime();
    const candDate = new Date(candidate.end_date_iso).getTime();
    const diffDays = Math.abs(userDate - candDate) / 86400000;
    if (diffDays <= 3)        score += 10;
    else if (diffDays <= 14)  score += 8;
    else if (diffDays <= 30)  score += 6;  // June 9 vs June 30 = 21 days → still scores
    else if (diffDays <= 60)  score += 3;
  } else {
    // No date to compare — give neutral partial credit, don't penalize
    score += 5;
  }

  // Title similarity (5%)
  if (userTitle && candidate.question) {
    const sim = stringSimilarity(userTitle.toLowerCase(), candidate.question.toLowerCase());
    score += sim * 5;
  }

  return Math.round(score);
}

function stringSimilarity(a, b) {
  const setA = new Set(a.split(/\s+/));
  const setB = new Set(b.split(/\s+/));
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

/**
 * MODEL 7 — LLM logic comparator (convergent logic check)
 */
async function llmCompare(userCriteria, candidateCriteria, marketName, candidateName) {
  const resp = await client.messages.create({
    model:      process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 200,
    messages:   [{
      role:    "user",
      content: `Do these two prediction markets resolve under the SAME real-world event and outcome?

Market A (user's market): "${marketName}"
Criteria A: "${userCriteria}"

Market B (Polymarket): "${candidateName}"
Criteria B: "${candidateCriteria}"

STRICT RULES — answer NO_MATCH if ANY of these differ:
- Different teams, people, countries, or entities (e.g. "Norway vs Senegal" is NOT "Portugal win" — different teams = NO_MATCH)
- Different event or match (a different game, election, or date entirely)
- Different metric (exact score vs win/lose, price level vs direction)
Only answer MATCH if they resolve YES/NO under the SAME outcome of the SAME event. Wording may differ, but the underlying event and entities must be the same.

"confidence" = how sure you are OF YOUR VERDICT (whether MATCH or NO_MATCH).

Respond ONLY with JSON:
{
  "verdict": "MATCH | PARTIAL_MATCH | NO_MATCH",
  "confidence": 0.0 to 1.0,
  "explanation": "one sentence explaining the key match/mismatch"
}`
    }]
  });
  try {
    return JSON.parse(resp.content[0].text.replace(/```json|```/g, "").trim());
  } catch {
    return { verdict: "NO_MATCH", confidence: 0, explanation: "Parse error" };
  }
}

/**
 * MODEL 8 — Resolution simulation
 * Tests 3 hypothetical scenarios to verify logical equivalence
 */
async function simulateResolution(userCriteria, candidateCriteria, userParsed) {
  const resp = await client.messages.create({
    model:      process.env.CLAUDE_MODEL || "claude-sonnet-4-6",
    max_tokens: 400,
    messages:   [{
      role:    "user",
      content: `Test these two resolution criteria against 3 hypothetical scenarios.
Both markets must resolve identically for a valid match.

Criteria A: "${userCriteria}"
Criteria B: "${candidateCriteria}"

Generate 3 relevant hypothetical scenarios and check resolution for each.
Respond ONLY with JSON:
{
  "scenarios": [
    {
      "scenario": "description of what happens",
      "A_resolves": "YES or NO",
      "B_resolves": "YES or NO",
      "agree": true or false
    }
  ],
  "allAgree": true or false,
  "simulationConfidence": 0.0 to 1.0
}`
    }]
  });
  try {
    return JSON.parse(resp.content[0].text.replace(/```json|```/g, "").trim());
  } catch {
    return { allAgree: false, simulationConfidence: 0 };
  }
}

/**
 * MAIN — Full market matching pipeline
 */
async function matchMarket({ marketName, marketUrl, resolutionCriteria, category, resolutionDate }) {
  // MODEL 1 — Memory check
  const criteriaHash = Buffer.from(resolutionCriteria).toString("base64");
  const cached = await checkMemory(criteriaHash);
  if (cached && cached.confidence >= 0.85) {
    console.log("[MarketMatcher] Memory hit!");
    return { ...cached, fromMemory: true };
  }

  // MODEL 2+3 — Parse user criteria
  const userParsed = await parseCriteria(resolutionCriteria);

  // NEW — Build an entity-aware search plan (the human strategy)
  const plan = await extractSearchPlan(marketName, resolutionCriteria, category);
  const entities = (plan?.entities || []).map(e => e.toLowerCase()).filter(Boolean);
  const planDate = plan?.date || resolutionDate;

  // Build search queries: plan queries first, then fallbacks
  const keywords = [];
  if (plan?.searchQueries?.length) keywords.push(...plan.searchQueries);
  if (userParsed?.entity) keywords.push(userParsed.entity);
  if (plan?.event)        keywords.push(plan.event);
  // entity pair as a combined query
  if (entities.length >= 2) keywords.push(entities.slice(0, 2).join(" "));
  // fallback: key nouns from the name
  const nameWords = marketName.replace(/[?"']/g, "").split(/\s+/)
    .filter(w => w.length > 3 &&
      !["will","the","new","by","or","and","be","a","an","on","of","is","for","to","than","that"].includes(w.toLowerCase()))
    .slice(0, 4);
  keywords.push(...nameWords);

  const uniqueKeywords = [...new Set(keywords.map(k => k.trim()).filter(Boolean))];
  console.log(`[MarketMatcher] Entities: ${entities.join(", ") || "none"}`);
  console.log(`[MarketMatcher] Search queries: ${uniqueKeywords.join(" | ")}`);

  // MODEL 4 — Keyword-driven broad search
  const candidates = await searchPolymarket(uniqueKeywords, planDate);
  if (candidates.length === 0) {
    return { success: false, confidence: 0, marketId: null, message: "No Polymarket candidates found" };
  }

  // MODEL 5+6 — Score candidates with ENTITY-PAIR awareness
  const scored = [];
  for (const candidate of candidates.slice(0, 30)) {
    const candidateParsed = await parseCriteria(
      candidate.description || candidate.question || ""
    );

    // MODEL 5 — Hard rejection
    if (hardReject(userParsed, candidateParsed)) continue;

    // MODEL 6 — Weighted scoring
    let score = scoreCandidate(
      userParsed, candidate, candidateParsed, marketName, planDate
    );

    // NEW — Entity co-occurrence boost/penalty.
    // The candidate's text must contain the SAME entities.
    const candText = `${candidate.question || ""} ${candidate.description || ""}`.toLowerCase();
    if (entities.length > 0) {
      const matchedEntities = entities.filter(e => candText.includes(e));
      if (entities.length >= 2) {
        // A two-entity match (e.g. Portugal vs Spain): BOTH must appear
        if (matchedEntities.length >= 2)      score += 40;   // both teams present
        else if (matchedEntities.length === 1) score -= 25;  // only one → wrong match
        else                                   score -= 40;  // neither → reject-tier
      } else {
        // Single entity must appear
        if (matchedEntities.length >= 1) score += 20;
        else                             score -= 30;
      }
    }

    scored.push({ candidate, candidateParsed, score });
  }

  // Sort and take top 3
  scored.sort((a, b) => b.score - a.score);
  const top3 = scored.slice(0, 3);

  if (top3.length === 0) {
    return { success: false, confidence: 0, marketId: null, message: "All candidates rejected" };
  }

  // MODEL 7 — LLM logic comparison on best candidate
  const best = top3[0];
  const llmResult = await llmCompare(
    resolutionCriteria,
    best.candidate.description || best.candidate.question || "",
    marketName,
    best.candidate.question || ""
  );

  // The LLM verdict is AUTHORITATIVE. Its confidence is confidence
  // IN THAT VERDICT — so a NO_MATCH at 0.84 means "84% sure it does
  // NOT match", which must FAIL, not pass.
  let finalConfidence;
  let isRealMatch;

  if (llmResult.verdict === "MATCH") {
    finalConfidence = llmResult.confidence;        // confident it matches
    isRealMatch = true;
  } else if (llmResult.verdict === "PARTIAL_MATCH") {
    finalConfidence = llmResult.confidence * 0.6;  // weak partial
    isRealMatch = llmResult.confidence >= 0.8;     // only if strongly partial
  } else {
    // NO_MATCH — invert: high LLM confidence = very NOT a match
    finalConfidence = 1 - llmResult.confidence;
    isRealMatch = false;
  }

  // MODEL 8 — Resolution simulation only when LLM actually says MATCH
  if (isRealMatch && finalConfidence >= 0.70) {
    const simulation = await simulateResolution(
      resolutionCriteria,
      best.candidate.description || best.candidate.question || "",
      userParsed
    );
    if (simulation.allAgree) {
      finalConfidence = Math.min(finalConfidence + 0.05, 1.0);
    } else {
      // Simulation disagreed — this is NOT a safe match
      finalConfidence = Math.max(finalConfidence - 0.30, 0);
      isRealMatch = false;
    }
  }

  // SUCCESS requires BOTH: the LLM said it's a real match AND score is high
  const success = isRealMatch && finalConfidence >= 0.65;

  const result = {
    success,
    confidence:      success ? finalConfidence : Math.min(finalConfidence, 0.5),
    marketId:        success ? (best.candidate.conditionId || best.candidate.condition_id || best.candidate.id) : null,
    marketSlug:      success ? (best.candidate.slug || best.candidate.market_slug || null) : null,
    polymarketName:  best.candidate.question,
    llmVerdict:      llmResult.verdict,
    llmExplanation:  llmResult.explanation,
    message:         success ? null : `No logical match — LLM verdict: ${llmResult.verdict}. Best candidate "${best.candidate.question}" does not resolve under the same outcome.`,
    scoredCandidates: top3.map(t => ({
      name:  t.candidate.question,
      score: t.score,
      id:    t.candidate.conditionId || t.candidate.condition_id || t.candidate.id
    }))
  };

  // Write to memory only on a genuine confident match
  if (success && finalConfidence >= 0.85) {
    await writeMemory(criteriaHash, result);
  }

  return result;
}

module.exports = { matchMarket };
