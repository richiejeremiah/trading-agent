'use strict';

/**
 * Deterministic stub provider for tests / offline paper paths.
 */

const DEFAULTS = {
  AAPL: {
    price: 190.25,
    market_cap: 2.9e12,
    pe_ratio: 30,
    sector: 'Technology',
    exchange: 'NASDAQ',
    avg_daily_volume: 5e7,
  },
  MSFT: {
    price: 420.1,
    market_cap: 3.1e12,
    pe_ratio: 35,
    sector: 'Technology',
    exchange: 'NASDAQ',
    avg_daily_volume: 2e7,
  },
  PENNY: {
    price: 0.45,
    market_cap: 1e7,
    pe_ratio: null,
    sector: 'Unknown',
    exchange: 'OTC',
    avg_daily_volume: 5000,
  },
};

function stubHashPrice(symbol) {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return 10 + (h % 400) + (h % 100) / 100;
}

class StubMarketDataProvider {
  constructor(table = {}) {
    this.name = 'stub';
    this.table = { ...DEFAULTS, ...table };
  }

  async getQuote(symbol) {
    const sym = String(symbol).toUpperCase();
    const row = this.table[sym];
    const price = row ? row.price : stubHashPrice(sym);
    return {
      symbol: sym,
      price,
      bid: price * 0.999,
      ask: price * 1.001,
      volume: row && row.avg_daily_volume != null ? row.avg_daily_volume : 1e6,
      currency: 'USD',
      provider: 'stub',
      as_of: '1970-01-01T00:00:00.000Z',
    };
  }

  async getFundamentals(symbol) {
    const sym = String(symbol).toUpperCase();
    const row = this.table[sym] || {};
    return {
      symbol: sym,
      market_cap: row.market_cap != null ? row.market_cap : 1e9,
      pe_ratio: row.pe_ratio != null ? row.pe_ratio : 15,
      sector: row.sector || 'Unknown',
      exchange: row.exchange || 'NYSE',
      avg_daily_volume: row.avg_daily_volume != null ? row.avg_daily_volume : 1e6,
      provider: 'stub',
      as_of: '1970-01-01T00:00:00.000Z',
    };
  }
}

module.exports = { StubMarketDataProvider, DEFAULTS };
