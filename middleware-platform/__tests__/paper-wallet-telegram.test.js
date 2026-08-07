'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

describe('paper wallet telegram (Task 1)', () => {
  let dbPath;
  let database;
  let writer;
  let auth;
  let commands;
  let bot;

  const USER = '111';
  const CHAT = '222';
  const OTHER = '999';

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
      `paper-wallet-test-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.sqlite`
    );
    process.env.TRADING_DB_PATH = dbPath;
    process.env.TRADING_MODE = 'paper';
    process.env.PAPER_WALLET_ID = 'default';
    process.env.TELEGRAM_ALLOWED_USER_IDS = USER;
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = '';
    delete process.env.PAPER_FUND_MAX_PER_CMD;
    delete process.env.PAPER_WITHDRAW_MAX_PER_CMD;
    delete process.env.PAPER_FUND_MAX_PER_DAY;
    delete process.env.PAPER_WITHDRAW_MAX_PER_DAY;
    delete process.env.PAPER_WALLET_MAX_CMDS_PER_HOUR;
    delete process.env.PAPER_WALLET_CONFIRM_TTL_SEC;

    // Re-require so modules see fresh env; database singleton is closed.
    jest.resetModules();
    database = require('../database');
    writer = require('../services/paper-wallet-writer');
    auth = require('../services/telegram-auth');
    commands = require('../services/telegram-paper-commands');
    bot = require('../services/telegram-bot');
    database.getDb();
  }

  beforeEach(() => {
    resetDb();
  });

  afterEach(() => {
    if (database) database.closeDb();
    if (dbPath && fs.existsSync(dbPath)) {
      try {
        fs.unlinkSync(dbPath);
      } catch (_) {}
    }
  });

  function msg(text, userId = USER, chatId = CHAT) {
    return { userId, chatId, text, messageId: 1 };
  }

  function update(text, userId = USER, chatId = CHAT) {
    return {
      update_id: 1,
      message: {
        message_id: 1,
        from: { id: Number(userId) },
        chat: { id: Number(chatId) },
        text,
      },
    };
  }

  it('rejects unauthorized caller before any write', () => {
    expect(() => auth.assertTelegramCaller(OTHER, CHAT)).toThrow(/unauthorized/i);
    const out = commands.handlePaperCommand(msg('/fund 1000', OTHER, CHAT));
    expect(out.unauthorized).toBe(true);
    expect(writer.getBalance().cash_balance).toBe(0);
  });

  it('disables money commands when allowlist is empty', () => {
    process.env.TELEGRAM_ALLOWED_USER_IDS = '';
    expect(auth.moneyCommandsEnabled()).toBe(false);
    expect(() => auth.assertTelegramCaller(USER, CHAT)).toThrow(/disabled/i);
    const out = commands.handlePaperCommand(msg('/fund 100'));
    expect(out.reply).toMatch(/disabled/i);
    expect(writer.getBalance().cash_balance).toBe(0);
  });

  it('fund without confirm does not change balance', () => {
    const out = commands.handlePaperCommand(msg('/fund 1000'));
    expect(out.pending).toBe(true);
    expect(out.reply).toMatch(/confirm_fund/i);
    expect(writer.getBalance().cash_balance).toBe(0);
  });

  it('confirm_fund credits once', () => {
    commands.handlePaperCommand(msg('/fund 1000'));
    expect(writer.getBalance().cash_balance).toBe(0);
    const conf = commands.handlePaperCommand(msg('/confirm_fund'));
    expect(conf.reply).toMatch(/Deposited \$1000\.00/i);
    expect(conf.reply).toMatch(/Ledger #/);
    expect(writer.getBalance().cash_balance).toBe(1000);
  });

  it('double confirm is idempotent (no double credit)', async () => {
    commands.handlePaperCommand(msg('/fund 250.50'));
    const pending = commands.getPending('default', USER);
    expect(pending).toBeTruthy();
    const key = pending.idempotency_key;

    const first = commands.handlePaperCommand(msg('/confirm_fund'));
    expect(first.result.idempotent).toBe(false);
    expect(writer.getBalance().cash_balance).toBe(250.5);

    // Second /confirm_fund has no pending → nothing to confirm
    const secondCmd = commands.handlePaperCommand(msg('/confirm_fund'));
    expect(secondCmd.reply).toMatch(/Nothing to confirm/i);
    expect(writer.getBalance().cash_balance).toBe(250.5);

    // Writer-level replay with same key is idempotent no-op
    const replay = writer.applyFund({
      amount: 250.5,
      actor: { type: 'telegram', id: USER },
      idempotencyKey: key,
      reason: 'replay',
    });
    expect(replay.idempotent).toBe(true);
    expect(writer.getBalance().cash_balance).toBe(250.5);

    const ledgerCount = database
      .getDb()
      .prepare(`SELECT COUNT(*) AS c FROM paper_wallet_ledger WHERE event_type = 'fund'`)
      .get().c;
    expect(ledgerCount).toBe(1);
  });

  it('withdraw overdraft fails without debit', () => {
    commands.handlePaperCommand(msg('/fund 100'));
    commands.handlePaperCommand(msg('/confirm_fund'));
    expect(writer.getBalance().cash_balance).toBe(100);

    const stage = commands.handlePaperCommand(msg('/withdraw 500'));
    expect(stage.reply).toMatch(/Insufficient/i);
    expect(writer.getBalance().cash_balance).toBe(100);

    // Stage a valid withdraw then force overdraft at confirm via direct writer check path:
    // fund small, stage withdraw of balance, then deplete... simpler: applyWithdraw directly
    expect(() =>
      writer.applyWithdraw({
        amount: 999,
        actor: { type: 'telegram', id: USER },
        idempotencyKey: 'tg:overdraft:1',
      })
    ).toThrow(/Insufficient/i);
    expect(writer.getBalance().cash_balance).toBe(100);
  });

  it('enforces per-command fund limit', () => {
    process.env.PAPER_FUND_MAX_PER_CMD = '100';
    const out = commands.handlePaperCommand(msg('/fund 150'));
    expect(out.reply).toMatch(/per-command limit/i);
    expect(writer.getBalance().cash_balance).toBe(0);
  });

  it('enforces daily fund limit', () => {
    process.env.PAPER_FUND_MAX_PER_DAY = '100';
    process.env.PAPER_FUND_MAX_PER_CMD = '80';

    commands.handlePaperCommand(msg('/fund 80'));
    commands.handlePaperCommand(msg('/confirm_fund'));
    expect(writer.getBalance().cash_balance).toBe(80);

    const stage = commands.handlePaperCommand(msg('/fund 30'));
    expect(stage.reply).toMatch(/daily fund limit/i);
    expect(writer.getBalance().cash_balance).toBe(80);
  });

  it('enforces hourly command limit', () => {
    process.env.PAPER_WALLET_MAX_CMDS_PER_HOUR = '2';
    process.env.PAPER_FUND_MAX_PER_CMD = '50';

    commands.handlePaperCommand(msg('/fund 10'));
    commands.handlePaperCommand(msg('/confirm_fund'));
    commands.handlePaperCommand(msg('/fund 10'));
    commands.handlePaperCommand(msg('/confirm_fund'));
    expect(writer.getBalance().cash_balance).toBe(20);

    const stage = commands.handlePaperCommand(msg('/fund 10'));
    expect(stage.reply).toMatch(/Hourly command limit/i);
  });

  it('/deposit aliases /fund and processUpdate works', async () => {
    const staged = await bot.processUpdate(update('/deposit 42'));
    expect(staged.handled).toBe(true);
    expect(staged.reply).toMatch(/confirm_fund/i);
    expect(writer.getBalance().cash_balance).toBe(0);

    const conf = await bot.processUpdate(update('/confirm_fund'));
    expect(conf.reply).toMatch(/Deposited \$42\.00/);
    expect(writer.getBalance().cash_balance).toBe(42);
  });

  it('/cancel clears pending without mutation', () => {
    commands.handlePaperCommand(msg('/fund 500'));
    expect(commands.getPending('default', USER)).toBeTruthy();
    const out = commands.handlePaperCommand(msg('/cancel'));
    expect(out.reply).toMatch(/cancelled/i);
    expect(commands.getPending('default', USER)).toBeFalsy();
    expect(writer.getBalance().cash_balance).toBe(0);
  });

  it('rejects chat not on TELEGRAM_ALLOWED_CHAT_IDS when set', () => {
    process.env.TELEGRAM_ALLOWED_CHAT_IDS = CHAT;
    const bad = commands.handlePaperCommand(msg('/balance', USER, '333'));
    expect(bad.unauthorized).toBe(true);
    const good = commands.handlePaperCommand(msg('/balance', USER, CHAT));
    expect(good.reply).toMatch(/Paper balance/);
  });
});
