'use strict';

const { randomUUID } = require('crypto');
const { Client } = require('langsmith');
require('../utils/langsmith-config');

let _client = null;

function _isEnabled() {
  const key = process.env.LANGSMITH_API_KEY || process.env.AP_Langchain || '';
  const v2 = String(process.env.LANGCHAIN_TRACING_V2 || '').toLowerCase() === 'true';
  const ls = String(process.env.LANGSMITH_TRACING || '').toLowerCase() === 'true';
  return !!key && (v2 || ls);
}

function _getClient() {
  if (!_isEnabled()) return null;
  if (_client) return _client;
  _client = new Client({
    apiKey: process.env.LANGSMITH_API_KEY || process.env.AP_Langchain,
    apiUrl: process.env.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com'
  });
  return _client;
}

async function startTrace({ name, inputs, metadata, tags }) {
  try {
    const client = _getClient();
    if (!client) return null;
    const runId = randomUUID();
    await client.createRun({
      id: runId,
      name: String(name || 'middleware_trace'),
      run_type: 'chain',
      project_name: process.env.LANGCHAIN_PROJECT || process.env.LANGSMITH_PROJECT || 'middleware-prod',
      inputs: inputs || {},
      tags: Array.isArray(tags) ? tags : [],
      extra: { metadata: metadata || {} },
      start_time: new Date().toISOString()
    });
    return { client, runId };
  } catch (e) {
    console.warn('[langsmith-trace] startTrace failed:', e?.message || e);
    return null;
  }
}

async function endTrace(ctx, { outputs, error, usage }) {
  try {
    if (!ctx?.client || !ctx?.runId) return;
    const payload = {
      outputs: outputs || {},
      error: error ? String(error) : undefined,
      end_time: new Date().toISOString()
    };
    if (usage && typeof usage === 'object') {
      if (usage.prompt_tokens != null) payload.prompt_tokens = Number(usage.prompt_tokens);
      if (usage.completion_tokens != null) payload.completion_tokens = Number(usage.completion_tokens);
      if (usage.total_tokens != null) payload.total_tokens = Number(usage.total_tokens);
    }
    await ctx.client.updateRun(ctx.runId, payload);
  } catch (e) {
    console.warn('[langsmith-trace] endTrace failed:', e?.message || e);
  }
}

module.exports = { startTrace, endTrace };
