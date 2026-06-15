'use strict';

const { ALLOWLISTS, getAllowedToolNames } = require('../services/trading-rails/tool-allowlists');
const { normalizeState, TRADING_LANE } = require('../services/trading-rails/state-schema');

describe('trading-rails', () => {
  it('defines research lane allowlists', () => {
    expect(ALLOWLISTS.research).toBeDefined();
    expect(getAllowedToolNames('research', 'query')).toContain('search_biotech_news');
  });

  it('normalizes default state to research/query', () => {
    const s = normalizeState({});
    expect(s.active_lane).toBe(TRADING_LANE.RESEARCH);
    expect(s.step).toBe('query');
  });
});
