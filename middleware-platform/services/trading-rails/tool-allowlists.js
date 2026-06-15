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
  execute: {
    confirm: ['paper_preview_order'],
    submit: ['paper_submit_order'],
  },
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
  return [...(laneMap[step] || laneMap[Object.keys(laneMap)[0]] || [])];
}

module.exports = { ALLOWLISTS, getAllowedToolNames };
