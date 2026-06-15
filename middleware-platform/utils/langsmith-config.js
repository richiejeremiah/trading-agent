/**
 * LangSmith configuration for Somo middleware
 *
 * Ensures tracing goes to the correct project for visibility.
 * Set LANGSMITH_API_KEY (or AP_Langchain) and optionally LANGSMITH_PROJECT.
 */

const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

if (process.env.AP_Langchain && !process.env.LANGSMITH_API_KEY) {
  process.env.LANGSMITH_API_KEY = process.env.AP_Langchain;
}
if (process.env.LANGSMITH_API_KEY && process.env.LANGCHAIN_TRACING_V2 !== 'false') {
  process.env.LANGCHAIN_TRACING_V2 = 'true';
}

// Somo middleware — use project NAME (LangSmith accepts names, not just UUIDs)
// Gap Analysis: env-based project naming (middleware-{env}) for dev/staging/prod separation
const env = process.env.NODE_ENV || 'development';
const envSuffix = env === 'production' ? 'prod' : env === 'staging' ? 'staging' : 'dev';
const DEFAULT_PROJECT = `middleware-${envSuffix}`;
const SOMO_MIDDLEWARE_PROJECT = process.env.LANGCHAIN_PROJECT || process.env.LANGSMITH_PROJECT || DEFAULT_PROJECT;
if (!process.env.LANGCHAIN_PROJECT && !process.env.LANGSMITH_PROJECT) {
  process.env.LANGCHAIN_PROJECT = DEFAULT_PROJECT;
  process.env.LANGSMITH_PROJECT = DEFAULT_PROJECT;
}
// Ensure tracing is on when API key present
if ((process.env.LANGSMITH_API_KEY || process.env.AP_Langchain) && process.env.LANGCHAIN_TRACING_V2 !== 'false') {
  process.env.LANGCHAIN_TRACING_V2 = 'true';
}

// P0: LangSmith mandatory in production - warn or fail when key missing
const isProd = process.env.NODE_ENV === 'production';
const hasKey = !!(process.env.LANGSMITH_API_KEY || process.env.AP_Langchain);
const tracingOff = process.env.LANGCHAIN_TRACING_V2 === 'false';
if (isProd && (!hasKey || tracingOff)) {
  const msg = '⚠️  LangSmith: Production requires LANGSMITH_API_KEY and LANGCHAIN_TRACING_V2=true for LLM traceability. Set LANGSMITH_API_KEY (or AP_Langchain) in env.';
  if (process.env.LANGSMITH_MANDATORY === 'true') {
    console.error('❌', msg);
    process.exit(1);
  }
  console.warn(msg);
}

function getConfig() {
  return {
    projectId: process.env.LANGCHAIN_PROJECT || process.env.LANGSMITH_PROJECT || SOMO_MIDDLEWARE_PROJECT,
    hasKey: !!(process.env.LANGSMITH_API_KEY || process.env.AP_Langchain),
    tracingEnabled: process.env.LANGCHAIN_TRACING_V2 === 'true'
  };
}

module.exports = { SOMO_MIDDLEWARE_PROJECT, DOCTOR_LITTLE_PROJECT: SOMO_MIDDLEWARE_PROJECT, getConfig };
