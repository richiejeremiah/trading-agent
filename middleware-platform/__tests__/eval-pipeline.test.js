'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Eval paper pipeline (Task 8)', () => {
  let dbPath;
  let database;
  let writer;
  let commands;
  let runStrategies;
  let executeProposedAction;
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
      `eval-pipe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
    );
    process.env.TRADING_DB_PATH = dbPath;
    process.env.TRADING_MODE = 'paper';
    process.env.BROKER_DRIVER = 'paper';
    process.env.PAPER_WALLET_ID = 'default';
    process.env.TELEGRAM_ALLOWED_USER_IDS = '111';
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = '';
    delete process.env.KILL_SWITCH;
    delete process.env.PAPER_WALLET_CONFIRM_TTL_SEC;

    jest.resetModules();
    database = require('../database');
    writer = require('../services/paper-wallet-writer');
    commands = require('../services/telegram-paper-commands');
    ({ runStrategies } = require('../services/strategy'));
    ({ executeProposedAction } = require('../services/execution'));
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

  it('fund → PEAD propose → pipeline → PaperBroker fill → ledger + position', async () => {
    writer.applyFund({
      amount: 20000,
      actor: { type: 'eval', id: 'harness' },
      idempotencyKey: 'eval:fund:1',
      reason: 'eval fund',
    });
    expect(writer.getBalance().cash_balance).toBe(20000);

    const proposals = runStrategies({
      earnings: {
        symbol: 'AAPL',
        actual: 2.4,
        consensus: 2.0,
        stdev: 0.2,
        price: 100,
        notional: 2000,
        qty: 20,
        exchange: 'NASDAQ',
        avg_daily_volume: 50_000_000,
      },
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].side).toBe('buy');

    const broker = new PaperBroker();
    const result = await executeProposedAction(proposals[0], {
      cash: 20000,
      equity: 20000,
      broker,
      idempotencyKey: 'eval:pead:aapl:1',
      actor: { type: 'eval', id: 'harness' },
    });

    expect(result.submitted).toBe(true);
    expect(result.order.status).toBe('filled');
    expect(writer.getBalance().cash_balance).toBe(18000);

    const positions = await broker.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].symbol).toBe('AAPL');
    expect(positions[0].qty).toBe(20);

    const debit = database
      .getDb()
      .prepare(
        `SELECT event_type, amount FROM paper_wallet_ledger WHERE event_type = 'trade_debit'`
      )
      .get();
    expect(debit).toBeTruthy();
    expect(Number(debit.amount)).toBe(2000);

    // Telegram command smoke integration assert (auth + fund path)
    const tg = commands.handlePaperCommand({
      userId: '111',
      chatId: '222',
      text: '/balance',
      messageId: 42,
    });
    expect(tg.unauthorized).not.toBe(true);
    expect(tg.reply).toMatch(/18000|18,000|\$18000|\$18,000/i);
  });
});
