'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('PaperBroker (Task 2)', () => {
  let dbPath;
  let database;
  let writer;
  let PaperBroker;
  let getBroker;
  let AlpacaBroker;

  function resetDb() {
    if (database) database.closeDb();
    if (dbPath && fs.existsSync(dbPath)) {
      try {
        fs.unlinkSync(dbPath);
      } catch (_) {}
      try {
        fs.unlinkSync(`${dbPath}-wal`);
      } catch (_) {}
      try {
        fs.unlinkSync(`${dbPath}-shm`);
      } catch (_) {}
    }
    dbPath = path.join(
      os.tmpdir(),
      `paper-broker-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
    );
    process.env.TRADING_DB_PATH = dbPath;
    process.env.TRADING_MODE = 'paper';
    process.env.BROKER_DRIVER = 'paper';
    process.env.PAPER_WALLET_ID = 'default';
    delete process.env.APCA_API_KEY;
    delete process.env.APCA_SECRET_KEY;
    delete process.env.KILL_SWITCH;

    jest.resetModules();
    database = require('../database');
    writer = require('../services/paper-wallet-writer');
    ({ PaperBroker, getBroker, AlpacaBroker } = require('../services/broker'));
    database.getDb();
  }

  beforeEach(() => resetDb());

  afterEach(() => {
    if (database) database.closeDb();
    if (dbPath && fs.existsSync(dbPath)) {
      try {
        fs.unlinkSync(dbPath);
      } catch (_) {}
    }
  });

  it('getBroker defaults to PaperBroker in paper mode', () => {
    const b = getBroker();
    expect(b).toBeInstanceOf(PaperBroker);
  });

  it('submit buy debits wallet after funding via writer', async () => {
    writer.applyFund({
      amount: 10000,
      actor: { type: 'telegram', id: '111' },
      idempotencyKey: 'fund:broker-test:1',
      reason: 'test fund',
    });
    expect(writer.getBalance().cash_balance).toBe(10000);

    const broker = new PaperBroker();
    const order = await broker.submitOrder({
      symbol: 'AAPL',
      side: 'buy',
      qty: 10,
      price: 100,
      client_order_id: 'test-buy-1',
      actor: { type: 'test', id: 'jest' },
    });

    expect(order.status).toBe('filled');
    expect(order.symbol).toBe('AAPL');
    expect(order.filled_qty).toBe(10);
    expect(order.filled_price).toBe(100);
    expect(writer.getBalance().cash_balance).toBe(9000);

    const acct = await broker.getAccount();
    expect(acct.cash).toBe(9000);

    const positions = await broker.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe('AAPL');
    expect(positions[0].qty).toBe(10);
    expect(positions[0].avg_cost).toBe(100);

    const ledger = database
      .getDb()
      .prepare(`SELECT event_type, amount FROM paper_wallet_ledger WHERE event_type = 'trade_debit'`)
      .get();
    expect(ledger).toBeTruthy();
    expect(Number(ledger.amount)).toBe(1000);
  });

  it('AlpacaBroker throws NOT_WIRED without and with APCA_*', async () => {
    const bare = new AlpacaBroker();
    await expect(bare.submitOrder({ symbol: 'AAPL', side: 'buy', qty: 1 })).rejects.toMatchObject({
      code: 'NOT_WIRED',
    });

    process.env.APCA_API_KEY = 'pk_test';
    process.env.APCA_SECRET_KEY = 'sk_test';
    jest.resetModules();
    ({ AlpacaBroker } = require('../services/broker'));
    const wired = new AlpacaBroker();
    await expect(wired.getAccount()).rejects.toMatchObject({ code: 'NOT_WIRED' });
  });
});
