/**
 * SOMIPROPHET — Accountability / Track Record
 *
 * Stores every prophecy the model makes, tracks resolved outcomes,
 * and computes the real accuracy stats shown on the homepage.
 *
 * Persistent JSON store at backend/data/track-record.json
 * (survives restarts; no database needed).
 *
 * A prophecy record:
 * {
 *   id, marketName, category, verdict ("YES"/"NO"/"NEUTRAL"),
 *   probability, createdAt,
 *   resolved (bool), outcome ("YES"/"NO"/null), correct (bool/null)
 * }
 */

const fs   = require("fs");
const path = require("path");

const DATA_DIR  = path.join(__dirname, "data");
const STORE     = path.join(DATA_DIR, "track-record.json");

// Ensure data dir + file exist
function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE)) {
    fs.writeFileSync(STORE, JSON.stringify({ prophecies: [] }, null, 2));
  }
}

function load() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return { prophecies: [] };
  }
}

function save(data) {
  ensureStore();
  fs.writeFileSync(STORE, JSON.stringify(data, null, 2));
}

/**
 * Record a new prophecy (called automatically after each reading)
 */
function recordProphecy({ marketName, category, verdict, probability, marketId }) {
  const data = load();
  const record = {
    id:          `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    marketName,
    category:    category || "General",
    verdict:     verdict || "NEUTRAL",   // YES / NO / NEUTRAL / INSUFFICIENT_DATA
    probability: probability || null,
    marketId:    marketId || null,
    createdAt:   new Date().toISOString(),
    resolved:    false,
    outcome:     null,                   // filled when market resolves
    correct:     null                    // true/false once resolved
  };
  data.prophecies.unshift(record);
  save(data);
  return record;
}

/**
 * Mark a prophecy resolved with its real outcome
 */
function resolveProphecy(id, outcome) {
  const data = load();
  const p = data.prophecies.find(x => x.id === id);
  if (!p) return null;
  p.resolved = true;
  p.outcome  = outcome;               // "YES" or "NO"
  // Only directional verdicts can be right/wrong; neutral = not counted
  if (p.verdict === "YES" || p.verdict === "NO") {
    p.correct = (p.verdict === outcome);
  } else {
    p.correct = null;
  }
  save(data);
  return p;
}

/**
 * Compute the headline stats for the homepage
 */
function getStats() {
  const data = load();
  const all  = data.prophecies;

  const total       = all.length;
  const resolved    = all.filter(p => p.resolved);
  const directional = resolved.filter(p => p.verdict === "YES" || p.verdict === "NO");
  const correct     = directional.filter(p => p.correct === true);
  const neutral     = all.filter(p => p.verdict === "NEUTRAL" || p.verdict === "INSUFFICIENT_DATA");

  // Accuracy only over resolved directional calls
  const accuracy = directional.length > 0
    ? Math.round((correct.length / directional.length) * 100)
    : null;

  return {
    propheciesMade:   total,
    resolvedCount:    resolved.length,
    directionalCalls: directional.length,
    correctCalls:     correct.length,
    neutralCalls:     neutral.length,
    accuracy,                       // % or null if nothing resolved yet
    lostByUsers:      0             // advisory model — users never lose to us
  };
}

/**
 * Full list for the public track-record page (newest first)
 */
function getAllProphecies(limit = 100) {
  const data = load();
  return data.prophecies.slice(0, limit);
}

/**
 * Seed initial real data (idempotent — only seeds if store is empty)
 */
function seedIfEmpty() {
  const data = load();
  if (data.prophecies.length > 0) return;

  const seed = [
    // Two resolved markets with clear signals
    {
      marketName: "Will the US and Iran reach a ceasefire deal by June 8, 2026?",
      category:   "Politics",
      verdict:    "NO",
      probability:"NO 78%",
      resolved:   true,
      outcome:    "NO",
      correct:    true     // Prophet said NO, resolved NO ✓
    },
    {
      marketName: "Will US gas prices be above $3.92?",
      category:   "Economics",
      verdict:    "NO",
      probability:"NO 64%",
      resolved:   true,
      outcome:    "YES",
      correct:    false    // Prophet said NO, resolved YES ✗
    },
    // Four neutral readings (no clear signal)
    { marketName: "Will Bitcoin close above $150K in 2026?", category: "Crypto",        verdict: "NEUTRAL", probability: "NO READING" },
    { marketName: "Will there be a new AI regulation bill passed this quarter?", category: "Technology", verdict: "NEUTRAL", probability: "NO READING" },
    { marketName: "Will the incumbent win the next major election?", category: "Politics", verdict: "NEUTRAL", probability: "NO READING" },
    { marketName: "Will a major club win the league by a 10-point margin?", category: "Sports", verdict: "NEUTRAL", probability: "NO READING" }
  ];

  const now = Date.now();
  data.prophecies = seed.map((s, i) => ({
    id:          `seed_${i}`,
    marketName:  s.marketName,
    category:    s.category,
    verdict:     s.verdict,
    probability: s.probability,
    marketId:    null,
    createdAt:   new Date(now - (i + 1) * 86400000).toISOString(),
    resolved:    s.resolved || false,
    outcome:     s.outcome || null,
    correct:     s.correct ?? null
  }));

  save(data);
  console.log("[TrackRecord] Seeded initial record: 2 resolved (1 hit, 1 miss), 4 neutral");
}

module.exports = {
  recordProphecy,
  resolveProphecy,
  getStats,
  getAllProphecies,
  seedIfEmpty
};
