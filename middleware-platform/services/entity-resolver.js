'use strict';

/**
 * entity-resolver — maps FDA / ClinicalTrials sponsor names to watchlist tickers.
 *
 * Every exported function returns { ok: true, data } | { ok: false, error: EntityResolverError }.
 * They never throw. Branch on result.ok; inspect error.code for:
 *   NOT_FOUND | DB_ERROR
 *
 * Matching strategy
 *   1. Normalise both sides: lowercase, strip legal noise words, collapse
 *      whitespace and punctuation.
 *   2. Exact match  → confidence "exact"
 *   3. Partial match → one normalised form is a substring of the other AND the
 *      shorter covers ≥ 80 % of the longer's tokens → confidence "partial"
 *   4. Anything below that threshold → NOT_FOUND (never guess).
 */

const { getDb } = require('../database');

// -- Typed error ---------------------------------------------------------------

class EntityResolverError extends Error {
  constructor(code, message) {
    super(message);
    this.name  = 'EntityResolverError';
    this.code  = code;
    this.httpStatus = null; // kept for contract parity with MarketDataError
  }
}

const err = (code, msg) => ({ ok: false, error: new EntityResolverError(code, msg) });

// -- Normalisation -------------------------------------------------------------

/**
 * Legal / filler words that carry no identity signal.
 * Applied as whole-word replacements after lowercasing.
 */
const STRIP_WORDS = new Set([
  'incorporated', 'inc', 'corporation', 'corp', 'limited', 'ltd',
  'plc', 'company', 'co', 'holdings', 'holding', 'group',
  'usa', 'us', 'llc', 'llp', 'lp', 'ag', 'sa', 'nv', 'bv', 'gmbh',
  'and', 'the', 'of',
]);

function normalise(raw) {
  return raw
    .toLowerCase()
    // replace punctuation (commas, dots, hyphens, slashes, parens) with spaces
    .replace(/[^a-z0-9\s]/g, ' ')
    // split on whitespace, drop noise words, rejoin
    .split(/\s+/)
    .filter((w) => w.length > 0 && !STRIP_WORDS.has(w))
    .join(' ')
    .trim();
}

// -- Partial-match threshold ---------------------------------------------------

const PARTIAL_THRESHOLD = 0.8; // shorter must cover ≥ 80 % of longer's tokens

function isPartialMatch(a, b) {
  const tokA = a.split(' ');
  const tokB = b.split(' ');
  const [shorter, longer] = tokA.length <= tokB.length ? [tokA, tokB] : [tokB, tokA];

  if (longer.length === 0) return false;

  // Count how many tokens from the shorter sequence appear in the longer one
  const longerSet = new Set(longer);
  const overlap   = shorter.filter((t) => longerSet.has(t)).length;

  return overlap / longer.length >= PARTIAL_THRESHOLD;
}

// -- Main export ---------------------------------------------------------------

/**
 * Resolve a raw sponsor / company name (as published by FDA or ClinicalTrials)
 * to a ticker in agent_watchlist.
 *
 * @param {string} rawName  e.g. "Eli Lilly and Company" or "Chiesi USA, Inc."
 * @returns {{ ok: true, data: { ticker: string, name: string, confidence: 'exact'|'partial' } }
 *          | { ok: false, error: EntityResolverError }}
 */
async function resolveCompanyName(rawName) {
  if (!rawName || typeof rawName !== 'string' || !rawName.trim()) {
    return err('NOT_FOUND', 'rawName must be a non-empty string');
  }

  const needle = normalise(rawName);
  if (!needle) {
    return err('NOT_FOUND', `"${rawName}" normalises to an empty string`);
  }

  let rows;
  try {
    rows = getDb()
      .prepare(`SELECT ticker, name FROM agent_watchlist WHERE name IS NOT NULL`)
      .all();
  } catch (e) {
    return err('DB_ERROR', `agent_watchlist query failed: ${e.message}`);
  }

  // Two-pass: collect exact matches first, then partial.
  let exactHit   = null;
  let partialHit = null;

  for (const row of rows) {
    const haystack = normalise(row.name);
    if (!haystack) continue;

    if (haystack === needle) {
      exactHit = row;
      break; // exact match wins immediately
    }

    if (!partialHit && isPartialMatch(needle, haystack)) {
      partialHit = row;
    }
  }

  const hit = exactHit || partialHit;
  if (!hit) {
    return err('NOT_FOUND', `No watchlist entry matched "${rawName}"`);
  }

  return {
    ok:   true,
    data: {
      ticker:     hit.ticker,
      name:       hit.name,
      confidence: exactHit ? 'exact' : 'partial',
    },
  };
}

module.exports = { resolveCompanyName, EntityResolverError };
