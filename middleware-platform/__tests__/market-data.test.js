'use strict';

const { MarketDataService } = require('../services/market-data/market-data-service');
const { StubMarketDataProvider } = require('../services/market-data/providers/stub-provider');
const { YahooMarketDataProvider } = require('../services/market-data/providers/yahoo-provider');

describe('MarketDataService (Task 4)', () => {
  const prevExec = process.env.EXECUTION_PATH;

  afterEach(() => {
    if (prevExec === undefined) delete process.env.EXECUTION_PATH;
    else process.env.EXECUTION_PATH = prevExec;
  });

  it('stub provider returns deterministic quote and fundamentals', async () => {
    delete process.env.EXECUTION_PATH;
    const svc = new MarketDataService({ provider: new StubMarketDataProvider() });
    const q = await svc.getQuote('AAPL');
    expect(q.symbol).toBe('AAPL');
    expect(q.price).toBe(190.25);
    expect(q.provider).toBe('stub');

    const f = await svc.getFundamentals('AAPL');
    expect(f.exchange).toBe('NASDAQ');
    expect(f.market_cap).toBeGreaterThan(1e12);
    expect(f.avg_daily_volume).toBe(5e7);
  });

  it('yahoo throws on EXECUTION_PATH=1', async () => {
    process.env.EXECUTION_PATH = '1';
    const yahoo = new YahooMarketDataProvider({
      fetchImpl: async () => ({ symbol: 'AAPL', price: 1 }),
    });
    await expect(yahoo.getQuote('AAPL')).rejects.toMatchObject({
      code: 'YAHOO_EXECUTION_FORBIDDEN',
    });
    await expect(yahoo.getFundamentals('AAPL')).rejects.toMatchObject({
      code: 'YAHOO_EXECUTION_FORBIDDEN',
    });

    const svc = new MarketDataService({ provider: yahoo });
    await expect(svc.getQuote('AAPL')).rejects.toMatchObject({
      code: 'YAHOO_EXECUTION_FORBIDDEN',
    });
  });

  it('yahoo research path still forbids when not wired without fetchImpl', async () => {
    delete process.env.EXECUTION_PATH;
    const yahoo = new YahooMarketDataProvider();
    await expect(yahoo.getQuote('AAPL')).rejects.toMatchObject({ code: 'YAHOO_NOT_WIRED' });
  });
});
