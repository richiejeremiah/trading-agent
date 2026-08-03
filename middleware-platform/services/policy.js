'use strict';

/**
 * Whether an action is allowed.
 *
 * The guards used to be four mechanisms in four files with three different
 * return shapes: a boolean the caller had to remember to negate, an object with
 * an `allowed` field, an inline `if` with no function at all, and a number the
 * caller compared itself. There was nowhere to ask "would this be permitted?"
 * — you had to know which four things to call, in which order, and what each
 * one returned.
 *
 * Three of them shipped broken. Not because any was hard, but because nothing
 * checked them together: one read a field the response does not carry, one
 * compared against null when the value was undefined, one was scoped globally
 * when it should have been per identity. Each looked right in isolation.
 *
 * So: one function, one shape, one test file. Callers ask; they do not decide.
 *
 * The rules declare which actions they apply to, and evaluate() refuses an
 * action nobody has declared rules for. That is the part that matters for
 * later — a new action path cannot quietly inherit no guards, because it has
 * to be registered before it will run at all.
 */

const { getDb } = require('../database');
const { subSectorOf, MAX_PER_SUB_SECTOR, MAX_PENDING_PER_SUB_SECTOR } = require('./sub-sectors');

/** Actions that can be evaluated. Anything else is refused, loudly. */
const ACTIONS = ['recommend', 'fill', 'accept'];

const COOLDOWN_DAYS = Number(process.env.SIGNAL_COOLDOWN_DAYS || 14);
const MAX_EVENT_LAG_DAYS = Number(process.env.SIGNAL_MAX_EVENT_LAG_DAYS || 5);
const STARTING_BALANCE = Number(process.env.PAPER_STARTING_BALANCE || 100000);
const PORTFOLIO_CURRENCY = (process.env.PAPER_WALLET_CURRENCY || 'USD').toUpperCase();

/**
 * A rule.
 *
 *   applies  — which actions it governs. A rule that applies to nothing is
 *              dead, and a rule missing from an action is a hole.
 *   check    — returns null to allow, or a reason string to refuse.
 *
 * Reasons are written for the person reading them, not for a log. "already
 * holding 2 in managed_care (ELV, CNC)" tells you what to do; "CONCENTRATION"
 * does not.
 */
const RULES = [
  {
    name: 'cooldown',
    applies: ['recommend'],
    check(ctx) {
      if (!ctx.ticker) return null;

      // Per identity. This was global once, so one person's test call silently
      // suppressed another person's real signal — a bug that behaved exactly
      // as written and was invisible for it.
      const row = getDb()
        .prepare(
          `SELECT recommended_at FROM agent_recommendation
           WHERE ticker = ? AND identity_id IS ?
             AND recommended_at > datetime('now', '-' || ? || ' days')
           ORDER BY recommended_at DESC LIMIT 1`
        )
        .get(ctx.ticker, ctx.identityId ?? null, COOLDOWN_DAYS);

      return row
        ? ctx.ticker + ' was already called on ' + String(row.recommended_at).slice(0, 10) +
          ', within the ' + COOLDOWN_DAYS + '-day cooldown'
        : null;
    },
  },

  {
    name: 'concentration',
    applies: ['recommend'],
    check(ctx) {
      if (!ctx.ticker) return null;

      const db = getDb();
      const sector = subSectorOf(ctx.ticker);

      const held = db
        .prepare('SELECT ticker FROM paper_positions WHERE identity_id IS ? AND quantity > 0')
        .all(ctx.identityId ?? null)
        .filter((p) => subSectorOf(p.ticker) === sector);

      if (held.length >= MAX_PER_SUB_SECTOR) {
        return 'already holding ' + held.length + ' in ' + sector +
          ' (' + held.map((h) => h.ticker).join(', ') + ')';
      }

      const waiting = db
        .prepare("SELECT ticker FROM agent_recommendation WHERE identity_id IS ? AND status = 'pending'")
        .all(ctx.identityId ?? null)
        .filter((r) => subSectorOf(r.ticker) === sector);

      if (waiting.length >= MAX_PENDING_PER_SUB_SECTOR) {
        return 'already ' + waiting.length + ' pending in ' + sector +
          ' (' + waiting.map((r) => r.ticker).join(', ') + ')';
      }

      return null;
    },
  },

  {
    name: 'event_staleness',
    applies: ['recommend'],
    check(ctx) {
      if (typeof ctx.eventLagDays !== 'number') return null;

      // News the market absorbed weeks ago has no overreaction left to fade.
      // Acting on it would make the event strategy indistinguishable from
      // mean reversion, and the comparison between them meaningless.
      return ctx.eventLagDays > MAX_EVENT_LAG_DAYS
        ? 'the event was ' + ctx.eventLagDays + ' days old when first seen, past the ' +
          MAX_EVENT_LAG_DAYS + '-day limit'
        : null;
    },
  },

  {
    name: 'currency',
    applies: ['fill', 'accept'],
    check(ctx) {
      if (!ctx.quoteCurrency) {
        // Not knowing is a refusal, not a pass. A fill in an unknown currency
        // produces a position whose value cannot be added to anything.
        return 'the quote currency for ' + (ctx.ticker || 'this instrument') + ' could not be established';
      }

      const q = String(ctx.quoteCurrency).toUpperCase();
      return q === PORTFOLIO_CURRENCY
        ? null
        : ctx.ticker + ' is quoted in ' + q + ' and the portfolio holds ' +
          PORTFOLIO_CURRENCY + '; converting would need a rate this does not have';
    },
  },

  {
    name: 'cash',
    applies: ['fill', 'accept'],
    check(ctx) {
      if (typeof ctx.notional !== 'number' || ctx.notional <= 0) return null;

      const db = getDb();

      // The research portfolio's balance is derived rather than stored: it
      // takes every signal and never had a wallet row, so it could deploy money
      // it did not have and report a return against a balance that constrained
      // nothing.
      const available =
        ctx.portfolio === 'research'
          ? STARTING_BALANCE +
            db.prepare("SELECT COALESCE(SUM(realized_pnl), 0) v FROM trade WHERE portfolio = 'research' AND status = 'closed'").get().v -
            db.prepare("SELECT COALESCE(SUM(net_notional), 0) v FROM trade WHERE portfolio = 'research' AND status = 'open'").get().v
          : (db.prepare('SELECT cash FROM agent_wallet WHERE identity_id = ?').get(ctx.identityId) || { cash: 0 }).cash;

      return ctx.notional > available
        ? 'needs ' + ctx.notional.toFixed(2) + ' and the ' +
          (ctx.portfolio === 'research' ? 'research portfolio' : 'wallet') +
          ' holds ' + available.toFixed(2)
        : null;
    },
  },
];

/**
 * Would this be allowed?
 *
 * Returns every reason it would not, rather than the first. A caller fixing one
 * refusal only to hit another is a worse experience than being told both, and
 * for a log it is the difference between one cause and the whole picture.
 */
function evaluate(action, context) {
  if (!ACTIONS.includes(action)) {
    // A new action path must declare itself. Defaulting to "allowed" would let
    // a future code path inherit no guards at all and look fine doing it.
    throw new Error(
      'No policy rules declared for action "' + action + '". ' +
        'Add it to ACTIONS in policy.js and state which rules apply, rather than ' +
        'letting a new path run unguarded.'
    );
  }

  const ctx = context || {};
  const refusals = [];

  for (const rule of RULES) {
    if (!rule.applies.includes(action)) continue;

    let reason;
    try {
      reason = rule.check(ctx);
    } catch (e) {
      // A guard that throws has not allowed anything. Treating an error as a
      // pass is how a broken check becomes an open door.
      reason = 'could not be evaluated: ' + e.message;
    }

    if (reason) refusals.push({ guard: rule.name, reason });
  }

  return {
    allowed: refusals.length === 0,
    refusals,
    // The first reason, for somewhere a single line has to do.
    reason: refusals.length ? refusals[0].reason : null,
    action,
  };
}

/** Which rules govern an action — for tests, and for explaining a refusal. */
function rulesFor(action) {
  return RULES.filter((r) => r.applies.includes(action)).map((r) => r.name);
}

module.exports = { evaluate, rulesFor, ACTIONS, RULES };
