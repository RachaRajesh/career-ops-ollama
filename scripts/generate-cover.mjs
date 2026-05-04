#!/usr/bin/env node
// scripts/generate-cover.mjs
// ============================================================================
// COVER LETTER GENERATOR — auto-research mode.
//
// For a given evaluation report, this script:
//   1. Reads the report (which has the JD + company name + URL)
//   2. Tries to scrape additional company info from public pages:
//        - The company's main domain homepage (if URL hints at it)
//        - The careers /about page if linked
//        - Any /blog or /engineering page that's findable from those
//   3. Hands what it found (or didn't find) to the local LLM
//   4. The LLM generates a cover letter that:
//        - References ONLY facts that were actually found in scraped pages
//        - If little/no info found: produces a short, honest generic letter
//          that doesn't make up details about the company
//   5. Saves as .pdf, .json, .html in the same folder pattern as resumes
//
// Output filename: same scheme as resume — {ROW}_{Name}_CoverLetter.pdf
//
// Usage:
//   node scripts/generate-cover.mjs --report path/to/report.md
//   node scripts/generate-cover.mjs --report path/to/report.md --out-name 02_Rajesh-Racha_CoverLetter
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { chatJSON } from './lib/llm.mjs';
import {
  paths, c, parseArgs, readFileOr, readYaml, ensureDir, jobFilename, fetchUrlText,
} from './lib/util.mjs';

const args = parseArgs();

async function main() {
  const reportPath = args.flags.report;
  if (!reportPath || !fs.existsSync(reportPath)) {
    console.error(c.red('Pass --report path/to/report.md'));
    process.exit(1);
  }

  const report = fs.readFileSync(reportPath, 'utf8');
  const cv = readFileOr(paths.cv);
  if (!cv) throw new Error(`No CV at ${paths.cv}`);
  const profile = readYaml(paths.profile);

  // Pull company + role + URL out of the report
  const company = (report.match(/^# (.+?) —/m)?.[1] || 'company').trim();
  const role = (report.match(/^# .+? — (.+)$/m)?.[1] || 'role').trim();
  const jdUrl = report.match(/(?:Source|URL|Job URL):\s*(https?:\/\/\S+)/i)?.[1] || '';

  console.log(c.cyan(`→ writing cover letter for ${company} / ${role}`));

  // STEP 1: Try to scrape company info from public pages
  const companyInfo = await researchCompany({ company, jdUrl });
  if (companyInfo.specificDetails.length > 0) {
    console.log(c.dim(`  found ${companyInfo.specificDetails.length} specific detail(s) about the company`));
  } else {
    console.log(c.yellow(`  ⚠ no specific company details found — letter will be generic`));
    console.log(c.dim(`     (better cover letters need specific team knowledge — consider adding 1-2 sentences manually)`));
  }

  // STEP 2: Generate the cover letter
  const letter = await generateLetter({ cv, profile, report, company, role, companyInfo });

  // STEP 3: Save
  ensureDir(paths.output);
  const stem = args.flags['out-name'] || `${jobFilename(company, role)}_CoverLetter`;
  const jsonPath = path.join(paths.output, `${stem}.json`);
  const htmlPath = path.join(paths.output, `${stem}.html`);
  const pdfPath  = path.join(paths.output, `${stem}.pdf`);

  fs.writeFileSync(jsonPath, JSON.stringify(letter, null, 2));

  // Render HTML and PDF
  const html = renderCoverHtml(letter);
  fs.writeFileSync(htmlPath, html);

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.pdf({
      path: pdfPath,
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', bottom: '0.5in', left: '0', right: '0' },
    });
  } finally {
    await browser.close();
  }

  console.log(c.green(`✓ Cover letter: ${pdfPath}`));
  if (companyInfo.specificDetails.length === 0) {
    console.log(c.yellow(`  ⚠ Generic letter — open and add 1-2 specific lines about the team before sending.`));
  }
}

// ============================================================================
// Company research — best-effort scrape of public pages
// ============================================================================

/**
 * Try to find specific company info by scraping a few likely public URLs.
 * Returns { specificDetails: [...], homepageText: '...', companyDomain: '...' }
 *
 * Strategy:
 *   1. Derive the likely main domain from the JD URL (e.g. careers.acme.com → acme.com)
 *   2. Fetch the homepage — most companies put their tagline + recent product
 *      announcement above the fold
 *   3. Try the /about, /blog, /engineering paths (they exist for ~30% of companies)
 *   4. Pull out specific details from whatever was successfully fetched
 *
 * If everything fails (which is common — Workday, Oracle, ATS-only links won't
 * reveal a real domain), returns empty specificDetails. The letter generator
 * will then produce an honest generic letter instead of fabricating company facts.
 */
async function researchCompany({ company, jdUrl }) {
  const result = { specificDetails: [], homepageText: '', companyDomain: '' };

  // Try to derive the main company domain from the JD URL
  // e.g. "https://careers.anthropic.com/jobs/123" → "anthropic.com"
  // e.g. "https://boards.greenhouse.io/anthropic/jobs/123" → can't derive (it's an ATS)
  const domain = deriveCompanyDomain(jdUrl, company);
  if (!domain) {
    return result;   // can't even guess a domain; return empty
  }
  result.companyDomain = domain;

  // Try a few likely URLs in priority order. We stop after we get useful content.
  const candidatePaths = ['', '/about', '/about-us', '/company', '/blog', '/engineering', '/news'];

  for (const subPath of candidatePaths) {
    const url = `https://${domain}${subPath}`;
    try {
      const text = await fetchUrlText(url);
      if (!text || text.length < 200) continue;

      // Save the homepage text for the LLM context (capped at 8000 chars to
      // keep the prompt manageable)
      if (subPath === '') {
        result.homepageText = text.slice(0, 8000);
      }

      // Pull out concrete details: blog post titles, product names, named projects.
      // We don't try to be smart — just grab anything that looks like a sentence
      // mentioning a product, paper, or release. The LLM will filter.
      const details = extractDetails(text, company);
      result.specificDetails.push(...details);

      if (result.specificDetails.length >= 5) break;   // enough material
    } catch {
      // 404s, timeouts, blocked — fine, just try next path
    }
  }

  // De-dupe and keep at most 8 details (LLM context budget)
  result.specificDetails = [...new Set(result.specificDetails)].slice(0, 8);
  return result;
}

/**
 * Derive a likely company domain from the JD URL or company name. Returns null
 * if nothing reasonable can be extracted (which is the common case for ATS URLs
 * like greenhouse.io/foo or workdayjobs.com).
 */
function deriveCompanyDomain(jdUrl, company) {
  // Common ATS hosts that DON'T reveal the company's actual domain
  const atsHosts = /(greenhouse|lever|ashbyhq|workday|workdayjobs|oraclecloud|successfactors|taleo|brassring|icims|saashr|gem\.com|careerpuck|adp\.com|avature|bamboohr|paylocity)/i;

  if (jdUrl) {
    try {
      const u = new URL(jdUrl);
      const host = u.hostname.toLowerCase();

      // If it's an ATS host, we can't get the company's real domain from here
      if (atsHosts.test(host)) {
        // Try to derive from company name as a fallback
        return guessFromCompanyName(company);
      }

      // Strip common subdomains (careers., jobs., apply.)
      const stripped = host.replace(/^(careers|jobs|apply|recruit|hr|talent|werk)\./i, '');
      // If it's still got more than 2 dots, take the last 2 parts (anthropic.com from foo.anthropic.com)
      const parts = stripped.split('.');
      if (parts.length >= 2) {
        return parts.slice(-2).join('.');
      }
      return stripped;
    } catch {
      // Bad URL, fall through
    }
  }

  return guessFromCompanyName(company);
}

/**
 * Fallback: guess a domain from the company name. Crude but sometimes works.
 * "Anthropic" → "anthropic.com". "JPMorgan Chase" → null (too compound).
 */
function guessFromCompanyName(company) {
  if (!company || company === 'unknown' || company === 'company') return null;
  const cleaned = company.toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(inc|llc|corp|ltd|gmbh|co|company|the)\b/g, '')
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  // Single-word companies are the most likely to map to {word}.com
  if (words.length === 1 && words[0].length >= 3) {
    return `${words[0]}.com`;
  }
  return null;
}

/**
 * Pull "specific details" out of scraped page text. Heuristic — looks for:
 *   - Sentences that mention the company name
 *   - Sentences with concrete nouns (model names, products, dates)
 *   - Headlines/titles (lines under 80 chars that don't end in punctuation
 *     other than "?" — these are often h1/h2 elements that survived markdown)
 *
 * Returns up to 8 candidate sentences. The LLM does the actual filtering.
 */
function extractDetails(text, company) {
  const details = new Set();
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);

  // Pass 1: short headline-like lines (likely h1/h2 elements)
  for (const line of lines) {
    if (line.length < 15 || line.length > 100) continue;
    if (line.match(/^[#*-]/)) continue;        // markdown leftovers
    if (line.match(/cookie|privacy|terms/i)) continue;   // boilerplate
    if (line.match(/^(home|about|careers|jobs|contact|blog)$/i)) continue;
    if (/[.?]$/.test(line) || line.includes(': ')) continue; // sentences, not titles
    if (line.split(' ').length >= 3 && line.split(' ').length <= 12) {
      details.add(line);
    }
  }

  // Pass 2: sentences mentioning the company name + a verb
  const companyRe = new RegExp(`\\b${escapeRegex(company.split(/\s+/)[0] || company)}\\b`, 'i');
  const sentences = text.split(/(?<=[.!?])\s+/);
  for (const s of sentences) {
    if (s.length < 30 || s.length > 200) continue;
    if (companyRe.test(s) && /\b(announced|launched|released|built|developed|introduced|partnered|raised|opened)\b/i.test(s)) {
      details.add(s.trim());
    }
    if (details.size >= 16) break;
  }

  return [...details].slice(0, 8);
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Cover letter generation
// ============================================================================

async function generateLetter({ cv, profile, report, company, role, companyInfo }) {
  const hasSpecifics = companyInfo.specificDetails.length > 0;

  const system = [
    'You are writing a cover letter for a job application. The output is JSON.',
    '',
    'STYLE — this is a HARD requirement, not a suggestion:',
    '  • Read like an engineer, not a recruiting tool.',
    '  • 3 short paragraphs maximum. Total length: 180-250 words.',
    '  • First paragraph: WHY this role specifically (not generic enthusiasm).',
    '  • Second paragraph: ONE specific thing from the candidate\'s experience',
    '    that maps to ONE specific thing the team does. No tech stack dumps.',
    '  • Third paragraph: short closer. One sentence. No "I look forward to'
      + ' hearing from you" — too generic. Just "Happy to talk."',
    '',
    'BANNED PHRASES (do not use any):',
    '  "I am excited about", "I am passionate about", "I am thrilled",',
    '  "results-driven", "demonstrated expertise", "proven track record",',
    '  "perfect fit", "ideal candidate", "leveraging", "spearheaded",',
    '  "synergize", "cross-functional", "aligned with my career goals",',
    '  "looking forward to hearing from you", "thank you for considering"',
    '',
    'INTEGRITY:',
    '  • NEVER invent facts about the company. If specificDetails is empty,',
    '    DO NOT make up details — write a shorter generic letter that ONLY',
    '    references what\'s in the JD itself.',
    '  • If specificDetails has real content, use AT MOST ONE — picking the',
    '    one that genuinely connects to the candidate\'s work. Quote it directly',
    '    or reference it by name. Do not paraphrase several into one sentence.',
    '  • Tech / projects mentioned must be from the candidate\'s CV, not invented.',
    '',
    hasSpecifics
      ? 'You HAVE specific details about the company below. Use ONE of them.'
      : 'You DO NOT have specific details about the company. Write an honest'
        + ' generic letter — no fake "I love your mission" lines.',
    '',
    'Output ONLY valid JSON, no markdown:',
    '  {',
    '    "greeting":     "Hi <Team> team," | "Dear hiring team,"',
    '    "opening":      "First paragraph (40-60 words)",',
    '    "body":         "Second paragraph (80-120 words)",',
    '    "closing":      "Third paragraph (20-40 words)",',
    '    "sign_off":     "Best, " or "Thanks, ",',
    '    "name":         "<candidate name from profile>",',
    '    "used_specific_detail": true | false',
    '  }',
  ].join('\n');

  const user = [
    `═══ CANDIDATE PROFILE ═══`,
    JSON.stringify(profile, null, 2),
    '',
    `═══ CANDIDATE CV (only source for experience claims) ═══`,
    cv,
    '',
    `═══ TARGET ROLE ═══`,
    `Company: ${company}`,
    `Role:    ${role}`,
    '',
    `═══ JD EVALUATION REPORT (use to identify what to emphasize) ═══`,
    report.slice(0, 6000),  // cap to keep prompt size reasonable
    '',
    `═══ COMPANY-SPECIFIC DETAILS FOUND ═══`,
    hasSpecifics
      ? `(use AT MOST ONE of these, the most concrete one):\n${companyInfo.specificDetails.map((d, i) => `${i + 1}. ${d}`).join('\n')}`
      : `(none found — write a short, honest generic letter, do NOT invent company facts)`,
  ].join('\n');

  const out = await chatJSON({ system, user, temperature: 0.4 });

  // Defensive defaults — local LLMs sometimes return partial output
  return {
    greeting: out.greeting || `Dear ${company} team,`,
    opening: out.opening || '',
    body: out.body || '',
    closing: out.closing || 'Happy to talk.',
    sign_off: out.sign_off || 'Best,',
    name: out.name || profile.name || profile.candidate?.full_name || '',
    used_specific_detail: !!out.used_specific_detail,
    company,
    role,
  };
}

// ============================================================================
// HTML rendering — same visual language as the resume
// ============================================================================

function renderCoverHtml(letter) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const today = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${esc(letter.name)} — Cover Letter</title>
<style>
  @page { size: Letter; margin: 0; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    font-family: "Lato", "Helvetica Neue", Helvetica, Arial, sans-serif;
    color: #2b2b2b;
    font-size: 10.5pt;
    line-height: 1.55;
    background: #fff;
  }
  /* Match resume header layout — same fonts, same teal accent, same proportions */
  .header {
    padding: 0.5in 0.55in 0.18in 0.55in;
  }
  .header h1 {
    margin: 0;
    font-size: 22pt;
    font-weight: 700;
    color: #1a1a1a;
    letter-spacing: -0.3px;
  }
  .header .subtitle {
    font-size: 11pt;
    color: #6b7c8c;
    margin: 4px 0 14px 0;
  }
  .header .contact {
    font-size: 9pt;
    color: #4a4a4a;
    line-height: 1.55;
  }
  .header .contact .sep {
    color: #c0c0c0;
    margin: 0 7px;
  }
  .body {
    padding: 0.2in 0.55in 0.5in 0.55in;
  }
  .date {
    font-size: 9.5pt;
    color: #8a98a8;
    margin: 0 0 0.3in 0;
  }
  .greeting {
    font-size: 11pt;
    font-weight: 500;
    color: #1a1a1a;
    margin: 0 0 0.2in 0;
  }
  p.para {
    margin: 0 0 0.18in 0;
    font-size: 10.5pt;
    line-height: 1.6;
    color: #2e2e2e;
  }
  .signoff {
    margin: 0.3in 0 0 0;
    font-size: 10.5pt;
    color: #2e2e2e;
  }
  .name {
    margin-top: 4px;
    font-weight: 600;
    color: #1a1a1a;
  }
</style>
</head><body>
<div class="header">
  <h1>${esc(letter.name)}</h1>
</div>
<div class="body">
  <p class="date">${esc(today)}</p>
  <p class="greeting">${esc(letter.greeting)}</p>
  <p class="para">${esc(letter.opening)}</p>
  <p class="para">${esc(letter.body)}</p>
  <p class="para">${esc(letter.closing)}</p>
  <div class="signoff">
    ${esc(letter.sign_off)}<br>
    <span class="name">${esc(letter.name)}</span>
  </div>
</div>
</body></html>`;
}

main().catch((err) => {
  console.error(c.red(`\nError: ${err.message}\n`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
