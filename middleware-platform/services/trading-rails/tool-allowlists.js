'use strict';

/**
 * Lane/step tool allowlists for the LLM agent.
 *
 * Hard rule: LLM tools are read + propose only.
 * NO submit / broker / alpaca_order tools — execution service owns broker.submitOrder.
 *
 * execute lane (Rail 3) — CANCELLED as a submit path; only propose/preview tools remain.
 */

const ALLOWLISTS = {
  research: {
    query: ['search_biotech_news', 'get_quote'],
    summarize: ['search_biotech_news', 'get_catalysts'],
  },
  signal: {
    analyze: ['generate_signal', 'propose_action'],
    preview: ['generate_signal', 'propose_action'],
  },
  // execute lane (Rail 3) — CANCELLED as broker submit; propose-only tools only
  execute: {
    // Preview / confirm UX only — never paper_submit_order or broker tools
    confirm: ['paper_preview_order', 'propose_action'],
    submit: ['paper_preview_order', 'propose_action'],
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
  // An unknown step grants nothing. This fell back to the first step's list,
  // so a misspelled step — reveiw for review — silently handed out whatever the
  // first step allowed. An invalid input should refuse, not approximate.
  if (!Object.prototype.hasOwnProperty.call(laneMap, step)) return [];
  return [...(laneMap[step] || [])];
}

/** Flatten all allowlisted tool names (for tests / docs). */
function listAllAllowedTools() {
  const names = new Set();
  for (const lane of Object.values(ALLOWLISTS)) {
    for (const tools of Object.values(lane)) {
      for (const t of tools) names.add(t);
    }
  }
  return [...names];
}

module.exports = { ALLOWLISTS, getAllowedToolNames, listAllAllowedTools };
