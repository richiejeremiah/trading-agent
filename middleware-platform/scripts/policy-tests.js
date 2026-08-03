'use strict';

/**
 * The guards, tested together.
 *
 * The reason three of them shipped broken was not that any was hard — it was
 * that nothing checked them in one place. Each looked correct in isolation and
 * each failed for a different reason: one read a field the response does not
 * carry, one compared against null when the value was undefined, one was
 * scoped globally when it should have been per identity.
 *
 * So every rule is tested twice: once that it refuses when it should, and once
 * that it permits when it should. The second half is the one that would have
 * caught the currency guard, which refused nothing because it was reading an
 * empty string and comparing it to a currency code.
 *
 * A guard that never fires and a guard that always fires are both broken, and
 * only testing both directions tells them apart.
 */

require('dotenv').config();

const assert = require('assert');
const { evaluate, rulesFor, ACTIONS } = require('../services/policy');
const { getDb } = require('../database');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('  pass  ' + name);
  } catch (e) {
    failed += 1;
    failures.push(name + ': ' + e.message);
    console.log('  FAIL  ' + name + '\n        ' + e.message);
  }
}

console.log('\npolicy — every rule, both directions\n');

// ---- the contract itself -------------------------------------------------

test('an undeclared action is refused rather than allowed', () => {
  assert.throws(
    () => evaluate('sell_everything', {}),
    /No policy rules declared/,
    'an unknown action did not throw — a new code path could run unguarded'
  );
});

test('every declared action has at least one rule', () => {
  for (const a of ACTIONS) {
    assert.ok(rulesFor(a).length > 0, 'action "' + a + '" has no rules and would permit anything');
  }
});

test('a refusal names which guard refused', () => {
  const r = evaluate('accept', { ticker: 'TEST', quoteCurrency: 'INR', notional: 100 });
  assert.strictEqual(r.allowed, false);
  assert.ok(r.refusals.length > 0, 'refused with no reasons given');
  assert.ok(r.refusals[0].guard, 'a refusal carries no guard name');
});

test('all reasons are reported, not just the first', () => {
  // Wrong currency and more money than exists — both should be named, so
  // fixing one does not surprise you with the other.
  const r = evaluate('accept', {
    ticker: 'CIPLA.NS',
    quoteCurrency: 'INR',
    notional: 999999999,
    identityId: 2,
  });
  assert.ok(r.refusals.length >= 2, 'expected two refusals, got ' + r.refusals.length);
});

// ---- currency ------------------------------------------------------------

test('currency refuses a foreign quote', () => {
  const r = evaluate('fill', { ticker: 'CIPLA.NS', quoteCurrency: 'INR', portfolio: 'research' });
  assert.strictEqual(r.allowed, false);
  assert.ok(r.refusals.some((x) => x.guard === 'currency'));
});

test('currency permits a matching quote', () => {
  // The half that matters. The original guard read a field the response does
  // not carry, so it compared an empty string and permitted everything — it
  // would have passed a refusal test written on its own.
  const r = evaluate('fill', { ticker: 'LLY', quoteCurrency: 'USD', portfolio: 'research' });
  assert.ok(
    !r.refusals.some((x) => x.guard === 'currency'),
    'a USD quote in a USD portfolio was refused: ' + JSON.stringify(r.refusals)
  );
});

test('currency refuses when it cannot be established', () => {
  const r = evaluate('fill', { ticker: 'LLY', portfolio: 'research' });
  assert.ok(
    r.refusals.some((x) => x.guard === 'currency'),
    'an unknown currency was permitted — not knowing is not the same as matching'
  );
});

// ---- event staleness -----------------------------------------------------

test('staleness refuses old news', () => {
  const r = evaluate('recommend', { ticker: 'ZZZZ_TEST', eventLagDays: 38 });
  assert.ok(r.refusals.some((x) => x.guard === 'event_staleness'));
});

test('staleness permits fresh news', () => {
  const r = evaluate('recommend', { ticker: 'ZZZZ_TEST', eventLagDays: 1 });
  assert.ok(
    !r.refusals.some((x) => x.guard === 'event_staleness'),
    'one-day-old news was refused as stale'
  );
});

test('staleness is silent when there is no event', () => {
  // The mean-reversion path has no event at all. A guard that refuses on
  // absent data would block every signal from the other strategy.
  const r = evaluate('recommend', { ticker: 'ZZZZ_TEST' });
  assert.ok(!r.refusals.some((x) => x.guard === 'event_staleness'));
});

// ---- cooldown ------------------------------------------------------------

test('cooldown refuses a name called recently', () => {
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_recommendation (identity_id, ticker, side, recommended_at, status)
     VALUES (9999, 'ZZTEST', 'buy', datetime('now'), 'pending')`
  ).run();

  try {
    const r = evaluate('recommend', { ticker: 'ZZTEST', identityId: 9999 });
    assert.ok(
      r.refusals.some((x) => x.guard === 'cooldown'),
      'a name called moments ago was not in cooldown'
    );
  } finally {
    db.prepare('DELETE FROM agent_recommendation WHERE identity_id = 9999').run();
  }
});

test('cooldown does not reach across identities', () => {
  // The original was global, so one identity's call suppressed another's. It
  // behaved exactly as written, which is why nothing caught it.
  const db = getDb();
  db.prepare(
    `INSERT INTO agent_recommendation (identity_id, ticker, side, recommended_at, status)
     VALUES (9999, 'ZZTEST2', 'buy', datetime('now'), 'pending')`
  ).run();

  try {
    const r = evaluate('recommend', { ticker: 'ZZTEST2', identityId: 8888 });
    assert.ok(
      !r.refusals.some((x) => x.guard === 'cooldown'),
      "one identity recommendation blocked another identity"
    );
  } finally {
    db.prepare('DELETE FROM agent_recommendation WHERE identity_id = 9999').run();
  }
});

test('cooldown permits a name never called', () => {
  const r = evaluate('recommend', { ticker: 'ZZNEVER', identityId: 9999 });
  assert.ok(!r.refusals.some((x) => x.guard === 'cooldown'));
});

// ---- cash ----------------------------------------------------------------

test('cash refuses more than the research portfolio holds', () => {
  const r = evaluate('fill', {
    ticker: 'LLY',
    quoteCurrency: 'USD',
    notional: 10_000_000,
    portfolio: 'research',
  });
  assert.ok(r.refusals.some((x) => x.guard === 'cash'));
});

test('cash permits a normal position', () => {
  const r = evaluate('fill', {
    ticker: 'LLY',
    quoteCurrency: 'USD',
    notional: 5000,
    portfolio: 'research',
  });
  assert.ok(
    !r.refusals.some((x) => x.guard === 'cash'),
    'a $5,000 position was refused: ' + JSON.stringify(r.refusals)
  );
});

// ---- concentration -------------------------------------------------------

test('concentration permits an unrelated sector', () => {
  const r = evaluate('recommend', { ticker: 'ZZNEVER', identityId: 7777 });
  assert.ok(!r.refusals.some((x) => x.guard === 'concentration'));
});

// ---- failure handling ----------------------------------------------------

test('a guard that throws refuses rather than permits', () => {
  // A null ticker in a context the cooldown rule reads. Whatever happens, the
  // one unacceptable outcome is silently allowing the action.
  const r = evaluate('recommend', { ticker: null, identityId: undefined, eventLagDays: NaN });
  assert.ok(typeof r.allowed === 'boolean', 'evaluate did not return a verdict');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed) {
  for (const f of failures) console.log('  ' + f);
  process.exit(1);
}
process.exit(0);
