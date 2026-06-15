'use strict';

const express = require('express');
const { handleTradingChatMessage } = require('../services/trading-chat-service');

function registerTradingChatRoutes(app, deps = {}) {
  const { apiLimiter, express: exp } = deps;
  const json = exp ? exp.json() : express.json();

  app.post('/api/trading/chat/turn', apiLimiter || ((req, res, next) => next()), json, async (req, res) => {
    try {
      const out = await handleTradingChatMessage(req);
      return res.status(out.status).json(out.json);
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  });
}

module.exports = { registerTradingChatRoutes };
