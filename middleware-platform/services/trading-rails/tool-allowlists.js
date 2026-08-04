'use strict';

const ALLOWLISTS = {
  research: {
    query: ['search_biotech_news', 'get_quote'],
    summarize: ['search_biotech_news', 'get_catalysts'],
  },
  signal: {
    analyze: ['generate_signal'],
    preview: ['generate_signal'],
  },
  // execute lane (Rail 3) — CANCELLED
  review: {
    portfolio: ['get_portfolio', 'get_trade_history'],
    postmortem: ['get_trade_history'],
  },
  guard: {
    block: [],
  },
};

function getAllowedToolNames(lane, step) {
  const laneMap = ALLOWLISTS[lane];
  if (!laneMap) return [];
  // An unknown step grants nothing. This fell back to the first step's list,
  // so a misspelled step — reveiw for review — silently handed out whatever the
  // first step allowed. An invalid input should refuse, not approximate.
  if (!Object.prototype.hasOwnProperty.call(laneMap, step)) return [];
  return [...(laneMap[step] || [])];
}

module.exports = { ALLOWLISTS, getAllowedToolNames };
