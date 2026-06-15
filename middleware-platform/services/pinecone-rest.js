'use strict';

/**
 * C2/C6 — Pinecone data plane over HTTPS (no SDK). Serverless / pod indexes.
 *
 * PINECONE_API_KEY
 * PINECONE_INDEX_HOST (e.g. my-index-abc123.svc.us-east1-aws.pinecone.io) or PINECONE_INDEX_URL full base
 * PINECONE_NAMESPACE (optional, default "")
 */

function pineconeBaseUrl() {
  const full = String(process.env.PINECONE_INDEX_URL || '').trim().replace(/\/$/, '');
  if (full) return full;
  const host = String(process.env.PINECONE_INDEX_HOST || '').trim().replace(/\/$/, '');
  if (!host) return '';
  return host.startsWith('http') ? host : `https://${host}`;
}

function pineconeHeaders() {
  const apiKey = String(process.env.PINECONE_API_KEY || '').trim();
  if (!apiKey) return null;
  return {
    'Api-Key': apiKey,
    'Content-Type': 'application/json',
  };
}

function pineconeNamespace() {
  return String(process.env.PINECONE_NAMESPACE || '').trim();
}

function isPineconeConfigured() {
  return Boolean(pineconeBaseUrl() && pineconeHeaders());
}

/**
 * @param {Array<{id:string, values:Float32Array|number[], metadata?:object}>} vectors
 */
async function pineconeUpsert(vectors) {
  const base = pineconeBaseUrl();
  const headers = pineconeHeaders();
  if (!base || !headers || !vectors.length) return { upserted: 0 };
  const ns = pineconeNamespace();
  const body = {
    vectors: vectors.map((v) => ({
      id: String(v.id),
      values: Array.from(v.values),
      metadata: v.metadata && typeof v.metadata === 'object' ? v.metadata : undefined,
    })),
  };
  if (ns) body.namespace = ns;
  const res = await fetch(`${base}/vectors/upsert`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Pinecone upsert ${res.status}: ${t.slice(0, 300)}`);
  }
  return { upserted: vectors.length };
}

/**
 * @param {Float32Array|number[]} vector
 * @param {object} opts
 * @returns {Promise<Array<{id:string, score:number, metadata?:object}>>}
 */
async function pineconeQuery(vector, opts = {}) {
  const base = pineconeBaseUrl();
  const headers = pineconeHeaders();
  if (!base || !headers) return [];
  const topK = Math.min(100, Math.max(1, opts.topK || 8));
  const arr = Array.from(vector);
  const body = {
    vector: arr,
    topK,
    includeValues: false,
    includeMetadata: true,
  };
  const ns = pineconeNamespace();
  if (ns) body.namespace = ns;
  const res = await fetch(`${base}/query`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Pinecone query ${res.status}: ${t.slice(0, 300)}`);
  }
  const data = await res.json();
  const matches = data.matches || [];
  return matches.map((m) => ({
    id: m.id,
    score: typeof m.score === 'number' ? m.score : 0,
    metadata: m.metadata || {},
  }));
}

async function pineconeDescribeIndexStats(opts = {}) {
  const base = pineconeBaseUrl();
  const headers = pineconeHeaders();
  if (!base || !headers) throw new Error('Pinecone not configured');
  const ns = opts.namespace != null ? String(opts.namespace) : pineconeNamespace();
  const body = {
    ...(ns ? { namespace: ns } : {}),
    ...(opts.filter && typeof opts.filter === 'object' ? { filter: opts.filter } : {}),
  };
  const res = await fetch(`${base}/describe_index_stats`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Pinecone describe_index_stats ${res.status}: ${t.slice(0, 300)}`);
  }
  return await res.json();
}

module.exports = {
  pineconeBaseUrl,
  isPineconeConfigured,
  pineconeUpsert,
  pineconeQuery,
  pineconeDescribeIndexStats,
  pineconeNamespace,
};
