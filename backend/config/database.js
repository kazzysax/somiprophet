/**
 * SOMIPROPHET — Database Client
 * Supabase PostgreSQL connection
 * Used by memory matcher and prophecy logger
 */

const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false
});

/**
 * Check memory matcher for cached market match
 */
async function findCachedMatch(criteriaHash) {
  try {
    const result = await pool.query(
      'SELECT * FROM find_cached_match($1)',
      [criteriaHash]
    );
    if (result.rows.length > 0) {
      // Update usage count
      await pool.query(
        'UPDATE market_matches SET times_used = times_used + 1, last_used_at = NOW() WHERE ps_criteria_hash = $1',
        [criteriaHash]
      );
      return result.rows[0];
    }
    return null;
  } catch (err) {
    console.error('[DB] findCachedMatch error:', err.message);
    return null;
  }
}

/**
 * Write a confirmed market match to memory
 */
async function writeMarketMatch(data) {
  try {
    await pool.query(`
      INSERT INTO market_matches (
        ps_market_name, ps_criteria_raw, ps_criteria_hash,
        ps_category, ps_resolution_date, ps_market_url,
        ps_entity, ps_event, ps_metric, ps_operator,
        ps_threshold, ps_location, ps_type,
        ps_resolution_source, ps_resolves_yes_if,
        pm_market_id, pm_market_slug, pm_market_name, pm_criteria_raw,
        match_confidence, match_method, llm_verdict,
        llm_explanation, structured_score, simulation_passed,
        user_confirmed
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
        $11,$12,$13,$14,$15,$16,$17,$18,
        $19,$20,$21,$22,$23,$24,$25,$26
      )
      ON CONFLICT DO NOTHING
    `, [
      data.ps_market_name,    data.ps_criteria_raw,
      data.ps_criteria_hash,  data.ps_category,
      data.ps_resolution_date, data.ps_market_url,
      data.ps_entity,         data.ps_event,
      data.ps_metric,         data.ps_operator,
      data.ps_threshold,      data.ps_location,
      data.ps_type,           data.ps_resolution_source,
      data.ps_resolves_yes_if, data.pm_market_id,
      data.pm_market_slug || null,
      data.pm_market_name,    data.pm_criteria_raw,
      data.match_confidence,  data.match_method || 'llm',
      data.llm_verdict,       data.llm_explanation,
      data.structured_score,  data.simulation_passed || false,
      data.user_confirmed     || false
    ]);
  } catch (err) {
    console.error('[DB] writeMarketMatch error:', err.message);
  }
}

/**
 * Log a prophecy request
 */
async function logProphecyRequest(data) {
  try {
    await pool.query(`
      INSERT INTO prophecy_requests (
        request_id, wallet_address, tier,
        market_name, market_url, resolution_criteria,
        category, resolution_date, status
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'running')
      ON CONFLICT (request_id) DO NOTHING
    `, [
      data.requestId,   data.walletAddress || null,
      data.tier,        data.marketName,
      data.marketUrl,   data.resolutionCriteria,
      data.category,    data.resolutionDate
    ]);
  } catch (err) {
    console.error('[DB] logProphecyRequest error:', err.message);
  }
}

/**
 * Update prophecy with final result
 */
async function updateProphecyResult(requestId, result) {
  try {
    await pool.query(`
      UPDATE prophecy_requests SET
        pm_market_id      = $2,
        match_confidence  = $3,
        wallets_admitted  = $4,
        threshold_used    = $5,
        gate_label        = $6,
        yes_votes         = $7,
        no_votes          = $8,
        verdict           = $9,
        probability       = $10,
        confidence_level  = $11,
        onchain_score     = $12,
        offchain_score    = $13,
        final_score       = $14,
        sentiment         = $15,
        status            = 'complete'
      WHERE request_id = $1
    `, [
      requestId,
      result.marketId,        result.matchConfidence,
      result.walletsAdmitted, result.thresholdUsed,
      result.gateLabel,       result.yesVotes,
      result.noVotes,         result.verdict,
      result.probability,     result.confidence,
      result.onchainScore,    result.offchainScore,
      result.finalScore,      result.sentiment
    ]);
  } catch (err) {
    console.error('[DB] updateProphecyResult error:', err.message);
  }
}

module.exports = {
  pool,
  findCachedMatch,
  writeMarketMatch,
  logProphecyRequest,
  updateProphecyResult
};
