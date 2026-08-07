'use strict';

/**
 * Single writer for paper_wallets.cash_balance.
 * All mutations run inside one SQLite transaction with ledger + idempotency.
 */

const crypto = require('crypto');
const logger = require('./logger');

const DEFAULT_WALLET_ID = () => String(process.env.PAPER_WALLET_ID || 'default').trim() || 'default';

function numEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function limits() {
  return {
    fundMaxPerCmd: numEnv('PAPER_FUND_MAX_PER_CMD', 50000),
    withdrawMaxPerCmd: numEnv('PAPER_WITHDRAW_MAX_PER_CMD', 50000),
    fundMaxPerDay: numEnv('PAPER_FUND_MAX_PER_DAY', 100000),
    withdrawMaxPerDay: numEnv('PAPER_WITHDRAW_MAX_PER_DAY', 100000),
    maxCmdsPerHour: numEnv('PAPER_WALLET_MAX_CMDS_PER_HOUR', 20),
  };
}

function assertPaperMode() {
  const mode = String(process.env.TRADING_MODE || 'paper').trim().toLowerCase();
  if (mode === 'live') {
    const err = new Error('Paper wallet commands refuse live TRADING_MODE');
    err.code = 'PAPER_WALLET_LIVE_REFUSED';
    throw err;
  }
}

function validateAmount(amount) {
  if (typeof amount === 'string' && /[eE]/.test(amount)) {
    const err = new Error('Amount must be a positive number with at most 2 decimal places');
    err.code = 'INVALID_AMOUNT';
    throw err;
  }
  const n = typeof amount === 'number' ? amount : Number(amount);
  if (!Number.isFinite(n) || n <= 0) {
    const err = new Error('Amount must be a positive number with at most 2 decimal places');
    err.code = 'INVALID_AMOUNT';
    throw err;
  }
  const rounded = Math.round(n * 100) / 100;
  if (Math.abs(n - rounded) > 1e-9) {
    const err = new Error('Amount must be a positive number with at most 2 decimal places');
    err.code = 'INVALID_AMOUNT';
    throw err;
  }
  return rounded;
}

function getDb() {
  return require('../database').getDb();
}

function ensureWallet(db, walletId) {
  db.prepare(
    `INSERT OR IGNORE INTO paper_wallets (wallet_id, cash_balance, updated_at, updated_by)
     VALUES (?, 0, datetime('now'), 'system:ensure')`
  ).run(walletId);
}

function getBalance({ walletId } = {}) {
  assertPaperMode();
  const id = walletId || DEFAULT_WALLET_ID();
  const db = getDb();
  ensureWallet(db, id);
  const row = db.prepare(`SELECT cash_balance FROM paper_wallets WHERE wallet_id = ?`).get(id);
  return { wallet_id: id, cash_balance: row ? Number(row.cash_balance) : 0 };
}

/** Sum successful events for actor on current UTC calendar day (sqlite datetime). */
function sumDay(db, walletId, actorId, eventType) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM paper_wallet_ledger
       WHERE wallet_id = ? AND actor_id = ? AND event_type = ?
         AND created_at >= date('now')`
    )
    .get(walletId, String(actorId), eventType);
  return Number(row.total || 0);
}

/** Count fund/withdraw ledger rows for actor in the last hour. */
function countHourCmds(db, walletId, actorId) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM paper_wallet_ledger
       WHERE wallet_id = ? AND actor_id = ?
         AND event_type IN ('fund', 'withdraw')
         AND created_at >= datetime('now', '-1 hour')`
    )
    .get(walletId, String(actorId));
  return Number(row.c || 0);
}

function findByIdempotency(db, idempotencyKey) {
  return db
    .prepare(`SELECT * FROM paper_wallet_ledger WHERE idempotency_key = ?`)
    .get(idempotencyKey);
}

function applyMutation({
  eventType,
  amount,
  actor,
  reason,
  idempotencyKey,
  walletId,
  chatId,
  command,
  requestMessageId,
  meta,
}) {
  assertPaperMode();
  const amt = validateAmount(amount);
  const id = walletId || DEFAULT_WALLET_ID();
  const key = String(idempotencyKey || '').trim();
  if (!key) {
    const err = new Error('idempotency_key is required');
    err.code = 'MISSING_IDEMPOTENCY_KEY';
    throw err;
  }

  const actorType = actor && actor.type ? String(actor.type) : 'telegram';
  const actorId = actor && actor.id != null ? String(actor.id) : '';
  if (!actorId) {
    const err = new Error('actor.id is required');
    err.code = 'MISSING_ACTOR';
    throw err;
  }

  const isTrade = eventType === 'trade_debit' || eventType === 'trade_credit';
  const lim = limits();
  const maxPerCmd = eventType === 'fund' ? lim.fundMaxPerCmd : lim.withdrawMaxPerCmd;
  const maxPerDay = eventType === 'fund' ? lim.fundMaxPerDay : lim.withdrawMaxPerDay;

  // Telegram fund/withdraw velocity limits do not apply to broker fill cash deltas.
  if (!isTrade && amt > maxPerCmd) {
    const err = new Error(`Amount exceeds per-command limit of $${maxPerCmd.toFixed(2)}`);
    err.code = 'LIMIT_PER_CMD';
    throw err;
  }

  const db = getDb();
  const run = db.transaction(() => {
    ensureWallet(db, id);

    const existing = findByIdempotency(db, key);
    if (existing) {
      return {
        ok: true,
        idempotent: true,
        ledger_id: existing.id,
        wallet_id: id,
        balance_before: Number(existing.balance_before),
        balance_after: Number(existing.balance_after),
        amount: Number(existing.amount),
        event_type: existing.event_type,
      };
    }

    if (!isTrade) {
      const cmds = countHourCmds(db, id, actorId);
      if (cmds >= lim.maxCmdsPerHour) {
        const err = new Error(`Hourly command limit of ${lim.maxCmdsPerHour} reached`);
        err.code = 'LIMIT_PER_HOUR';
        throw err;
      }

      const daySum = sumDay(db, id, actorId, eventType);
      if (daySum + amt > maxPerDay) {
        const err = new Error(
          `Would exceed daily ${eventType} limit of $${maxPerDay.toFixed(2)} (used $${daySum.toFixed(2)})`
        );
        err.code = 'LIMIT_PER_DAY';
        throw err;
      }
    }

    const wallet = db.prepare(`SELECT cash_balance FROM paper_wallets WHERE wallet_id = ?`).get(id);
    const before = Number(wallet.cash_balance);
    let after;
    if (eventType === 'fund' || eventType === 'trade_credit') {
      after = Math.round((before + amt) * 100) / 100;
    } else if (eventType === 'withdraw' || eventType === 'trade_debit') {
      after = Math.round((before - amt) * 100) / 100;
      if (after < 0) {
        const err = new Error(`Insufficient cash: balance $${before.toFixed(2)}, requested $${amt.toFixed(2)}`);
        err.code = 'INSUFFICIENT_FUNDS';
        throw err;
      }
    } else {
      const err = new Error(`Unsupported event_type: ${eventType}`);
      err.code = 'INVALID_EVENT';
      throw err;
    }

    const updatedBy = `${actorType}:${actorId}`;
    db.prepare(
      `UPDATE paper_wallets SET cash_balance = ?, updated_at = datetime('now'), updated_by = ? WHERE wallet_id = ?`
    ).run(after, updatedBy, id);

    const info = db
      .prepare(
        `INSERT INTO paper_wallet_ledger (
          wallet_id, event_type, amount, balance_before, balance_after,
          actor_type, actor_id, chat_id, command, idempotency_key,
          request_message_id, created_at, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`
      )
      .run(
        id,
        eventType,
        amt,
        before,
        after,
        actorType,
        actorId,
        chatId != null ? String(chatId) : null,
        command || reason || null,
        key,
        requestMessageId != null ? String(requestMessageId) : null,
        meta ? JSON.stringify(meta) : null
      );

    return {
      ok: true,
      idempotent: false,
      ledger_id: Number(info.lastInsertRowid),
      wallet_id: id,
      balance_before: before,
      balance_after: after,
      amount: amt,
      event_type: eventType,
    };
  });

  let result;
  try {
    result = run();
  } catch (e) {
    if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const existing = findByIdempotency(db, key);
      if (existing) {
        return {
          ok: true,
          idempotent: true,
          ledger_id: existing.id,
          wallet_id: id,
          balance_before: Number(existing.balance_before),
          balance_after: Number(existing.balance_after),
          amount: Number(existing.amount),
          event_type: existing.event_type,
        };
      }
    }
    throw e;
  }

  if (!result.idempotent) {
    logger.info('paper_wallet_mutation', {
      event_type: result.event_type,
      actor_id: actorId,
      amount: result.amount,
      balance_after: result.balance_after,
      ledger_id: result.ledger_id,
    });
  }
  return result;
}

function applyFund(opts) {
  return applyMutation({ ...opts, eventType: 'fund' });
}

function applyWithdraw(opts) {
  return applyMutation({ ...opts, eventType: 'withdraw' });
}

/**
 * Cash delta from paper broker fills only (not Telegram).
 * delta < 0 → trade_debit (buy); delta > 0 → trade_credit (sell proceeds).
 */
function applyTradeCashDelta(opts) {
  const delta = Number(opts && opts.delta);
  if (!Number.isFinite(delta) || delta === 0) {
    const err = new Error('Trade cash delta must be a non-zero finite number');
    err.code = 'INVALID_TRADE_DELTA';
    throw err;
  }
  const amount = Math.abs(delta);
  const eventType = delta < 0 ? 'trade_debit' : 'trade_credit';
  return applyMutation({
    ...opts,
    eventType,
    amount,
    reason: opts.reason || `paper_fill:${eventType}`,
    command: opts.command || 'paper_broker_fill',
  });
}

/** Pre-check limits without mutating (used when staging pending). */
function checkLimits({ eventType, amount, actorId, walletId } = {}) {
  assertPaperMode();
  const amt = validateAmount(amount);
  const id = walletId || DEFAULT_WALLET_ID();
  const lim = limits();
  const maxPerCmd = eventType === 'fund' ? lim.fundMaxPerCmd : lim.withdrawMaxPerCmd;
  const maxPerDay = eventType === 'fund' ? lim.fundMaxPerDay : lim.withdrawMaxPerDay;
  if (amt > maxPerCmd) {
    const err = new Error(`Amount exceeds per-command limit of $${maxPerCmd.toFixed(2)}`);
    err.code = 'LIMIT_PER_CMD';
    throw err;
  }
  const db = getDb();
  ensureWallet(db, id);
  const cmds = countHourCmds(db, id, String(actorId));
  if (cmds >= lim.maxCmdsPerHour) {
    const err = new Error(`Hourly command limit of ${lim.maxCmdsPerHour} reached`);
    err.code = 'LIMIT_PER_HOUR';
    throw err;
  }
  const daySum = sumDay(db, id, String(actorId), eventType);
  if (daySum + amt > maxPerDay) {
    const err = new Error(
      `Would exceed daily ${eventType} limit of $${maxPerDay.toFixed(2)} (used $${daySum.toFixed(2)})`
    );
    err.code = 'LIMIT_PER_DAY';
    throw err;
  }
  if (eventType === 'withdraw') {
    const bal = getBalance({ walletId: id }).cash_balance;
    if (bal - amt < 0) {
      const err = new Error(`Insufficient cash: balance $${bal.toFixed(2)}, requested $${amt.toFixed(2)}`);
      err.code = 'INSUFFICIENT_FUNDS';
      throw err;
    }
  }
  return { ok: true, amount: amt, limits: lim };
}

function newPendingId() {
  return crypto.randomBytes(8).toString('hex');
}

module.exports = {
  applyFund,
  applyWithdraw,
  applyTradeCashDelta,
  getBalance,
  checkLimits,
  validateAmount,
  limits,
  DEFAULT_WALLET_ID,
  newPendingId,
  assertPaperMode,
};
