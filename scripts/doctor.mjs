#!/usr/bin/env node
// scripts/doctor.mjs
// Sanity checks: is Ollama up? is the model pulled? do the config files exist?
// Run this first; it catches 90% of "it doesn't work" problems.

import fs from 'node:fs';
import 'dotenv/config';
import { ping, listModels, config } from './lib/ollama.mjs';
import { paths, c } from './lib/util.mjs';

const checks = [];
function check(name, fn) { checks.push({ name, fn }); }

check('Ollama server reachable', async () => {
  const v = await ping();
  return `OK — Ollama ${v.version} at ${config.HOST}`;
});

check(`Model "${config.MODEL}" available`, async () => {
  const models = await listModels();
  // Ollama appends `:latest` to some tags; accept either form.
  const match = models.find((m) => m === config.MODEL || m.startsWith(config.MODEL + ':') || m.replace(':latest', '') === config.MODEL);
  if (!match) {
    throw new Error(`Not pulled. Run: ollama pull ${config.MODEL}\nAvailable: ${models.join(', ') || '(none)'}`);
  }
  return `OK — ${match}`;
});

check('cv.md exists', async () => {
  if (!fs.existsSync(paths.cv)) {
    throw new Error(`Missing ${paths.cv}. Copy examples/cv.example.md and edit.`);
  }
  const bytes = fs.statSync(paths.cv).size;
  if (bytes < 200) throw new Error(`${paths.cv} is suspiciously small (${bytes} bytes). Did you fill it in?`);
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
  const { chat } = await import('./lib/ollama.mjs');
  const out = await chat({
    system: 'Reply with exactly one word: "pong".',
    user: 'ping',
    temperature: 0,
  });
  const ok = /pong/i.test(out);
  return ok ? `OK — model responded` : `WARN — model replied "${out.trim().slice(0, 60)}" instead of "pong"`;
});

// Run sequentially so output is readable
console.log(c.bold('\nCareer-Ops (Ollama Edition) — doctor\n'));
let failed = 0;
for (const { name, fn } of checks) {
  process.stdout.write(`  ${c.dim('•')} ${name} ... `);
  try {
    const msg = await fn();
    console.log(c.green(msg));
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
  console.log(c.green('All checks passed. You\'re good to go.'));
}
