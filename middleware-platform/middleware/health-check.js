/**
 * Trading platform health check
 */

const db = require('../database');

async function checkDatabase() {
  try {
    const row = db.getDb().prepare('SELECT 1 AS test').get();
    return { healthy: !!row };
  } catch (e) {
    return { healthy: false, error: e.message };
  }
}

async function healthCheckHandler(req, res) {
  const dbCheck = await checkDatabase();
  const mode = process.env.TRADING_MODE || 'paper';
  const body = {
    status: dbCheck.healthy ? 'ok' : 'unhealthy',
    product: 'somo-trading',
    mode,
    timestamp: new Date().toISOString(),
    service: 'middleware-platform',
  };
  res.status(dbCheck.healthy ? 200 : 503).json(body);
}

async function readinessCheck(req, res) {
  const dbCheck = await checkDatabase();
  if (!dbCheck.healthy) {
    return res.status(503).json({ ready: false, reason: 'database_unavailable' });
  }
  res.json({ ready: true });
}

function livenessCheck(_req, res) {
  res.json({ alive: true });
}

module.exports = {
  healthCheckHandler,
  readinessCheck,
  livenessCheck,
};
