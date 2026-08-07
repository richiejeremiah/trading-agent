'use strict';

const TradingToolExecutor = require('../services/trading-tool-executor');
const {
  assertProposeOnlyTool,
  isForbiddenToolName,
} = require('../services/trading-rails/propose-only-guard');
const {
  ALLOWLISTS,
  listAllAllowedTools,
} = require('../services/trading-rails/tool-allowlists');

describe('Propose-only agent (Task 6)', () => {
  it('rejects submit_order via propose-only-guard', () => {
    expect(isForbiddenToolName('submit_order')).toBe(true);
    const g = assertProposeOnlyTool('submit_order');
    expect(g.ok).toBe(false);
    expect(g.code).toBe('PROPOSE_ONLY_VIOLATION');
  });

  it('rejects broker and alpaca_order tool names', () => {
    for (const name of ['broker_submit', 'get_broker', 'alpaca_order', 'paper_submit_order']) {
      expect(assertProposeOnlyTool(name).ok).toBe(false);
    }
  });

  it('allows read and propose tool names', () => {
    for (const name of ['get_quote', 'propose_action', 'paper_preview_order', 'get_portfolio']) {
      expect(assertProposeOnlyTool(name).ok).toBe(true);
    }
  });

  it('TradingToolExecutor rejects submit_order before implementation', async () => {
    await expect(TradingToolExecutor.execute('submit_order', {}, {})).rejects.toMatchObject({
      code: 'PROPOSE_ONLY_VIOLATION',
    });
  });

  it('allowlists contain no submit/broker/alpaca_order tools', () => {
    const all = listAllAllowedTools();
    for (const name of all) {
      expect(isForbiddenToolName(name)).toBe(false);
    }
    expect(ALLOWLISTS.execute.submit).not.toContain('paper_submit_order');
    expect(JSON.stringify(ALLOWLISTS)).not.toMatch(/submit_order|alpaca_order/i);
  });
});
