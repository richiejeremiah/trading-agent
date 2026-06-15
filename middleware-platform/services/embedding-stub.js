'use strict';

/**
 * Back-compat: delegates to embedding-provider (OpenAI when configured, else null vectors).
 */

const { getEmbeddingRuntimeConfig, embedTexts } = require('./embedding-provider');

module.exports = { getEmbeddingRuntimeConfig, embedTexts };
