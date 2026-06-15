'use strict';

/**
 * C6 — Freshness / ops metadata for vector sync (SQLite; no Pinecone control plane).
 */

const META_PREFIX = 'vector_index:';

function _ensureTable(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS knowledge_vector_index_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  } catch (_) {}
}

function getVectorIndexMeta(db, key) {
  if (!db || !key) return null;
  _ensureTable(db);
  try {
    const row = db.prepare('SELECT value FROM knowledge_vector_index_meta WHERE key = ?').get(String(key));
    if (!row || !row.value) return null;
    return JSON.parse(row.value);
  } catch (_) {
    return null;
  }
}

function setVectorIndexMeta(db, key, obj) {
  if (!db || !key) return;
  _ensureTable(db);
  try {
    db.prepare(
      `
      INSERT INTO knowledge_vector_index_meta (key, value, updated_at)
      VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
    `
    ).run(String(key), JSON.stringify(obj || {}));
  } catch (_) {}
}

function recordVectorSyncStats(db, stats) {
  setVectorIndexMeta(db, `${META_PREFIX}last_sync`, {
    ts: new Date().toISOString(),
    ...stats,
  });
}

module.exports = {
  getVectorIndexMeta,
  setVectorIndexMeta,
  recordVectorSyncStats,
  META_PREFIX,
};
