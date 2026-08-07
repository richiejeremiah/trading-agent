'use strict';

const { createProposedAction } = require('../services/policy/proposed-action');
const policyEngine = require('../services/policy/policy-engine');
const riskEngine = require('../services/risk/risk-engine');
const { evaluateOrderPipeline } = require('../services/policy/order-pipeline');

describe('Policy + Risk (Task 3)', () => {
  const prevKill = process.env.KILL_SWITCH;

  afterEach(() => {
    if (prevKill === undefined) delete process.env.KILL_SWITCH;
    else process.env.KILL_SWITCH = prevKill;
  });

  function midCap() {
    return createProposedAction({
      symbol: 'AAPL',
      side: 'buy',
      intent: 'open_long',
      reason: 'PEAD surprise positive',
      notional: 5000,
      qty: 25,
      price: 190,
      exchange: 'NASDAQ',
      avg_daily_volume: 50_000_000,
    });
  }

  it('kill switch rejects', () => {
    process.env.KILL_SWITCH = '1';
    const out = evaluateOrderPipeline(midCap(), { cash: 100000, equity: 100000 });
    expect(out.decision).toBe('REJECT');
    expect(out.reasons.some((r) => /KILL_SWITCH/i.test(r))).toBe(true);
    expect(out.policy.decision).toBe('ALLOW');
    expect(out.risk.decision).toBe('REJECT');
  });

  it('penny price < 1 rejects', () => {
    delete process.env.KILL_SWITCH;
    const action = createProposedAction({
      symbol: 'PENNY',
      side: 'buy',
      intent: 'open_long',
      reason: 'junk',
      notional: 100,
      qty: 200,
      price: 0.5,
      exchange: 'NYSE',
      avg_daily_volume: 2_000_000,
    });
    const risk = riskEngine.evaluate(action, { cash: 10000, equity: 10000 });
    expect(risk.decision).toBe('REJECT');
    expect(risk.reasons.some((r) => /penny/i.test(r))).toBe(true);

    const pipeline = evaluateOrderPipeline(action, { cash: 10000, equity: 10000 });
    expect(pipeline.decision).toBe('REJECT');
  });

  it('OTC exchange rejects', () => {
    delete process.env.KILL_SWITCH;
    const action = createProposedAction({
      symbol: 'OTCY',
      side: 'buy',
      intent: 'open_long',
      reason: 'otc',
      notional: 500,
      price: 5,
      exchange: 'OTC',
    });
    expect(riskEngine.evaluate(action).decision).toBe('REJECT');
  });

  it('allows clean mid-cap', () => {
    delete process.env.KILL_SWITCH;
    const out = evaluateOrderPipeline(midCap(), {
      cash: 100000,
      equity: 100000,
      currentExposure: 0,
    });
    expect(out.decision).toBe('ALLOW');
    expect(out.policy.decision).toBe('ALLOW');
    expect(out.risk.decision).toBe('ALLOW');
  });

  it('policy requires confirmation for large notional', () => {
    delete process.env.KILL_SWITCH;
    const action = createProposedAction({
      ...midCap(),
      notional: 50000,
      qty: 250,
    });
    const pol = policyEngine.evaluate(action, { confirmNotionalThreshold: 25000 });
    expect(pol.decision).toBe('REQUIRE_HUMAN_CONFIRMATION');
  });
});
