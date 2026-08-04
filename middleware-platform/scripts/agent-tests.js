'use strict';

/**
 * Does the agent still behave the way it did?
 *
 * The backtest measures whether the strategy makes money. Nothing measured
 * whether the agent still works — whether a prompt edit removed a refusal,
 * whether a lane still exposes the tools it should, whether the executor still
 * dispatches every declared name. Those are different questions, and a change
 * could quietly alter the second while the first looked unchanged.
 *
 * This half needs no model, so it can run on every change. It covers the parts
 * that are deterministic: what the allowlists grant, what the prompt promises,
 * what the executor does with each tool name. Those are also where the bugs
 * have been — a misspelled step silently granted the first step's tools, which
 * nothing would have caught.
 *
 * What it deliberately does not cover: whether the model chooses the right tool
 * for a question. That needs a live call, is non-deterministic, and belongs in
 * a separate suite you run before something that matters rather than on every
 * save. Conflating the two gives you a suite too slow to run and too flaky to
 * believe.
 */

require('dotenv').config();

const assert = require('assert');
const { ALLOWLISTS, getAllowedToolNames } = require('../services/trading-rails/tool-allowlists');
const { normalizeState } = require('../services/trading-rails/state-schema');
const TradingToolExecutor = require('../services/trading-tool-executor');
const { resolveCaller } = require('../services/caller');

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
    failures.push(name + ': ' + e.message);
    console.log('  FAIL  ' + name + '\n        ' + e.message);
  }
}

(async () => {
  console.log('\nagent behaviour — no model required\n');

  // ---- allowlists --------------------------------------------------------

  await test('an unknown step grants nothing', () => {
    // This returned the first step's tools, so a typo — reveiw for review —
    // silently handed out the portfolio. An invalid input must refuse rather
    // than approximate.
    assert.deepStrictEqual(getAllowedToolNames('review', 'reveiw'), []);
    assert.deepStrictEqual(getAllowedToolNames('research', 'nonsense'), []);
  });

  await test('an unknown lane grants nothing', () => {
    assert.deepStrictEqual(getAllowedToolNames('nope', 'query'), []);
  });

  await test('the guard lane grants nothing, whatever the step', () => {
    // Rail 3 is cancelled by design. If this ever returns a tool, something has
    // reopened a lane that exists to be closed.
    for (const step of Object.keys(ALLOWLISTS.guard)) {
      assert.deepStrictEqual(getAllowedToolNames('guard', step), [], 'guard/' + step + ' granted tools');
    }
  });

  await test('no lane grants a tool that places an order', () => {
    // The strongest invariant here. Execution is not enabled, and the way it
    // would accidentally become enabled is a tool name appearing in a list
    // nobody re-read.
    // Verbs of action, not nouns. An earlier version matched /trade/ and
    // flagged get_trade_history, which reads history and places nothing —
    // a test that cries wolf gets muted, and then it protects nothing.
    const forbidden = /^(place|submit|execute|cancel|buy|sell)_|_(buy|sell)$|place_order|paper_buy|paper_sell/i;
    for (const [lane, steps] of Object.entries(ALLOWLISTS)) {
      for (const [step, tools] of Object.entries(steps)) {
        for (const t of tools) {
          assert.ok(
            !forbidden.test(t),
            lane + '/' + step + ' grants "' + t + '", which reads like an execution tool'
          );
        }
      }
    }
  });

  await test('every allowlisted tool is one the executor knows', async () => {
    // A tool the model can see but the executor cannot dispatch produces a
    // confident call and an error, which reads to a user as the agent being
    // broken rather than the feature being absent.
    const names = new Set();
    for (const steps of Object.values(ALLOWLISTS)) {
      for (const tools of Object.values(steps)) for (const t of tools) names.add(t);
    }

    for (const name of names) {
      let code = null;
      try {
        await TradingToolExecutor.execute(name, {}, {});
      } catch (e) {
        code = e.code;
      }
      assert.notStrictEqual(
        code,
        'TRADING_TOOL_UNKNOWN',
        'allowlists grant "' + name + '" but the executor does not know it'
      );
    }
  });

  // ---- state -------------------------------------------------------------

  await test('an invalid step cannot be persisted', () => {
    const s = normalizeState({ active_lane: 'review', step: 'reveiw' });
    assert.notStrictEqual(s.step, 'reveiw', 'a bad step was written through and would persist');
  });

  await test('the execute lane is redirected, not honoured', () => {
    // Rail 3 is cancelled. A stale session carrying it must not simply run.
    const s = normalizeState({ active_lane: 'execute', step: 'anything' });
    assert.ok(
      s.active_lane !== 'execute' || getAllowedToolNames(s.active_lane, s.step).length === 0,
      'the execute lane was honoured and granted tools'
    );
  });

  // ---- the executor ------------------------------------------------------

  await test('an unknown tool is refused by name', async () => {
    let code = null;
    try {
      await TradingToolExecutor.execute('definitely_not_a_tool', {}, {});
    } catch (e) {
      code = e.code;
    }
    assert.strictEqual(code, 'TRADING_TOOL_UNKNOWN');
  });

  await test('an unimplemented tool says so rather than inventing a result', async () => {
    // generate_signal is the strategy engine and is deliberately still a stub.
    // The failure mode that matters is it returning something plausible.
    let code = null;
    try {
      await TradingToolExecutor.execute('generate_signal', {}, {});
    } catch (e) {
      code = e.code;
    }
    assert.strictEqual(code, 'TRADING_TOOL_NOT_IMPLEMENTED');
  });

  await test('get_quote refuses a missing ticker', async () => {
    let code = null;
    try {
      await TradingToolExecutor.execute('get_quote', {}, {});
    } catch (e) {
      code = e.code;
    }
    assert.strictEqual(code, 'BAD_ARGS');
  });

  await test('a tool reading a portfolio is scoped to the caller', async () => {
    // Two identities must not see each other's positions. The scoping lives in
    // an argument, so it is one forgotten parameter away from leaking.
    const a = await TradingToolExecutor.execute('get_portfolio', {}, { identityId: 1 });
    const b = await TradingToolExecutor.execute('get_portfolio', {}, { identityId: 2 });
    const tickersOf = (r) => (r.positions || []).map((p) => p.ticker).sort().join(',');

    if (tickersOf(a) && tickersOf(a) === tickersOf(b)) {
      throw new Error('two identities returned identical holdings — check the scoping');
    }
  });

  // ---- the boundary ------------------------------------------------------

  await test('the agent refuses a caller it did not resolve', async () => {
    const { executeTurn } = require('../services/trading-rails/execute-turn');
    await assert.rejects(
      () => executeTurn({ sessionId: 'eval', identityId: 2, message: 'hello' }),
      /not a resolved caller/,
      'a bare identity id was accepted as a caller'
    );
  });

  await test('an unverified chat resolves to a refusal, not an identity', () => {
    const r = resolveCaller('telegram', '000000000');
    assert.strictEqual(r.ok, false);
  });

  await test('an unknown channel is refused rather than defaulted', () => {
    const r = resolveCaller('carrier_pigeon', 'x');
    assert.strictEqual(r.ok, false, 'a new ingress inherited access without declaring how it verifies');
  });

  // ---- the prompt --------------------------------------------------------

  await test('the system prompt still refuses execution', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../services/trading-rails/execute-turn.js'),
      'utf8'
    );

    // A prompt edit could remove this without any test noticing, and the agent
    // would start describing trades it had not made.
    assert.ok(
      /cannot place orders|execution is not enabled/i.test(src),
      'the prompt no longer tells the model it cannot place orders'
    );
    assert.ok(
      /never state a price you have not fetched/i.test(src),
      'the prompt no longer forbids quoting a remembered price'
    );
  });

  await test('the step budget is stated and finite', () => {
    const fs = require('fs');
    const src = fs.readFileSync(
      require('path').join(__dirname, '../services/trading-rails/execute-turn.js'),
      'utf8'
    );
    const m = src.match(/MAX_STEPS\s*=\s*(\d+)/);
    assert.ok(m, 'MAX_STEPS is gone — the loop may not terminate');
    const n = Number(m[1]);
    assert.ok(n > 0 && n <= 20, 'MAX_STEPS is ' + n + ', which is either useless or unbounded');
  });

  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  if (failed) {
    for (const f of failures) console.log('  ' + f);
    process.exit(1);
  }
  process.exit(0);
})();
