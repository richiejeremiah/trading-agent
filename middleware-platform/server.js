'use strict';

const path = require('path');
const telegramBot = require('./services/telegram-bot');
require('dotenv').config({ path: path.join(__dirname, '.env') });
require('./utils/langsmith-config');

const express = require('express');
const cors = require('cors');
const { apiLimiter } = require('./middleware/rate-limiter');
const { errorHandler, notFoundHandler } = require('./middleware/error-handler');
const { healthCheckHandler, readinessCheck, livenessCheck } = require('./middleware/health-check');
const { registerTradingChatRoutes } = require('./routes/trading-chat');
const internalOps = require('./routes/internal-service-ops');

const PORT = parseInt(process.env.PORT || '4000', 10);
const app = express();

app.set('trust proxy', 1);
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(apiLimiter);

app.get('/health', healthCheckHandler);
app.get('/ready', readinessCheck);
app.get('/live', livenessCheck);

registerTradingChatRoutes(app, { apiLimiter, express });
app.use('/api/internal', internalOps);

const dashboardRoot = path.join(__dirname, '..', 'unified-dashboard');
app.use('/trading', express.static(path.join(dashboardRoot, 'trading')));
app.use('/assets', express.static(path.join(dashboardRoot, 'assets')));
app.get('/', (_req, res) => res.redirect('/trading/trading-chat.html'));

app.use(notFoundHandler);
app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`[somo-trading] listening on http://localhost:${PORT}`);
    console.log(`[somo-trading] mode=${process.env.TRADING_MODE || 'paper'}`);
  });
}

module.exports = app;


// Started last, and only when both are set. A bot with no agent behind it is
// worse than no bot.
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TRADING_AGENT_ENABLED === '1') {
  telegramBot.start();
}


// The daily cycle. Off unless asked for, because a process that trades on a
// timer should be started deliberately.
if (process.env.SCHEDULER_ENABLED === '1') {
  const scheduler = require('./services/scheduler');
  scheduler.start(async (chatId, text) => {
    try {
      await telegramBot.notify(chatId, text, true);
    } catch (e) {
      console.warn('[scheduler] notify failed:', e.message);
    }
  });
}
