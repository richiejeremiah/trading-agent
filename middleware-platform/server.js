'use strict';

const path = require('path');
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
