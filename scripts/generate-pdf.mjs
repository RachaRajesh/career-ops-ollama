#!/usr/bin/env node
// scripts/generate-pdf.mjs
// Generate an ATS-optimized CV PDF tailored to a specific report.
// Flow:
//   1. Load the evaluation report (to grab keywords + strengths)
//   2. Ask Ollama to rewrite the CV with those keywords woven in contextually
//      (NOT keyword-stuffed — ATS systems flag that too)
//   3. Render the result through templates/cv-template.html via Playwright
//
// This is intentionally a minimal version of upstream's `generate-pdf.mjs`.
// The full upstream version has more design polish; swap in their template
// if you want the Space Grotesk + DM Sans look.

import fs from 'node:fs';
import path from 'node:path';
import { chat } from './lib/llm.mjs';
import { paths, c, parseArgs, readFileOr, ensureDir, slug, timestamp } from './lib/util.mjs';

const args = parseArgs();

async function main() {
  const reportPath = args.flags.report;
  if (!reportPath) throw new Error('Pass --report path/to/report.md');
  if (!fs.existsSync(reportPath)) throw new Error(`Report not found: ${reportPath}`);

  const report = fs.readFileSync(reportPath, 'utf8');
  const cv = readFileOr(paths.cv);
  if (!cv) throw new Error(`No CV at ${paths.cv}`);

  const company = (report.match(/^# (.+?) —/m)?.[1] || 'company').trim();
  const role = (report.match(/^# .+? — (.+)$/m)?.[1] || 'role').trim();

  console.log(c.cyan(`→ tailoring CV for ${company} / ${role}`));

  const tailoredMd = await chat({
    system: [
      'You are an ATS-optimization expert. You rewrite CVs to surface keywords from a',
      'job description WITHOUT inventing new experience, WITHOUT keyword-stuffing, and',
      'WITHOUT changing any factual content (companies, dates, titles, numbers).',
      '',
      'Rules:',
      '  1. Do not add skills the candidate does not already have.',
      '  2. Preserve every company, title, and date exactly.',
      '  3. You may reorder bullets, rephrase for clarity, and surface relevant keywords.',
      '  4. Output markdown in the same structure as the input CV.',
      '  5. No preamble. Output only the rewritten CV.',
    ].join('\n'),
    user: `EVALUATION REPORT (use this to identify what to emphasize):\n\n${report}\n\n---\n\nCV TO TAILOR:\n\n${cv}`,
    temperature: 0.4,
  });

  ensureDir(paths.output);
  const stem = `${timestamp()}-${slug(company)}-${slug(role)}`;

  const mdPath = path.join(paths.output, `${stem}.md`);
  fs.writeFileSync(mdPath, tailoredMd);
  console.log(c.green(`✓ tailored CV (md): ${mdPath}`));

  // Render to PDF via the HTML template
  const templatePath = path.join('templates', 'cv-template.html');
  if (!fs.existsSync(templatePath)) {
    console.log(c.yellow(`  (no templates/cv-template.html — skipping PDF render; use the .md above)`));
    return;
  }

  const template = fs.readFileSync(templatePath, 'utf8');
  const html = template.replace('{{CV_MARKDOWN}}', escapeHtml(tailoredMd));

  const htmlPath = path.join(paths.output, `${stem}.html`);
  fs.writeFileSync(htmlPath, html);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdfPath = path.join(paths.output, `${stem}.pdf`);
    await page.pdf({ path: pdfPath, format: 'Letter', printBackground: true, margin: { top: '0.5in', bottom: '0.5in', left: '0.5in', right: '0.5in' } });
    console.log(c.green(`✓ PDF: ${pdfPath}`));
  } finally {
    await browser.close();
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
}

main().catch((err) => {
  console.error(c.red(`\nError: ${err.message}\n`));
  process.exit(1);
});
