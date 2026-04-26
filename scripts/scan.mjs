#!/usr/bin/env node
// scripts/scan.mjs
// ============================================================================
// PORTAL SCANNER — crawls configured company careers pages for new listings.
//
// Reads portals.yml (copy from templates/portals.example.yml). For each
// enabled company, opens the careers URL in a headless browser and extracts
// links that look like job postings.
//
// Outputs:
//   1. Excel file at output/scan_{DATE_TIME}/scan_results.xlsx
//      Ready to feed into option `e` (Process Excel/CSV) for evaluation.
//      Has clickable hyperlinks, frozen header row, sortable columns.
//   2. .txt stubs in ./jds/ — for compatibility with the older
//      batch-evaluate-folder workflow (menu option 3). One file per listing.
//   3. Console log of which portals succeeded and how many listings each
//      contributed.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { paths, c, readYaml, ensureDir, slug, parseArgs } from './lib/util.mjs';

const args = parseArgs();
const portalsPath = args.flags.portals || 'portals.yml';

if (!fs.existsSync(portalsPath)) {
  console.error(c.red(`No ${portalsPath}. Copy templates/portals.example.yml to ${portalsPath} first.`));
  process.exit(1);
}

const portals = readYaml(portalsPath);
const companies = portals.companies || [];

if (companies.length === 0) {
  console.error(c.yellow(`No companies in ${portalsPath}.`));
  process.exit(0);
}

// Output destinations
const outDir = args.flags.out || './jds';     // .txt stubs (legacy compat)
ensureDir(outDir);

const now = new Date();
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
const scanFolder = path.join(paths.output, `scan_${stamp}`);
ensureDir(scanFolder);
const excelPath = path.join(scanFolder, 'scan_results.xlsx');

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });

console.log(c.bold(`\nScanning ${companies.length} portals\n`));
console.log(c.dim(`  Excel output:  ${excelPath}`));
console.log(c.dim(`  TXT stubs:     ${outDir}/`));
console.log('');

// Accumulate everything found across portals — written to Excel at the end
const allListings = [];   // [{ company, title, url, scanned_at }]
const portalStats = [];   // [{ company, status, found, skipped, error }]
let totalFound = 0;

try {
  const page = await browser.newPage();

  for (const company of companies) {
    const name = typeof company === 'string' ? company : company.name;
    const url = typeof company === 'string' ? null : company.url;

    if (!url) {
      console.log(c.dim(`  skip ${name} (no url)`));
      portalStats.push({ company: name, status: 'no-url', found: 0, skipped: 0, error: '' });
      continue;
    }

    // Skip aggregators marked disabled (Indeed, LinkedIn, etc.)
    if (typeof company === 'object' && company.disabled) {
      console.log(c.dim(`  skip ${name} (disabled — set up email alerts instead)`));
      portalStats.push({ company: name, status: 'disabled', found: 0, skipped: 0, error: '' });
      continue;
    }

    console.log(c.cyan(`  ${name}: ${truncate(url, 70)}`));

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);

      // Generic link-extraction — works on Greenhouse/Lever/Ashby and most
      // company careers pages. The pattern is: <a> tags whose text looks like
      // a job title and whose href looks like a job URL.
      const jobs = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        return links
          .map((a) => ({ href: a.href, text: (a.innerText || '').trim() }))
          .filter((l) => l.text.length > 8 && l.text.length < 120)
          .filter((l) => /engineer|developer|scientist|lead|manager|architect|analyst|designer|director/i.test(l.text))
          .filter((l) => /\/jobs?\/|\/careers?\/|\/positions?\//i.test(l.href))
          .slice(0, 50);
      });

      let newCount = 0;
      let skippedCount = 0;
      const scannedAt = new Date().toISOString();

      for (const job of jobs) {
        // Write the legacy .txt stub for option-3 batch-folder compat
        const filename = `${slug(name)}-${slug(job.text)}.txt`;
        const outPath = path.join(outDir, filename);
        if (fs.existsSync(outPath)) {
          skippedCount++;
          continue;
        }
        fs.writeFileSync(
          outPath,
          `Company: ${name}\nTitle: ${job.text}\nURL: ${job.href}\n\n(Fetch this URL and paste the JD body here, or run: npm run evaluate -- --url "${job.href}")\n`
        );

        // Accumulate for the Excel output
        allListings.push({
          company: name,
          title: job.text,
          url: job.href,
          scanned_at: scannedAt,
        });
        newCount++;
        totalFound++;
      }

      console.log(c.dim(`     found ${jobs.length} listings (${newCount} new, ${skippedCount} already saved)`));
      portalStats.push({
        company: name, status: 'ok', found: jobs.length, skipped: skippedCount, error: '',
      });
    } catch (err) {
      console.log(c.red(`     error: ${err.message.split('\n')[0]}`));
      portalStats.push({
        company: name, status: 'error', found: 0, skipped: 0,
        error: err.message.split('\n')[0].slice(0, 200),
      });
    }
  }
} finally {
  await browser.close();
}

// Write the Excel file
if (allListings.length > 0) {
  await writeScanExcel(excelPath, allListings, portalStats);
}

console.log('');
console.log(c.bold('─── DONE ───'));
console.log(`  ${c.green(totalFound + ' new listings saved')}`);
if (allListings.length > 0) {
  console.log(c.bold(c.green(`  Excel:  ${excelPath}`)));
  console.log(c.dim(`          (open in Excel/Numbers — or feed to option e to evaluate all of them)`));
}
console.log(c.dim(`  Stubs:  ${outDir}/  (for option 3 — batch-evaluate folder)`));
console.log('');
console.log(c.dim('  Next:'));
console.log(c.dim('    • Filter the Excel to the listings you actually want to apply to'));
console.log(c.dim('    • Save it as a new file (or just drop the URL column to a .txt)'));
console.log(c.dim('    • Run npm start → e → paste that file path'));
console.log('');

// ============================================================================
// Excel writer
// ============================================================================

/**
 * Write the scan results to an Excel file with two sheets:
 *
 *   "Listings"  — every job link found, one row each. This is the sheet you
 *                 work with: filter, copy URLs to a separate file, hand to
 *                 option `e` for evaluation.
 *
 *   "Portal Log" — diagnostic info: which portals worked, which errored,
 *                  how many listings each contributed. Useful when a portal
 *                  changes its layout and stops returning results.
 */
async function writeScanExcel(filepath, listings, stats) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'career-ops-ollama';
  wb.created = new Date();

  // ─── Listings sheet ──────────────────────────────────────────────────
  const sheet = wb.addWorksheet('Listings', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  sheet.columns = [
    { header: '#',          key: 'rank',    width: 4 },
    { header: 'Company',    key: 'company', width: 22 },
    { header: 'Title',      key: 'title',   width: 60 },
    { header: 'URL',        key: 'url',     width: 70 },
    { header: 'Apply?',     key: 'apply',   width: 10 },   // user fills this
    { header: 'Notes',      key: 'notes',   width: 30 },   // user fills this
    { header: 'Scanned at', key: 'scanned_at', width: 22 },
  ];

  // Style header
  const hdr = sheet.getRow(1);
  hdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a1a' } };
  hdr.alignment = { vertical: 'middle' };
  hdr.height = 22;

  // Data rows — sort by company alphabetically so similar listings cluster
  const sorted = [...listings].sort((a, b) => {
    const c = a.company.localeCompare(b.company);
    if (c !== 0) return c;
    return a.title.localeCompare(b.title);
  });

  sorted.forEach((j, i) => {
    const row = sheet.addRow({
      rank: i + 1,
      company: j.company,
      title: j.title,
      url: j.url,
      apply: '',
      notes: '',
      scanned_at: j.scanned_at,
    });
    // Make URL a clickable hyperlink
    const urlCell = row.getCell('url');
    urlCell.value = { text: j.url, hyperlink: j.url };
    urlCell.font = { color: { argb: 'FF0066CC' }, underline: true };
    row.alignment = { vertical: 'middle' };
  });

  // Add Excel auto-filter so the user can filter by Company/Apply easily
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to:   { row: 1, column: sheet.columns.length },
  };

  // ─── Portal Log sheet ────────────────────────────────────────────────
  const log = wb.addWorksheet('Portal Log', {
    views: [{ state: 'frozen', ySplit: 1 }],
  });
  log.columns = [
    { header: 'Portal',  key: 'company', width: 25 },
    { header: 'Status',  key: 'status',  width: 12 },
    { header: 'Found',   key: 'found',   width: 8 },
    { header: 'Skipped (dup)', key: 'skipped', width: 14 },
    { header: 'Error',   key: 'error',   width: 50 },
  ];
  const lhdr = log.getRow(1);
  lhdr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  lhdr.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1a1a1a' } };

  for (const s of stats) {
    const row = log.addRow(s);
    // Color-code status
    const statusCell = row.getCell('status');
    if (s.status === 'ok') {
      statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD4EDDA' } };
    } else if (s.status === 'error') {
      statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8D7DA' } };
    } else if (s.status === 'disabled') {
      statusCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE2E3E5' } };
    }
  }

  await wb.xlsx.writeFile(filepath);
}

// ============================================================================
// helpers
// ============================================================================

function pad(n) { return String(n).padStart(2, '0'); }

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
