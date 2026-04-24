#!/usr/bin/env node
// scripts/apply.mjs
// ============================================================================
// HUMAN-IN-THE-LOOP AUTO-APPLY — enhanced
// ============================================================================
//
// Flow on each application URL:
//   1. Load the page
//   2. Dismiss cookie banner (if present) — before anything else
//   3. If this is a job landing page (has "Apply Now" button, not a form):
//        click "Apply Now" to reveal the real form
//   4. If the form requires sign-in/sign-up:
//        try to sign in with APPLY_EMAIL / APPLY_PASSWORD from .env
//        if sign-in fails with "account doesn't exist", try sign-up instead
//   5. Extract form fields, filtering out landing-page search boxes
//   6. Ask the LLM to propose answers (grounded in cv.md + profile.yml)
//   7. Fill the form
//   8. STOP. Show review summary. Wait for human to click submit.
//
// What this does NOT do:
//   - Never clicks the final submit/apply-final button. You do that.
//   - Never uploads fake documents.
//   - Never invents personal data (salary, visa status, EEO).
//
// Bulk mode (scripts/bulk-apply.mjs wraps this):
//   - Runs through multiple URLs sequentially
//   - If a URL fails at any step, logs it to data/failures_DATE.csv
//     with the URL so you can retry manually
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { chatJSON } from './lib/llm.mjs';
import { paths, c, parseArgs, readFileOr, readYaml, ensureDir } from './lib/util.mjs';

const args = parseArgs();
const url = args.flags.url || args.positional[0];
// Optional: tailored resume PDF to attach to this application. When bulk-apply
// runs, it'll pass the PDF that was generated for this specific JD.
const resumePdfPath = args.flags.resume || '';
if (!url || !/^https?:\/\//.test(url)) {
  console.error(c.red('Pass --url https://... (the application page URL)'));
  process.exit(1);
}

const HEADLESS = process.env.AUTO_APPLY_HEADLESS === 'true';
const REVIEW_TIMEOUT_MS = parseInt(process.env.AUTO_APPLY_REVIEW_TIMEOUT_MS || '600000', 10);

// Credentials for sign-in/sign-up. These come from .env — NEVER hardcoded here.
const APPLY_EMAIL    = process.env.APPLY_EMAIL    || '';
const APPLY_PASSWORD = process.env.APPLY_PASSWORD || '';

const cv = readFileOr(paths.cv);
const profile = readYaml(paths.profile);
if (!cv) { console.error(c.red(`No CV at ${paths.cv}`)); process.exit(1); }

// Log failures to a CSV so bulk mode can track which applications need manual retry
const FAILURE_LOG = process.env.APPLY_FAILURE_LOG || '';

console.log(c.bold('\nCareer-Ops apply — human-in-the-loop\n'));
console.log(c.dim(`  url:      ${url}`));
console.log(c.dim(`  headless: ${HEADLESS}`));
if (APPLY_EMAIL) console.log(c.dim(`  email:    ${APPLY_EMAIL} (from .env)`));
if (!APPLY_EMAIL) console.log(c.yellow(`  ⚠ APPLY_EMAIL not set in .env — sign-in will be skipped`));
console.log('');

async function main() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext();
  const page = await context.newPage();

  let failureReason = '';

  try {
    console.log(c.cyan('→ loading application page'));
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(2000); // let SPAs settle

    // STEP 1: Dismiss cookie banner so it doesn't cover form elements
    console.log(c.cyan('→ dismissing cookie banner (if any)'));
    const cookieDismissed = await dismissCookieBanner(page);
    if (cookieDismissed) console.log(c.dim('  cookie banner dismissed'));
    else console.log(c.dim('  no cookie banner found'));

    // STEP 2: If we're on a job landing page, click "Apply Now" to reveal the form
    console.log(c.cyan('→ navigating to application form'));
    const applyResult = await clickApplyNow(page);
    if (applyResult === 'clicked') {
      console.log(c.dim('  walked through Apply Now flow — waiting for form'));
      await page.waitForTimeout(2000);
    } else if (applyResult === 'already-on-form') {
      console.log(c.dim('  already on a form page'));
    } else {
      console.log(c.yellow('  ⚠ Apply button not found — the page may require manual navigation'));
    }

    // Dismiss any SECOND dialog that appeared after clicking Apply Now
    // (e.g. JPMC's "IMPORTANT NOTICE" modal appears post-click, not at load)
    console.log(c.cyan('→ dismissing post-apply dialogs (if any)'));
    const secondPassDismissed = await dismissCookieBanner(page);
    if (secondPassDismissed) console.log(c.dim('  dismissed additional dialog'));

    // STEP 3: Detect sign-in / sign-up gate
    if (APPLY_EMAIL && APPLY_PASSWORD) {
      const authHandled = await handleAuthGate(page);
      if (authHandled === 'signed-in')    console.log(c.dim('  signed in with stored credentials'));
      else if (authHandled === 'signed-up') console.log(c.dim('  created account with stored credentials'));
      else if (authHandled === 'skipped')   console.log(c.dim('  no sign-in gate detected'));
      await page.waitForTimeout(2000);
    }

    // STEP 3b: Attach the tailored resume PDF to any visible file-upload field
    if (resumePdfPath) {
      if (!fs.existsSync(resumePdfPath)) {
        console.log(c.yellow(`  ⚠ Resume PDF not found at ${resumePdfPath} — skipping upload`));
      } else {
        console.log(c.cyan(`→ attaching resume PDF (${path.basename(resumePdfPath)})`));
        const uploaded = await attachResume(page, resumePdfPath);
        if (uploaded) console.log(c.dim(`  uploaded`));
        else          console.log(c.dim(`  no resume-upload field found on this page`));
      }
    }

    // STEP 4-6: Multi-step form loop — fill page, click Next, fill next page.
    // Stops when we hit the submit-only step (where only "Submit Application"
    // button remains — that's for the human to click).
    const MAX_STEPS = 6;   // safety cap — most ATS forms are 2-4 steps
    const allFilled = [];
    let step = 0;

    while (step < MAX_STEPS) {
      step++;
      console.log(c.bold(c.cyan(`\n  Step ${step}:`)));

      // Some multi-step forms present resume upload on step 2 (after basic info).
      // Re-run the attach in each step in case the upload field appears now.
      if (step > 1 && resumePdfPath && fs.existsSync(resumePdfPath)) {
        const uploaded = await attachResume(page, resumePdfPath);
        if (uploaded) console.log(c.dim(`  uploaded resume on step ${step}`));
      }

      // Dismiss any popup that may have appeared when advancing
      await dismissCookieBanner(page);

      // Extract fields on THIS step
      console.log(c.cyan('  → extracting form fields'));
      const fields = await extractFormFields(page);
      console.log(c.dim(`    found ${fields.length} fillable fields`));

      if (fields.length === 0 && step === 1) {
        // Never got a form at all
        failureReason = 'no form detected (page may still be a job listing)';
        console.log(c.yellow('  No form detected. Try clicking Apply Now manually, then re-run.'));
        await logFailure(url, failureReason);
        return;
      }

      if (fields.length > 0) {
        console.log(c.cyan('  → proposing answers via local LLM (30–90s)'));
        const proposals = await proposeAnswers({ fields, cv, profile });
        console.log(c.cyan('  → filling form'));
        const filled = await fillForm(page, fields, proposals);
        allFilled.push(...filled);
      }

      // Try to advance to the next step. If there's no Next button, or only a
      // Submit-style button is left, stop the loop (we've reached the final
      // page — the human clicks submit).
      const advance = await clickNextIfPresent(page);
      if (advance === 'advanced') {
        console.log(c.dim(`  advanced to step ${step + 1}`));
        continue;
      }
      if (advance === 'submit-only') {
        console.log(c.dim(`  next action is "Submit" — stopping here for human review`));
        break;
      }
      // No Next button at all — single-page form, done.
      break;
    }

    const filled = allFilled;

    // Review summary
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
    failureReason = err.message || String(err);
    console.error(c.red(`\nError: ${failureReason}\n`));
    if (process.env.DEBUG) console.error(err.stack);
    await logFailure(url, failureReason);
  } finally {
    await browser.close();
  }
}

main();

// ===========================================================================
// Cookie banner dismissal
// ===========================================================================

/**
 * Dismisses cookie banners AND any generic popup/overlay dialogs that
 * cover form fields — e.g. "IMPORTANT NOTICE" boxes on Oracle Cloud,
 * GDPR modals on SAP SuccessFactors, notices on Workday.
 *
 * Called multiple times during the flow because some sites show a SECOND
 * dialog after the first is dismissed (or after the user interacts with
 * the page).
 *
 * Returns true if any dialog was dismissed, false if none was found.
 */
async function dismissCookieBanner(page) {
  const selectors = [
    // Cookie-specific patterns (most specific)
    'button:has-text("Accept All Cookies")',
    'button:has-text("Accept all cookies")',
    'button:has-text("Accept All")',
    'button:has-text("Accept all")',
    // OneTrust, Didomi, and other major consent vendors
    '#onetrust-accept-btn-handler',
    '#didomi-notice-agree-button',
    '[data-testid="cookie-accept"]',
    '[data-cy="cookie-accept"]',
    // Generic "Accept" buttons — for "IMPORTANT NOTICE" style dialogs
    // Ordered so cookie-specific ones are tried first above.
    'button:has-text("ACCEPT")',
    'button:has-text("Accept")',
    'button:has-text("I Accept")',
    'button:has-text("I agree")',
    'button:has-text("Agree")',
    'button:has-text("Got it")',
    'button:has-text("OK, got it")',
    'button:has-text("OK")',
    'button:has-text("Continue")',
    'button:has-text("Close")',
    'button:has-text("Dismiss")',
  ];

  let anyDismissed = false;
  // Loop up to 3 times in case multiple dialogs stack
  for (let attempt = 0; attempt < 3; attempt++) {
    let dismissedThisPass = false;
    for (const sel of selectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 300 })) {
          await btn.click({ timeout: 2000 });
          await page.waitForTimeout(500);
          dismissedThisPass = true;
          anyDismissed = true;
          break; // restart scan — a new dialog may have appeared
        }
      } catch { /* try next */ }
    }
    if (!dismissedThisPass) break; // nothing dismissed this pass, we're done
  }
  return anyDismissed;
}

// ===========================================================================
// Apply Now button click
// ===========================================================================

/**
 * Detects a job-listing landing page and walks the "Apply Now" chain
 * until we reach a real application form.
 *
 * Many ATS platforms have a multi-step flow:
 *   - Page 1: Apply Now button → opens dropdown/modal
 *   - Page 2: Apply Now button in the modal → goes to form
 *   - Page 3: the actual form with email/password/textarea
 *
 * This function clicks Apply Now up to 3 times, dismissing any popups
 * between clicks. Stops as soon as real form fields are detected.
 *
 * Returns: 'clicked' | 'already-on-form' | 'not-found'
 */
async function clickApplyNow(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    // Check: are we already on a form? (email/password/textarea visible)
    const hasFormFields = await page.evaluate(() => {
      const emailOrPasswordVisible = Array.from(document.querySelectorAll('input'))
        .some((el) => ['email', 'password'].includes(el.type) && el.offsetParent !== null);
      const hasTextarea = Array.from(document.querySelectorAll('textarea'))
        .some((el) => el.offsetParent !== null);
      // Also check for heading "Enter your email" / "Sign in" which indicates
      // we've landed on a form page even if inputs haven't rendered yet
      const formHeading = /enter\s+your\s+email|sign\s+in|create\s+(an\s+)?account|apply\s+for/i.test(
        document.body?.innerText?.slice(0, 3000) || ''
      );
      return emailOrPasswordVisible || hasTextarea || formHeading;
    });
    if (hasFormFields) {
      return attempt === 0 ? 'already-on-form' : 'clicked';
    }

    // Not on a form yet — look for an Apply button to click
    const applySelectors = [
      'button:has-text("Apply Now")',
      'button:has-text("Apply now")',
      'a:has-text("Apply Now")',
      'a:has-text("Apply now")',
      // Sometimes the button appears inside a "dropdown" that the first
      // click opens — it may have a different label on round 2.
      'button:has-text("Apply for this job")',
      'a:has-text("Apply for this job")',
      'button:has-text("Continue to apply")',
      'button:has-text("Start application")',
      // More generic, tried last
      'button:has-text("Apply")',
      'a:has-text("Apply")',
      '[data-testid="apply-button"]',
      '[data-cy="apply-button"]',
    ];

    let clicked = false;
    for (const sel of applySelectors) {
      try {
        const btn = page.locator(sel).first();
        if (await btn.isVisible({ timeout: 300 })) {
          await btn.scrollIntoViewIfNeeded();
          await btn.click({ timeout: 3000 });
          clicked = true;
          break;
        }
      } catch { /* try next */ }
    }

    if (!clicked) {
      // No more Apply buttons to click. If we never clicked one at all,
      // the page might just not have one; if we've clicked already,
      // we're probably on a non-form page and should bail.
      return attempt === 0 ? 'not-found' : 'clicked';
    }

    // Wait for navigation / modal to settle, then dismiss any new popup
    await page.waitForTimeout(2500);
    await dismissCookieBanner(page);
  }
  return 'clicked';
}

// ===========================================================================
// Sign-in / sign-up gate handling
// ===========================================================================

/**
 * Detects if the form currently shows a sign-in/sign-up gate (typically an
 * email + password pair). If so, try to authenticate with APPLY_EMAIL and
 * APPLY_PASSWORD from .env.
 *
 * Strategy:
 *   1. Find a visible email input and a visible password input
 *   2. Fill both with stored credentials
 *   3. Click the submit button
 *   4. If we see "account doesn't exist" or similar, flip to the sign-up tab
 *      and re-submit
 *
 * Returns: 'signed-in' | 'signed-up' | 'skipped' | 'failed'
 */
// ===========================================================================
// Resume PDF upload
// ===========================================================================

/**
 * Finds a resume / CV upload input on the current page and uploads the given
 * PDF to it. Returns true if a matching input was found and the file was
 * attached, false otherwise.
 *
 * Strategy: look for <input type="file"> elements whose name/id/label hints
 * at "resume", "cv", "upload". Fall back to the first file input on the page
 * if no hint matches (most single-file application forms only have ONE).
 */
async function attachResume(page, pdfPath) {
  // Collect candidate file inputs with their hint signals
  const candidates = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
    return inputs.map((el, index) => {
      const hay = [
        el.name, el.id,
        el.getAttribute('aria-label'),
        el.closest('label')?.innerText,
        el.parentElement?.innerText?.slice(0, 200),
      ].filter(Boolean).join(' ').toLowerCase();
      return {
        index,
        visible: el.offsetParent !== null || el.getAttribute('type') === 'file',
        isResume: /\b(resume|resum|cv|upload.*(resume|cv))\b/i.test(hay),
      };
    });
  });

  // Prefer a resume-hinted input; otherwise fall back to the first file input
  // (many simple forms only have one file input anyway).
  const match = candidates.find((c) => c.isResume) || candidates[0];
  if (!match) return false;

  try {
    // Use nth(index) to target the specific input element — resolves correctly
    // even when inputs are styled hidden (common with custom upload buttons).
    const inputs = await page.locator('input[type="file"]').all();
    const el = inputs[match.index];
    if (!el) return false;
    await el.setInputFiles(pdfPath);
    await page.waitForTimeout(1500); // let the upload indicator settle
    return true;
  } catch (err) {
    console.log(c.yellow(`  upload attempt failed: ${err.message.split('\n')[0]}`));
    return false;
  }
}

// ===========================================================================
// Multi-step form navigation — click "Next" / "Continue" buttons
// ===========================================================================

/**
 * After filling the current form page, look for a "Next" / "Continue" button
 * and click it to advance to the next step. Returns 'advanced' | 'submit-only' |
 * 'none'.
 *
 * We are very careful here: we NEVER click a button whose label is "Submit" or
 * "Apply" (final-action verbs). Those are human-only. "Next", "Continue",
 * "Save and Continue", "Review" are OK.
 */
async function clickNextIfPresent(page) {
  const dangerousLabels = /\b(submit\s*application|submit\s*now|apply\s*now|send\s*application|confirm\s*and\s*submit)\b/i;

  // Ordered by how explicitly "next-step" they are. Stop at the first visible match.
  const nextSelectors = [
    'button:has-text("Save and Continue")',
    'button:has-text("Save & Continue")',
    'button:has-text("Continue")',
    'button:has-text("Next")',
    'button:has-text("Next Step")',
    'button:has-text("Next step")',
    'button:has-text("Review")',
    'a:has-text("Next")',
    'a:has-text("Continue")',
  ];

  for (const sel of nextSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 300 })) {
        const labelText = (await btn.innerText()) || '';
        if (dangerousLabels.test(labelText)) {
          // This is a submit-style button masquerading as "next" — do NOT click
          return 'submit-only';
        }
        await btn.scrollIntoViewIfNeeded();
        await btn.click({ timeout: 3000 });
        await page.waitForTimeout(2500);
        return 'advanced';
      }
    } catch { /* try next */ }
  }
  return 'none';
}

async function handleAuthGate(page) {
  const hasAuth = await page.evaluate(() => {
    const emailVisible = Array.from(document.querySelectorAll('input[type="email"], input[name*="email" i]'))
      .some((el) => el.offsetParent !== null);
    const passwordVisible = Array.from(document.querySelectorAll('input[type="password"]'))
      .some((el) => el.offsetParent !== null);
    return emailVisible && passwordVisible;
  });
  if (!hasAuth) return 'skipped';

  try {
    // Try to fill email and password
    const emailInput = page.locator('input[type="email"], input[name*="email" i]').first();
    const passwordInput = page.locator('input[type="password"]').first();

    await emailInput.fill(APPLY_EMAIL, { timeout: 5000 });
    await passwordInput.fill(APPLY_PASSWORD, { timeout: 5000 });

    // Find a sign-in button. Don't click generic "Submit" — that could submit
    // the application form instead. Be specific.
    const signInButton = page.locator([
      'button:has-text("Sign In")',
      'button:has-text("Sign in")',
      'button:has-text("Log In")',
      'button:has-text("Login")',
      'button:has-text("Continue")',
    ].join(', ')).first();

    if (!(await signInButton.isVisible({ timeout: 1000 }))) {
      return 'failed';
    }
    await signInButton.click();
    await page.waitForTimeout(3000);

    // Did sign-in fail? Look for error text suggesting the account doesn't exist
    const pageText = await page.content();
    const accountMissing = /account\s+(not\s+found|doesn'?t\s+exist|does\s+not\s+exist|no\s+account)/i.test(pageText)
      || /create\s+(an\s+)?account/i.test(pageText);

    if (!accountMissing) return 'signed-in';

    // Try sign-up flow: look for a "Create Account" tab/button
    const signUpTab = page.locator([
      'button:has-text("Create Account")',
      'button:has-text("Create account")',
      'a:has-text("Create Account")',
      'a:has-text("Create account")',
      'button:has-text("Sign Up")',
      'button:has-text("Register")',
    ].join(', ')).first();

    if (await signUpTab.isVisible({ timeout: 1000 })) {
      await signUpTab.click();
      await page.waitForTimeout(2000);

      // Refill email + password on the sign-up form
      const emailInput2 = page.locator('input[type="email"], input[name*="email" i]').first();
      const passwordInput2 = page.locator('input[type="password"]').first();
      await emailInput2.fill(APPLY_EMAIL, { timeout: 5000 }).catch(() => {});
      await passwordInput2.fill(APPLY_PASSWORD, { timeout: 5000 }).catch(() => {});

      // There may be a second password field (confirm password)
      const confirmInput = page.locator('input[type="password"]').nth(1);
      if (await confirmInput.isVisible({ timeout: 500 })) {
        await confirmInput.fill(APPLY_PASSWORD).catch(() => {});
      }

      // Don't auto-click the submit here. Let the human decide.
      // (Creating accounts is a state change; human review is appropriate.)
      console.log(c.yellow('  ⚠ Sign-up form filled. Review and click Create Account yourself.'));
      return 'signed-up';
    }

    return 'failed';
  } catch (err) {
    console.log(c.yellow(`  (auth attempt failed: ${err.message} — skipping)`));
    return 'failed';
  }
}

// ===========================================================================
// Form field extraction — now filters out landing-page search boxes
// ===========================================================================

async function extractFormFields(page) {
  return page.evaluate(() => {
    const fields = [];
    const seen = new Set();

    // Names/labels that are clearly search/filter widgets, not application fields.
    // If we match these, skip — they're the "Search by Keyword" trap on job pages.
    const SEARCH_FIELD_PATTERNS = [
      /search/i,
      /^keyword/i,
      /^query/i,
      /filter/i,
      /^q$/i,
      /sort\s*by/i,
      /^location$/i,   // only on landing pages; real app forms use more specific labels
      /^location\s*search/i,
      /receive\s+an\s+alert/i,     // "how often to receive alerts"
      /create\s+alert/i,
    ];

    function isSearchField(el, label) {
      const combined = [el.name, el.id, el.placeholder, label].filter(Boolean).join(' ');
      // Also check: is this field near a "Search Jobs" button? (structural hint)
      const closestForm = el.closest('form');
      if (closestForm) {
        const formText = closestForm.innerText.toLowerCase();
        if (/search\s+jobs?/i.test(formText) && !/apply/i.test(formText)) return true;
      }
      return SEARCH_FIELD_PATTERNS.some((re) => re.test(combined));
    }

    function labelFor(el) {
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return lbl.innerText.trim();
      }
      const wrap = el.closest('label');
      if (wrap) return wrap.innerText.trim();
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
      if (['submit', 'button', 'hidden', 'file', 'image', 'reset'].includes(type)) continue;
      if (el.disabled || el.readOnly) continue;

      // Skip invisible elements — they're probably not real form fields
      if (el.offsetParent === null && type !== 'hidden') continue;

      const sel = selectorFor(el);
      if (!sel || seen.has(sel)) continue;
      seen.add(sel);

      const label = labelFor(el) || el.name || '(unlabeled)';

      // ★ THE FIX: skip search/filter widgets
      if (isSearchField(el, label)) continue;

      const field = {
        selector: sel,
        tag: el.tagName.toLowerCase(),
        type,
        name: el.name || '',
        label,
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

// ===========================================================================
// LLM answer proposal (unchanged behavior — integrity rules same as before)
// ===========================================================================

async function proposeAnswers({ fields, cv, profile }) {
  const system = [
    'You fill out job application forms on behalf of a candidate.',
    '',
    '════════════════════════════════════════════════════════════════════════',
    'TWO-TIER POLICY: every field is in exactly ONE of these tiers.',
    '════════════════════════════════════════════════════════════════════════',
    '',
    '━━━ TIER 1: FACTUAL FIELDS (use profile.yml verbatim) ━━━',
    '  Name, email, phone, location, LinkedIn, GitHub, state, school, degree,',
    '  company names, start/end dates, work authorization, sponsorship need,',
    '  visa status, EEO answers (gender/race/veteran/disability), communication',
    '  preferences, agree-to-terms, certify-info-is-true, start date, salary.',
    '',
    '  RULE: use EXACTLY what profile.yml says. Never paraphrase, never invent.',
    '        If profile.yml is null/missing → value=null, note="needs human".',
    '        NEVER guess these to "just get past validation." Wrong answers',
    '        here cause offers to be rescinded.',
    '',
    '  Salary specifically: use profile.yml target_base_usd if set. Otherwise',
    '  value=null, note="needs human — salary not in profile". DO NOT invent',
    '  a number.',
    '',
    '  Certification checkboxes ("I certify the above is true"): check ONLY if',
    '  profile.yml application_defaults.certify_info_is_true is true AND this',
    '  is the last field. value=null otherwise.',
    '',
    '━━━ TIER 2: ESSAY FIELDS (you write these, grounded in CV) ━━━',
    '  Questions like:',
    '    - "Tell us about a project you worked on"',
    '    - "Describe your experience with X technology"',
    '    - "Why do you want this role?" / "Why this company?"',
    '    - "What\'s your biggest accomplishment?"',
    '    - "What do you bring to this role?"',
    '    - Any open-ended <textarea> or freeform multi-sentence prompt',
    '    - Cover-letter style fields',
    '',
    '  RULE: write a grounded, concrete 2-5 sentence answer pulling from the',
    '        candidate\'s actual CV. Reference specific technologies, companies,',
    '        and project outcomes from the CV. Use essay_hints from profile.yml',
    '        if relevant.',
    '',
    '        CRITICAL: every concrete claim must trace back to the CV. You may',
    '        reword; you may NOT invent. If the CV says "5 years experience",',
    '        don\'t write "10 years." If the CV says "built RAG at UnitedHealth",',
    '        don\'t write "built RAG at Google."',
    '',
    '        Tone: first-person, conversational, avoid AI-tells like',
    '        "Spearheaded", "Leveraged", "As an AI Engineer, I...". Write like',
    '        the candidate wrote it themselves.',
    '',
    '        Length: match what the field seems to want. 1-2 sentences for short',
    '        prompts, 3-5 for standard essay fields, up to 6-8 if the form shows',
    '        a ~500 word limit.',
    '',
    '        confidence: "medium" (always — essay answers are drafts that the',
    '        human should skim before submit).',
    '',
    '━━━ HOW TO TELL TIER 1 FROM TIER 2 ━━━',
    '  Tier 1 has a "correct" answer that exists somewhere (profile.yml or not at all).',
    '  Tier 2 is a narrative where the candidate synthesizes their experience.',
    '',
    '  If the label contains any of: salary, compensation, pay, wage, race,',
    '  ethnicity, gender, veteran, disability, authorized, sponsor, visa,',
    '  citizen, criminal, felony, conviction, drug test, background check,',
    '  i certify, i agree, consent, sign here  → TIER 1.',
    '',
    '  If the label contains any of: describe, tell us about, why, what drew,',
    '  walk us through, share a time, what interests, what do you bring, in your',
    '  own words  → TIER 2.',
    '',
    '  If ambiguous, default to Tier 1 (safer).',
    '',
    'Return ONLY valid JSON:',
    '  { "answers": [ { "selector": "...", "value": "...", "confidence": "high"|"medium"|"low", "note": "..." } ] }',
    '',
    '"note" is REQUIRED when value is null (explain what info is missing) or',
    'when you wrote a Tier 2 essay (note="AI-drafted — review before submit").',
  ].join('\n');

  const user = [
    `CANDIDATE PROFILE (source of truth for Tier 1 factual fields):`,
    JSON.stringify(profile, null, 2),
    '',
    `CANDIDATE CV (source of truth for Tier 2 essay grounding):`,
    cv,
    '',
    `FORM FIELDS (fill these — classify each as Tier 1 or Tier 2 per policy):`,
    JSON.stringify(fields, null, 2),
  ].join('\n');

  const out = await chatJSON({ system, user, temperature: 0.3 });
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

    // Skip honeypot fields entirely — they're traps for bots
    if (isHoneypot(field)) {
      results.push({
        label: field.label,
        status: 'flagged',
        value: '',
        note: 'honeypot field — intentionally left blank',
      });
      continue;
    }

    try {
      if (field.tag === 'select') {
        await page.selectOption(field.selector, { value: String(proposal.value) }).catch(async () => {
          await page.selectOption(field.selector, { label: String(proposal.value) });
        });
      } else if (field.type === 'checkbox' || field.type === 'radio') {
        if (proposal.value === true || String(proposal.value).toLowerCase() === 'yes' || String(proposal.value).toLowerCase() === 'true') {
          // First attempt — standard check
          try {
            await page.check(field.selector, { timeout: 5000 });
          } catch {
            // Covered by dialog? Dismiss and retry
            await dismissCookieBanner(page);
            await page.waitForTimeout(500);
            try {
              await page.check(field.selector, { timeout: 5000 });
            } catch {
              // Last-ditch: click the label next to the checkbox (works when
              // the input itself is hidden behind custom styling)
              const labelClicked = await page.evaluate((sel) => {
                const input = document.querySelector(sel);
                if (!input) return false;
                const wrap = input.closest('label');
                if (wrap) { wrap.click(); return true; }
                if (input.id) {
                  const lbl = document.querySelector(`label[for="${input.id}"]`);
                  if (lbl) { lbl.click(); return true; }
                }
                return false;
              }, field.selector);
              if (!labelClicked) throw new Error('checkbox could not be toggled');
            }
          }
        }
      } else {
        // Text field — if fill times out, dismiss potential blocking dialog and retry
        try {
          await page.fill(field.selector, String(proposal.value), { timeout: 10000 });
        } catch (err) {
          if (err.message.includes('Timeout') || err.message.includes('not visible')) {
            await dismissCookieBanner(page);
            await page.waitForTimeout(500);
            await page.fill(field.selector, String(proposal.value), { timeout: 10000 });
          } else {
            throw err;
          }
        }
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
        note: `fill failed: ${err.message.split('\n')[0]}`,
      });
    }
  }
  return results;
}

// ===========================================================================
// Failure logging (for bulk mode)
// ===========================================================================

async function logFailure(failedUrl, reason) {
  if (!FAILURE_LOG) return;   // only when running under bulk mode
  try {
    ensureDir(path.dirname(FAILURE_LOG));
    const exists = fs.existsSync(FAILURE_LOG);
    const line = csvLine([new Date().toISOString(), failedUrl, reason]);
    if (!exists) {
      fs.writeFileSync(FAILURE_LOG, csvLine(['timestamp', 'url', 'reason']) + '\n');
    }
    fs.appendFileSync(FAILURE_LOG, line + '\n');
  } catch { /* don't crash on log failures */ }
}

function csvLine(cells) {
  return cells.map((c) => {
    const s = String(c ?? '');
    if (/["\n,]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  }).join(',');
}

/**
 * Detects honeypot fields — hidden or suspiciously-named fields that bots
 * fill and humans don't see. Filling them flags the submission as automated.
 * Common names: "honeypot", "website", "url", "phone2", "confirm_email" when
 * hidden, or labels that literally say "honeypot".
 */
function isHoneypot(field) {
  const hay = [field.name, field.label].filter(Boolean).join(' ').toLowerCase();
  if (/honeypot/i.test(hay)) return true;
  // Fields with label explicitly saying "leave this blank" — some forms are helpful
  if (/leave\s+(this\s+)?blank/i.test(hay)) return true;
  return false;
}

function truncate(s, n) {
  s = String(s).replace(/\s+/g, ' ');
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
