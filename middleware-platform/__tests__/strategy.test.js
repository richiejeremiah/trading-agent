'use strict';

const {
  computeSurprise,
  proposeFromEarnings,
  proposeFromFdaEvent,
  runStrategies,
  fda,
} = require('../services/strategy');
const { validateProposedActionShape } = require('../services/policy/proposed-action');

describe('Strategy (Task 5)', () => {
  describe('PEAD SUE', () => {
    it('computes arithmetic surprise (actual - consensus) / stdev', () => {
      expect(computeSurprise({ actual: 2.0, consensus: 1.5, stdev: 0.25 })).toBeCloseTo(2.0);
      expect(computeSurprise({ actual: 1.0, consensus: 1.5, stdev: 0.5 })).toBeCloseTo(-1.0);
    });

    it('proposes buy when surprise >= threshold', () => {
      const action = proposeFromEarnings({
        symbol: 'AAPL',
        actual: 2.5,
        consensus: 2.0,
        stdev: 0.2,
        price: 190,
        notional: 5000,
        exchange: 'NASDAQ',
        avg_daily_volume: 50_000_000,
      });
      expect(action).not.toBeNull();
      expect(action.side).toBe('buy');
      expect(action.intent).toBe('open_long');
      expect(action.reason).toMatch(/PEAD SUE=/);
      expect(validateProposedActionShape(action).ok).toBe(true);
    });

    it('returns null when |surprise| below threshold', () => {
      const action = proposeFromEarnings(
        {
          symbol: 'MSFT',
          actual: 1.05,
          consensus: 1.0,
          stdev: 0.2,
          notional: 1000,
        },
        { threshold: 1.0 }
      );
      // surprise = 0.25 < 1.0
      expect(action).toBeNull();
    });

    it('proposes sell on negative surprise past threshold', () => {
      const action = proposeFromEarnings({
        symbol: 'XBI',
        actual: 0.5,
        consensus: 1.5,
        stdev: 0.4,
        notional: 3000,
        price: 90,
      });
      // surprise = -2.5
      expect(action.side).toBe('sell');
      expect(action.intent).toBe('open_short');
    });
  });

  describe('FDA supply', () => {
    it('maps private company stub → ticker and proposes short', () => {
      const action = proposeFromFdaEvent({
        private_company: 'Acme Biologics',
        severity: 'shortage',
        summary: 'fill-finish capacity outage',
        notional: 2500,
        price: 12,
      });
      expect(action).not.toBeNull();
      expect(action.symbol).toBe('ACME');
      expect(action.side).toBe('sell');
      expect(action.intent).toBe('open_short');
      expect(action.reason).toMatch(/FDA supply/i);
      expect(validateProposedActionShape(action).ok).toBe(true);
    });

    it('resolveTicker uses PRIVATE_TO_TICKER stub', () => {
      expect(fda.resolveTicker({ private_company: 'northwind pharma' })).toBe('NWPH');
      expect(fda.resolveTicker({ symbol: 'PFE' })).toBe('PFE');
      expect(fda.resolveTicker({ private_company: 'unknown llc' })).toBeNull();
    });
  });

  describe('runStrategies', () => {
    it('aggregates PEAD + FDA proposals', () => {
      const actions = runStrategies({
        earnings: {
          symbol: 'LLY',
          actual: 3,
          consensus: 2,
          stdev: 0.5,
          notional: 4000,
          price: 800,
        },
        fdaEvents: [
          {
            private_company: 'Helio Therapeutics Private',
            severity: 'warning',
            notional: 2000,
            price: 20,
          },
        ],
      });
      expect(actions.length).toBe(2);
      expect(actions.map((a) => a.symbol).sort()).toEqual(['HLIO', 'LLY']);
    });
  });
});
