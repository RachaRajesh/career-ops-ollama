#!/usr/bin/env node
// scripts/bulk-apply.mjs
// ============================================================================
// BULK AUTO-APPLY — runs scripts/apply.mjs over multiple application URLs.
//
// Three input modes:
//   --urls url1,url2,url3              # comma-separated URLs
//   --from data/queue.txt              # one URL per line
//   --roster path/to/roster.xlsx       # the Excel written by process-excel.mjs
//                                      #   (matches each URL to its tailored PDF)
//
// The --roster mode is the sweet spot: process-excel.mjs ran, generated PDFs,
// and wrote application_roster.xlsx. This command picks that up and applies
// to every row, passing the right tailored PDF for each job.
//
// Between jobs: prompts "press Enter for next" so the human reviews and
// submits the current one before the script moves on.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import ExcelJS from 'exceljs';
import { paths, c, parseArgs, ensureDir } from './lib/util.mjs';

const args = parseArgs();

async function main() {
  // Build the work list — each item has { url, resumePdf }
  const items = await buildWorkList();
  if (items.length === 0) {
    console.log(c.yellow('No URLs to process.'));
    return;
  }

  // Optional minimum score filter (only when using --roster, since the roster
  // has scores attached)
  const minScore = parseFloat(args.flags.min || '0');
  let filtered = items;
  if (minScore > 0 && items.some((it) => it.score !== undefined)) {
    filtered = items.filter((it) => (it.score ?? 0) >= minScore);
    console.log(c.dim(`  filtered to ${filtered.length} items with score ≥ ${minScore}`));
  }

  // Set up the failure log
  const date = new Date().toISOString().slice(0, 10);
  const failureLog = path.join(paths.data || './data', `failures_${date}.csv`);
  ensureDir(path.dirname(failureLog));

  console.log(c.bold(`\nBulk auto-apply\n`));
  console.log(c.dim(`  items:        ${filtered.length}`));
  console.log(c.dim(`  failure log:  ${failureLog}`));
  console.log(c.dim(`  pause:        press Enter between jobs`));
  console.log('');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  const stats = { total: filtered.length, done: 0, failed: 0 };

  for (let i = 0; i < filtered.length; i++) {
    const item = filtered[i];
    console.log(c.bold(c.cyan(`\n─── [${i + 1}/${stats.total}]${item.company ? ` ${item.company}` : ''}${item.role ? ` — ${item.role}` : ''} ───`)));
    console.log(c.dim(`  ${truncate(item.url, 80)}`));
    if (item.resumePdf) console.log(c.dim(`  resume:  ${path.basename(item.resumePdf)}`));

    try {
      await runApply(item, failureLog);
      stats.done++;
    } catch (err) {
      stats.failed++;
      console.log(c.red(`  run failed: ${err.message}`));
    }

    if (i < filtered.length - 1) {
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

// ---------------------------------------------------------------------------
// Input parsing — URLs alone, URLs from a file, or the full roster Excel

async function buildWorkList() {
  // Roster mode — the preferred path (knows which PDF goes with which URL)
  if (args.flags.roster) {
    const file = args.flags.roster;
    if (!fs.existsSync(file)) throw new Error(`Roster not found: ${file}`);
    const rosterDir = path.dirname(file);
    return readRoster(file, rosterDir);
  }

  // Plain URL list modes
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
    console.error(c.red('Pass one of: --roster path.xlsx | --urls url1,url2 | --from path.txt'));
    process.exit(1);
  }
  return urls.map((url) => ({ url, resumePdf: '', company: '', role: '', score: undefined }));
}

/**
 * Read the application_roster.xlsx written by process-excel.mjs.
 * Expected columns (from the "Apply to these" sheet):
 *   # | Score | Company | Role | Resume PDF to use | Application URL | ...
 */
async function readRoster(filepath, rosterDir) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filepath);
  const sheet = wb.getWorksheet('Apply to these') || wb.worksheets[0];
  if (!sheet) throw new Error(`No worksheet found in ${filepath}`);

  const items = [];
  sheet.eachRow((rowObj, rowNumber) => {
    if (rowNumber === 1) return; // header
    // Score col 2, Company col 3, Role col 4, PDF col 5, URL col 6
    const score = parseFloat(String(rowObj.getCell(2).value ?? '').split('/')[0]) || 0;
    const company = String(rowObj.getCell(3).value ?? '').trim();
    const role = String(rowObj.getCell(4).value ?? '').trim();
    const pdfFile = String(rowObj.getCell(5).value ?? '').trim();
    // URL cell may be a hyperlink object {text, hyperlink} or a plain string
    const urlCell = rowObj.getCell(6).value;
    const url = (urlCell && typeof urlCell === 'object' ? urlCell.text || urlCell.hyperlink : String(urlCell || '')).trim();
    if (!/^https?:\/\//.test(url)) return;

    const resumePdf = pdfFile && pdfFile !== '—'
      ? path.resolve(rosterDir, pdfFile)
      : '';
    items.push({ url, resumePdf, company, role, score });
  });
  return items;
}

// ---------------------------------------------------------------------------
// Subprocess runner — spawns apply.mjs with the right flags

function runApply(item, failureLog) {
  return new Promise((resolve, reject) => {
    const applyArgs = ['scripts/apply.mjs', '--url', item.url];
    if (item.resumePdf) applyArgs.push('--resume', item.resumePdf);

    const child = spawn(process.execPath, applyArgs, {
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
