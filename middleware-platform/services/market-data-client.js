'use strict';

/**
 * market-data-client — Yahoo Finance public endpoints, no API key required.
 *
 * Every exported function returns { ok: true, data } | { ok: false, error: MarketDataError }.
 * They never throw. Branch on result.ok; inspect error.code for:
 *   TICKER_NOT_FOUND | RATE_LIMITED | FETCH_ERROR | PARSE_ERROR
 */

const YAHOO_BASE = 'https://query1.finance.yahoo.com';
const TIMEOUT_MS = 8000;

// -- Typed error -------------------------------------------------------------

class MarketDataError extends Error {
  constructor(code, message, httpStatus = null) {
    super(message);
    this.name = 'MarketDataError';
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const err = (code, msg, status = null) => ({ ok: false, error: new MarketDataError(code, msg, status) });

// -- Internal fetch ----------------------------------------------------------

async function _yahooFetch(url) {
  let res;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; market-data-client/1.0)', Accept: 'application/json' },
    });
    clearTimeout(t);
  } catch (e) {
    return err('FETCH_ERROR', e && e.name === 'AbortError' ? `Timed out after ${TIMEOUT_MS}ms` : `Network error: ${e && e.message}`);
  }

  if (res.status === 429) return err('RATE_LIMITED', 'Yahoo Finance rate limit (HTTP 429)', 429);
  if (!res.ok) return err('FETCH_ERROR', `Yahoo Finance HTTP ${res.status}`, res.status);

  let body;
  try { body = await res.json(); }
  catch (e) { return err('PARSE_ERROR', `JSON parse failed: ${e && e.message}`); }

  // Yahoo soft-blocks return HTTP 200 with an error envelope
  const envelope = body && (body.chart || body.quoteSummary);
  const yErr = envelope && envelope.error;
  if (yErr) {
    const desc = String(yErr.description || yErr.code || '').toLowerCase();
    const code = (desc.includes('too many') || desc.includes('rate') || yErr.code === 'Too Many Requests')
      ? 'RATE_LIMITED' : 'FETCH_ERROR';
    return err(code, `Yahoo error: ${yErr.description || yErr.code}`, 200);
  }

  return { ok: true, data: body };
}

// -- Public API --------------------------------------------------------------

/** Current (delayed) price for a ticker. */
async function getCurrentPrice(ticker) {
  const sym = String(ticker || '').trim().toUpperCase();
  if (!sym) return err('TICKER_NOT_FOUND', 'ticker is required');

  const result = await _yahooFetch(`${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`);
  if (!result.ok) return result;

  try {
    const meta = result.data.chart?.result?.[0]?.meta;
    if (!meta) return err('TICKER_NOT_FOUND', `No data for ticker: ${sym}`);
    const price = meta.regularMarketPrice ?? meta.chartPreviousClose ?? null;
    if (price == null) return err('TICKER_NOT_FOUND', `Price unavailable for ticker: ${sym}`);
    return { ok: true, data: { ticker: sym, price, currency: meta.currency || 'USD', marketState: meta.marketState || 'UNKNOWN', timestamp: meta.regularMarketTime || Math.floor(Date.now() / 1000) } };
  } catch (e) {
    return err('PARSE_ERROR', `Could not extract price: ${e && e.message}`);
  }
}

/**
 * OHLCV historical prices.
 * @param {string} ticker
 * @param {{ range?: string, interval?: string }} [opts]  range default "3mo", interval default "1d"
 */
async function getHistoricalPrices(ticker, opts = {}) {
  const sym = String(ticker || '').trim().toUpperCase();
  if (!sym) return err('TICKER_NOT_FOUND', 'ticker is required');
  const range = String(opts.range || '3mo');
  const interval = String(opts.interval || '1d');

  const result = await _yahooFetch(`${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(sym)}?interval=${interval}&range=${range}`);
  if (!result.ok) return result;

  try {
    const cr = result.data.chart?.result?.[0];
    if (!cr) return err('TICKER_NOT_FOUND', `No historical data for ticker: ${sym}`);
    const ts = cr.timestamp || [];
    const q = cr.indicators?.quote?.[0] || {};
    const quotes = ts.map((t, i) => ({
      date: new Date(t * 1000).toISOString().slice(0, 10),
      open: q.open?.[i] ?? null, high: q.high?.[i] ?? null,
      low: q.low?.[i] ?? null,   close: q.close?.[i] ?? null,
      volume: q.volume?.[i] ?? null,
    }));
    return { ok: true, data: { ticker: sym, interval, range, quotes } };
  } catch (e) {
    return err('PARSE_ERROR', `Could not extract history: ${e && e.message}`);
  }
}

/**
 * Company fundamentals sourced from the /v8/finance/chart meta object —
 * the same endpoint used by getCurrentPrice, which requires no crumb.
 *
 * Fields available from chart meta are returned as-is.
 * Fields that require /v10/finance/quoteSummary (sector, industry, marketCap,
 * peRatio, dividendYield) are returned as NOT_SUPPORTED with an explanatory
 * message so callers can handle them gracefully.
 */
async function getCompanyFundamentals(ticker) {
  const sym = String(ticker || '').trim().toUpperCase();
  if (!sym) return err('TICKER_NOT_FOUND', 'ticker is required');

  const result = await _yahooFetch(
    `${YAHOO_BASE}/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1d`
  );
  if (!result.ok) return result;

  try {
    const meta = result.data.chart?.result?.[0]?.meta;
    if (!meta) return err('TICKER_NOT_FOUND', `No data for ticker: ${sym}`);

    const NOT_SUPPORTED = (field) =>
      `NOT_SUPPORTED: ${field} requires a paid/authenticated source (e.g. /v10/finance/quoteSummary with crumb, or a third-party fundamentals API)`;

    return {
      ok: true,
      data: {
        ticker: sym,
        name:             meta.longName || meta.shortName || null,
        currency:         meta.currency || null,
        exchange:         meta.exchangeName || meta.fullExchangeName || null,
        instrumentType:   meta.instrumentType || null,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow:  meta.fiftyTwoWeekLow  ?? null,
        // --- fields unavailable from the chart endpoint ---
        sector:        NOT_SUPPORTED('sector'),
        industry:      NOT_SUPPORTED('industry'),
        marketCap:     NOT_SUPPORTED('marketCap'),
        peRatio:       NOT_SUPPORTED('peRatio'),
        dividendYield: NOT_SUPPORTED('dividendYield'),
      },
    };
  } catch (e) {
    return err('PARSE_ERROR', `Could not extract fundamentals: ${e && e.message}`);
  }
}

module.exports = { MarketDataError, getCurrentPrice, getHistoricalPrices, getCompanyFundamentals };
