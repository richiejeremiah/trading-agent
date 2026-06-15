#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function fail(msg) {
  console.error('[verify-trading-shell] FAIL:', msg);
  process.exit(1);
}

function ok(msg) {
  console.log('[verify-trading-shell] OK:', msg);
}

const forbidden = [
  'services/kelly-agent-service.js',
  'webhooks/retell-websocket.js',
  'routes/kelly.js',
  'routes/stedi-webhooks.js',
];
for (const rel of forbidden) {
  if (fs.existsSync(path.join(ROOT, rel))) fail(`forbidden path still exists: ${rel}`);
}
ok('healthcare paths removed');

for (const rel of [
  'server.js',
  'services/trading-rails/orchestrator.js',
  'routes/trading-chat.js',
  '../unified-dashboard/trading/trading-chat.html',
]) {
  const p = rel.startsWith('..') ? path.join(ROOT, rel) : path.join(ROOT, rel);
  if (!fs.existsSync(p)) fail(`missing required file: ${rel}`);
}
ok('trading shell files present');

const testRun = spawnSync('npm', ['test'], {
  cwd: ROOT,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'test', TRADING_DB_PATH: path.join(ROOT, 'data', 'verify-trading.sqlite') },
});
if (testRun.status !== 0) fail('npm test failed');

console.log('[verify-trading-shell] All checks passed');
