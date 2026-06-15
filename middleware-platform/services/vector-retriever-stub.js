'use strict';

/**
 * C1 / batch-4 — Placeholder for semantic / vector retrieval (Pinecone-class backends).
 *
 * Env: VECTOR_SEARCH_BACKEND = none | stub | pinecone
 * Pinecone: set PINECONE_API_KEY + PINECONE_INDEX_HOST (or PINECONE_INDEX_URL); search still returns []
 * until query wiring is added (no new npm dependency in this stub).
 */

const ENV_KEY = 'VECTOR_SEARCH_BACKEND';

function _pineconeConfigured() {
  return Boolean(
    String(process.env.PINECONE_API_KEY || '').trim() &&
      (String(process.env.PINECONE_INDEX_HOST || '').trim() ||
        String(process.env.PINECONE_INDEX_URL || '').trim())
  );
}

function createVectorRetrieverStub() {
  return {
    /**
     * @returns {Promise<Array<{id:string, text:string, score:number}>>}
     */
    async search(_query, _opts = {}) {
      const backend = String(process.env[ENV_KEY] || 'none').toLowerCase();
      if (backend === 'pinecone') {
        if (process.env.VECTOR_STUB_LOG === '1' || process.env.PINECONE_STUB_LOG === '1') {
          console.warn(
            `[vector-retriever-stub] pinecone backend: configured=${_pineconeConfigured()} — query path not implemented; returning [].`
          );
        }
        return [];
      }
      if (backend !== 'none' && backend !== 'stub' && process.env.VECTOR_STUB_LOG === '1') {
        console.warn(
          `[vector-retriever-stub] ${ENV_KEY}=${backend} — embeddings not wired; returning [].`
        );
      }
      return [];
    },
    getBackend() {
      return String(process.env[ENV_KEY] || 'none').toLowerCase();
    },
  };
}

module.exports = { createVectorRetrieverStub, VECTOR_SEARCH_BACKEND_ENV: ENV_KEY };
