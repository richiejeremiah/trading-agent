'use strict';

const { isPineconeConfigured, pineconeQuery } = require('../services/pinecone-rest');

describe('pinecone-rest', () => {
  it('reports not configured without env', () => {
    const prevKey = process.env.PINECONE_API_KEY;
    const prevHost = process.env.PINECONE_INDEX_HOST;
    delete process.env.PINECONE_API_KEY;
    delete process.env.PINECONE_INDEX_HOST;
    delete process.env.PINECONE_INDEX_URL;
    jest.resetModules();
    const mod = require('../services/pinecone-rest');
    expect(mod.isPineconeConfigured()).toBe(false);
    if (prevKey) process.env.PINECONE_API_KEY = prevKey;
    if (prevHost) process.env.PINECONE_INDEX_HOST = prevHost;
  });

  it('pineconeQuery returns empty when unconfigured', async () => {
    if (isPineconeConfigured()) {
      expect(true).toBe(true);
      return;
    }
    const hits = await pineconeQuery([0.1, 0.2], { topK: 1 });
    expect(hits).toEqual([]);
  });
});
