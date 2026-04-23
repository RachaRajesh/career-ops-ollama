#!/usr/bin/env node
// scripts/process-excel.mjs
// ============================================================================
// PROCESS EXCEL / CSV — batch evaluate + PDF generate from a spreadsheet of URLs
// ============================================================================
//
// Usage:
//   node scripts/process-excel.mjs --file path/to/jobs.xlsx
//   node scripts/process-excel.mjs --file path/to/jobs.csv
//
// Behavior:
//   1. Parse every cell in the spreadsheet, extract URLs (http/https)
//   2. Create output folder: output/{ExcelName}_{DATE}_{TIME}/
//   3. For each URL:
//        - spawn evaluate.mjs with REPORTS_DIR pointing into the run folder
//        - if report succeeds, spawn generate-pdf.mjs with OUTPUT_DIR pointing
//          into the same run folder
//        - log result (score, PDF path, or failure reason) to summary.csv
//   4. On completion: print summary, tell user where to look
//
// Why spawn subprocesses instead of importing? Reuses evaluate.mjs and
// generate-pdf.mjs exactly as they are, so any bugfix to those scripts
// applies here automatically. No code duplication.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ExcelJS from 'exceljs';
import 'dotenv/config';
import { paths, c, parseArgs, ensureDir } from './lib/util.mjs';

const args = parseArgs();

async function main() {
  const filePath = args.flags.file || args.positional[0];
  if (!filePath) {
    console.error(c.red('Pass --file path/to/jobs.xlsx (or .csv)'));
    process.exit(1);
  }
  if (!fs.existsSync(filePath)) {
    console.error(c.red(`File not found: ${filePath}`));
    process.exit(1);
  }

  // 1. Parse URLs from the file
  console.log(c.bold('\nCareer-Ops · Process Excel\n'));
  console.log(c.dim(`  source: ${filePath}`));

  const urls = await extractUrls(filePath);
  if (urls.length === 0) {
    console.log(c.yellow('  No URLs found in the file. Exiting.'));
    process.exit(0);
  }
  console.log(c.dim(`  URLs:   ${urls.length}`));

  // 2. Create output folder named after the Excel file + timestamp
  const stem = path.basename(filePath).replace(/\.[^.]+$/, '');   // "Ai_Engineer_1.xlsx" → "Ai_Engineer_1"
  const now = new Date();
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
  const runFolderName = `${stem}_${stamp}`;
  const runFolder = path.join(paths.output, runFolderName);
  ensureDir(runFolder);

  // Reports go into a sub-folder so the main run folder stays tidy with PDFs at top
  const reportsSub = path.join(runFolder, 'reports');
  ensureDir(reportsSub);

  console.log(c.dim(`  output: ${runFolder}/`));
  console.log('');

  // 3. Per-URL: evaluate, then generate PDF. Write summary.csv row at each step.
  const summaryPath = path.join(runFolder, 'summary.csv');
  fs.writeFileSync(summaryPath, csvLine([
    'row', 'url', 'status', 'company', 'role', 'score', 'report_file', 'pdf_file', 'notes',
  ]) + '\n');

  const stats = { ok: 0, partial: 0, failed: 0 };

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const idx = i + 1;
    console.log(c.bold(c.cyan(`─── [${idx}/${urls.length}] ───`)));
    console.log(c.dim(`  ${truncate(url, 80)}`));

    let row = {
      row: idx,
      url,
      status: '',
      company: '',
      role: '',
      score: '',
      report_file: '',
      pdf_file: '',
      notes: '',
    };

    // 3a. Run evaluate.mjs on this URL, routing reports to our run folder
    console.log(c.cyan('  → evaluating...'));
    const evalResult = await runEvaluate(url, reportsSub);

    if (!evalResult.ok) {
      row.status = 'eval_failed';
      row.notes = evalResult.reason || 'evaluation failed';
      stats.failed++;
      console.log(c.red(`      FAILED: ${row.notes}`));
      appendRow(summaryPath, row);
      continue;
    }

    row.company = evalResult.company || '';
    row.role = evalResult.role || '';
    row.score = evalResult.score || '';
    row.report_file = path.basename(evalResult.reportPath);
    console.log(c.dim(`      ${row.company} — ${row.role}  score ${row.score}/5`));

    // 3b. Generate PDF from the report, routing output to our run folder
    console.log(c.cyan('  → generating PDF...'));
    const pdfResult = await runPdf(evalResult.reportPath, runFolder);

    if (!pdfResult.ok) {
      row.status = 'report_only';
      row.notes = `PDF failed: ${pdfResult.reason || 'unknown'}`;
      stats.partial++;
      console.log(c.yellow(`      report saved, PDF failed: ${pdfResult.reason}`));
      appendRow(summaryPath, row);
      continue;
    }

    row.pdf_file = pdfResult.pdfPath ? path.basename(pdfResult.pdfPath) : '';
    row.status = 'ok';
    stats.ok++;
    console.log(c.green(`      ✓ PDF: ${row.pdf_file}`));
    appendRow(summaryPath, row);
  }

  // 4. Summary
  console.log('');
  console.log(c.bold('─── DONE ───'));
  console.log(`  ${c.green(stats.ok + ' fully processed')}, ${stats.partial ? c.yellow(stats.partial + ' reports without PDF') : c.dim('0 partial')}, ${stats.failed ? c.red(stats.failed + ' failed') : c.dim('0 failed')}`);
  console.log('');
  console.log(c.dim(`  Folder:  ${runFolder}/`));
  console.log(c.dim(`  Summary: ${summaryPath}`));
  if (stats.failed > 0) {
    console.log('');
    console.log(c.yellow('  ⚠ Some URLs failed — usually Workday / SuccessFactors / Oracle Cloud which block scrapers.'));
    console.log(c.dim('    For those, use menu option 1 → "Paste the JD text" and provide the JD manually.'));
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// URL extraction — works on .xlsx (any sheet, any column) and .csv

async function extractUrls(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const urls = new Set();
  const pattern = /https?:\/\/[^\s"',<>()]+/g;

  if (ext === '.csv' || ext === '.txt' || ext === '.tsv') {
    const content = fs.readFileSync(filePath, 'utf8');
    const matches = content.match(pattern) || [];
    matches.forEach((u) => urls.add(cleanUrl(u)));
  } else if (ext === '.xlsx' || ext === '.xlsm') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    wb.eachSheet((sheet) => {
      sheet.eachRow((rowObj) => {
        rowObj.eachCell((cell) => {
          const text = cell.text || String(cell.value || '');
          // Also check the hyperlink property — Excel stores the URL separately
          // when a cell has a clickable link
          if (cell.hyperlink && /^https?:\/\//.test(cell.hyperlink)) {
            urls.add(cleanUrl(cell.hyperlink));
          }
          const matches = text.match(pattern) || [];
          matches.forEach((u) => urls.add(cleanUrl(u)));
        });
      });
    });
  } else {
    throw new Error(`Unsupported file type: ${ext}. Use .xlsx, .xlsm, .csv, .tsv, or .txt.`);
  }

  return [...urls];
}

function cleanUrl(u) {
  // Strip trailing punctuation that sometimes gets captured from copy-paste
  return u.replace(/[)\]}.,;:!?]+$/, '').trim();
}

// ---------------------------------------------------------------------------
// Subprocess runners

/**
 * Run evaluate.mjs on a single URL, routing the report into `reportsDir`.
 * Returns { ok, reportPath, company, role, score, reason }.
 */
function runEvaluate(url, reportsDir) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const env = { ...process.env, REPORTS_DIR: reportsDir };
    const child = spawn(process.execPath, ['scripts/evaluate.mjs', '--url', url], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) {
        return resolve({
          ok: false,
          reason: extractFailureReason(stderr || stdout) || `exit ${code}`,
        });
      }
      // Parse the report path and summary info from stdout
      const reportMatch = stdout.match(/✓ report: (\S+)/);
      const companyMatch = stdout.match(/company:\s+(.+)/);
      const roleMatch = stdout.match(/role:\s+(.+)/);
      const scoreMatch = stdout.match(/Score:\s+([\d.]+)\/5/);
      resolve({
        ok: !!reportMatch,
        reportPath: reportMatch ? reportMatch[1].trim() : '',
        company: companyMatch ? companyMatch[1].trim() : '',
        role: roleMatch ? roleMatch[1].trim() : '',
        score: scoreMatch ? scoreMatch[1] : '',
        reason: !reportMatch ? 'no report path in output' : '',
      });
    });
  });
}

/**
 * Run generate-pdf.mjs on a report, routing the PDF into `outputDir`.
 * Returns { ok, pdfPath, reason }.
 */
function runPdf(reportPath, outputDir) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    const env = { ...process.env, OUTPUT_DIR: outputDir };
    const child = spawn(process.execPath, ['scripts/generate-pdf.mjs', '--report', reportPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code !== 0) {
        return resolve({
          ok: false,
          reason: extractFailureReason(stderr || stdout) || `exit ${code}`,
        });
      }
      const pdfMatch = stdout.match(/✓ PDF:\s+(\S+)/);
      resolve({
        ok: !!pdfMatch,
        pdfPath: pdfMatch ? pdfMatch[1].trim() : '',
        reason: !pdfMatch ? 'PDF path not found in output' : '',
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers

function extractFailureReason(text) {
  if (!text) return '';
  // Pull the last-looking error line
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^Error:/.test(lines[i])) return lines[i].replace(/^Error:\s*/, '').slice(0, 200);
  }
  return lines[lines.length - 1]?.slice(0, 200) || '';
}

function appendRow(summaryPath, row) {
  const line = csvLine([
    row.row, row.url, row.status, row.company, row.role, row.score,
    row.report_file, row.pdf_file, row.notes,
  ]);
  fs.appendFileSync(summaryPath, line + '\n');
}

function csvLine(cells) {
  return cells.map((c) => {
    const s = String(c ?? '');
    if (/["\n,]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }).join(',');
}

function pad(n) { return String(n).padStart(2, '0'); }

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

main().catch((err) => {
  console.error(c.red(`\nError: ${err.message}\n`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
