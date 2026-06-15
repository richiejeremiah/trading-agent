'use strict';

const express = require('express');
const router = express.Router();
const { isPineconeConfigured } = require('../services/pinecone-rest');

router.get('/status', (_req, res) => {
  res.json({
    success: true,
    product: 'somo-trading',
    mode: process.env.TRADING_MODE || 'paper',
    pinecone: isPineconeConfigured() ? 'configured' : 'not_configured',
  });
});

module.exports = router;
