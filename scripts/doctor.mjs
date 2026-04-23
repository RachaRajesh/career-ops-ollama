#!/usr/bin/env node
// scripts/doctor.mjs
// Environment checks. Provider-aware: tests Ollama OR openclaude based on
// whatever LLM_PROVIDER is set to. Catches 90% of "it doesn't work" problems.

import fs from 'node:fs';
import 'dotenv/config';
import { ping, listModels, chat, getConfig, PROVIDER_NAME } from './lib/llm.mjs';
import { paths, c } from './lib/util.mjs';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

// The provider endpoint check + model check need dynamic labels because the
// backend could be Ollama or openclaude. We fetch config once up front.
const llmConfig = await getConfig();
const endpoint = llmConfig.HOST || llmConfig.BASE_URL || '(unknown)';

check(`${PROVIDER_NAME} server reachable`, async () => {
  const v = await ping();
  const version = v.version || 'unknown';
  return `OK — ${PROVIDER_NAME} ${version} at ${endpoint}`;
});

check(`Model "${llmConfig.MODEL}" available`, async () => {
  try {
    const models = await listModels();
    const match = models.find((m) =>
      m === llmConfig.MODEL ||
      m.startsWith(llmConfig.MODEL + ':') ||
      m.replace(':latest', '') === llmConfig.MODEL
    );
    if (!match) {
      const hint = PROVIDER_NAME === 'ollama'
        ? `Not pulled. Run: ollama pull ${llmConfig.MODEL}`
        : `openclaude doesn't report "${llmConfig.MODEL}" as available. Check /provider inside openclaude, or set OPENCLAUDE_MODEL to match what's configured.`;
      throw new Error(`${hint}\nAvailable: ${models.slice(0, 10).join(', ') || '(none)'}`);
    }
    return `OK — ${match}`;
  } catch (err) {
    // Some openclaude versions don't implement /v1/models. Fall back to a chat test.
    if (PROVIDER_NAME === 'openclaude' && /404|not.found|unsupported/i.test(err.message)) {
      return `SKIP — openclaude doesn't expose /v1/models (not an error, will verify via chat test below)`;
    }
    throw err;
  }
});

check('cv.md exists', async () => {
  if (!fs.existsSync(paths.cv)) {
    throw new Error(`Missing ${paths.cv}. Copy examples/cv.example.md and edit.`);
  }
  const bytes = fs.statSync(paths.cv).size;
  if (bytes < 200) throw new Error(`${paths.cv} is suspiciously small (${bytes} bytes). Did you fill it in?`);
  // Catch the Jane Doe bug
  const head = fs.readFileSync(paths.cv, 'utf8').slice(0, 400).toLowerCase();
  if (head.includes('jane doe') || head.includes('jane@example.com')) {
    throw new Error(`cv.md still contains the Jane Doe example. Replace it with YOUR actual CV content.`);
  }
  return `OK — ${bytes} bytes`;
});

check('config/profile.yml exists', async () => {
  if (!fs.existsSync(paths.profile)) {
    throw new Error(`Missing ${paths.profile}. Copy config/profile.example.yml and edit.`);
  }
  return 'OK';
});

check('modes/ directory populated', async () => {
  if (!fs.existsSync(paths.modes)) throw new Error(`Missing ${paths.modes}/`);
  const files = fs.readdirSync(paths.modes).filter((f) => f.endsWith('.md'));
  if (files.length === 0) throw new Error(`No .md files in ${paths.modes}/`);
  return `OK — ${files.length} modes`;
});

check('Playwright chromium installed', async () => {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return 'OK';
  } catch (err) {
    throw new Error(`Playwright chromium not installed. Run: npx playwright install chromium\n(${err.message})`);
  }
});

check('LLM round-trip works', async () => {
  const out = await chat({
    system: 'Reply with exactly one word: "pong".',
    user: 'ping',
    temperature: 0,
  });
  const ok = /pong/i.test(out);
  return ok ? `OK — ${PROVIDER_NAME} responded correctly` : `WARN — ${PROVIDER_NAME} replied "${out.trim().slice(0, 60)}" instead of "pong"`;
});

// Run sequentially so output is readable
console.log(c.bold(`\nCareer-Ops doctor — provider: ${c.cyan(PROVIDER_NAME)}\n`));
let failed = 0;
for (const { name, fn } of checks) {
  process.stdout.write(`  ${c.dim('•')} ${name} ... `);
  try {
    const msg = await fn();
    if (msg.startsWith('SKIP')) console.log(c.yellow(msg));
    else console.log(c.green(msg));
  } catch (err) {
    console.log(c.red('FAIL'));
    console.log(c.red(`      ${err.message.split('\n').join('\n      ')}`));
    failed++;
  }
}
console.log('');
if (failed) {
  console.log(c.red(`${failed} check(s) failed. Fix those before running anything else.`));
  process.exit(1);
} else {
  console.log(c.green("All checks passed. You're good to go."));
}
