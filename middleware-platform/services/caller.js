'use strict';

/**
 * Who is asking.
 *
 * Identity used to be a number passed inward by convention. Each ingress
 * decided what to send — the bot sent a verified id, the web path sent null —
 * and executeTurn took whatever arrived: `identityId: opts.identityId ?? null`.
 * Nothing verified it. Anything able to call executeTurn could claim to be any
 * identity, and every guard downstream trusts that claim: cooldown, sub-sector
 * caps and wallet balances all key on it. One forged number defeats all of
 * them at once.
 *
 * So identity stops being a value and becomes an object that only this module
 * can mint. A bare `{ id: 2 }` is not a caller. The brand is a module-private
 * symbol, so forging one requires reaching inside this file rather than
 * guessing a number.
 *
 * What this defends against: a new ingress passing an unverified id, code
 * fabricating an identity, and the quieter case of a call site forgetting to
 * pass one at all — which used to become null and land silently in the
 * unowned bucket.
 *
 * What it does not: anything with access to this process or this database.
 * The brand is a correctness boundary, not a security one, and the distinction
 * matters before real money is involved.
 */

const identity = require('./identity-service');

/** Private. A caller object is only genuine if it carries this. */
const BRAND = Symbol('verified-caller');

function err(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * A caller who has proven who they are.
 *
 * Frozen, so a holder cannot promote themselves to another identity after the
 * fact — the object that arrives at a guard is the one the resolver made.
 */
function mintVerified(row, channel) {
  return Object.freeze({
    [BRAND]: true,
    kind: 'verified',
    identityId: row.id,
    email: row.email,
    channel,
    resolvedAt: new Date().toISOString(),
  });
}

/**
 * A caller who has not.
 *
 * Explicit rather than null. The web surface has no verification, and saying
 * so is better than passing nothing and letting it land in the unowned bucket
 * by accident — one of those is a decision, the other is a bug that looks like
 * a decision.
 */
function mintAnonymous(channel, reason) {
  return Object.freeze({
    [BRAND]: true,
    kind: 'anonymous',
    identityId: null,
    email: null,
    channel,
    reason: reason || 'this channel does not verify identity',
    resolvedAt: new Date().toISOString(),
  });
}

/**
 * Resolve who is asking, for a channel and whatever that channel uses to
 * identify people.
 *
 * Telegram uses a chat id, which is a claim rather than a credential — anyone
 * can send any chat id to the Bot API. It only means something because the
 * enrolment flow bound it to a verified email, and this is where that binding
 * is checked.
 */
function resolveCaller(channel, rawId) {
  const ch = String(channel || '').trim().toLowerCase();

  if (!ch) return err('BAD_ARGS', 'A channel is required to resolve a caller.');

  if (ch === 'web') {
    // No verification exists for the browser surface. Anonymous, deliberately,
    // and it gets nothing that belongs to anyone.
    return { ok: true, data: mintAnonymous('web', 'the web surface has no identity verification') };
  }

  if (ch === 'telegram') {
    const chatId = String(rawId || '').trim();
    if (!chatId) return err('BAD_ARGS', 'A chat id is required.');

    const row = identity.getIdentity(chatId);
    if (!row) {
      return err(
        'UNVERIFIED',
        'This chat has not been verified. Send /start to link an email address.'
      );
    }
    return { ok: true, data: mintVerified(row, 'telegram') };
  }

  // An unknown channel is refused rather than defaulted. A new ingress should
  // have to state how it establishes identity, not inherit whatever happens to
  // be least restrictive.
  return err(
    'UNKNOWN_CHANNEL',
    'No identity rule for channel "' + ch + '". Add one to caller.js before using it.'
  );
}

/**
 * Is this a caller this module made?
 *
 * The check that makes the rest worthwhile. Without it the object is just a
 * shape anyone can imitate.
 */
function isCaller(x) {
  return !!x && typeof x === 'object' && x[BRAND] === true;
}

function isVerified(x) {
  return isCaller(x) && x.kind === 'verified' && Number.isFinite(x.identityId);
}

/**
 * Refuse anything that is not a genuine caller.
 *
 * Called at every boundary that acts on someone's behalf. Throws rather than
 * returning a union, because a bare number arriving here is a programming
 * error and should stop, not degrade into an anonymous session that quietly
 * reads the wrong portfolio.
 */
function assertCaller(x, where) {
  if (!isCaller(x)) {
    throw new Error(
      (where || 'this call') +
        ' was given something that is not a resolved caller. Use resolveCaller() at the ingress; ' +
        'a bare identity id is a claim, not a verification.'
    );
  }
  return x;
}

/** For the wallet and the guards, which key on a number. */
function identityIdOf(caller) {
  assertCaller(caller, 'identityIdOf');
  return caller.identityId;
}

module.exports = {
  resolveCaller,
  isCaller,
  isVerified,
  assertCaller,
  identityIdOf,
  // Exported for tests only. Minting a caller anywhere else defeats the point.
  __mintAnonymousForTests: mintAnonymous,
};
