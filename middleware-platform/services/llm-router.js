/**
 * LLMRouter
 *
 * Routes LLM requests to Claude (default primary) or Groq (fallback).
 * Set KELLY_PRIMARY_PROVIDER=groq to force Groq-only. If the key is missing,
 * resolvePrimaryProvider() falls back to Groq when ANTHROPIC_API_KEY is unset.
 *
 * Streaming (commerce checkout SSE): use callStreamWithDeltas — it respects the same
 * primary as call(); callGroqStreamWithDeltas is Groq-only.
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const Groq = require('groq-sdk');

let _anthropic = null;
let _groq = null;

function getAnthropic() {
  if (_anthropic) return _anthropic;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  _anthropic = new Anthropic({ apiKey: key });
  return _anthropic;
}

function getGroq() {
  if (_groq) return _groq;
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error('GROQ_API_KEY not set');
  _groq = new Groq({ apiKey: key });
  return _groq;
}

function _toAnthropicTools(tools) {
  return (tools || []).map((t) => ({
    name: t.function.name,
    description: t.function.description || '',
    input_schema: t.function.parameters || { type: 'object', properties: {} }
  }));
}

/**
 * Convert OpenAI-style messages to Anthropic format.
 *
 * Guardrails:
 * - strips empty user/assistant messages (avoids Anthropic 400 non-empty content errors)
 * - groups tool_result blocks into user turns
 * - merges same-role consecutive messages to enforce strict alternation
 */
function _toAnthropicMessages(messages) {
  const systemMsg = messages.find((m) => m.role === 'system');
  const rest = messages.filter((m) => m.role !== 'system');

  const converted = [];

  for (const msg of rest) {
    if (msg.role === 'assistant') {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        const content = [];
        const text = String(msg.content || '').trim();
        if (text) content.push({ type: 'text', text });

        for (const tc of msg.tool_calls) {
          let input = {};
          try { input = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input
          });
        }
        converted.push({ role: 'assistant', content });
      } else {
        const text = String(msg.content || '').trim();
        if (text) converted.push({ role: 'assistant', content: text });
      }
      continue;
    }

    if (msg.role === 'tool') {
      const toolResult = {
        type: 'tool_result',
        tool_use_id: msg.tool_call_id,
        content: String(msg.content || '(no result)')
      };
      const last = converted[converted.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(toolResult);
      } else {
        converted.push({ role: 'user', content: [toolResult] });
      }
      continue;
    }

    // regular user
    const text = String(msg.content || '').trim();
    if (text) converted.push({ role: msg.role, content: text });
  }

  const alternated = [];
  for (const msg of converted) {
    const last = alternated[alternated.length - 1];
    if (last && last.role === msg.role) {
      const mergeContent = (a, b) => {
        if (Array.isArray(a) && Array.isArray(b)) return [...a, ...b];
        if (Array.isArray(a)) return [...a, { type: 'text', text: String(b) }];
        if (Array.isArray(b)) return [{ type: 'text', text: String(a) }, ...b];
        return `${String(a)}\n${String(b)}`;
      };
      last.content = mergeContent(last.content, msg.content);
    } else {
      alternated.push({ ...msg });
    }
  }

  const safe = alternated.filter((m) => {
    if (Array.isArray(m.content)) return m.content.length > 0;
    return m.content && String(m.content).trim().length > 0;
  });

  if (safe.length > 0 && safe[0].role === 'assistant') {
    safe.unshift({ role: 'user', content: '(conversation resumed)' });
  }

  return { system: systemMsg?.content || '', messages: safe };
}

const PROVIDER_TIMEOUT_MS = parseInt(process.env.KELLY_PROVIDER_TIMEOUT_MS || '20000', 10);
const GROQ_FALLBACK_MODEL = process.env.KELLY_GROQ_FALLBACK_MODEL || 'llama-3.1-8b-instant';

function withTimeout(promise, ms, label) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label || `Timeout after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function _sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function _hasAnthropicKey() {
  return !!(process.env.ANTHROPIC_API_KEY || '').trim();
}

function _hasGroqKey() {
  return !!(process.env.GROQ_API_KEY || '').trim();
}

/** True when failing over from primary to secondary provider is reasonable. */
function _isCrossFallbackTransient(err) {
  const status = err?.status ?? err?.statusCode ?? 0;
  if (status === 401 || status === 403) return false;
  const msg = String(err?.message || '').toLowerCase();
  if (msg.includes('anthropic provider timeout') || msg.includes('groq provider timeout')) return true;
  return (
    status === 529 ||
    msg.includes('overloaded') ||
    status === 429 ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    status === 400 ||
    msg.includes('invalid_request') ||
    msg.includes('bad request') ||
    status === 408 ||
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('etimedout') ||
    msg.includes('deadline') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('fetch failed') ||
    msg.includes('network error') ||
    msg.includes('enotfound') ||
    msg.includes('eai_again') ||
    (typeof status === 'number' && status >= 500 && status < 600) ||
    status === 413 ||
    msg.includes('too large') ||
    msg.includes('tokens per minute')
  );
}

function _fromAnthropicResponse(response) {
  const toolCalls = [];
  let textContent = '';

  for (const block of (response.content || [])) {
    if (block.type === 'text') {
      textContent += block.text;
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {})
        }
      });
    }
  }

  const finishReason = response.stop_reason === 'tool_use' ? 'tool_calls' : 'stop';

  const out = {
    choices: [
      {
        finish_reason: finishReason,
        message: {
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined
        }
      }
    ]
  };
  if (response?.usage) {
    const prompt = Number(response.usage.input_tokens || response.usage.prompt_tokens || 0);
    const completion = Number(response.usage.output_tokens || response.usage.completion_tokens || 0);
    out._usage = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion
    };
  }
  return out;
}

/**
 * Effective Kelly primary: Claude when ANTHROPIC_API_KEY is set (default),
 * unless KELLY_PRIMARY_PROVIDER=groq. Missing Anthropic key → Groq only + warning.
 */
function resolvePrimaryProvider() {
  const raw = (process.env.KELLY_PRIMARY_PROVIDER || 'anthropic').trim().toLowerCase();
  if (raw === 'groq') return 'groq';
  if (!(process.env.ANTHROPIC_API_KEY || '').trim()) {
    console.warn('[LLMRouter] Claude is the default primary but ANTHROPIC_API_KEY is not set; using Groq only');
    return 'groq';
  }
  return 'anthropic';
}

/**
 * @param {object} opts
 * @param {string} [opts.forceProvider] - 'groq' | 'anthropic' — no cross-fallback
 */
async function call({ messages, tools, maxTokens, channel, forceProvider = null }) {
  if (forceProvider === 'groq') {
    const out = await _callGroq({ messages, tools, maxTokens, channel });
    if (out?.usage && !out?._usage) {
      const p = Number(out.usage.prompt_tokens || out.usage.input_tokens || 0);
      const c = Number(out.usage.completion_tokens || out.usage.output_tokens || 0);
      out._usage = { prompt_tokens: p, completion_tokens: c, total_tokens: p + c };
    }
    return out;
  }
  if (forceProvider === 'anthropic') {
    return await _callAnthropic({ messages, tools, maxTokens });
  }

  const primary = resolvePrimaryProvider();
  const order = [];
  if (primary === 'anthropic') {
    order.push('anthropic');
    if (_hasGroqKey()) order.push('groq');
  } else {
    order.push('groq');
    if (_hasAnthropicKey() && process.env.KELLY_GROQ_FALLBACK_TO_ANTHROPIC !== '0') {
      order.push('anthropic');
    }
  }

  let lastErr;
  for (let i = 0; i < order.length; i++) {
    const p = order[i];
    try {
      if (p === 'anthropic') {
        return await _callAnthropic({ messages, tools, maxTokens });
      }
      const out = await _callGroq({ messages, tools, maxTokens, channel });
      if (out?.usage && !out?._usage) {
        const pTok = Number(out.usage.prompt_tokens || out.usage.input_tokens || 0);
        const cTok = Number(out.usage.completion_tokens || out.usage.output_tokens || 0);
        out._usage = { prompt_tokens: pTok, completion_tokens: cTok, total_tokens: pTok + cTok };
      }
      return out;
    } catch (err) {
      lastErr = err;
      const hasNext = i < order.length - 1;
      if (hasNext && _isCrossFallbackTransient(err)) {
        console.warn(`[LLMRouter] ${p} failed, trying ${order[i + 1]}:`, err?.message || err);
        await _sleep(450);
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('No LLM provider available');
}

async function _callAnthropic({ messages, tools, maxTokens }) {
  const client = getAnthropic();
  const model = process.env.KELLY_ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  const { system, messages: converted } = _toAnthropicMessages(messages);
  const anthropicTools = _toAnthropicTools(tools || []);

  if (process.env.KELLY_DEBUG_ANTHROPIC === '1') {
    const payload = JSON.stringify({ system: system?.slice(0, 200), messages: converted, tools: anthropicTools?.length });
    console.log('[LLMRouter] Anthropic payload (first 1500 chars):', payload?.slice(0, 1500));
  }

  try {
    const payload = {
      model,
      max_tokens: maxTokens || 1024,
      system,
      messages: converted
    };
    if (anthropicTools.length > 0) payload.tools = anthropicTools;
    const response = await withTimeout(
      client.messages.create(payload),
      PROVIDER_TIMEOUT_MS,
      `Anthropic provider timeout after ${PROVIDER_TIMEOUT_MS}ms`
    );
    return _fromAnthropicResponse(response);
  } catch (err) {
    const status = err?.status ?? err?.statusCode ?? err?.httpStatus ?? '?';
    const errType = err?.type ?? err?.name ?? 'Error';
    const reqBody = JSON.stringify({
      model,
      system: system?.slice(0, 100),
      message_count: converted?.length,
      tools: anthropicTools?.length,
      first_msg: converted?.[0],
      last_msg: converted?.[converted?.length - 1]
    });
    console.error('[LLMRouter] Anthropic API error: status=%s type=%s message=%s',
      status, errType, err?.message || err);
    console.error('[LLMRouter] Request body (first 500 chars):', reqBody?.slice(0, 500));
    throw err;
  }
}

async function _callGroq({ messages, tools, maxTokens, channel }) {
  const client = getGroq();
  const model = process.env.KELLY_GROQ_MODEL || 'llama-3.3-70b-versatile';
  const tokens =
    maxTokens ||
    (channel === 'voice'
      ? parseInt(process.env.KELLY_VOICE_MAX_TOKENS || '150', 10)
      : parseInt(process.env.KELLY_CHAT_MAX_TOKENS || '200', 10));

  const maxAttempts = Math.max(1, parseInt(process.env.KELLY_GROQ_MAX_RETRIES || '4', 10));
  let requestMessages = messages;
  let requestModel = model;
  let compactedFor413 = false;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await withTimeout(
        client.chat.completions.create({
          model: requestModel,
          messages: requestMessages,
          tools: tools || [],
          tool_choice: 'auto',
          temperature: 0.3,
          max_tokens: tokens
        }),
        PROVIDER_TIMEOUT_MS,
        `Groq provider timeout after ${PROVIDER_TIMEOUT_MS}ms`
      );
    } catch (err) {
      lastErr = err;
      const status = err?.status ?? err?.statusCode ?? 0;
      const msg = String(err?.message || '').toLowerCase();
      const is429 = status === 429 || msg.includes('rate_limit') || msg.includes('rate limit');
      const isTooLarge =
        status === 413 || msg.includes('tokens per minute') || msg.includes('too large');
      if ((!is429 && !isTooLarge) || attempt >= maxAttempts) {
        throw err;
      }
      if (isTooLarge && !compactedFor413) {
        compactedFor413 = true;
        requestModel = GROQ_FALLBACK_MODEL;
        requestMessages = _compactMessagesForGroq413(messages, 4);
        console.warn(
          '[LLMRouter] Groq 413 detected; retrying with compact prompt (last 4 messages) on fallback model %s',
          requestModel
        );
        await _sleep(200);
        continue;
      }
      const delay = Math.min(
        12000,
        parseInt(process.env.KELLY_GROQ_RETRY_BASE_MS || '1200', 10) * Math.pow(2, attempt - 1)
      );
      console.warn('[LLMRouter] Groq busy (attempt %s/%s), waiting %sms: %s',
        attempt, maxAttempts, delay, err?.message || err);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * Groq streaming completion (OpenAI-compatible). Invokes onDelta for each content token.
 * Accumulates tool_calls from stream chunks and returns a non-stream-shaped response for the Kelly loop.
 * @param {function(string): void} [opts.onDelta]
 */
async function callGroqStreamWithDeltas({ messages, tools, maxTokens, channel, onDelta }) {
  const client = getGroq();
  const model = process.env.KELLY_GROQ_MODEL || 'llama-3.3-70b-versatile';
  const tokens =
    maxTokens ||
    (channel === 'voice'
      ? parseInt(process.env.KELLY_VOICE_MAX_TOKENS || '150', 10)
      : parseInt(process.env.KELLY_CHAT_MAX_TOKENS || '200', 10));

  const stream = await withTimeout(
    client.chat.completions.create({
      model,
      messages,
      tools: tools || [],
      tool_choice: 'auto',
      temperature: 0.3,
      max_tokens: tokens,
      stream: true
    }),
    PROVIDER_TIMEOUT_MS,
    `Groq stream timeout after ${PROVIDER_TIMEOUT_MS}ms`
  );

  let accumulatedContent = '';
  const toolCallsByIndex = [];
  let finishReason = null;

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;
    if (delta?.content) {
      accumulatedContent += delta.content;
      if (typeof onDelta === 'function') onDelta(delta.content);
    }
    if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const idx = typeof tc.index === 'number' ? tc.index : 0;
        if (!toolCallsByIndex[idx]) {
          toolCallsByIndex[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
        }
        if (tc.id) toolCallsByIndex[idx].id = tc.id;
        if (tc.function?.name) toolCallsByIndex[idx].function.name += tc.function.name;
        if (tc.function?.arguments) toolCallsByIndex[idx].function.arguments += tc.function.arguments;
      }
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  }

  const toolCalls = toolCallsByIndex
    .filter(Boolean)
    .map((tc, i) => ({
      id: tc.id || `call_${i}`,
      type: 'function',
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments
      }
    }));

  const hasTools = toolCalls.length > 0;
  return {
    choices: [
      {
        finish_reason: finishReason || (hasTools ? 'tool_calls' : 'stop'),
        message: {
          role: 'assistant',
          content: accumulatedContent || null,
          tool_calls: hasTools ? toolCalls : undefined
        }
      }
    ]
  };
}

/**
 * Anthropic Messages API streaming; returns OpenAI-shaped { choices[0] } like callGroqStreamWithDeltas.
 */
async function _callAnthropicStreamWithDeltas({ messages, tools, maxTokens, onDelta }) {
  const client = getAnthropic();
  const model = process.env.KELLY_ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  const { system, messages: converted } = _toAnthropicMessages(messages);
  const anthropicTools = _toAnthropicTools(tools || []);

  const payload = {
    model,
    max_tokens: maxTokens || 1024,
    system,
    messages: converted
  };
  if (anthropicTools.length > 0) payload.tools = anthropicTools;

  const stream = client.messages.stream(payload);

  let textContent = '';
  const toolCalls = [];
  let currentToolUse = null;
  let finishReason = null;

  for await (const event of stream) {
    if (event.type === 'content_block_start') {
      const block = event.content_block;
      if (block && block.type === 'tool_use') {
        currentToolUse = {
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: '' }
        };
      }
    }
    if (event.type === 'content_block_delta') {
      const d = event.delta;
      if (d.type === 'text_delta') {
        textContent += d.text;
        if (typeof onDelta === 'function') onDelta(d.text);
      }
      if (d.type === 'input_json_delta' && currentToolUse) {
        currentToolUse.function.arguments += d.partial_json || '';
      }
    }
    if (event.type === 'content_block_stop') {
      if (currentToolUse) {
        toolCalls.push(currentToolUse);
        currentToolUse = null;
      }
    }
    if (event.type === 'message_delta' && event.delta && event.delta.stop_reason) {
      finishReason = event.delta.stop_reason === 'tool_use' ? 'tool_calls' : 'stop';
    }
  }

  finishReason = finishReason || (toolCalls.length > 0 ? 'tool_calls' : 'stop');

  return {
    choices: [
      {
        finish_reason: finishReason,
        message: {
          role: 'assistant',
          content: textContent || null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined
        }
      }
    ]
  };
}

function _callAnthropicStreamWithDeltasTimed({ messages, tools, maxTokens, onDelta }) {
  return withTimeout(
    _callAnthropicStreamWithDeltas({ messages, tools, maxTokens, onDelta }),
    PROVIDER_TIMEOUT_MS,
    `Anthropic stream timeout after ${PROVIDER_TIMEOUT_MS}ms`
  );
}

/**
 * Provider-aware streaming for Kelly: respects KELLY_PRIMARY_PROVIDER (and optional forceProvider).
 * Use instead of callGroqStreamWithDeltas in commerce SSE paths so prod matches non-stream / harness.
 *
 * @param {string|null} [opts.forceProvider] - 'groq' | 'anthropic' — when set, skips primary resolution (no cross-fallback except noted).
 */
async function callStreamWithDeltas({ messages, tools, maxTokens, channel, onDelta, forceProvider = null }) {
  if (forceProvider === 'groq') {
    return await callGroqStreamWithDeltas({ messages, tools, maxTokens, channel, onDelta });
  }
  if (forceProvider === 'anthropic') {
    return await _callAnthropicStreamWithDeltasTimed({ messages, tools, maxTokens, onDelta });
  }

  const provider = resolvePrimaryProvider();
  if (provider === 'anthropic' && _hasAnthropicKey()) {
    try {
      return await _callAnthropicStreamWithDeltasTimed({ messages, tools, maxTokens, onDelta });
    } catch (err) {
      if (_isCrossFallbackTransient(err) && _hasGroqKey()) {
        console.warn('[LLMRouter] Anthropic stream failed, falling back to Groq:', err?.message || err);
        await _sleep(450);
        return await callGroqStreamWithDeltas({ messages, tools, maxTokens, channel, onDelta });
      }
      throw err;
    }
  }
  return await callGroqStreamWithDeltas({ messages, tools, maxTokens, channel, onDelta });
}

function _compactSystemPromptFor413(content, maxChars = 700) {
  const text = String(content || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'You are Kelly. Ask one focused question at a time. Use tools only when needed.';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}...`;
}

function _compactMessagesForGroq413(messages, keepLast = 4) {
  const input = Array.isArray(messages) ? messages : [];
  const system = input.find((m) => m && m.role === 'system');
  const tail = input.filter((m) => m && m.role !== 'system').slice(-Math.max(1, keepLast));
  if (!system) return tail;
  return [
    {
      role: 'system',
      content: _compactSystemPromptFor413(system.content)
    },
    ...tail
  ];
}

module.exports = {
  call,
  callGroqStreamWithDeltas,
  callStreamWithDeltas,
  resolvePrimaryProvider,
  withTimeout,
  _compactMessagesForGroq413
};
