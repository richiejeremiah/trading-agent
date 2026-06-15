'use strict';

const { getAllowedToolNames } = require('./trading-rails/tool-allowlists');

class TradingToolExecutor {
  static getAllowedTools(lane, step) {
    return getAllowedToolNames(lane, step);
  }

  static async execute(toolName, _args, _context) {
    const err = new Error(`Trading tool not implemented: ${toolName}`);
    err.code = 'TRADING_TOOL_NOT_IMPLEMENTED';
    throw err;
  }
}

module.exports = TradingToolExecutor;
