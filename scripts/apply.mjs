#!/usr/bin/env node
// scripts/apply.mjs
// ============================================================================
// HUMAN-IN-THE-LOOP AUTO-APPLY
// ============================================================================
//
// What this does:
//   1. Opens the application URL in a VISIBLE Playwright browser
//   2. Walks the form DOM, extracts every field + its label
//   3. Asks the local LLM to propose an answer for each field, grounding
//      answers in cv.md and config/profile.yml — if the profile doesn't have
//      an answer, the script flags it instead of hallucinating
//   4. Fills the form
//   5. STOPS. Prints a review summary. Does NOT click submit.
//   6. Leaves the browser open so YOU can review and click submit yourself
//
// What this does NOT do:
//   - It never clicks a submit button. Ever. The submit step is not coded.
//   - It never uploads fake documents.
//   - It never makes up personal data (salary, visa status, EEO answers).
//     If it can't find the answer in your profile, it leaves the field blank
//     and flags it in the summary.
//
// Why: local LLMs hallucinate more than hosted models on structured form-fill.
// A wrong salary or work-authorization answer on a real application is a much
// bigger problem than a slightly slower apply cadence. The human review is the
// safety net.
// ============================================================================

import fs from 'node:fs';
import 'dotenv/config';
import { chatJSON } from './lib/ollama.mjs';
import { paths, c, parseArgs, readFileOr, readYaml } from './lib/util.mjs';

const args = parseArgs();
const url = args.flags.url || args.positional[0];
if (!url || !/^https?:\/\//.test(url)) {
  console.error(c.red('Pass --url https://... (the application page URL)'));
  process.exit(1);
}

const HEADLESS = process.env.AUTO_APPLY_HEADLESS === 'true';
const REVIEW_TIMEOUT_MS = parseInt(process.env.AUTO_APPLY_REVIEW_TIMEOUT_MS || '600000', 10);
// Note: AUTO_APPLY_REQUIRE_CONFIRM is read but currently has no disable path.
// That's intentional — the submit click is not wired up in this code.

const cv = readFileOr(paths.cv);
const profile = readYaml(paths.profile);
if (!cv) { console.error(c.red(`No CV at ${paths.cv}`)); process.exit(1); }

console.log(c.bold('\nCareer-Ops apply — human-in-the-loop\n'));
console.log(c.dim(`  url:      ${url}`));
console.log(c.dim(`  headless: ${HEADLESS}`));
console.log('');
if (HEADLESS) {
  console.log(c.yellow('  ⚠ Running headless. You won\'t see the browser. Set AUTO_APPLY_HEADLESS=false to watch.\n'));
}

async function main() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log(c.cyan('→ loading application page'));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000); // let SPAs settle

    console.log(c.cyan('→ extracting form fields'));
    const fields = await extractFormFields(page);
    console.log(c.dim(`  found ${fields.length} fillable fields`));
    if (fields.length === 0) {
      console.log(c.yellow('  No form detected. The page may be a job listing rather than an application form.'));
      console.log(c.yellow('  Try opening the "Apply" button first, then run this against that URL.'));
      return;
    }

    console.log(c.cyan('→ proposing answers via local LLM'));
    const proposals = await proposeAnswers({ fields, cv, profile });

    console.log(c.cyan('→ filling form'));
    const filled = await fillForm(page, fields, proposals);

    console.log('');
    console.log(c.bold('─── REVIEW SUMMARY ────────────────────────────────────────'));
    for (const row of filled) {
      const icon = row.status === 'filled' ? c.green('✓') :
                   row.status === 'flagged' ? c.yellow('⚠') :
                   c.red('✗');
      console.log(`  ${icon} ${row.label}`);
      if (row.value) console.log(c.dim(`      → ${truncate(row.value, 80)}`));
      if (row.note)  console.log(c.yellow(`      note: ${row.note}`));
    }
    console.log(c.bold('───────────────────────────────────────────────────────────'));
    console.log('');
    console.log(c.bold(c.yellow('  👀 REVIEW AND SUBMIT YOURSELF IN THE BROWSER.')));
    console.log(c.dim(`     The script will NOT click submit. Browser stays open for ${Math.round(REVIEW_TIMEOUT_MS / 60000)} min.`));
    console.log(c.dim('     Things to double-check:'));
    console.log(c.dim('       • salary / compensation fields'));
    console.log(c.dim('       • work authorization / visa status'));
    console.log(c.dim('       • EEO / demographic questions (you can skip those)'));
    console.log(c.dim('       • anything flagged ⚠ above'));
    console.log('');

    await page.waitForTimeout(REVIEW_TIMEOUT_MS);
  } catch (err) {
    console.error(c.red(`\nError: ${err.message}\n`));
    if (process.env.DEBUG) console.error(err.stack);
  } finally {
    await browser.close();
  }
}

main();

// ---------------------------------------------------------------------------

async function extractFormFields(page) {
  return page.evaluate(() => {
    const fields = [];
    const seen = new Set();

    function labelFor(el) {
      // 1. explicit <label for="id">
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return lbl.innerText.trim();
      }
      // 2. wrapping <label>
      const wrap = el.closest('label');
      if (wrap) return wrap.innerText.trim();
      // 3. aria-label / placeholder
      return (el.getAttribute('aria-label') || el.placeholder || el.name || '').trim();
    }

    function selectorFor(el) {
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.name) return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      return null;
    }

    const inputs = document.querySelectorAll('input, textarea, select');
    for (const el of inputs) {
      const type = (el.type || el.tagName).toLowerCase();
      // Skip the ones we never want to touch
      if (['submit', 'button', 'hidden', 'file', 'image', 'reset'].includes(type)) continue;
      if (el.disabled || el.readOnly) continue;
      const sel = selectorFor(el);
      if (!sel || seen.has(sel)) continue;
      seen.add(sel);

      const field = {
        selector: sel,
        tag: el.tagName.toLowerCase(),
        type,
        name: el.name || '',
        label: labelFor(el) || el.name || '(unlabeled)',
        required: el.required || el.getAttribute('aria-required') === 'true',
      };
      if (el.tagName === 'SELECT') {
        field.options = Array.from(el.options).map((o) => ({ value: o.value, label: o.text.trim() }));
      }
      fields.push(field);
    }
    return fields;
  });
}

async function proposeAnswers({ fields, cv, profile }) {
  const system = [
    'You fill out job application forms on behalf of a candidate.',
    '',
    'STRICT RULES — violating these is worse than leaving a field blank:',
    '  1. NEVER invent personal data. If the answer is not in the candidate',
    '     profile or CV, set "value" to null and explain in "note".',
    '  2. For salary / compensation: if a target number is in the profile, use it.',
    '     Otherwise set value=null and note "needs human — salary not in profile".',
    '  3. For work authorization, visa status, sponsorship needs, EEO questions,',
    '     veteran status, disability status: ONLY answer if explicitly in the',
    '     profile. Otherwise value=null, note="needs human".',
    '  4. For yes/no questions where the profile is silent: value=null.',
    '  5. For long-form "why do you want this role" questions: write 2-3 honest',
    '     sentences grounded in the CV.',
    '  6. For dropdowns: pick the option whose `value` or `label` best matches',
    '     the profile. If nothing matches, value=null.',
    '',
    'Return ONLY valid JSON in this shape:',
    '  { "answers": [ { "selector": "...", "value": "...", "confidence": "high"|"medium"|"low", "note": "..." } ] }',
    '',
    '"note" is required when confidence is "low" or when value is null.',
  ].join('\n');

  const user = [
    `CANDIDATE PROFILE:\n${JSON.stringify(profile, null, 2)}`,
    '',
    `CANDIDATE CV:\n${cv}`,
    '',
    `FORM FIELDS (fill these):\n${JSON.stringify(fields, null, 2)}`,
  ].join('\n');

  const out = await chatJSON({ system, user, temperature: 0.2 });
  return out.answers || [];
}

async function fillForm(page, fields, proposals) {
  const bySelector = Object.fromEntries(proposals.map((a) => [a.selector, a]));
  const results = [];

  for (const field of fields) {
    const proposal = bySelector[field.selector];

    if (!proposal || proposal.value === null || proposal.value === undefined || proposal.value === '') {
      results.push({
        label: field.label,
        status: 'flagged',
        value: '',
        note: proposal?.note || 'no answer proposed — fill manually',
      });
      continue;
    }

    try {
      if (field.tag === 'select') {
        // Try both value and label match
        await page.selectOption(field.selector, { value: String(proposal.value) }).catch(async () => {
          await page.selectOption(field.selector, { label: String(proposal.value) });
        });
      } else if (field.type === 'checkbox' || field.type === 'radio') {
        if (proposal.value === true || String(proposal.value).toLowerCase() === 'yes' || String(proposal.value).toLowerCase() === 'true') {
          await page.check(field.selector);
        }
      } else {
        await page.fill(field.selector, String(proposal.value));
      }

      results.push({
        label: field.label,
        status: proposal.confidence === 'low' ? 'flagged' : 'filled',
        value: String(proposal.value),
        note: proposal.confidence === 'low' ? (proposal.note || 'low confidence — verify') : '',
      });
    } catch (err) {
      results.push({
        label: field.label,
        status: 'error',
        value: String(proposal.value),
        note: `fill failed: ${err.message}`,
      });
    }
  }
  return results;
}

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
