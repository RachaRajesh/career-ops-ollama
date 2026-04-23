#!/usr/bin/env node
// scripts/menu.mjs
// Interactive menu. Launch with: npm start
//
// Options:
//   [1] Single link — evaluate one job
//   [2] Multiple links — batch pipeline (evaluate all, filter, PDF + apply for picks)
//   [3] Batch folder — evaluate every file in ./jds
//   [4] Scan portals
//   [5] Generate PDF (standalone)
//   [6] Auto-fill one application
//   [7] View tracker
//   [8] Doctor
//   [9] Help

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import 'dotenv/config';
import { c, paths } from './lib/util.mjs';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(q) { return new Promise((r) => rl.question(q, (a) => r(a.trim()))); }
function clear() { process.stdout.write('\x1b[2J\x1b[H'); }

function banner() {
  console.log('');
  console.log(c.bold(c.cyan('  ╔══════════════════════════════════════════════╗')));
  console.log(c.bold(c.cyan('  ║        CAREER-OPS · Ollama Edition           ║')));
  console.log(c.bold(c.cyan('  ║        local-LLM job search toolkit          ║')));
  console.log(c.bold(c.cyan('  ╚══════════════════════════════════════════════╝')));
  console.log('');
}
function hr() { console.log(c.dim('  ' + '─'.repeat(46))); }

function run(scriptPath, args = []) {
  return new Promise((resolve) => {
    console.log('');
    const proc = spawn(process.execPath, [scriptPath, ...args], { stdio: 'inherit', env: process.env });
    proc.on('close', (code) => resolve(code || 0));
  });
}

async function pause(msg = 'Press Enter to return to the menu...') {
  console.log('');
  await ask(c.dim('  ' + msg));
}

// ---------------------------------------------------------------------------

function isExampleCv() {
  // Flag the "still using Jane Doe" bug — cv.md exists but contains the example content
  if (!fs.existsSync(paths.cv)) return false;
  try {
    const head = fs.readFileSync(paths.cv, 'utf8').slice(0, 400).toLowerCase();
    return head.includes('jane doe') || head.includes('jane@example.com');
  } catch { return false; }
}
function cvHint() {
  if (!fs.existsSync(paths.cv)) return 'copy examples/cv.example.md to cv.md and replace with your real CV';
  if (isExampleCv()) return 'cv.md still contains the Jane Doe example — replace it with YOUR CV';
  return '';
}

function setupStatus() {
  const checks = [
    { name: 'Ollama configured', ok: !!process.env.OLLAMA_MODEL, hint: 'edit .env — set OLLAMA_MODEL' },
    { name: 'Your CV (cv.md)',   ok: fs.existsSync(paths.cv) && !isExampleCv(), hint: cvHint() },
    { name: 'Profile',           ok: fs.existsSync(paths.profile), hint: 'copy config/profile.example.yml to config/profile.yml' },
    { name: '.env file',         ok: fs.existsSync('.env'), hint: 'copy .env.example to .env' },
  ];
  const model = process.env.OLLAMA_MODEL || '(not set)';
  return { checks, model };
}

function renderStatus() {
  const { checks, model } = setupStatus();
  console.log(c.dim('  Setup:'));
  for (const ch of checks) {
    const mark = ch.ok ? c.green('✓') : c.red('✗');
    const text = ch.ok ? c.dim(ch.name) : c.red(`${ch.name} — ${ch.hint}`);
    console.log(`    ${mark} ${text}`);
  }
  console.log(c.dim(`    model: ${model}`));
  console.log('');
}

// ---------------------------------------------------------------------------

const MAIN_MENU = [
  { key: '1', label: 'Evaluate ONE job (single link)',     desc: 'Paste one URL, file, or JD text → scored report',       run: evaluateOneFlow },
  { key: '2', label: 'Batch pipeline (MULTIPLE links)',    desc: 'Paste N URLs → filter by score → PDF + apply picks',    run: pipelineFlow },
  { key: '3', label: 'Batch-evaluate a folder',            desc: 'Run every .txt/.md in ./jds through the evaluator',     run: batchFolderFlow },
  { key: '4', label: 'Scan job portals',                   desc: 'Crawl configured companies for new listings',           run: scanFlow },
  { key: '5', label: 'Generate tailored PDF',              desc: 'Turn an existing report into an ATS-optimized CV',      run: pdfFlow },
  { key: '6', label: 'Auto-fill one application',          desc: 'Open browser, fill form, you review + submit',          run: applyOneFlow },
  { key: '7', label: 'View tracker (your pipeline)',       desc: 'Pretty-print every job you\'ve evaluated',              run: trackerFlow },
  { key: '8', label: 'Run setup check (doctor)',           desc: 'Verify Ollama is running and everything configured',    run: doctorFlow },
  { key: '9', label: 'Help — what does this do?',          desc: 'Quick intro for first-time users',                      run: helpFlow },
  { key: 'q', label: 'Quit',                               desc: '',                                                      run: async () => 'quit' },
];

async function main() {
  while (true) {
    clear();
    banner();
    renderStatus();

    const { checks } = setupStatus();
    if (checks.some((ch) => !ch.ok)) {
      console.log(c.yellow('  ⚠ Setup is incomplete. Fix the ✗ items above or option 8 will tell you how.'));
      console.log('');
    }

    console.log(c.bold('  What would you like to do?'));
    console.log('');
    for (const item of MAIN_MENU) {
      const k = c.bold(c.cyan(` [${item.key}]`));
      const l = c.bold(item.label.padEnd(36));
      const d = c.dim(item.desc);
      console.log(`  ${k}  ${l}${d}`);
    }
    console.log('');

    const choice = (await ask(c.bold('  Enter a number (or q to quit) › '))).toLowerCase();
    const item = MAIN_MENU.find((m) => m.key === choice);
    if (!item) { console.log(c.red('  That\'s not an option. Try again.')); await pause(); continue; }
    const result = await item.run();
    if (result === 'quit') break;
  }
  console.log('');
  console.log(c.dim('  Good luck with the job hunt. 👋'));
  console.log('');
  rl.close();
}

// ---------------------------------------------------------------------------

async function evaluateOneFlow() {
  clear(); banner();
  console.log(c.bold('  📋 Evaluate ONE job'));
  hr();
  console.log('');
  console.log(`    ${c.cyan('[1]')} Paste a URL`);
  console.log(`    ${c.cyan('[2]')} Paste the JD text`);
  console.log(`    ${c.cyan('[3]')} Point at a file`);
  console.log(`    ${c.cyan('[b]')} Back`);
  console.log('');
  const mode = (await ask(c.bold('  How? › '))).toLowerCase();
  if (mode === 'b' || mode === '') return;

  let args;
  if (mode === '1') {
    const url = await ask(c.bold('  URL: '));
    if (!url) return pause();
    args = ['--url', url];
  } else if (mode === '2') {
    console.log(c.dim('  Paste JD, then Enter on an empty line:'));
    const jd = await readMultiline();
    if (!jd.trim()) { console.log(c.yellow('  Empty.')); return pause(); }
    const tmpPath = path.join(paths.data || './data', `.pasted-${Date.now()}.txt`);
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, jd);
    args = ['--file', tmpPath];
  } else if (mode === '3') {
    const file = await ask(c.bold('  File path: '));
    if (!file || !fs.existsSync(file)) { console.log(c.red('  Not found.')); return pause(); }
    args = ['--file', file];
  } else { console.log(c.red('  Not valid.')); return pause(); }

  await run('scripts/evaluate.mjs', args);
  await pause();
}

async function pipelineFlow() {
  await run('scripts/pipeline.mjs', []);
  await pause();
}

async function batchFolderFlow() {
  clear(); banner();
  console.log(c.bold('  📚 Batch-evaluate a folder'));
  hr();
  const dir = await ask(c.bold(`  Directory [${c.dim('./jds')}] › `)) || './jds';
  if (!fs.existsSync(dir)) { console.log(c.red(`  Not found: ${dir}`)); return pause(); }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt') || f.endsWith('.md'));
  console.log(c.dim(`  Found ${files.length} file(s) in ${dir}`));
  if (files.length === 0) return pause();

  const concurrency = await ask(c.bold('  Parallel workers [2] › ')) || '2';
  const go = (await ask(c.bold('  Start? [Y/n] › '))).toLowerCase();
  if (go === 'n') return;
  await run('scripts/batch.mjs', ['--dir', dir, '--concurrency', concurrency]);
  await pause();
}

async function scanFlow() {
  clear(); banner();
  console.log(c.bold('  🔍 Scan job portals')); hr();
  if (!fs.existsSync('portals.yml')) {
    console.log(c.red('  No portals.yml. Copy templates/portals.example.yml first.'));
    return pause();
  }
  const go = (await ask(c.bold('  Start scan? [Y/n] › '))).toLowerCase();
  if (go === 'n') return;
  await run('scripts/scan.mjs', []);
  await pause();
}

async function pdfFlow() {
  clear(); banner();
  console.log(c.bold('  📄 Generate tailored CV PDF')); hr();
  const reportsDir = paths.reports || './reports';
  if (!fs.existsSync(reportsDir)) { console.log(c.red('  No reports yet.')); return pause(); }
  const reports = fs.readdirSync(reportsDir).filter((f) => f.endsWith('.md')).sort().reverse();
  if (reports.length === 0) { console.log(c.yellow('  No reports yet.')); return pause(); }

  console.log(c.dim('  Pick a report (newest first):\n'));
  const show = reports.slice(0, 15);
  show.forEach((r, i) => console.log(`    ${c.cyan(`[${i + 1}]`)} ${r}`));
  if (reports.length > 15) console.log(c.dim(`    (${reports.length - 15} older hidden)`));
  console.log('');

  const pick = await ask(c.bold('  Number › '));
  const idx = parseInt(pick, 10) - 1;
  if (isNaN(idx) || !show[idx]) { console.log(c.red('  Invalid.')); return pause(); }
  await run('scripts/generate-pdf.mjs', ['--report', path.join(reportsDir, show[idx])]);
  await pause();
}

async function applyOneFlow() {
  clear(); banner();
  console.log(c.bold('  📝 Auto-fill ONE application')); hr();
  console.log(c.yellow('  Before you continue:'));
  console.log(c.dim('    • A browser opens — watch it.'));
  console.log(c.dim('    • Unknown fields flagged ⚠ — review carefully.'));
  console.log(c.dim('    • Script will NOT click submit. You submit yourself.'));
  console.log(c.dim('    • Don\'t use on LinkedIn — they detect and suspend accounts.'));
  console.log('');
  const url = await ask(c.bold('  Application URL (blank to cancel) › '));
  if (!url) return;
  if (!/^https?:\/\//.test(url)) { console.log(c.red('  Not a URL.')); return pause(); }
  const ok = (await ask(c.bold('  Profile is filled honestly (esp. work_authorization)? [y/N] › '))).toLowerCase();
  if (ok !== 'y') { console.log(c.yellow('  → Fix config/profile.yml first.')); return pause(); }
  await run('scripts/apply.mjs', ['--url', url]);
  await pause();
}

async function trackerFlow() {
  clear(); banner();
  console.log(c.bold('  📊 Your pipeline')); hr();
  const min = await ask(c.bold(`  Minimum score [${c.dim('0')}] › `)) || '0';
  await run('scripts/tracker.mjs', ['--min', min]);
  await pause();
}

async function doctorFlow() {
  clear(); banner();
  console.log(c.bold('  🩺 Setup check')); hr();
  await run('scripts/doctor.mjs', []);
  await pause();
}

async function helpFlow() {
  clear(); banner();
  console.log(c.bold('  📖 What is this?')); hr();
  console.log('');
  console.log('  Career-ops is a local job search assistant. Runs on your machine,');
  console.log('  uses your Ollama models (no API keys, no data leaves the laptop).');
  console.log('');
  console.log(c.bold('  Two main flows:'));
  console.log('');
  console.log(c.cyan('    SINGLE  ') + '  Option 1 — one job at a time.');
  console.log(c.cyan('    BATCH   ') + '  Option 2 — paste many URLs, it evaluates all, you pick');
  console.log(c.dim('             which ones to PDF + apply to. Recommended when you\'re'));
  console.log(c.dim('             triaging a list of jobs from your inbox or LinkedIn.'));
  console.log('');
  console.log(c.bold('  Golden rule:'));
  console.log('');
  console.log(c.yellow('    "This is a FILTER, not a spray-and-pray aid."'));
  console.log('');
  console.log('  Don\'t apply to jobs scoring below 4.0. Don\'t invent experience on');
  console.log('  your CV. The gap analyzer flags missing requirements — you decide');
  console.log('  which ones you actually have.');
  console.log('');
  console.log(c.dim('  Docs: docs/SETUP.md · docs/AUTO_APPLY.md · docs/ARCHITECTURE.md'));
  await pause();
}

function readMultiline() {
  return new Promise((resolve) => {
    const lines = [];
    const onLine = (line) => {
      if (line.trim() === '' && lines.length > 0) {
        rl.removeListener('line', onLine);
        resolve(lines.join('\n'));
      } else if (line.trim()) {
        lines.push(line);
      }
    };
    rl.on('line', onLine);
  });
}

main().catch((err) => {
  console.error(c.red(`\nFatal: ${err.message}\n`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
