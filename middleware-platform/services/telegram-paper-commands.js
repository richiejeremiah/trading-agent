'use strict';

/**
 * Telegram paper-wallet slash commands.
 * Never mutates balance without /confirm_*; auth via assertTelegramCaller.
 */

const {
  assertTelegramCaller,
  moneyCommandsEnabled,
} = require('./telegram-auth');
const writer = require('./paper-wallet-writer');

function confirmTtlSec() {
  const n = Number(process.env.PAPER_WALLET_CONFIRM_TTL_SEC);
  return Number.isFinite(n) && n > 0 ? n : 60;
}

function defaultWalletId() {
  return writer.DEFAULT_WALLET_ID();
}

function getDb() {
  return require('../database').getDb();
}

function fmtUsd(n) {
  return `$${Number(n).toFixed(2)}`;
}

function parseCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  // Strip @BotName from /cmd@BotName
  const m = raw.match(/^\/([a-zA-Z0-9_]+)(?:@[^\s]+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return {
    name: m[1].toLowerCase(),
    args: (m[2] || '').trim(),
  };
}

function moneyCommands() {
  return new Set(['fund', 'deposit', 'withdraw', 'confirm_fund', 'confirm_withdraw', 'cancel']);
}

function upsertPending({ walletId, actorId, kind, amount, idempotencyKey, expiresAt, meta }) {
  getDb()
    .prepare(
      `INSERT INTO paper_wallet_pending (
         wallet_id, actor_id, pending_kind, amount, idempotency_key, expires_at, created_at, meta_json
       ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?)
       ON CONFLICT(wallet_id, actor_id) DO UPDATE SET
         pending_kind = excluded.pending_kind,
         amount = excluded.amount,
         idempotency_key = excluded.idempotency_key,
         expires_at = excluded.expires_at,
         created_at = datetime('now'),
         meta_json = excluded.meta_json`
    )
    .run(
      walletId,
      String(actorId),
      kind,
      amount,
      idempotencyKey,
      expiresAt,
      meta ? JSON.stringify(meta) : null
    );
}

function getPending(walletId, actorId) {
  return getDb()
    .prepare(`SELECT * FROM paper_wallet_pending WHERE wallet_id = ? AND actor_id = ?`)
    .get(walletId, String(actorId));
}

function clearPending(walletId, actorId) {
  getDb()
    .prepare(`DELETE FROM paper_wallet_pending WHERE wallet_id = ? AND actor_id = ?`)
    .run(walletId, String(actorId));
}

function isExpired(pending, now = new Date()) {
  if (!pending || !pending.expires_at) return true;
  const exp = Date.parse(pending.expires_at);
  if (!Number.isFinite(exp)) return true;
  return now.getTime() > exp;
}

function requireAuth(userId, chatId) {
  return assertTelegramCaller(userId, chatId);
}

function handleBalance(userId, chatId) {
  if (!moneyCommandsEnabled()) {
    return { reply: 'Paper wallet money commands are disabled (no TELEGRAM_ALLOWED_USER_IDS).' };
  }
  try {
    requireAuth(userId, chatId);
  } catch (e) {
    if (e.code === 'UNAUTHORIZED' || e.code === 'MONEY_COMMANDS_DISABLED') {
      return { reply: 'unauthorized', unauthorized: true };
    }
    throw e;
  }
  const bal = writer.getBalance();
  return { reply: `Paper balance: ${fmtUsd(bal.cash_balance)} (wallet ${bal.wallet_id})` };
}

function stageMoney({ kind, amountRaw, userId, chatId }) {
  if (!moneyCommandsEnabled()) {
    return { reply: 'Paper wallet money commands are disabled (no TELEGRAM_ALLOWED_USER_IDS).' };
  }
  let auth;
  try {
    auth = requireAuth(userId, chatId);
  } catch (e) {
    if (e.code === 'UNAUTHORIZED' || e.code === 'MONEY_COMMANDS_DISABLED') {
      return { reply: 'unauthorized', unauthorized: true };
    }
    throw e;
  }

  let amount;
  try {
    amount = writer.validateAmount(amountRaw);
  } catch (e) {
    return { reply: e.message || 'Invalid amount' };
  }

  try {
    writer.checkLimits({ eventType: kind, amount, actorId: auth.userId });
  } catch (e) {
    clearPending(defaultWalletId(), auth.userId);
    return { reply: e.message || 'Limit check failed' };
  }

  if (kind === 'withdraw') {
    const bal = writer.getBalance().cash_balance;
    if (bal - amount < 0) {
      return {
        reply: `Insufficient cash: balance ${fmtUsd(bal)}, requested ${fmtUsd(amount)}`,
      };
    }
  }

  const walletId = defaultWalletId();
  const pendingId = writer.newPendingId();
  const idempotencyKey = `tg:${auth.userId}:${pendingId}`;
  const ttl = confirmTtlSec();
  const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
  const replaced = !!getPending(walletId, auth.userId);

  upsertPending({
    walletId,
    actorId: auth.userId,
    kind,
    amount,
    idempotencyKey,
    expiresAt,
    meta: { chat_id: auth.chatId },
  });

  const bal = writer.getBalance({ walletId }).cash_balance;
  const after =
    kind === 'fund'
      ? Math.round((bal + amount) * 100) / 100
      : Math.round((bal - amount) * 100) / 100;
  const label = kind === 'fund' ? 'DEPOSIT' : 'WITHDRAWAL';
  const confirmCmd = kind === 'fund' ? '/confirm_fund' : '/confirm_withdraw';
  const replaceNote = replaced ? '\n(Replaced previous pending confirm.)' : '';
  return {
    reply:
      `Confirm paper ${label} of ${fmtUsd(amount)}?\n` +
      `Current balance: ${fmtUsd(bal)} → after: ${fmtUsd(after)}\n` +
      `Reply ${confirmCmd} within ${ttl}s, or /cancel` +
      replaceNote,
    pending: true,
  };
}

function handleConfirm({ expectedKind, userId, chatId, messageId }) {
  if (!moneyCommandsEnabled()) {
    return { reply: 'Paper wallet money commands are disabled (no TELEGRAM_ALLOWED_USER_IDS).' };
  }
  let auth;
  try {
    auth = requireAuth(userId, chatId);
  } catch (e) {
    if (e.code === 'UNAUTHORIZED' || e.code === 'MONEY_COMMANDS_DISABLED') {
      return { reply: 'unauthorized', unauthorized: true };
    }
    throw e;
  }

  const walletId = defaultWalletId();
  const pending = getPending(walletId, auth.userId);
  if (!pending) {
    return { reply: 'Nothing to confirm' };
  }
  if (isExpired(pending)) {
    clearPending(walletId, auth.userId);
    return { reply: 'Pending confirm expired. Start again with /fund or /withdraw.' };
  }
  if (pending.pending_kind !== expectedKind) {
    clearPending(walletId, auth.userId);
    return {
      reply: `Wrong confirm command for pending ${pending.pending_kind}. Pending cleared.`,
    };
  }

  const apply = expectedKind === 'fund' ? writer.applyFund : writer.applyWithdraw;
  const command = expectedKind === 'fund' ? '/fund+confirm_fund' : '/withdraw+confirm_withdraw';

  let result;
  try {
    result = apply({
      amount: pending.amount,
      actor: { type: 'telegram', id: auth.userId },
      reason: command,
      idempotencyKey: pending.idempotency_key,
      walletId,
      chatId: auth.chatId,
      command,
      requestMessageId: messageId,
      meta: { pending_amount: pending.amount },
    });
  } catch (e) {
    clearPending(walletId, auth.userId);
    return { reply: e.message || 'Mutation failed' };
  }

  clearPending(walletId, auth.userId);
  const verb = expectedKind === 'fund' ? 'Deposited' : 'Withdrew';
  const idemNote = result.idempotent ? ' (idempotent replay)' : '';
  return {
    reply:
      `${verb} ${fmtUsd(result.amount)}. New balance: ${fmtUsd(result.balance_after)}. ` +
      `Ledger #${result.ledger_id}${idemNote}`,
    result,
  };
}

function handleCancel(userId, chatId) {
  if (!moneyCommandsEnabled()) {
    return { reply: 'Paper wallet money commands are disabled (no TELEGRAM_ALLOWED_USER_IDS).' };
  }
  let auth;
  try {
    auth = requireAuth(userId, chatId);
  } catch (e) {
    if (e.code === 'UNAUTHORIZED' || e.code === 'MONEY_COMMANDS_DISABLED') {
      return { reply: 'unauthorized', unauthorized: true };
    }
    throw e;
  }
  const walletId = defaultWalletId();
  const pending = getPending(walletId, auth.userId);
  if (!pending) {
    return { reply: 'Nothing to cancel' };
  }
  clearPending(walletId, auth.userId);
  return { reply: 'Pending confirm cancelled.' };
}

/**
 * Handle a parsed Telegram message (or synthetic test input).
 * @param {{ userId: string|number, chatId?: string|number, text: string, messageId?: string|number }} msg
 * @returns {{ reply: string, unauthorized?: boolean, handled?: boolean }}
 */
function handlePaperCommand(msg) {
  const cmd = parseCommand(msg && msg.text);
  if (!cmd) {
    return { reply: null, handled: false };
  }

  const { userId, chatId, messageId } = msg;
  const name = cmd.name;

  if (name === 'balance') {
    return { ...handleBalance(userId, chatId), handled: true };
  }
  if (name === 'fund' || name === 'deposit') {
    if (!cmd.args) {
      return { reply: 'Usage: /fund <amount>', handled: true };
    }
    return { ...stageMoney({ kind: 'fund', amountRaw: cmd.args, userId, chatId }), handled: true };
  }
  if (name === 'withdraw') {
    if (!cmd.args) {
      return { reply: 'Usage: /withdraw <amount>', handled: true };
    }
    return { ...stageMoney({ kind: 'withdraw', amountRaw: cmd.args, userId, chatId }), handled: true };
  }
  if (name === 'confirm_fund') {
    return { ...handleConfirm({ expectedKind: 'fund', userId, chatId, messageId }), handled: true };
  }
  if (name === 'confirm_withdraw') {
    return {
      ...handleConfirm({ expectedKind: 'withdraw', userId, chatId, messageId }),
      handled: true,
    };
  }
  if (name === 'cancel') {
    return { ...handleCancel(userId, chatId), handled: true };
  }

  // Unknown slash — not our command
  if (moneyCommands().has(name)) {
    return { reply: 'Unknown money command', handled: true };
  }
  return { reply: null, handled: false };
}

module.exports = {
  handlePaperCommand,
  parseCommand,
  confirmTtlSec,
  clearPending,
  getPending,
};
