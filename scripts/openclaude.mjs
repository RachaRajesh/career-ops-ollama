// scripts/lib/openclaude.mjs
// Client for the openclaude CLI (https://github.com/Gitlawb/openclaude).
//
// openclaude exposes an OpenAI-compatible HTTP API. It's meant to be used
// as a drop-in replacement for OpenAI's /v1/chat/completions endpoint, routed
// to whatever local/cloud model you've configured in openclaude.
//
// KEY USAGE NOTES:
//   - You run `openclaude serve` (or however openclaude exposes its HTTP API)
//     to start the server. The env var OPENCLAUDE_BASE_URL points at it.
//   - The model name you set here must match what openclaude has configured.
//     If openclaude is routed to Ollama's qwen2.5:32b, then OPENCLAUDE_MODEL
//     should be "qwen2.5:32b".
//   - No API key required for local-only openclaude. If you're using it to
//     route to a cloud provider through openclaude's proxy, set
//     OPENCLAUDE_API_KEY.
//
// KNOWN LIMITATIONS (as of openclaude v0.1.8, April 2026):
//   - Issue #486: file reading broken for local Ollama backends
//   - Issue #557: tool-calling sometimes prints JSON without executing
// For career-ops' evaluate/apply/pipeline flows we don't use tool-calling or
// file-reading — we handle those in JavaScript and feed the LLM plain text.
// So these bugs don't affect us in the current flows.

import 'dotenv/config';

const BASE_URL = process.env.OPENCLAUDE_BASE_URL || 'http://localhost:3000/v1';
const MODEL = process.env.OPENCLAUDE_MODEL || process.env.OLLAMA_MODEL || 'qwen2.5:14b';
const API_KEY = process.env.OPENCLAUDE_API_KEY || 'not-needed';
const TIMEOUT_MS = parseInt(process.env.OLLAMA_TIMEOUT_MS || process.env.OPENCLAUDE_TIMEOUT_MS || '300000', 10);
const DEFAULT_TEMPERATURE = parseFloat(process.env.OLLAMA_TEMPERATURE || '0.3');

/**
 * Send a chat request to openclaude. Same signature as ollama.mjs → chat().
 *
 * @param {Object} opts
 * @param {string} opts.system
 * @param {string} opts.user
 * @param {number} [opts.temperature]
 * @param {string} [opts.model]
 * @param {boolean} [opts.json] — when true, asks for JSON-mode response if supported
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
    temperature: temperature ?? DEFAULT_TEMPERATURE,
  };
  if (json) {
    // OpenAI-compatible "json_object" response format. Not all backends honor
    // this — if the downstream model is Ollama and doesn't emit valid JSON,
    // chatJSON() below has a salvage path.
    body.response_format = { type: 'json_object' };
  }

  try {
    const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`openclaude ${res.status}: ${text || res.statusText}`);
    }

    const data = await res.json();
    // OpenAI format: { choices: [{ message: { role, content } }] }
    return data?.choices?.[0]?.message?.content ?? '';
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`openclaude request timed out after ${TIMEOUT_MS}ms. Consider a smaller model or raise OLLAMA_TIMEOUT_MS.`);
    }
    if (err.cause?.code === 'ECONNREFUSED') {
      throw new Error(`Cannot reach openclaude at ${BASE_URL}. Is openclaude's HTTP server running? See docs/OPENCLAUDE.md.`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function chatJSON(opts) {
  const raw = await chat({ ...opts, json: true });
  try { return JSON.parse(raw); } catch { /* fall through */ }
  const match = raw.match(/\{[\s\S]*\}/);
  if (match) { try { return JSON.parse(match[0]); } catch { /* fall through */ } }
  // Last resort: re-prompt with a stricter instruction
  const retry = await chat({
    system: 'You output ONLY valid JSON. No markdown, no prose, no code fences.',
    user: `Fix this so it parses as JSON:\n\n${raw}`,
    temperature: 0,
  });
  return JSON.parse(retry);
}

export async function listModels() {
  const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/models`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`openclaude ${res.status}: ${res.statusText}`);
  const data = await res.json();
  return (data?.data || []).map((m) => m.id).filter(Boolean);
}

export async function ping() {
  // openclaude may or may not have /health — try /models as a liveness check
  const res = await fetch(`${BASE_URL.replace(/\/$/, '')}/models`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) throw new Error(`openclaude ${res.status}: ${res.statusText}`);
  return { version: 'unknown', provider: 'openclaude' };
}

export const config = { BASE_URL, MODEL, TIMEOUT_MS, DEFAULT_TEMPERATURE };
