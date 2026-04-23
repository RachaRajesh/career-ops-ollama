#!/usr/bin/env node
// scripts/batch.mjs
// Evaluate every .txt / .md file in a directory. Runs N workers in parallel.
// With local Ollama you're usually GPU/RAM-bound, not API-bound, so keep the
// concurrency low — 2-3 is typically the sweet spot unless you have a beefy rig.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs, c } from './lib/util.mjs';

const args = parseArgs();
const dir = args.flags.dir || './jds';
const concurrency = parseInt(args.flags.concurrency || '2', 10);

if (!fs.existsSync(dir)) {
  console.error(c.red(`Directory not found: ${dir}`));
  process.exit(1);
}

const files = fs.readdirSync(dir)
  .filter((f) => f.endsWith('.txt') || f.endsWith('.md'))
  .map((f) => path.join(dir, f));

if (files.length === 0) {
  console.error(c.yellow(`No .txt or .md files in ${dir}`));
  process.exit(0);
}

console.log(c.bold(`\nBatch: ${files.length} JDs, concurrency=${concurrency}\n`));

const queue = [...files];
const results = { done: 0, failed: 0 };

async function worker(id) {
  while (queue.length) {
    const file = queue.shift();
    const idx = files.length - queue.length;
    console.log(c.cyan(`  [w${id}] (${idx}/${files.length}) ${path.basename(file)}`));
    try {
      await runOne(file);
      results.done++;
    } catch (err) {
      console.log(c.red(`  [w${id}] FAIL ${path.basename(file)}: ${err.message}`));
      results.failed++;
    }
  }
}

function runOne(file) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['scripts/evaluate.mjs', '--file', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.stdout.on('data', () => {}); // swallow per-job chatter
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-300) || `exit ${code}`));
    });
  });
}

const workers = Array.from({ length: concurrency }, (_, i) => worker(i + 1));
await Promise.all(workers);

console.log('');
console.log(c.bold(`Done: ${results.done} ok, ${results.failed} failed.`));
