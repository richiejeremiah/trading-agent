'use strict';

/**
 * Tests for the failures that do not throw.
 *
 * Every serious bug in this system so far ran to completion and produced wrong
 * data. None would have been caught by a test that only checked for exceptions:
 *
 *   resolveCompanyName called without await — every FDA event unresolved, 70 of
 *   70, while the code reported success.
 *
 *   best.close written as best.ose — returned undefined, which passed a
 *   `!== null` guard, and NULL went to the database.
 *
 *   A currency guard reading series.data.currency, a field that response does
 *   not carry — the check was always empty and always passed.
 *
 *   captured_at used as the point-in-time anchor — correct for live ingest,
 *   meaningless for backfill, and it zeroed every signal silently.
 *
 * So these tests assert on behaviour a broken version would get wrong, not on
 * the absence of errors. Several deliberately feed in bad data and require a
 * refusal: a guard that has never been seen to fire is not a guard.
 */

const assert = require('assert');
const { getDb } = require('../database');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('  pass  ' + name);
  } catch (e) {
    failed += 1;
    failures.push({ name, message: e.message });
    console.log('  FAIL  ' + name + '\n        ' + e.message);
  }
}

(async () => {
  console.log('\nintegration tests — the silent failure class\n');

  // ---- Promises returned where a value was expected -----------------------

  await test('async services are actually async, and callers must await them', async () => {
    const resolver = require('../services/entity-resolver');
    const result = resolver.resolveCompanyName('Eli Lilly and Company');

    // If this ever stops being a Promise, every existing `await` site still
    // works — but if it IS a Promise and a caller forgets, `.ok` is undefined
    // and the failure is silent. The test records which it is, so the change
    // is visible rather than discovered in production data.
    assert.ok(
      typeof result.then === 'function',
      'resolveCompanyName no longer returns a Promise — check every call site before relying on this'
    );

    const awaited = await result;
    assert.ok(awaited.ok === true || awaited.ok === false, 'result must carry an explicit ok');
  });

  await test('a forgotten await produces a value with no ok field', async () => {
    const resolver = require('../services/entity-resolver');
    const notAwaited = resolver.resolveCompanyName('Pfizer Inc.');

    // This is what the bug looked like: truthy, no ok, falls to the else branch.
    assert.strictEqual(
      notAwaited.ok,
      undefined,
      'a Promise should not expose ok — if it does, the shape changed'
    );
    await notAwaited;
  });

  // ---- Response shapes the code reads -------------------------------------

  await test('getCurrentPrice returns every field its callers read', async () => {
    const { getCurrentPrice } = require('../services/market-data-client');
    const r = await getCurrentPrice('XLV');
    assert.ok(r.ok, 'could not price XLV: ' + (r.error && r.error.message));

    for (const field of ['ticker', 'price', 'currency', 'timestamp']) {
      assert.notStrictEqual(
        r.data[field],
        undefined,
        'getCurrentPrice no longer returns ' + field + ' — anything reading it now gets undefined'
      );
    }
    assert.ok(Number.isFinite(r.data.price), 'price must be a finite number');
  });

  await test('getHistoricalPrices bars carry the fields the scorer and backtest read', async () => {
    const { getHistoricalPrices } = require('../services/market-data-client');
    const r = await getHistoricalPrices('XLV', { range: '1mo', interval: '1d' });
    assert.ok(r.ok, 'could not fetch bars');

    const bar = r.data.quotes[r.data.quotes.length - 1];
    for (const field of ['date', 'open', 'high', 'low', 'close', 'volume']) {
      assert.notStrictEqual(bar[field], undefined, 'bars no longer carry ' + field);
    }
  });

  await test('getHistoricalPrices does NOT carry currency — the guard must not read it there', async () => {
    const { getHistoricalPrices } = require('../services/market-data-client');
    const r = await getHistoricalPrices('CIPLA.NS', { range: '1mo', interval: '1d' });
    assert.ok(r.ok);

    // Recorded deliberately. A currency guard once read this field, found
    // undefined, and passed everything. If this ever starts returning a
    // currency the guard can be simplified — but until then, reading it here
    // is a silent no-op.
    assert.strictEqual(
      r.data.currency,
      undefined,
      'getHistoricalPrices now returns a currency — the trade-service guard can be simplified'
    );
  });

  // ---- Guards that must actually fire -------------------------------------

  await test('the entity resolver refuses a company it cannot match', async () => {
    const { resolveCompanyName } = require('../services/entity-resolver');
    const r = await resolveCompanyName('Definitely Not A Listed Company LLC');
    assert.strictEqual(r.ok, false, 'resolver returned a match for a fictional company');
  });

  await test('the entity resolver does not confuse Merck KGaA with Merck & Co', async () => {
    const { resolveCompanyName } = require('../services/entity-resolver');
    const r = await resolveCompanyName('Merck KGaA');

    // A wrong attribution is worse than a missing one: it puts a German
    // chemicals company's recall on an American pharma ticker.
    assert.ok(
      r.ok === false || r.data.ticker !== 'MRK',
      'Merck KGaA resolved to MRK — that is a wrong attribution, not a near miss'
    );
  });

  await test('a currency mismatch is refused rather than converted', async () => {
    const wallet = require('../services/wallet-service');
    const db = getDb();

    const rec = await wallet.recordRecommendation({
      identityId: 999,
      ticker: 'CIPLA.NS',
      side: 'buy',
      rationale: 'integration test',
    });
    assert.ok(rec.ok, 'could not record the test recommendation');

    const accepted = await wallet.acceptRecommendation(999, rec.data.id, 1000);
    assert.strictEqual(accepted.ok, false, 'an INR stock was bought with a USD wallet');
    assert.strictEqual(accepted.error.code, 'CURRENCY_MISMATCH', 'refused for the wrong reason');

    db.prepare('DELETE FROM agent_recommendation WHERE identity_id = 999').run();
    db.prepare('DELETE FROM agent_wallet WHERE identity_id = 999').run();
    db.prepare('DELETE FROM agent_wallet_ledger WHERE identity_id = 999').run();
  });

  await test('an empty file write is refused', async () => {
    let executeCreateFile;
    try {
      // Belongs to the tooling repository, not this one. Skipped rather than
      // failed when absent — a missing neighbour is not a bug here.
      ({ executeCreateFile } = require('../../src/ai/fileEdit.js'));
    } catch {
      return;
    }
    const os = require('os');
    const r = executeCreateFile(os.tmpdir(), { filePath: 'integration-test-empty.js', contents: '   ' });
    assert.strictEqual(r.error !== undefined, true, 'an empty file was created and reported as success');
  }).catch(() => {
    // fileEdit belongs to the other repository; skipped when not present.
  });

  // ---- Timestamp semantics ------------------------------------------------

  await test('kg_event distinguishes when it happened from when we saw it', async () => {
    const db = getDb();
    const cols = db.prepare("SELECT name FROM pragma_table_info('kg_event')").all().map((c) => c.name);

    assert.ok(cols.includes('published_at'), 'kg_event lost published_at');
    assert.ok(cols.includes('captured_at'), 'kg_event lost captured_at');

    // The distinction that matters: published_at is when the market could have
    // known, captured_at is when this system did. Using the second as a
    // point-in-time anchor made every backfilled signal measure zero.
    const row = db
      .prepare('SELECT published_at, captured_at FROM kg_event WHERE published_at IS NOT NULL LIMIT 1')
      .get();

    if (row) {
      assert.notStrictEqual(row.published_at, null, 'an event with no publication date is unusable');
    }
  });

  await test('a stale event does not generate an event signal', async () => {
    const db = getDb();
    const stale = db
      .prepare(
        "SELECT COUNT(*) n FROM agent_recommendation WHERE strategy = 'fda_overreaction' " +
        "AND evidence LIKE '%\"lag_days\":%' AND status = 'pending'"
      )
      .get();

    // The rule: an event learned about weeks late has no overreaction left to
    // fade, and acting on it would make this strategy indistinguishable from
    // mean reversion.
    const pending = db
      .prepare("SELECT evidence FROM agent_recommendation WHERE strategy = 'fda_overreaction' AND status = 'pending'")
      .all();

    for (const p of pending) {
      const ev = JSON.parse(p.evidence || '[]');
      const fda = ev.find((e) => e.type === 'fda_event');
      if (fda && typeof fda.lag_days === 'number') {
        assert.ok(fda.lag_days <= 5, 'a pending event signal has a lag of ' + fda.lag_days + ' days');
      }
    }
    assert.ok(stale.n >= 0);
  });

  // ---- Trade lifecycle integrity ------------------------------------------

  await test('a trade is never filled at the price that triggered it', async () => {
    const db = getDb();
    const filled = db
      .prepare("SELECT id, ticker, signal_price, fill_price FROM trade WHERE portfolio = 'research' AND status IN ('open','closed') AND signal_price IS NOT NULL")
      .all();

    for (const t of filled) {
      // Identical to the cent is possible but suspicious — it is what using the
      // close to both decide and execute looks like.
      if (t.signal_price === t.fill_price) {
        throw new Error(
          'trade #' + t.id + ' (' + t.ticker + ') filled at exactly its signal price — check the fill logic for lookahead'
        );
      }
    }
    assert.ok(true);
  });

  await test('a closed trade has everything needed to score it', async () => {
    const db = getDb();
    const closed = db.prepare("SELECT * FROM trade WHERE status = 'closed'").all();

    for (const t of closed) {
      for (const field of ['fill_price', 'exit_price', 'realized_pnl', 'realized_excess_pct', 'exit_reason']) {
        assert.notStrictEqual(
          t[field],
          null,
          'closed trade #' + t.id + ' has no ' + field + ' — it cannot be scored and should have been marked invalid'
        );
      }
    }
    assert.ok(true);
  });

  await test('costs are charged on every filled trade', async () => {
    const db = getDb();
    const zeroCost = db
      .prepare("SELECT id, ticker FROM trade WHERE status IN ('open','closed') AND (costs IS NULL OR costs = 0)")
      .all();

    assert.strictEqual(
      zeroCost.length,
      0,
      zeroCost.length + ' filled trade(s) carry no cost — a free fill is not a real one'
    );
  });

  // ---- Health -------------------------------------------------------------

  await test('the health check notices stale bars', async () => {
    const { runHealthChecks } = require('../services/health-service');
    const r = await runHealthChecks({ verbose: false });

    const bars = r.data.checks.find((c) => c.name === 'bars');
    assert.ok(bars, 'the bars check disappeared');
    assert.ok(
      bars.detail.includes('newest'),
      'the bars check no longer reports the newest bar date — staleness would be invisible'
    );
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  if (failed) {
    for (const f of failures) console.log('  ' + f.name + ': ' + f.message);
    process.exit(1);
  }
  process.exit(0);
})();
