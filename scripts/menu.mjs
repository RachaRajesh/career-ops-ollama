#!/usr/bin/env node
// scripts/menu.mjs
// Interactive menu for people who don't want to remember command-line flags.
// Launch with: npm start   (or: node scripts/menu.mjs)
//
// Everything here calls the same underlying scripts as `npm run evaluate`,
// `npm run apply`, etc. — this is just a friendlier front door.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import 'dotenv/config';
import { c, paths } from './lib/util.mjs';

// ---------------------------------------------------------------------------
// UI helpers

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

/** Ask a question, return the trimmed answer. */
function ask(q) {
  return new Promise((resolve) => rl.question(q, (a) => resolve(a.trim())));
}

function clear() {
  // ANSI clear screen + cursor home. Works on macOS/Linux/modern Windows terminals.
  process.stdout.write('\x1b[2J\x1b[H');
}

function banner() {
  console.log('');
  console.log(c.bold(c.cyan('  ╔══════════════════════════════════════════════╗')));
  console.log(c.bold(c.cyan('  ║        CAREER-OPS · Ollama Edition           ║')));
  console.log(c.bold(c.cyan('  ║        local-LLM job search toolkit          ║')));
  console.log(c.bold(c.cyan('  ╚══════════════════════════════════════════════╝')));
  console.log('');
}

function hr() { console.log(c.dim('  ' + '─'.repeat(46))); }

/** Run a child script with args, stream its output, resolve when it exits. */
function run(scriptPath, args = []) {
  return new Promise((resolve) => {
    console.log('');
    const proc = spawn(process.execPath, [scriptPath, ...args], {
      stdio: 'inherit',
      env: process.env,
    });
    proc.on('close', (code) => resolve(code || 0));
  });
}

async function pause(msg = 'Press Enter to return to the menu...') {
  console.log('');
  await ask(c.dim('  ' + msg));
}

// ---------------------------------------------------------------------------
// Setup status — what the menu shows at the top so users know what's missing

function setupStatus() {
  const checks = [
    { name: 'Ollama configured', ok: !!process.env.OLLAMA_MODEL, hint: 'edit .env — set OLLAMA_MODEL' },
    { name: 'Your CV (cv.md)',   ok: fs.existsSync(paths.cv), hint: 'copy examples/cv.example.md to cv.md and edit' },
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
// Menu definitions

const MAIN_MENU = [
  { key: '1', label: 'Evaluate a job',                desc: 'Paste a URL, file, or JD text → get a scored report',   run: evaluateFlow },
  { key: '2', label: 'Batch-evaluate a folder',       desc: 'Run every .txt/.md in ./jds through the evaluator',     run: batchFlow },
  { key: '3', label: 'Scan job portals',              desc: 'Crawl configured companies for new listings',           run: scanFlow },
  { key: '4', label: 'Generate tailored PDF',         desc: 'Turn an evaluation report into an ATS-optimized CV',    run: pdfFlow },
  { key: '5', label: 'Auto-fill an application',      desc: 'Opens browser, fills form, you review + submit',        run: applyFlow },
  { key: '6', label: 'View tracker (your pipeline)',  desc: 'Pretty-print every job you\'ve evaluated',              run: trackerFlow },
  { key: '7', label: 'Run setup check (doctor)',      desc: 'Verify Ollama is running and everything is configured', run: doctorFlow },
  { key: '8', label: 'Help — what does this do?',     desc: 'Quick intro for first-time users',                      run: helpFlow },
  { key: 'q', label: 'Quit',                          desc: '',                                                      run: async () => 'quit' },
];

// ---------------------------------------------------------------------------
// Main loop

async function main() {
  // If setup is broken, nudge the user to fix it before they try anything.
  const { checks } = setupStatus();
  const missing = checks.filter((c) => !c.ok);

  while (true) {
    clear();
    banner();
    renderStatus();

    if (missing.length && !process.env.SKIP_SETUP_WARNING) {
      console.log(c.yellow('  ⚠ Setup is incomplete. Some actions will fail until you fix the ✗ items above.'));
      console.log(c.dim('    (Run option 7 for a full diagnostic.)'));
      console.log('');
    }

    console.log(c.bold('  What would you like to do?'));
    console.log('');
    for (const item of MAIN_MENU) {
      const k = c.bold(c.cyan(` [${item.key}]`));
      const l = c.bold(item.label.padEnd(32));
      const d = c.dim(item.desc);
      console.log(`  ${k}  ${l}${d}`);
    }
    console.log('');

    const choice = (await ask(c.bold('  Enter a number (or q to quit) › '))).toLowerCase();
    const item = MAIN_MENU.find((m) => m.key === choice);
    if (!item) {
      console.log(c.red('  That\'s not an option. Try again.'));
      await pause();
      continue;
    }

    const result = await item.run();
    if (result === 'quit') break;
  }

  console.log('');
  console.log(c.dim('  Good luck with the job hunt. 👋'));
  console.log('');
  rl.close();
}

// ---------------------------------------------------------------------------
// Individual flows

async function evaluateFlow() {
  clear();
  banner();
  console.log(c.bold('  📋 Evaluate a job'));
  hr();
  console.log(c.dim('  You can provide the job three ways:'));
  console.log('');
  console.log(`    ${c.cyan('[1]')} Paste a URL       (works best — we scrape the page)`);
  console.log(`    ${c.cyan('[2]')} Paste the JD text (copy-paste the whole description)`);
  console.log(`    ${c.cyan('[3]')} Point at a file   (e.g. something you saved in ./jds/)`);
  console.log(`    ${c.cyan('[b]')} Back to menu`);
  console.log('');
  const mode = (await ask(c.bold('  How? › '))).toLowerCase();
  if (mode === 'b' || mode === '') return;

  let args;
  if (mode === '1') {
    const url = await ask(c.bold('  Paste the job URL: '));
    if (!url) return pause();
    args = ['--url', url];
  } else if (mode === '2') {
    console.log('');
    console.log(c.dim('  Paste the JD. When you\'re done, press Enter on an empty line.'));
    const jd = await readMultiline();
    if (!jd.trim()) { console.log(c.yellow('  Empty — nothing to evaluate.')); return pause(); }
    // Write to a temp file so we don't run into shell-arg length limits on long JDs
    const tmpPath = path.join(paths.data || './data', `.pasted-${Date.now()}.txt`);
    fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
    fs.writeFileSync(tmpPath, jd);
    args = ['--file', tmpPath];
  } else if (mode === '3') {
    const file = await ask(c.bold('  Path to the JD file: '));
    if (!file) return pause();
    if (!fs.existsSync(file)) { console.log(c.red(`  File not found: ${file}`)); return pause(); }
    args = ['--file', file];
  } else {
    console.log(c.red('  Not a valid option.'));
    return pause();
  }

  await run('scripts/evaluate.mjs', args);
  await pause();
}

async function batchFlow() {
  clear();
  banner();
  console.log(c.bold('  📚 Batch-evaluate a folder'));
  hr();
  const dir = await ask(c.bold(`  Directory [${c.dim('./jds')}] › `)) || './jds';
  if (!fs.existsSync(dir)) { console.log(c.red(`  Not found: ${dir}`)); return pause(); }
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.txt') || f.endsWith('.md'));
  console.log(c.dim(`  Found ${files.length} file(s) in ${dir}`));
  if (files.length === 0) return pause();

  const concurrency = await ask(c.bold('  Parallel workers [2] › ')) || '2';
  console.log(c.yellow('  (Higher concurrency is faster but uses more RAM. 2 is safe for most setups.)'));

  const go = (await ask(c.bold('  Start? [Y/n] › '))).toLowerCase();
  if (go === 'n') return;

  await run('scripts/batch.mjs', ['--dir', dir, '--concurrency', concurrency]);
  await pause();
}

async function scanFlow() {
  clear();
  banner();
  console.log(c.bold('  🔍 Scan job portals'));
  hr();
  const portals = 'portals.yml';
  if (!fs.existsSync(portals)) {
    console.log(c.red(`  No ${portals} found.`));
    console.log(c.dim(`  Copy templates/portals.example.yml to portals.yml and edit it first.`));
    return pause();
  }
  console.log(c.dim('  This opens a headless browser and extracts listings from each portal in portals.yml.'));
  console.log(c.dim('  Output goes to ./jds/ — then you can batch-evaluate with option 2.'));
  console.log('');
  const go = (await ask(c.bold('  Start scan? [Y/n] › '))).toLowerCase();
  if (go === 'n') return;

  await run('scripts/scan.mjs', []);
  await pause();
}

async function pdfFlow() {
  clear();
  banner();
  console.log(c.bold('  📄 Generate tailored CV PDF'));
  hr();
  const reportsDir = paths.reports || './reports';
  if (!fs.existsSync(reportsDir)) { console.log(c.red(`  No reports yet. Evaluate a job first (option 1).`)); return pause(); }

  const reports = fs.readdirSync(reportsDir).filter((f) => f.endsWith('.md')).sort().reverse();
  if (reports.length === 0) { console.log(c.yellow('  No reports yet. Evaluate a job first (option 1).')); return pause(); }

  console.log(c.dim('  Pick a report (most recent first):'));
  console.log('');
  const show = reports.slice(0, 15);
  show.forEach((r, i) => console.log(`    ${c.cyan(`[${i + 1}]`)} ${r}`));
  if (reports.length > 15) console.log(c.dim(`    (${reports.length - 15} older reports hidden)`));
  console.log('');

  const pick = await ask(c.bold('  Number › '));
  const idx = parseInt(pick, 10) - 1;
  if (isNaN(idx) || !show[idx]) { console.log(c.red('  Invalid choice.')); return pause(); }

  await run('scripts/generate-pdf.mjs', ['--report', path.join(reportsDir, show[idx])]);
  await pause();
}

async function applyFlow() {
  clear();
  banner();
  console.log(c.bold('  📝 Auto-fill an application'));
  hr();
  console.log(c.yellow('  Before you continue, read this:'));
  console.log('');
  console.log(c.dim('    • A browser will open — watch it. Don\'t walk away.'));
  console.log(c.dim('    • The LLM will fill fields using cv.md and config/profile.yml.'));
  console.log(c.dim('    • Unknown fields (salary, visa, EEO) will be flagged ⚠ — review carefully.'));
  console.log(c.dim('    • The script will NOT click submit. You click submit yourself.'));
  console.log(c.dim('    • Don\'t use this on LinkedIn — they detect automation and suspend accounts.'));
  console.log('');
  const url = await ask(c.bold('  Application URL (or blank to cancel) › '));
  if (!url) return;
  if (!/^https?:\/\//.test(url)) { console.log(c.red('  That doesn\'t look like a URL.')); return pause(); }

  const ok = (await ask(c.bold('  Profile is filled out honestly (esp. work_authorization)? [y/N] › '))).toLowerCase();
  if (ok !== 'y') {
    console.log(c.yellow('  → Fix config/profile.yml first. Wrong profile data ends up on a real application.'));
    return pause();
  }

  await run('scripts/apply.mjs', ['--url', url]);
  await pause();
}

async function trackerFlow() {
  clear();
  banner();
  console.log(c.bold('  📊 Your pipeline'));
  hr();
  const min = await ask(c.bold(`  Minimum score to show [${c.dim('0')}] › `)) || '0';
  await run('scripts/tracker.mjs', ['--min', min]);
  await pause();
}

async function doctorFlow() {
  clear();
  banner();
  console.log(c.bold('  🩺 Setup check'));
  hr();
  await run('scripts/doctor.mjs', []);
  await pause();
}

async function helpFlow() {
  clear();
  banner();
  console.log(c.bold('  📖 What is this thing?'));
  hr();
  console.log('');
  console.log('  Career-ops is a local job search assistant. It runs on your machine,');
  console.log('  uses your own Ollama models (no API keys, no data uploaded anywhere),');
  console.log('  and helps you with four things:');
  console.log('');
  console.log(c.cyan('    1. EVALUATE') + '  — score a job 1–5 against your CV, with honest strengths/gaps');
  console.log(c.cyan('    2. TAILOR  ') + '  — rewrite your CV to highlight the right keywords (PDF output)');
  console.log(c.cyan('    3. TRACK   ') + '  — keep a pipeline of every job you\'ve looked at');
  console.log(c.cyan('    4. APPLY   ') + '  — fill application forms for you, but YOU click submit');
  console.log('');
  console.log(c.bold('  First-time workflow:'));
  console.log('');
  console.log('    a) Run option 7 (doctor) — make sure Ollama is working');
  console.log('    b) Run option 1 with a job URL you\'re interested in');
  console.log('    c) If the score is ≥ 4.0, run option 4 to tailor your CV');
  console.log('    d) Manually upload that PDF when you apply');
  console.log('    e) For forms you want auto-filled, option 5 (but read the warning)');
  console.log('');
  console.log(c.bold('  The golden rule of this tool:'));
  console.log('');
  console.log(c.yellow('    "This is a FILTER, not a spray-and-pray aid."'));
  console.log('');
  console.log('  Don\'t apply to jobs scoring below 4.0. Your time is valuable,');
  console.log('  and spraying low-fit applications just trains recruiters to ignore you.');
  console.log('');
  console.log(c.dim('  Detailed docs: docs/SETUP.md · docs/AUTO_APPLY.md · docs/ARCHITECTURE.md'));
  await pause();
}

// ---------------------------------------------------------------------------
// Multi-line input helper (for pasting JD text)

function readMultiline() {
  return new Promise((resolve) => {
    const lines = [];
    let blank = 0;
    const onLine = (line) => {
      if (line.trim() === '') {
        blank++;
        if (blank >= 1 && lines.length > 0) {
          rl.removeListener('line', onLine);
          resolve(lines.join('\n'));
          return;
        }
      } else {
        blank = 0;
        lines.push(line);
      }
    };
    rl.on('line', onLine);
  });
}

// ---------------------------------------------------------------------------

main().catch((err) => {
  console.error(c.red(`\nFatal error: ${err.message}\n`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
