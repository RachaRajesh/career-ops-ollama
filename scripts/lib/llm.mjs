// scripts/lib/llm.mjs
// Provider dispatcher. This is the ONLY file other scripts should import from
// for LLM calls. It reads LLM_PROVIDER from the environment and routes every
// call to the appropriate backend.
//
// Supported providers (as of now):
//   "ollama"     — direct to local Ollama server (default, reliable)
//   "openclaude" — through openclaude's OpenAI-compatible endpoint
//
// Adding a new provider = add a case in loadProvider() + create a sibling
// module that exports { chat, chatJSON, listModels, ping, config }.

import 'dotenv/config';

const PROVIDER = (process.env.LLM_PROVIDER || 'ollama').toLowerCase();

let provider;

async function loadProvider() {
  if (provider) return provider;
  switch (PROVIDER) {
    case 'ollama':
      provider = await import('./ollama.mjs');
      break;
    case 'openclaude':
      provider = await import('./openclaude.mjs');
      break;
    default:
      throw new Error(
        `Unknown LLM_PROVIDER="${PROVIDER}". Supported: "ollama" (default), "openclaude".\n` +
        `Edit .env or export LLM_PROVIDER=ollama to fix.`
      );
  }
  return provider;
}

/** Provider name, for logging. */
export const PROVIDER_NAME = PROVIDER;

/** chat({ system, user, temperature?, model?, json? }) → Promise<string> */
export async function chat(opts) {
  const p = await loadProvider();
  return p.chat(opts);
}

/** chatJSON({ ... }) → Promise<object> */
export async function chatJSON(opts) {
  const p = await loadProvider();
  return p.chatJSON(opts);
}

/** listModels() → Promise<string[]> */
export async function listModels() {
  const p = await loadProvider();
  return p.listModels();
}

/** ping() → Promise<{ version, ... }> */
export async function ping() {
  const p = await loadProvider();
  return p.ping();
}

/** Provider-specific config snapshot, for the doctor to display. */
export async function getConfig() {
  const p = await loadProvider();
  return { provider: PROVIDER, ...p.config };
}
