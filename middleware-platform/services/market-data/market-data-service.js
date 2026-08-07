'use strict';

/**
 * MarketDataService — normalized quotes / fundamentals behind a provider.
 *
 * Execution path must inject a production-grade provider (FMP/Polygon/etc.).
 * Yahoo is research-only and must never be used when EXECUTION_PATH=1.
 */

class MarketDataService {
  /**
   * @param {{ provider: { getQuote(symbol): Promise, getFundamentals(symbol): Promise } }} opts
   */
  constructor(opts = {}) {
    if (!opts.provider || typeof opts.provider.getQuote !== 'function') {
      throw new Error('MarketDataService requires a provider with getQuote');
    }
    this.provider = opts.provider;
    this.name = opts.name || opts.provider.name || 'market-data';
  }

  async getQuote(symbol) {
    const sym = String(symbol || '')
      .trim()
      .toUpperCase();
    if (!sym) {
      const err = new Error('symbol is required');
      err.code = 'INVALID_SYMBOL';
      throw err;
    }
    const q = await this.provider.getQuote(sym);
    return normalizeQuote(q, sym);
  }

  async getFundamentals(symbol) {
    const sym = String(symbol || '')
      .trim()
      .toUpperCase();
    if (!sym) {
      const err = new Error('symbol is required');
      err.code = 'INVALID_SYMBOL';
      throw err;
    }
    const f = await this.provider.getFundamentals(sym);
    return normalizeFundamentals(f, sym);
  }
}

function normalizeQuote(q, symbol) {
  const price = Number(q && (q.price != null ? q.price : q.last));
  return {
    symbol: (q && q.symbol) || symbol,
    price: Number.isFinite(price) ? price : null,
    bid: q && q.bid != null ? Number(q.bid) : null,
    ask: q && q.ask != null ? Number(q.ask) : null,
    volume: q && q.volume != null ? Number(q.volume) : null,
    currency: (q && q.currency) || 'USD',
    as_of: (q && q.as_of) || new Date().toISOString(),
    provider: q && q.provider,
    raw: q && q.raw,
  };
}

function normalizeFundamentals(f, symbol) {
  return {
    symbol: (f && f.symbol) || symbol,
    market_cap: f && f.market_cap != null ? Number(f.market_cap) : null,
    pe_ratio: f && f.pe_ratio != null ? Number(f.pe_ratio) : null,
    sector: (f && f.sector) || null,
    exchange: (f && f.exchange) || null,
    avg_daily_volume:
      f && f.avg_daily_volume != null ? Number(f.avg_daily_volume) : null,
    as_of: (f && f.as_of) || new Date().toISOString(),
    provider: f && f.provider,
    raw: f && f.raw,
  };
}

module.exports = { MarketDataService, normalizeQuote, normalizeFundamentals };
