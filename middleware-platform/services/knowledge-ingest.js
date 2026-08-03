'use strict';

/**
 * knowledge-ingest — pulls FDA recalls and ClinicalTrials terminations,
 * resolves each sponsor to a watchlist ticker, and persists resolved events
 * into kg_event.
 *
 * Returns { ok: true, data: { inserted, unresolved } } | { ok: false, error }.
 * Never throws.
 */

const { getDb }            = require('../database');
const { getRecentRecalls, getTrialStatusChanges } = require('./fda-client');
const { resolveCompanyName }                      = require('./entity-resolver');

// -- Typed error ---------------------------------------------------------------

class KnowledgeIngestError extends Error {
  constructor(code, message) {
    super(message);
    this.name       = 'KnowledgeIngestError';
    this.code       = code;
    this.httpStatus = null;
  }
}

const err = (code, msg) => ({ ok: false, error: new KnowledgeIngestError(code, msg) });

// -- DB helpers ----------------------------------------------------------------

function prepareInsert(db) {
  return db.prepare(`
    INSERT OR IGNORE INTO kg_event
      (ticker, kind, headline, detail, source, published_at, raw_company, captured_at)
    VALUES
      (@ticker, @kind, @headline, @detail, @source, @published_at, @raw_company, datetime('now'))
  `);
}

// -- Recall ingestion ----------------------------------------------------------

async function _ingestRecalls(sinceDays, stmt) {
  const result = await getRecentRecalls(sinceDays);
  if (!result.ok) return result; // propagate FdaClientError

  let inserted   = 0;
  let unresolved = 0;

  for (const item of result.data) {
    if (!item.raw_company) { unresolved++; continue; }

    const resolved = await resolveCompanyName(item.raw_company);
    if (!resolved.ok) { unresolved++; continue; }

    const info = stmt.run({
      ticker:       resolved.data.ticker,
      kind:         'recall',
      headline:     item.product_description || null,
      detail:       item.reason              || null,
      source:       item.source,
      published_at: item.published_at        || null,
      raw_company:  item.raw_company,
    });
    // changes === 0 means the unique index fired (duplicate) — still counts as
    // "already known", not an error, but we don't double-count as inserted.
    if (info.changes > 0) inserted++;
  }

  return { ok: true, data: { inserted, unresolved } };
}

// -- Rate-limit helper ---------------------------------------------------------

/** Resolves after `ms` milliseconds. */
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Calls `fn` for each item in `items`, at most `ratePerSec` calls per second.
 * Returns an array of results in the same order as `items`.
 *
 * Implementation: bucket-based — after every `ratePerSec` calls we wait until
 * the 1-second window has elapsed before starting the next bucket.
 */
async function _rateLimit(items, ratePerSec, fn) {
  const results = [];
  const intervalMs = 1000 / ratePerSec;

  for (let i = 0; i < items.length; i++) {
    const start = Date.now();
    results.push(await fn(items[i]));
    const elapsed = Date.now() - start;
    // Pace to `ratePerSec` calls/s: sleep the remainder of the slot if the
    // call returned faster than the allowed interval.
    if (elapsed < intervalMs) {
      await _sleep(intervalMs - elapsed);
    }
  }

  return results;
}

// -- Trial ingestion -----------------------------------------------------------

const TRIAL_RATE_PER_SEC = 2;

/**
 * getTrialStatusChanges requires a sponsor name, so we fan out over every
 * name in agent_watchlist, rate-limited to 2 calls/second.
 * Results are deduplicated by nct_id before insert so that sponsors whose
 * names overlap don't produce duplicate rows.
 */
async function _ingestTrials(sinceDays, stmt) {
  let watchlistNames;
  try {
    watchlistNames = getDb()
      .prepare(`SELECT name FROM agent_watchlist WHERE name IS NOT NULL`)
      .all()
      .map((r) => r.name);
  } catch (e) {
    return err('DB_ERROR', `agent_watchlist read failed: ${e.message}`);
  }

  if (watchlistNames.length === 0) {
    return { ok: true, data: { inserted: 0, unresolved: 0 } };
  }

  // Fan out — one API call per watchlist entry, rate-limited to 2/s.
  const seen     = new Set(); // dedup by nct_id
  let inserted   = 0;
  let unresolved = 0;

  const apiResults = await _rateLimit(
    watchlistNames,
    TRIAL_RATE_PER_SEC,
    (sponsorName) => getTrialStatusChanges(sponsorName, sinceDays),
  );

  for (const result of apiResults) {
    if (!result.ok) {
      // NOT_FOUND just means no matching trials — skip silently.
      if (result.error.code === 'NOT_FOUND') continue;
      return result; // propagate hard errors (FETCH_ERROR, RATE_LIMITED, etc.)
    }

    for (const item of result.data) {
      const dedupeKey = item.nct_id || `${item.raw_company}|${item.published_at}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      if (!item.raw_company) { unresolved++; continue; }

      const resolved = await resolveCompanyName(item.raw_company);
      if (!resolved.ok) { unresolved++; continue; }

      const info = stmt.run({
        ticker:       resolved.data.ticker,
        kind:         'trial_termination',
        headline:     item.title        || null,
        detail:       item.status       || null,
        source:       item.source,
        published_at: item.published_at || null,
        raw_company:  item.raw_company,
      });
      if (info.changes > 0) inserted++;
    }
  }

  return { ok: true, data: { inserted, unresolved } };
}

// -- Public API ----------------------------------------------------------------

/**
 * Ingest FDA recall and ClinicalTrials termination events for the given
 * look-back window, resolve sponsors to tickers, and persist to kg_event.
 *
 * @param {number} [sinceDays=30]
 * @returns {{ ok: true, data: { inserted: number, unresolved: number } }
 *          | { ok: false, error: KnowledgeIngestError }}
 */
async function ingestFdaEvents(sinceDays = 30) {
  const days = Math.max(1, Math.floor(Number(sinceDays) || 30));

  let stmt;
  try {
    stmt = prepareInsert(getDb());
  } catch (e) {
    return err('DB_ERROR', `Failed to prepare insert statement: ${e.message}`);
  }

  const [recallResult, trialResult] = await Promise.all([
    _ingestRecalls(days, stmt),
    _ingestTrials(days, stmt),
  ]);

  if (!recallResult.ok) return recallResult;
  if (!trialResult.ok)  return trialResult;

  return {
    ok:   true,
    data: {
      inserted:   recallResult.data.inserted   + trialResult.data.inserted,
      unresolved: recallResult.data.unresolved + trialResult.data.unresolved,
    },
  };
}

module.exports = { ingestFdaEvents, KnowledgeIngestError };
