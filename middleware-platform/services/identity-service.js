'use strict';

/**
 * Proving who is on the other end of a Telegram chat.
 *
 * A chat id is not an identity. It is a number the platform assigns, visible to
 * anyone in the conversation, and reassignable. Binding a portfolio to one means
 * whoever holds that chat holds the portfolio.
 *
 * So an email is verified once and the chat id is bound to it. The code goes to
 * the email — not to Telegram, where the user demonstrably already is. Typing it
 * back proves they hold both.
 *
 * What this defends against, and what it does not:
 *
 *   It stops a stranger who finds the bot from acting as you. It stops a chat id
 *   being reused for a different identity without re-verification. It stops the
 *   bot being used to send unlimited mail to an address.
 *
 *   It does not defend against someone with access to your email, or to this
 *   database. For paper trading that is the right amount of security; before
 *   real execution it would not be.
 */

const crypto = require('crypto');
const { getDb } = require('../database');

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;

// Per hour. Enough to recover from a mistyped address, not enough to be a
// mailbomb tool aimed at someone else.
const MAX_CODES_PER_EMAIL_HOUR = 3;
const MAX_CODES_PER_CHAT_HOUR = 5;

function err(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * Six digits from a cryptographic source. Math.random is predictable enough
 * that a determined guesser with the attempt budget could do better than chance.
 */
function generateCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Hashed with a per-code salt. A readable code in the database is a code
 * anyone with read access can use, and this table is the whole authentication.
 */
function hashCode(code, salt) {
  return crypto.scryptSync(code, salt, 32).toString('hex');
}

function packHash(code) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + hashCode(code, salt);
}

function verifyHash(code, packed) {
  const [salt, expected] = String(packed).split(':');
  if (!salt || !expected) return false;
  const actual = hashCode(code, salt);
  // Constant time. A comparison that returns early on the first wrong byte
  // leaks how much of the code was right.
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function normaliseEmail(raw) {
  return String(raw || '').trim().toLowerCase();
}

function looksLikeEmail(e) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

/** Who this chat is, if it has been verified. */
function getIdentity(chatId) {
  const db = getDb();
  const row = db
    .prepare('SELECT id, email, chat_id, verified_at FROM agent_identity WHERE chat_id = ? AND verified_at IS NOT NULL')
    .get(String(chatId));
  return row || null;
}

function countRecent(column, value) {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM agent_auth_code
       WHERE ${column} = ? AND created_at > datetime('now', '-1 hour')`
    )
    .get(value);
  return row ? row.n : 0;
}

/**
 * Start verification. Returns the code so the caller can send it — this service
 * does not know how to send mail, deliberately, so the transport can be swapped
 * without touching the security logic.
 */
function requestCode(rawEmail, chatId) {
  const email = normaliseEmail(rawEmail);
  const chat = String(chatId || '').trim();

  if (!chat) return err('BAD_ARGS', 'A chat id is required.');
  if (!looksLikeEmail(email)) return err('BAD_EMAIL', 'That does not look like an email address.');

  if (countRecent('email', email) >= MAX_CODES_PER_EMAIL_HOUR) {
    return err('RATE_LIMITED', 'Too many codes requested for that address. Try again in an hour.');
  }
  if (countRecent('chat_id', chat) >= MAX_CODES_PER_CHAT_HOUR) {
    return err('RATE_LIMITED', 'Too many attempts from this chat. Try again in an hour.');
  }

  // An email already bound to a different chat is a re-link, and re-linking is
  // how an account gets taken over quietly. Refuse rather than reassign.
  const db = getDb();
  const existing = db
    .prepare('SELECT id, chat_id FROM agent_identity WHERE email = ? AND verified_at IS NOT NULL')
    .get(email);
  if (existing && existing.chat_id && existing.chat_id !== chat) {
    return err(
      'ALREADY_LINKED',
      'That address is already linked to a different chat. Unlink it there first.'
    );
  }

  const code = generateCode();

  try {
    db.prepare(
      `INSERT INTO agent_auth_code (email, chat_id, code_hash, expires_at)
       VALUES (?, ?, ?, datetime('now', '+${CODE_TTL_MINUTES} minutes'))`
    ).run(email, chat, packHash(code));
  } catch (e) {
    return err('DB_ERROR', e.message);
  }

  return { ok: true, data: { email, code, expiresInMinutes: CODE_TTL_MINUTES } };
}

/**
 * Finish verification. On success the chat id is bound to the email and that
 * binding is what owns positions from then on.
 */
function verifyCode(chatId, rawCode) {
  const chat = String(chatId || '').trim();
  const code = String(rawCode || '').trim();

  if (!chat) return err('BAD_ARGS', 'A chat id is required.');
  if (!/^\d{6}$/.test(code)) return err('BAD_CODE', 'The code is six digits.');

  const db = getDb();
  const row = db
    .prepare(
      `SELECT id, email, code_hash, attempts, expires_at FROM agent_auth_code
       WHERE chat_id = ? AND consumed_at IS NULL AND expires_at > datetime('now')
       ORDER BY id DESC LIMIT 1`
    )
    .get(chat);

  if (!row) return err('NO_PENDING_CODE', 'No code is waiting. Ask for a new one.');

  if (row.attempts >= MAX_ATTEMPTS) {
    return err('TOO_MANY_ATTEMPTS', 'Too many wrong attempts. Ask for a new code.');
  }

  if (!verifyHash(code, row.code_hash)) {
    db.prepare('UPDATE agent_auth_code SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    const left = MAX_ATTEMPTS - (row.attempts + 1);
    return err(
      'WRONG_CODE',
      left > 0 ? `That code is not right. ${left} attempts left.` : 'That code is not right. Ask for a new one.'
    );
  }

  try {
    const now = new Date().toISOString();
    db.prepare('UPDATE agent_auth_code SET consumed_at = ? WHERE id = ?').run(now, row.id);

    // One identity per email, one chat per identity.
    db.prepare(
      `INSERT INTO agent_identity (email, chat_id, channel, verified_at, last_seen_at)
       VALUES (?, ?, 'telegram', ?, ?)
       ON CONFLICT(email) DO UPDATE SET chat_id = excluded.chat_id, verified_at = excluded.verified_at, last_seen_at = excluded.last_seen_at`
    ).run(row.email, chat, now, now);

    const identity = getIdentity(chat);
    return { ok: true, data: identity };
  } catch (e) {
    return err('DB_ERROR', e.message);
  }
}

/** Break the binding. Requires re-verification to use the bot again. */
function unlink(chatId) {
  const db = getDb();
  const info = db
    .prepare('UPDATE agent_identity SET chat_id = NULL, verified_at = NULL WHERE chat_id = ?')
    .run(String(chatId));
  return { ok: true, data: { unlinked: info.changes > 0 } };
}

function touch(chatId) {
  try {
    getDb()
      .prepare('UPDATE agent_identity SET last_seen_at = ? WHERE chat_id = ?')
      .run(new Date().toISOString(), String(chatId));
  } catch {
    // Recording activity should never fail a turn.
  }
}

module.exports = {
  requestCode,
  verifyCode,
  getIdentity,
  unlink,
  touch,
  CODE_TTL_MINUTES,
  MAX_ATTEMPTS,
};
