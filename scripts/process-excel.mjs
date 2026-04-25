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
import { paths, c, parseArgs, ensureDir, readYaml } from './lib/util.mjs';

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
    'row', 'excel_row', 'url', 'status', 'company', 'role', 'score', 'report_file', 'pdf_file', 'notes',
  ]) + '\n');

  const stats = { ok: 0, partial: 0, failed: 0 };
  const rosterRows = []; // rows that got a PDF — written to Excel at the end

  for (let i = 0; i < urls.length; i++) {
    const { url, rowNumber } = urls[i];
    const idx = i + 1;
    console.log(c.bold(c.cyan(`─── [${idx}/${urls.length}]  Excel row ${rowNumber} ───`)));
    console.log(c.dim(`  ${truncate(url, 80)}`));

    let row = {
      row: idx,                // processing order (1..N)
      excel_row: rowNumber,    // actual spreadsheet row number — used for filename prefix
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
    rosterRows.push(row);
    console.log(c.green(`      ✓ PDF: ${row.pdf_file}`));
    appendRow(summaryPath, row);
  }

  // 4. Rename PDFs with Excel row number prefix + generic owner-centric name.
  // Files get renamed from "Sayari_AI-Engineer_DATE.pdf" to
  // "18_Rajesh-Racha_Resume.pdf" (if Sayari was in spreadsheet row 18).
  // Also renames the companion .json and .html files so they stay together.
  //
  // The Excel row number is used — not the processing index — so you can open
  // the spreadsheet, see "row 18 is Sayari", and find the matching file
  // instantly in Finder's sort-by-name view.
  if (rosterRows.length > 0) {
    const profile = readYaml(paths.profile) || {};
    const ownerName = profile.name || profile.candidate?.full_name || 'Resume';
    prefixPdfsByExcelRow(rosterRows, runFolder, ownerName);
    // summary.csv was written with the ORIGINAL (unprefixed) filenames. Rewrite
    // it now that names have changed so the CSV stays accurate.
    rewriteSummaryCsv(summaryPath, rosterRows);
  }

  // 5. Write the "application roster" Excel — successful runs only, sorted by score.
  // This is the file the user actually opens when they sit down to apply.
  // Contains clickable URLs and the matching (rank-prefixed) PDF filename for each.
  let rosterPath = '';
  if (rosterRows.length > 0) {
    rosterPath = path.join(runFolder, 'application_roster.xlsx');
    await writeRosterExcel(rosterPath, rosterRows, runFolder);
  }

  // 6. Summary
  console.log('');
  console.log(c.bold('─── DONE ───'));
  console.log(`  ${c.green(stats.ok + ' fully processed')}, ${stats.partial ? c.yellow(stats.partial + ' reports without PDF') : c.dim('0 partial')}, ${stats.failed ? c.red(stats.failed + ' failed') : c.dim('0 failed')}`);
  console.log('');
  console.log(c.dim(`  Folder:  ${runFolder}/`));
  console.log(c.dim(`  Summary: ${summaryPath}`));
  if (rosterPath) {
    console.log(c.bold(c.green(`  Roster:  ${rosterPath}`)));
    console.log(c.dim(`           (open this Excel to see which PDF to use for each URL)`));
  }
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
  // Map URL → first rowNumber it appeared at. Using Map preserves insertion
  // order AND lets us dedupe while keeping the earliest row reference.
  const urlToRow = new Map();
  const pattern = /https?:\/\/[^\s"',<>()]+/g;

  function addUrl(rawUrl, rowNumber) {
    const u = cleanUrl(rawUrl);
    if (!u) return;
    if (!urlToRow.has(u)) urlToRow.set(u, rowNumber);
  }

  if (ext === '.csv' || ext === '.txt' || ext === '.tsv') {
    // Skip the first line — commonly a title or column header
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    // Line index 0 = header (skipped). Real row 2 in a spreadsheet = line index 1.
    for (let i = 1; i < lines.length; i++) {
      const matches = lines[i].match(pattern) || [];
      // Row number matches 1-indexed spreadsheet row (i + 1, since i starts at 1 = row 2)
      matches.forEach((u) => addUrl(u, i + 1));
    }
  } else if (ext === '.xlsx' || ext === '.xlsm') {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    wb.eachSheet((sheet) => {
      sheet.eachRow((rowObj, rowNumber) => {
        // Row 1 is almost always a title or column header — skip it.
        if (rowNumber === 1) return;
        rowObj.eachCell((cell) => {
          const text = cell.text || String(cell.value || '');
          // Excel stores hyperlink URLs separately when cells are clickable links
          if (cell.hyperlink && /^https?:\/\//.test(cell.hyperlink)) {
            addUrl(cell.hyperlink, rowNumber);
          }
          const matches = text.match(pattern) || [];
          matches.forEach((u) => addUrl(u, rowNumber));
        });
      });
    });
  } else {
    throw new Error(`Unsupported file type: ${ext}. Use .xlsx, .xlsm, .csv, .tsv, or .txt.`);
  }

  // Return [{ url, rowNumber }] in insertion order
  return [...urlToRow.entries()].map(([url, rowNumber]) => ({ url, rowNumber }));
}

function cleanUrl(u) {
  // Strip trailing punctuation that sometimes gets captured from copy-paste
  return u.replace(/[)\]}.,;:!?]+$/, '').trim();
}

/**
 * Write the "application roster" Excel file — the user's working list when
 * they sit down to apply to the batch.
 *
 * Contents:
 *   - One row per successfully-processed job
 *   - Sorted by score descending (apply to strongest matches first)
 *   - Clickable URL column (Excel/Numbers treats as hyperlink)
 *   - PDF filename column (the resume to upload for that job)
 *
 * Styling:
 *   - Bold header row with background
 *   - Score column: green for >=4.5, yellow for 4.0-4.4, orange for <4.0
 *   - Column widths sized to content so everything's readable
 */
/**
 * Rename each PDF + companion files using the Excel row number and a generic
 * owner-centric filename (no company name, since uploading a file called
 * "Capgemini_Resume.pdf" to Capgemini's ATS signals you have multiple versions).
 *
 * New format: {ROW}_{Name}_Resume.{pdf,json,html}
 * Example:    02_Rajesh-Racha_Resume.pdf
 *
 * The Excel row number is used verbatim (row 2 in spreadsheet → "02_") so you
 * can open the Excel, see "row 5 is the Hippocratic AI job", and find the
 * matching file instantly.
 */
function prefixPdfsByExcelRow(rosterRows, runFolder, ownerName) {
  // Derive the filename-safe owner slug once — used in every new filename.
  // "Rajesh Racha" → "Rajesh-Racha"
  const nameSlug = String(ownerName || 'Resume')
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'Resume';

  // Pad width is based on max row number seen, so 2-digit and 3-digit
  // spreadsheets both look clean.
  const maxRow = Math.max(...rosterRows.map((r) => r.excel_row || 0), 1);
  const padWidth = Math.max(2, String(maxRow).length);

  for (const row of rosterRows) {
    if (!row.pdf_file || !row.excel_row) continue;

    const rowNum = String(row.excel_row).padStart(padWidth, '0');
    const oldStem = row.pdf_file.replace(/\.pdf$/i, '');
    // New stem: "02_Rajesh-Racha_Resume"
    const newStem = `${rowNum}_${nameSlug}_Resume`;

    // Skip if already in the target format (safe re-runs)
    if (oldStem === newStem) continue;

    // Rename all three companion files if they exist
    for (const ext of ['.pdf', '.json', '.html']) {
      const oldPath = path.join(runFolder, oldStem + ext);
      const newPath = path.join(runFolder, newStem + ext);
      try {
        if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
      } catch { /* non-fatal — leaves the file under its old name */ }
    }

    row.pdf_file = newStem + '.pdf';
  }
}

/**
 * Rewrite summary.csv to reflect the renamed PDFs. summary.csv was written
 * row-by-row DURING the loop (before renames), so its pdf_file column points
 * at stale names until we refresh it here.
 */
function rewriteSummaryCsv(summaryPath, rosterRows) {
  // Rebuild the file: header + all rosterRows (which now have updated pdf_file)
  // Rows that aren't in rosterRows (failures/partials) stay as-is.
  const header = csvLine([
    'row', 'excel_row', 'url', 'status', 'company', 'role', 'score', 'report_file', 'pdf_file', 'notes',
  ]);
  const lines = [header];

  // Read existing file, keep only the failure/partial rows (those not in rosterRows)
  try {
    const existing = fs.readFileSync(summaryPath, 'utf8').split('\n').slice(1);
    const rosterUrls = new Set(rosterRows.map((r) => r.url));
    for (const line of existing) {
      if (!line.trim()) continue;
      // Cheap check: URL is at column index 2 (after row, excel_row).
      // If it's not in the roster, this line was a failure — keep as-is.
      const cols = parseCsvRow(line);
      if (cols.length >= 3 && !rosterUrls.has(cols[2])) {
        lines.push(line);
      }
    }
  } catch { /* summary didn't exist or was unreadable; start fresh */ }

  // Append the (now updated, sorted-by-score) roster rows
  for (const row of rosterRows) {
    lines.push(csvLine([
      row.row, row.excel_row, row.url, row.status, row.company, row.role, row.score,
      row.report_file, row.pdf_file, row.notes,
    ]));
  }

  fs.writeFileSync(summaryPath, lines.join('\n') + '\n');
}

/**
 * Minimal CSV row parser — handles quoted fields with commas/newlines inside.
 * Good enough for the rows this script writes.
 */
function parseCsvRow(line) {
  const cols = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { cur += ch; }
    } else {
      if (ch === ',') { cols.push(cur); cur = ''; }
      else if (ch === '"') { inQuotes = true; }
      else { cur += ch; }
    }
  }
  cols.push(cur);
  return cols;
}

async function writeRosterExcel(filepath, rows, runFolder) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'career-ops-ollama';
  wb.created = new Date();
  const sheet = wb.addWorksheet('Apply to these', {
    views: [{ state: 'frozen', ySplit: 1 }],   // freeze header row so it stays visible when scrolling
  });

  sheet.columns = [
    { header: '#',           key: 'rank',     width: 4 },
    { header: 'Score',       key: 'score',    width: 7 },
    { header: 'Company',     key: 'company',  width: 30 },
    { header: 'Role',        key: 'role',     width: 45 },
    { header: 'Resume PDF to use',  key: 'pdf_file', width: 55 },
    { header: 'Application URL',    key: 'url',      width: 70 },
    { header: 'Status',      key: 'applied',  width: 12 },
    { header: 'Notes',       key: 'notes',    width: 30 },
  ];

  // Header styling
  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a1a' } };
  headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
  headerRow.height = 22;

  // Sort rows by score descending (strongest matches first) —
  // candidates with the same score keep their original order
  const sorted = [...rows].sort((a, b) => {
    const sa = parseFloat(a.score) || 0;
    const sb = parseFloat(b.score) || 0;
    return sb - sa;
  });

  sorted.forEach((r, i) => {
    const scoreNum = parseFloat(r.score) || 0;
    const row = sheet.addRow({
      rank: i + 1,
      score: scoreNum ? `${scoreNum}/5` : 'n/a',
      company: r.company || '—',
      role: r.role || '—',
      pdf_file: r.pdf_file || '—',
      url: r.url,
      applied: '',           // blank by default — user fills "applied" / "skipped" as they work
      notes: '',             // user can add their own notes
    });

    // Clickable hyperlink on the URL cell — Excel and Numbers both respect this
    const urlCell = row.getCell('url');
    urlCell.value = { text: r.url, hyperlink: r.url };
    urlCell.font = { color: { argb: 'FF0066CC' }, underline: true };

    // Color-code the score cell
    const scoreCell = row.getCell('score');
    if (scoreNum >= 4.5) {
      scoreCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4EDDA' } }; // green-ish
      scoreCell.font = { bold: true, color: { argb: 'FF155724' } };
    } else if (scoreNum >= 4.0) {
      scoreCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } }; // yellow-ish
      scoreCell.font = { bold: true, color: { argb: 'FF856404' } };
    } else {
      scoreCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE0B3' } }; // orange-ish
      scoreCell.font = { color: { argb: 'FF7A4A00' } };
    }

    // Row height a bit taller for readability
    row.height = 18;
    row.alignment = { vertical: 'middle', wrapText: false };
  });

  // Add a summary info row at the top BEFORE the header? No — keep it clean.
  // Instead: add an empty row at the bottom with a note about where PDFs are.
  sheet.addRow({});
  const infoRow = sheet.addRow({
    company: `All PDFs are in this same folder: ${path.basename(runFolder)}/`,
  });
  infoRow.getCell('company').font = { italic: true, color: { argb: 'FF666666' } };
  sheet.mergeCells(`C${infoRow.number}:H${infoRow.number}`);

  await wb.xlsx.writeFile(filepath);
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
      // Strip ANSI color codes so regex matching is robust
      const cleanStdout = stripAnsi(stdout);
      if (code !== 0) {
        return resolve({
          ok: false,
          reason: extractFailureReason(stripAnsi(stderr) || cleanStdout) || `exit ${code}`,
        });
      }
      // Parse the report path from stdout.
      // NOTE: use [^\n]+ not \S+ because file paths CAN contain spaces
      // (e.g. output folder "Ai Engineer 1_2026-04-23_22-10" has a space).
      const reportMatch = cleanStdout.match(/✓ report:\s+([^\n]+?)\s*$/m);
      const reportPath  = reportMatch ? reportMatch[1].trim() : '';

      // Read company/role/score FROM THE REPORT FILE itself — much more
      // reliable than parsing them from stdout, and it handles the case
      // where evaluate.mjs fell back to "unknown" metadata.
      let company = '', role = '', score = '';
      if (reportPath && fs.existsSync(reportPath)) {
        try {
          const head = fs.readFileSync(reportPath, 'utf8').slice(0, 2000);
          // Report format: first line "# Company — Role"
          const h = head.match(/^# (.+?) — (.+)$/m);
          if (h) { company = h[1].trim(); role = h[2].trim(); }
          // Score: "**Score:** 4.2 / 5"
          const s = head.match(/\*\*Score:\*\*\s*([\d.]+)/);
          if (s) score = s[1];
        } catch { /* fall through to stdout parse */ }
      }

      // Fallback to stdout patterns if the report read didn't yield values
      if (!company) {
        const m = cleanStdout.match(/company:\s+(.+)/);
        if (m) company = m[1].trim();
      }
      if (!role) {
        const m = cleanStdout.match(/role:\s+(.+)/);
        if (m) role = m[1].trim();
      }
      if (!score) {
        const m = cleanStdout.match(/Score:\s+([\d.]+)\/5/);
        if (m) score = m[1];
      }

      resolve({
        ok: !!reportPath,
        reportPath,
        company,
        role,
        score,
        reason: !reportPath ? 'no report path in output' : '',
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
      const cleanStdout = stripAnsi(stdout);
      if (code !== 0) {
        return resolve({
          ok: false,
          reason: extractFailureReason(stripAnsi(stderr) || cleanStdout) || `exit ${code}`,
        });
      }
      // Use [^\n]+ to capture paths that contain spaces
      const pdfMatch = cleanStdout.match(/✓ PDF:\s+([^\n]+?)\s*$/m);
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

/**
 * Strip ANSI color escape sequences. evaluate.mjs and generate-pdf.mjs emit
 * colored output (✓ report: in green, etc.) — those escape codes pollute
 * our regex capture groups if we don't remove them first.
 */
function stripAnsi(text) {
  // \x1b is ESC; the common patterns are \x1b[NNm for colors and \x1b[0m to reset
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
}

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
    row.row, row.excel_row, row.url, row.status, row.company, row.role, row.score,
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
