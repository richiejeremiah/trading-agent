'use strict';

/**
 * Seed script — US Healthcare watchlist
 * Usage: node scripts/seed-watchlist.js
 *
 * Calls getCompanyFundamentals for each ticker, inserts into agent_watchlist.
 * Skips tickers already present. Rate-limited to 5 req/s.
 */

const { getDb } = require('../database');
const { getCompanyFundamentals } = require('../services/market-data-client');

const TICKERS = [
  'LLY','JNJ','MRK','BMY','PFE','ZTS','RPRX','TEVA','NVO','AZN',
  'GSK','NVS','TMO','DHR','MTD','WAT','A','ILMN','WST','ICLR',
  'SYK','DXCM','BSX','GEHC','MDT','RMD','EW','STE','ZBH','ABT',
  'ISRG','BDX','PODD','IDXX','SNN','PHG','ALC','COO','HCA','MCK',
  'CAH','COR','CI','CVS','LH','DGX','FMS','UNH','CNC','HUM',
  'ELV','VEEV',
  'CIPLA.NS','LUPIN.NS','SUNPHARMA.NS','DRREDDY.NS','AUROPHARMA.NS','ZYDUSLIFE.NS','VTRS','PRGO','AMRX',
];

const DELAY_MS = 200; // 5 per second

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function ensureColumns(db) {
  // agent_watchlist was created with ticker/added_by/note/added_at.
  // Add the three extra columns if they don't exist yet (SQLite ≥ 3.37 supports
  // ADD COLUMN IF NOT EXISTS; for older versions we swallow the "duplicate column" error).
  for (const ddl of [
    `ALTER TABLE agent_watchlist ADD COLUMN name        TEXT`,
    `ALTER TABLE agent_watchlist ADD COLUMN source      TEXT`,
    `ALTER TABLE agent_watchlist ADD COLUMN captured_at TEXT`,
  ]) {
    try { db.prepare(ddl).run(); } catch (_) { /* column already exists */ }
  }
}

async function main() {
  const db = getDb();
  ensureColumns(db);

  const exists = db.prepare(`SELECT 1 FROM agent_watchlist WHERE ticker = ?`);
  const insert = db.prepare(
    `INSERT INTO agent_watchlist (ticker, name, source, captured_at, added_at)
     VALUES (@ticker, @name, @source, @captured_at, @captured_at)`
  );

  let inserted = 0, skipped = 0, failed = 0;

  for (const ticker of TICKERS) {
    if (exists.get(ticker)) { skipped++; continue; }

    const result = await getCompanyFundamentals(ticker);
    if (!result.ok) {
      console.warn(`  WARN ${ticker}: ${result.error}`);
      failed++;
    } else {
      const now = new Date().toISOString();
      insert.run({ ticker, name: result.data.name || null, source: 'yahoo', captured_at: now });
      inserted++;
    }

    await sleep(DELAY_MS);
  }

  console.log(
    `seed-watchlist done — inserted: ${inserted}, skipped: ${skipped}, failed: ${failed} / ${TICKERS.length} tickers`
  );
  db.close();
}

main().catch((e) => { console.error('seed-watchlist fatal:', e.message); process.exit(1); });
