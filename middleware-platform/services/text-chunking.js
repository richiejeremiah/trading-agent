'use strict';

/**
 * C3 — Split long documents into overlapping windows before embedding / vector upsert.
 *
 * Env: DOCUMENT_CHUNK_MAX_CHARS (default 1200), DOCUMENT_CHUNK_OVERLAP (default 100)
 */

function _num(v, fallback) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function splitTextForEmbedding(text, opts = {}) {
  const maxChars = _num(opts.maxChars, _num(process.env.DOCUMENT_CHUNK_MAX_CHARS, 1200));
  const overlap = _num(opts.overlap, _num(process.env.DOCUMENT_CHUNK_OVERLAP, 100));
  const safeOverlap = Math.min(Math.max(0, overlap), Math.max(0, maxChars - 1));
  const t = String(text || '');
  if (!t.trim()) return [];

  const out = [];
  let i = 0;
  while (i < t.length) {
    const end = Math.min(i + maxChars, t.length);
    const piece = t.slice(i, end).trim();
    if (piece) out.push(piece);
    if (end >= t.length) break;
    const next = end - safeOverlap;
    i = next > i ? next : end;
  }
  return out;
}

module.exports = { splitTextForEmbedding };
