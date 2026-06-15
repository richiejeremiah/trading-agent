'use strict';

/**
 * C1/C4/C5 — Production embedding path behind env (OpenAI today; stub fallback).
 *
 * EMBEDDING_PROVIDER=openai  + OPENAI_API_KEY
 * OPENAI_EMBEDDING_MODEL     default text-embedding-3-small
 * EMBEDDING_DIM              must match Pinecone index (1536 for -3-small)
 */

function getEmbeddingRuntimeConfig() {
  return {
    provider: String(process.env.EMBEDDING_PROVIDER || '').trim().toLowerCase(),
    modelId: String(
      process.env.OPENAI_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL_ID || 'text-embedding-3-small'
    ).trim(),
    dimensions: parseInt(process.env.EMBEDDING_DIM || '1536', 10) || 1536,
  };
}

async function _embedOpenAI(texts) {
  const key = String(process.env.OPENAI_API_KEY || '').trim();
  if (!key) return texts.map(() => null);
  const cfg = getEmbeddingRuntimeConfig();
  const url = String(process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '') + '/embeddings';
  const out = new Array(texts.length).fill(null);
  const batchSize = Math.min(64, Math.max(1, parseInt(process.env.EMBEDDING_BATCH_SIZE || '32', 10) || 32));
  for (let i = 0; i < texts.length; i += batchSize) {
    const slice = texts.slice(i, i + batchSize).map((t) => String(t || '').slice(0, 8000));
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: cfg.modelId,
        input: slice,
      }),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenAI embeddings ${res.status}: ${errText.slice(0, 200)}`);
    }
    const data = await res.json();
    const rows = data.data || [];
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j];
      const emb = row && row.embedding;
      if (!Array.isArray(emb)) continue;
      out[i + j] = Float32Array.from(emb.map((x) => Number(x)));
    }
  }
  return out;
}

/**
 * @param {string[]} texts
 * @returns {Promise<Array<Float32Array|null>>}
 */
async function embedTexts(texts) {
  const list = Array.isArray(texts) ? texts : [];
  const cfg = getEmbeddingRuntimeConfig();
  if (cfg.provider === 'openai' && process.env.OPENAI_API_KEY) {
    try {
      return await _embedOpenAI(list);
    } catch (e) {
      if (process.env.EMBEDDING_STUB_LOG === '1') {
        console.warn('[embedding-provider] OpenAI failed, returning nulls:', e.message);
      }
      return list.map(() => null);
    }
  }
  if (process.env.EMBEDDING_STUB_LOG === '1') {
    console.warn(
      '[embedding-provider] stub embedTexts count=',
      list.length,
      'set EMBEDDING_PROVIDER=openai + OPENAI_API_KEY for live vectors'
    );
  }
  return list.map(() => null);
}

module.exports = { getEmbeddingRuntimeConfig, embedTexts };
