#!/usr/bin/env node
// scripts/bulk-apply.mjs
// ============================================================================
// BULK AUTO-APPLY — runs scripts/apply.mjs over multiple application URLs.
//
// Usage:
//   node scripts/bulk-apply.mjs --urls url1,url2,url3
//   node scripts/bulk-apply.mjs --from data/queue.txt     # one URL per line
//
// For each URL: spawns apply.mjs, sets APPLY_FAILURE_LOG env var so failures
// auto-append to a CSV. Between jobs, prompts "press Enter for next job"
// so you have time to review and click submit.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { paths, c, parseArgs, ensureDir } from './lib/util.mjs';

const args = parseArgs();

async function main() {
  // Build the URL list
  let urls = [];
  if (args.flags.urls) {
    urls = String(args.flags.urls).split(/[,\s]+/).filter(Boolean);
  } else if (args.flags.from) {
    const file = args.flags.from;
    if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
    urls = fs.readFileSync(file, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#') && /^https?:\/\//.test(l));
  } else {
    console.error(c.red('Pass --urls url1,url2 or --from path/to/file.txt'));
    process.exit(1);
  }

  if (urls.length === 0) {
    console.log(c.yellow('No URLs to process.'));
    return;
  }

  // Set up the failure log
  const date = new Date().toISOString().slice(0, 10);
  const failureLog = path.join(paths.data || './data', `failures_${date}.csv`);
  ensureDir(path.dirname(failureLog));

  console.log(c.bold(`\nBulk auto-apply\n`));
  console.log(c.dim(`  urls:         ${urls.length}`));
  console.log(c.dim(`  failure log:  ${failureLog}`));
  console.log(c.dim(`  pause:        press Enter between jobs`));
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  const stats = { total: urls.length, done: 0, failed: 0 };

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(c.bold(c.cyan(`\n─── [${i + 1}/${stats.total}] ${truncate(url, 80)} ───`)));

    try {
      await runApply(url, failureLog);
      stats.done++;
    } catch (err) {
      stats.failed++;
      console.log(c.red(`  run failed: ${err.message}`));
    }

    if (i < urls.length - 1) {
      console.log('');
      await ask(c.dim('Press Enter for next job (or Ctrl+C to stop) › '));
    }
  }

  rl.close();

  console.log('');
  console.log(c.bold('─── DONE ───'));
  console.log(`  ${c.green(stats.done + ' processed')}, ${stats.failed ? c.red(stats.failed + ' run failures') : c.dim('0 run failures')}`);
  if (fs.existsSync(failureLog)) {
    const lines = fs.readFileSync(failureLog, 'utf8').split('\n').filter((l) => l).length - 1;
    if (lines > 0) {
      console.log('');
      console.log(c.yellow(`  ⚠ ${lines} application(s) could not be auto-filled.`));
      console.log(c.dim(`    Open for manual retry: ${failureLog}`));
    }
  }
  console.log('');
}

function runApply(url, failureLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/apply.mjs', '--url', url], {
      stdio: 'inherit',
      env: { ...process.env, APPLY_FAILURE_LOG: failureLog },
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`apply.mjs exited ${code}`));
    });
  });
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 3) + '...' : s;
}

main().catch((err) => {
  console.error(c.red(`\nError: ${err.message}\n`));
  process.exit(1);
});
