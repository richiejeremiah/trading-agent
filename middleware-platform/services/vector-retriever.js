'use strict';

/**
 * C1/C2 — Vector query path: Pinecone when configured + live embeddings; else legacy stub.
 */

const { createVectorRetrieverStub } = require('./vector-retriever-stub');
const { embedTexts } = require('./embedding-provider');
const { pineconeQuery, isPineconeConfigured } = require('./pinecone-rest');

function createVectorRetriever() {
  const backend = String(process.env.VECTOR_SEARCH_BACKEND || 'none').toLowerCase();
  if (backend === 'pinecone' && isPineconeConfigured()) {
    return {
      /**
       * @returns {Promise<Array<{id:string, text:string, score:number, metadata?:object}>>}
       */
      async search(query, opts = {}) {
        const limit = opts.limit || 8;
        let vec;
        try {
          vec = (await embedTexts([String(query || '')]))[0];
        } catch (e) {
          if (process.env.VECTOR_STUB_LOG === '1') {
            console.warn('[vector-retriever] embed failed:', e.message);
          }
          vec = null;
        }
        if (!vec || !(vec instanceof Float32Array) || vec.length === 0) {
          if (process.env.VECTOR_STUB_LOG === '1') {
            console.warn('[vector-retriever] no query vector; set EMBEDDING_PROVIDER=openai + OPENAI_API_KEY');
          }
          return [];
        }
        try {
          const hits = await pineconeQuery(vec, { topK: limit });
          return hits.map((h) => ({
            id: String(h.metadata?.chunk_id || h.metadata?.id || h.id || ''),
            text: String(h.metadata?.text || ''),
            score: h.score,
            metadata: h.metadata || {},
          }));
        } catch (e) {
          if (process.env.VECTOR_STUB_LOG === '1') {
            console.warn('[vector-retriever] pinecone query failed:', e.message);
          }
          return [];
        }
      },
      getBackend() {
        return 'pinecone';
      },
    };
  }
  return createVectorRetrieverStub();
}

module.exports = { createVectorRetriever };
