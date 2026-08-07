'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createProposedAction } = require('../services/policy/proposed-action');

describe('Execution (Task 7)', () => {
  let dbPath;
  let database;
  let writer;
  let executeProposedAction;
  let reconcilePositions;
  let PaperBroker;

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
      `exec-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
    );
    process.env.TRADING_DB_PATH = dbPath;
    process.env.TRADING_MODE = 'paper';
    process.env.BROKER_DRIVER = 'paper';
    process.env.PAPER_WALLET_ID = 'default';
    delete process.env.KILL_SWITCH;

    jest.resetModules();
    database = require('../database');
    writer = require('../services/paper-wallet-writer');
    ({ executeProposedAction } = require('../services/execution/execution-service'));
    ({ reconcilePositions } = require('../services/execution/reconcile'));
    ({ PaperBroker } = require('../services/broker'));
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

  function cleanAction(overrides = {}) {
    return createProposedAction({
      symbol: 'AAPL',
      side: 'buy',
      intent: 'open_long',
      reason: 'test allow',
      notional: 1000,
      qty: 10,
      price: 100,
      exchange: 'NASDAQ',
      avg_daily_volume: 50_000_000,
      ...overrides,
    });
  }

  it('reject path never calls broker submitOrder', async () => {
    process.env.KILL_SWITCH = '1';
    const submitOrder = jest.fn();
    const broker = { submitOrder, getPositions: async () => [] };

    const out = await executeProposedAction(cleanAction(), {
      cash: 10000,
      equity: 10000,
      broker,
      idempotencyKey: 'reject-path-1',
    });

    expect(out.submitted).toBe(false);
    expect(out.decision).toBe('REJECT');
    expect(out.order).toBeNull();
    expect(submitOrder).not.toHaveBeenCalled();
  });

  it('allow path creates paper order via PaperBroker', async () => {
    delete process.env.KILL_SWITCH;
    writer.applyFund({
      amount: 10000,
      actor: { type: 'test', id: 'exec' },
      idempotencyKey: 'fund:exec:1',
      reason: 'fund for allow path',
    });

    const broker = new PaperBroker();
    const out = await executeProposedAction(cleanAction(), {
      cash: 10000,
      equity: 10000,
      broker,
      idempotencyKey: 'allow-path-1',
      actor: { type: 'test', id: 'exec' },
    });

    expect(out.submitted).toBe(true);
    expect(out.decision).toBe('ALLOW');
    expect(out.order).toBeTruthy();
    expect(out.order.status).toBe('filled');
    expect(out.order.symbol).toBe('AAPL');
    expect(out.client_order_id).toBe('allow-path-1');
    expect(writer.getBalance().cash_balance).toBe(9000);
  });

  it('reconcile empty when local paper_positions in sync with PaperBroker', async () => {
    delete process.env.KILL_SWITCH;
    writer.applyFund({
      amount: 5000,
      actor: { type: 'test', id: 'recon' },
      idempotencyKey: 'fund:recon:1',
      reason: 'fund',
    });
    const broker = new PaperBroker();
    await broker.submitOrder({
      symbol: 'MSFT',
      side: 'buy',
      qty: 5,
      price: 100,
      client_order_id: 'recon-buy-1',
      actor: { type: 'test', id: 'recon' },
    });

    const result = await reconcilePositions({ broker, db: database.getDb() });
    expect(result.inSync).toBe(true);
    expect(result.diffs).toEqual([]);
    expect(result.local.some((p) => p.symbol === 'MSFT' && p.qty === 5)).toBe(true);
  });
});
