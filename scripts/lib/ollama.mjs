// scripts/lib/ollama.mjs
// One place for every Ollama call. If you want to swap providers later,
// change this file and nothing else breaks.

import 'dotenv/config';

const HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';
const MODEL = process.env.OLLAMA_MODEL || 'llama3.1:8b';
const TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || '120000', 10);
const DEFAULT_TEMPERATURE = parseFloat(process.env.OLLAMA_TEMPERATURE || '0.3');
const NUM_CTX = parseInt(process.env.OLLAMA_NUM_CTX || '16384', 10);

/**
 * Send a chat request to Ollama and return the full assistant message.
 *
 * @param {Object} opts
 * @param {string} opts.system   - system prompt
 * @param {string} opts.user     - user prompt
 * @param {number} [opts.temperature]
 * @param {string} [opts.model]  - override the default model for this call
 * @param {boolean} [opts.json]  - if true, ask Ollama to return valid JSON
 * @returns {Promise<string>} the assistant message content
 */
export async function chat({ system, user, temperature, model, json = false }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const body = {
    model: model || MODEL,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: user },
    ],
    stream: false,
    options: {
      temperature: temperature ?? DEFAULT_TEMPERATURE,
      num_ctx: NUM_CTX,
    },
  };
  if (json) body.format = 'json';

  try {
    const res = await fetch(`${HOST}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama ${res.status}: ${text || res.statusText}`);
    }

    const data = await res.json();
    // /api/chat returns { message: { role, content }, ... }
    return data?.message?.content ?? '';
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Ollama request timed out after ${TIMEOUT_MS}ms (model=${body.model}). Consider a smaller model or raise OLLAMA_TIMEOUT_MS.`);
    }
    if (err.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Cannot reach Ollama at ${HOST}. Is 'ollama serve' running?`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Ask Ollama for a JSON object and parse it. Retries once on parse failure
 * with a stricter re-prompt, because small local models sometimes wrap JSON
 * in prose even when asked not to.
 */
export async function chatJSON(opts) {
  const raw = await chat({ ...opts, json: true });
  try {
    return JSON.parse(raw);
  } catch {
    // Try to salvage: find the first { ... } block
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    // Last resort: re-prompt with a stricter instruction
    const retry = await chat({
      system: 'You output ONLY valid JSON. No markdown, no prose, no code fences.',
      user: `Fix this so it parses as JSON:\n\n${raw}`,
      temperature: 0,
    });
    return JSON.parse(retry);
  }
}

/** List locally-available models. Used by the doctor. */
export async function listModels() {
  const res = await fetch(`${HOST}/api/tags`);
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${res.statusText}`);
  const data = await res.json();
  return (data.models || []).map((m) => m.name);
}

/** Hit /api/version to check the server is up. */
export async function ping() {
  const res = await fetch(`${HOST}/api/version`, {
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${res.statusText}`);
  return res.json();
}

export const config = { HOST, MODEL, TIMEOUT_MS, DEFAULT_TEMPERATURE, NUM_CTX };
