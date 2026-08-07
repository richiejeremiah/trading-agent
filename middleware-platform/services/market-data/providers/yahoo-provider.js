'use strict';

/**
 * Yahoo Finance provider — OPTIONAL, research / prototype ONLY.
 *
 * MUST NOT be used on the execution path (policy → risk → execution → broker).
 * If EXECUTION_PATH=1, every method throws.
 *
 * Swap to FMP / Polygon / Alpaca market data behind MarketDataService for exec.
 */

function assertNotExecutionPath() {
  const v = String(process.env.EXECUTION_PATH || '')
    .trim()
    .toLowerCase();
  if (v === '1' || v === 'true' || v === 'yes' || v === 'on') {
    const err = new Error(
      'YahooMarketDataProvider must not be used on EXECUTION_PATH=1 (research-only)'
    );
    err.code = 'YAHOO_EXECUTION_FORBIDDEN';
    throw err;
  }
}

class YahooMarketDataProvider {
  constructor(opts = {}) {
    this.name = 'yahoo';
    this.fetchImpl = opts.fetchImpl || null;
  }

  async getQuote(symbol) {
    assertNotExecutionPath();
    const sym = String(symbol).toUpperCase();
    // Research stub: no live HTTP wired; callers should treat as research-only.
    if (this.fetchImpl) {
      return this.fetchImpl('quote', sym);
    }
    const err = new Error(
      'YahooMarketDataProvider HTTP not wired; research-only placeholder. Do not use on execution path.'
    );
    err.code = 'YAHOO_NOT_WIRED';
    throw err;
  }

  async getFundamentals(symbol) {
    assertNotExecutionPath();
    const sym = String(symbol).toUpperCase();
    if (this.fetchImpl) {
      return this.fetchImpl('fundamentals', sym);
    }
    const err = new Error(
      'YahooMarketDataProvider HTTP not wired; research-only placeholder. Do not use on execution path.'
    );
    err.code = 'YAHOO_NOT_WIRED';
    throw err;
  }
}

module.exports = { YahooMarketDataProvider, assertNotExecutionPath };
