/**
 * SOMIPROPHET — Market Matcher (v3, logical)
 * ============================================
 * Design philosophy:
 *   Retrieval is WIDE and dumb. Judgment is NARROW and smart.
 *
 * Four stages:
 *   1. UNDERSTAND  — one LLM call turns the user's market into a
 *                    structured "claim": subject(s), the event, the
 *                    exact measurable condition, the resolution date,
 *                    and a ranked list of search queries.
 *   2. RETRIEVE    — fire those queries across 3 Polymarket endpoints,
 *                    collect a wide, de-duplicated candidate pool.
 *   3. SHORTLIST   — cheap, deterministic pre-rank by lexical + entity
 *                    overlap to cut the pool to the best ~8. No verdicts
 *                    here, just "which are worth a careful look."
 *   4. JUDGE       — ONE LLM call ranks the shortlist and returns the
 *                    single best match with an explicit verdict and a
 *                    calibrated confidence. The verdict is authoritative;
 *                    confidence can never be read backwards.
 *
 * Output contract (used by orchestrator):
 *   { success, confidence, marketId, marketSlug, polymarketName,
 *     llmVerdict, llmExplanation, message, scoredCandidates,
 *     searchPlan, totalCandidates, rawSearchLog }
 */

const axios     = require("axios");
const Anthropic  = require("@anthropic-ai/sdk").default;
const { APPROVED_SOURCES } = require("../config/sources");

const client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const MODEL  = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";
const GAMMA  = APPROVED_SOURCES.onchain.polymarket.gamma;

const ACCEPT_THRESHOLD = 0.62;

const STOP = new Set(["will","the","new","by","or","and","be","a","an","on","of","is","for",
  "to","than","that","this","with","at","in","it","as","are","was","reach","above","below","before","after"]);

// ──────────────────────────────────────────────────────────
//  MEMORY  (Supabase-backed, RAM fallback)
// ──────────────────────────────────────────────────────────
const memoryCache = new Map();
let db = null;
try { if (process.env.DATABASE_URL) db = require("../config/database"); }
catch (e) { console.error("[Matcher] DB load failed, RAM only:", e.message); }

function hashCriteria(s) {
  return Buffer.from((s || "").toLowerCase().replace(/\s+/g, " ").trim()).toString("base64").slice(0, 60);
}
async function checkMemory(hash) {
  if (memoryCache.has(hash)) return memoryCache.get(hash);
  if (db) {
    try {
      const row = await db.findCachedMatch(hash);
      if (row) return { success: true, confidence: row.match_confidence, marketId: row.pm_market_id,
                        marketSlug: row.pm_market_slug || null,
                        polymarketName: row.pm_market_name, fromMemory: true };
    } catch { /* ignore */ }
  }
  return null;
}
async function writeMemory(hash, result) {
  memoryCache.set(hash, { ...result, cachedAt: Date.now() });
  if (db) {
    try {
      await db.writeMarketMatch({
        ps_criteria_hash: hash, ps_market_name: result.polymarketName || "",
        ps_criteria_raw: result._criteriaRaw || "", pm_market_id: result.marketId,
        pm_market_slug: result.marketSlug || null,
        pm_market_name: result.polymarketName, match_confidence: result.confidence,
        match_method: "llm-v3", llm_verdict: result.llmVerdict,
        llm_explanation: result.llmExplanation, user_confirmed: false
      });
    } catch { /* RAM holds it */ }
  }
}

// ──────────────────────────────────────────────────────────
//  STAGE 1 — UNDERSTAND
// ──────────────────────────────────────────────────────────
async function understand(marketName, resolutionCriteria, category, resolutionDate) {
  const prompt = `You convert a prediction market into a structured claim and a Polymarket search plan.

USER MARKET
  Title:    "${marketName}"
  Criteria: "${resolutionCriteria || "(none provided)"}"
  Category: "${category || "(none)"}"
  Date:     "${resolutionDate || "(none)"}"

Return STRICT JSON, no prose, no markdown:
{
  "subjects": [],          // concrete named entities the market is ABOUT (teams, people, countries, assets, tickers). For an A-vs-B event, list BOTH.
  "subjectAliases": {},    // for EACH subject, an array of common aliases/abbreviations/full names (e.g. {"Man City": ["Manchester City", "MCFC"], "US": ["USA", "United States", "America"]}). Empty arrays are fine.
  "event": "",             // umbrella event if any (e.g. "2026 World Cup", "US Presidential Election", "Bitcoin price")
  "claimType": "",         // one of: MATCH_RESULT | EXACT_SCORE | THRESHOLD | YES_NO_EVENT | ELECTION | RANGE | OTHER
  "measurable": "",        // the exact condition that decides YES, in one plain sentence
  "direction": "",         // what makes it resolve YES, <=10 words
  "date": null,            // ISO yyyy-mm-dd if a specific date is implied, else null
  "searchQueries": []      // 4-6 SHORT queries (1-4 words) best-first. Include each subject alone, the subject pair, and the event. Use common aliases (US/USA, BTC/Bitcoin).
}`;
  try {
    const r = await client.messages.create({ model: MODEL, max_tokens: 500,
      messages: [{ role: "user", content: prompt }] });
    const plan = JSON.parse(r.content[0].text.replace(/```json|```/g, "").trim());
    plan.subjects = (plan.subjects || []).filter(Boolean);
    plan.subjectAliases = plan.subjectAliases || {};
    plan.searchQueries = (plan.searchQueries || []).filter(Boolean);
    if (plan.searchQueries.length === 0) plan.searchQueries = fallbackQueries(marketName);
    return plan;
  } catch (e) {
    console.error("[Matcher] understand() error:", e.message);
    return { subjects: [], event: "", claimType: "OTHER", measurable: marketName,
             direction: "", date: resolutionDate || null, searchQueries: fallbackQueries(marketName) };
  }
}
function fallbackQueries(marketName) {
  const words = marketName.replace(/[?"'.]/g, "").split(/\s+/)
    .filter(w => w.length > 3 && !STOP.has(w.toLowerCase()));
  return [words.slice(0, 4).join(" "), ...words.slice(0, 3)].filter(Boolean);
}

// ──────────────────────────────────────────────────────────
//  STAGE 2 — RETRIEVE
// ──────────────────────────────────────────────────────────
function normMarket(m, evTitle, source) {
  const id = m.conditionId || m.condition_id || m.id;
  if (!id) return null;
  return {
    id,
    slug: m.slug || m.market_slug || null,
    question: m.question || m.title || evTitle || "",
    description: m.description || "",
    closed: m.closed === true || m.active === false,
    volume: Number(m.volume || m.volumeNum || 0),
    endDate: m.endDate || m.end_date_iso || null,
    _source: source
  };
}
async function retrieve(queries) {
  const pool = new Map();
  const log = [];
  const add = (m) => { if (m && !pool.has(m.id)) pool.set(m.id, m); };

  // Fire ALL queries across ALL endpoints in PARALLEL (was 18 sequential calls)
  const jobs = [];
  for (const q of queries.slice(0, 6)) {
    jobs.push(
      axios.get(`${GAMMA}/public-search`, { params: { q, limit_per_type: 20 }, timeout: 10000 })
        .then(({ data }) => {
          (data.markets || []).forEach(m => add(normMarket(m, null, "search")));
          (data.events || []).forEach(ev => (ev.markets || [])
            .forEach(m => add(normMarket(m, ev.title, "search-event"))));
          log.push({ ep: "public-search", q, markets: (data.markets||[]).length, events: (data.events||[]).length });
        })
        .catch(e => log.push({ ep: "public-search", q, error: e.message })),

      axios.get(`${GAMMA}/events`, { params: { _q: q, limit: 12, order: "volume24hr", ascending: false }, timeout: 10000 })
        .then(({ data }) => {
          const evs = data.data || data || [];
          (Array.isArray(evs) ? evs : []).forEach(ev => (ev.markets || [])
            .forEach(m => add(normMarket(m, ev.title, "events"))));
          log.push({ ep: "events", q, events: Array.isArray(evs) ? evs.length : 0 });
        })
        .catch(e => log.push({ ep: "events", q, error: e.message })),

      axios.get(`${GAMMA}/markets`, { params: { _q: q, limit: 20, order: "volume24hr", ascending: false }, timeout: 10000 })
        .then(({ data }) => {
          const ms = data.data || data || [];
          (Array.isArray(ms) ? ms : []).forEach(m => add(normMarket(m, null, "markets")));
          log.push({ ep: "markets", q, markets: Array.isArray(ms) ? ms.length : 0 });
        })
        .catch(e => log.push({ ep: "markets", q, error: e.message }))
    );
  }
  await Promise.allSettled(jobs);
  return { candidates: [...pool.values()], log };
}

// ──────────────────────────────────────────────────────────
//  STAGE 3 — SHORTLIST
// ──────────────────────────────────────────────────────────
function tokenize(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9$ ]/g, " ")
    .split(/\s+/).filter(w => w.length > 2 && !STOP.has(w));
}
/** A subject is "present" if the subject itself OR any of its aliases appears. */
function subjectsPresent(plan, text) {
  const t = (text || "").toLowerCase();
  const aliases = plan.subjectAliases || {};
  return (plan.subjects || []).filter(s => {
    const names = [s, ...(aliases[s] || [])].map(x => String(x).toLowerCase()).filter(Boolean);
    return names.some(n => t.includes(n));
  });
}
/** Date proximity score: dated events should match markets ending near that date. */
function dateScore(plan, candidate) {
  if (!plan.date || !candidate.endDate) return 0;
  const d1 = new Date(plan.date).getTime();
  const d2 = new Date(candidate.endDate).getTime();
  if (isNaN(d1) || isNaN(d2)) return 0;
  const days = Math.abs(d1 - d2) / 86400000;
  if (days <= 3)  return 20;    // same fixture window
  if (days <= 14) return 8;
  if (days <= 45) return 0;
  return -15;                   // wrong edition / different event
}
function preRank(plan, candidates) {
  const subjects = (plan.subjects || []).map(s => s.toLowerCase());
  const userTokens = new Set([
    ...tokenize(plan.measurable), ...tokenize(plan.event),
    ...subjects.flatMap(s => tokenize(s))
  ]);

  return candidates.map(c => {
    const text = `${c.question} ${c.description}`;
    const cTokens = new Set(tokenize(text));

    const present = subjectsPresent(plan, text);
    let entityScore;
    if (subjects.length >= 2)      entityScore = present.length >= 2 ? 60 : present.length === 1 ? 12 : -20;
    else if (subjects.length === 1) entityScore = present.length === 1 ? 35 : -10;
    else                            entityScore = 0;

    let overlap = 0;
    userTokens.forEach(t => { if (cTokens.has(t)) overlap++; });
    const lexScore = userTokens.size ? (overlap / userTokens.size) * 30 : 0;
    const volNudge = c.volume > 0 ? Math.min(Math.log10(c.volume + 1), 6) : 0;
    const dScore   = dateScore(plan, c);

    return { ...c, _pre: entityScore + lexScore + volNudge + dScore,
             _entityPresent: present.length, _entityTotal: subjects.length };
  }).sort((a, b) => b._pre - a._pre);
}

// ──────────────────────────────────────────────────────────
//  STAGE 4 — JUDGE
// ──────────────────────────────────────────────────────────
async function judge(plan, marketName, resolutionCriteria, shortlist) {
  const listText = shortlist.map((c, i) =>
    `[${i}] "${c.question}"${c.endDate ? ` (ends ${String(c.endDate).slice(0,10)})` : ""}${c.volume ? ` ($${Math.round(c.volume).toLocaleString()} vol)` : ""}${c.description ? ` — ${c.description.slice(0, 140)}` : ""}`
  ).join("\n");

  const prompt = `You decide which Polymarket market (if any) resolves under the SAME real-world outcome as the user's market.

USER MARKET
  Title:    "${marketName}"
  Means:    "${plan.measurable || resolutionCriteria}"
  Subjects: ${JSON.stringify(plan.subjects || [])}
  Resolves YES if: "${plan.direction || "(see criteria)"}"

CANDIDATES
${listText}

RULES (apply strictly):
- A real match resolves YES/NO on the SAME event, SAME subjects, SAME measurable condition. Wording may differ.
- Different teams/people/countries  -> NOT a match (e.g. "Norway vs Senegal" is NOT "Portugal win").
- Different measure of the same event -> at best PARTIAL (e.g. "who wins" vs "exact score").
- Different date/edition of an event  -> NOT a match.
- If nothing fits, say so honestly. A wrong match is far worse than no match.

Return STRICT JSON, no prose:
{
  "bestIndex": <integer index of best candidate, or -1 if none fit>,
  "verdict": "MATCH | PARTIAL_MATCH | NO_MATCH",
  "confidence": <0.0-1.0, confidence that bestIndex resolves on the SAME outcome>,
  "explanation": "<=20 words why"
}`;
  try {
    const r = await client.messages.create({ model: MODEL, max_tokens: 300,
      messages: [{ role: "user", content: prompt }] });
    return JSON.parse(r.content[0].text.replace(/```json|```/g, "").trim());
  } catch (e) {
    console.error("[Matcher] judge() error:", e.message);
    return { bestIndex: -1, verdict: "NO_MATCH", confidence: 0, explanation: "judge failed" };
  }
}

// ──────────────────────────────────────────────────────────
//  ORCHESTRATION
// ──────────────────────────────────────────────────────────
async function matchMarket({ marketName, marketUrl, resolutionCriteria, category, resolutionDate }) {
  const criteriaHash = hashCriteria(`${marketName}|${resolutionCriteria}`);

  const cached = await checkMemory(criteriaHash);
  if (cached) { console.log("[Matcher] memory hit"); return cached; }

  const plan = await understand(marketName, resolutionCriteria, category, resolutionDate);
  console.log(`[Matcher] subjects=[${(plan.subjects||[]).join(", ")}] type=${plan.claimType}`);
  console.log(`[Matcher] queries: ${plan.searchQueries.join(" | ")}`);

  const { candidates, log } = await retrieve(plan.searchQueries);
  console.log(`[Matcher] retrieved ${candidates.length} candidates`);
  if (candidates.length === 0) return fail("No Polymarket candidates found for this market.", plan, 0, log);

  const ranked = preRank(plan, candidates);
  const shortlist = ranked.slice(0, 8);

  const j = await judge(plan, marketName, resolutionCriteria, shortlist);

  const idx = Number.isInteger(j.bestIndex) ? j.bestIndex : -1;
  const best = idx >= 0 && idx < shortlist.length ? shortlist[idx] : null;
  const conf = typeof j.confidence === "number" ? Math.max(0, Math.min(1, j.confidence)) : 0;

  let finalConfidence, isRealMatch;
  if (!best || j.verdict === "NO_MATCH") { finalConfidence = best ? 1 - conf : 0; isRealMatch = false; }
  else if (j.verdict === "MATCH")        { finalConfidence = conf; isRealMatch = true; }
  else                                   { finalConfidence = conf * 0.6; isRealMatch = conf >= 0.85; }

  // Entity guard (alias-aware): 2 subjects but chosen market has neither -> fail
  if (best && (plan.subjects || []).length >= 2) {
    const present = subjectsPresent(plan, `${best.question} ${best.description}`).length;
    if (present === 0) { isRealMatch = false; finalConfidence = Math.min(finalConfidence, 0.3); }
  }

  const success = isRealMatch && finalConfidence >= ACCEPT_THRESHOLD;
  const scoredCandidates = shortlist.slice(0, 3).map(c => ({
    name: c.question, score: Math.round(c._pre), id: c.id, slug: c.slug, source: c._source
  }));

  if (!success) {
    return fail(
      `No confident match. Verdict: ${j.verdict}. ` +
      (best ? `Closest was "${best.question}" but it does not resolve on the same outcome.`
            : "No candidate resolved on the same outcome."),
      plan, candidates.length, log, scoredCandidates, j
    );
  }

  const result = {
    success: true, confidence: finalConfidence,
    marketId: best.id, marketSlug: best.slug, polymarketName: best.question,
    llmVerdict: j.verdict, llmExplanation: j.explanation, message: null,
    searchPlan: { subjects: plan.subjects, queries: plan.searchQueries },
    totalCandidates: candidates.length, rawSearchLog: log, scoredCandidates,
    _criteriaRaw: resolutionCriteria
  };
  if (finalConfidence >= 0.85) await writeMemory(criteriaHash, result);
  return result;
}

function fail(message, plan, total, log, scoredCandidates = [], j = null) {
  return {
    success: false,
    confidence: j ? Math.min(typeof j.confidence === "number" ? j.confidence : 0, 0.5) : 0,
    marketId: null, marketSlug: null, polymarketName: null,
    llmVerdict: j ? j.verdict : "NO_MATCH", llmExplanation: j ? j.explanation : null,
    message,
    searchPlan: { subjects: plan?.subjects || [], queries: plan?.searchQueries || [] },
    totalCandidates: total, rawSearchLog: log || [], scoredCandidates
  };
}

module.exports = { matchMarket };
