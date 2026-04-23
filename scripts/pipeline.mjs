#!/usr/bin/env node
// scripts/pipeline.mjs
// Multi-link pipeline: evaluate ALL first, show you the scores, you pick
// which ones get PDF + apply. Each application opens its own browser window.
//
// Flow:
//   1. You paste N URLs
//   2. Script fetches + evaluates each one, shows a table of scores
//   3. You pick which jobs to take forward (all / by score / manual)
//   4. For each selected job: PDF → continue? → apply → continue? → next
//   5. Gap-fill helper runs between evaluation and PDF (honest gap surfacing
//      only — we do not invent experience)

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import 'dotenv/config';
import { chatJSON, chat } from './lib/ollama.mjs';
import {
  paths, c, readFileOr, readYaml, ensureDir, slug, timestamp, fetchUrlText,
} from './lib/util.mjs';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((r) => rl.question(q, (a) => r(a.trim())));

function hr() { console.log(c.dim('  ' + '─'.repeat(56))); }
function header(s) {
  console.log('');
  console.log(c.bold(c.cyan(`  ═══ ${s} `)) + c.dim('═'.repeat(Math.max(0, 52 - s.length))));
  console.log('');
}

async function waitContinue(msg = 'Continue?') {
  console.log('');
  while (true) {
    const a = (await ask(c.bold(`  ${msg} [${c.green('c')}ontinue / ${c.yellow('s')}kip / ${c.red('q')}uit] › `))).toLowerCase();
    if (a === 'c' || a === '' || a === 'continue') return 'continue';
    if (a === 's' || a === 'skip') return 'skip';
    if (a === 'q' || a === 'quit') return 'quit';
    console.log(c.red('  Please enter c, s, or q.'));
  }
}

async function yesNo(q, defaultYes = true) {
  const suffix = defaultYes ? '[Y/n]' : '[y/N]';
  const a = (await ask(c.bold(`  ${q} ${suffix} › `))).toLowerCase();
  if (a === '') return defaultYes;
  return a === 'y' || a === 'yes';
}

// ---------------------------------------------------------------------------
// Main pipeline

async function main() {
  console.clear();
  console.log(c.bold(c.cyan('\n  CAREER-OPS · Multi-link pipeline\n')));
  console.log(c.dim('  Evaluate all → you pick winners → PDF + apply for the ones you like.\n'));

  // ── Stage 0: collect URLs ────────────────────────────────────────────────
  const urls = await collectUrls();
  if (urls.length === 0) {
    console.log(c.yellow('  No URLs provided. Bye.'));
    rl.close();
    return;
  }

  // Ask for any context that would help the evaluator (e.g. "skip Meta, already applied")
  console.log('');
  console.log(c.dim('  Optional: anything I should know about these jobs?'));
  console.log(c.dim('  (e.g. "I already applied to Anthropic" or "I prefer the Retool one")'));
  const userNotes = await ask(c.bold('  Notes [or Enter to skip] › '));

  // Load shared inputs once
  const cv = readFileOr(paths.cv);
  if (!cv) {
    console.log(c.red(`\n  No CV at ${paths.cv}. Create it first (see README).`));
    rl.close();
    return;
  }
  const profile = readYaml(paths.profile);
  const modeShared = readFileOr(path.join(paths.modes, '_shared.md'));
  const modeEval = readFileOr(path.join(paths.modes, 'oferta.md'));

  // ── Stage 1: evaluate every URL ──────────────────────────────────────────
  header(`Stage 1/3 — evaluating ${urls.length} job${urls.length > 1 ? 's' : ''}`);
  const evaluated = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(c.cyan(`  [${i + 1}/${urls.length}] ${url}`));
    try {
      const jd = await fetchOrPrompt(url);
      if (!jd) { console.log(c.yellow('      ↳ skipped (no JD)\n')); continue; }

      const meta = await extractMetadata(jd);
      process.stdout.write(c.dim(`      ${meta.company} — ${meta.role} ... `));

      const report = await runEvaluation({ jd, cv, profile, modeShared, modeEval, meta, userNotes });
      console.log(c.dim(`score ${report.overall_score}/5`));

      // Persist the evaluation now
      const reportPath = writeReport({ meta, report, jd });
      appendTracker({ meta, report, reportPath });
      evaluated.push({ url, jd, meta, report, reportPath });
    } catch (err) {
      console.log(c.red(`      ERROR: ${err.message}\n`));
    }
  }

  if (evaluated.length === 0) {
    console.log(c.red('\n  No jobs made it through evaluation. Bye.'));
    rl.close();
    return;
  }

  // ── Stage 2: show scores, let user pick ─────────────────────────────────
  header('Stage 2/3 — results + picks');
  printScoreboard(evaluated);
  console.log('');

  const picks = await pickJobs(evaluated);
  if (picks.length === 0) {
    console.log(c.yellow('\n  No jobs picked. Bye.'));
    rl.close();
    return;
  }

  // ── Stage 3: per-job PDF → apply → next ─────────────────────────────────
  header(`Stage 3/3 — PDF + apply for ${picks.length} pick${picks.length > 1 ? 's' : ''}`);

  for (let i = 0; i < picks.length; i++) {
    const job = picks[i];
    console.log(c.bold(c.cyan(`\n  ── [${i + 1}/${picks.length}] ${job.meta.company} — ${job.meta.role} (${job.report.overall_score}/5) ──\n`)));

    // Optional gap-fill helper
    if (await yesNo('Run gap analysis first (flags requirements your CV doesn\'t clearly show)?', true)) {
      await runGapAnalysis({ job, cv });
      const after = await waitContinue('Ready for PDF generation?');
      if (after === 'quit') break;
      if (after === 'skip') continue;
    }

    // PDF — special rule: ask each time if score < 4.0
    let shouldPdf = true;
    if (job.report.overall_score < 4.0) {
      console.log(c.yellow(`  ⚠ This job scored ${job.report.overall_score}/5 (below the 4.0 cutoff).`));
      shouldPdf = await yesNo('Generate a tailored PDF anyway?', false);
    }

    if (shouldPdf) {
      console.log(c.dim('  → generating tailored PDF...'));
      const code = await runChildScript('scripts/generate-pdf.mjs', ['--report', job.reportPath]);
      if (code !== 0) console.log(c.red(`  PDF failed (exit ${code}).`));
      const after = await waitContinue('PDF done. Continue to application filling?');
      if (after === 'quit') break;
      if (after === 'skip') continue;
    } else {
      console.log(c.dim('  skipped PDF.'));
    }

    // Apply — opens a new browser window per job (per your preference)
    const apply = await yesNo('Auto-fill the application now?', job.report.overall_score >= 4.0);
    if (!apply) {
      console.log(c.dim('  skipped apply.'));
      const after = await waitContinue('Move to next job?');
      if (after === 'quit') break;
      continue;
    }

    // Find the application URL (the JD URL is often a listing, apply is usually one click deeper)
    const applyUrl = await ask(c.bold(`  Application URL [${c.dim('Enter to use ' + truncate(job.url, 50))}] › `)) || job.url;
    console.log(c.dim('  → launching browser (new window for this job)...'));
    const code = await runChildScript('scripts/apply.mjs', ['--url', applyUrl]);
    if (code !== 0) console.log(c.yellow(`  Apply exited with code ${code}.`));

    if (i < picks.length - 1) {
      const after = await waitContinue(`Done with ${job.meta.company}. Next job (${picks[i + 1].meta.company})?`);
      if (after === 'quit') break;
    }
  }

  console.log('');
  console.log(c.green(c.bold('  ✓ Pipeline complete.')));
  console.log(c.dim('  View your pipeline any time with: npm run tracker'));
  console.log('');
  rl.close();
}

// ---------------------------------------------------------------------------
// Helpers

async function collectUrls() {
  console.log(c.bold('  Paste job URLs, one per line. Empty line when done:'));
  console.log(c.dim('  (Paste all at once is fine — the script will split on newlines.)'));
  console.log('');
  const urls = [];
  while (true) {
    const line = await ask(c.dim(`  ${urls.length + 1} › `));
    if (!line) break;
    // Handle multiple URLs pasted on one line too
    const found = line.split(/\s+/).filter((s) => /^https?:\/\//.test(s));
    if (found.length === 0 && line) {
      console.log(c.yellow('    (doesn\'t look like a URL — ignored)'));
      continue;
    }
    urls.push(...found);
  }
  console.log(c.dim(`\n  Got ${urls.length} URL${urls.length === 1 ? '' : 's'}.`));
  return urls;
}

async function fetchOrPrompt(url) {
  try {
    const text = await fetchUrlText(url);
    if (text && text.trim().length > 300) return text.trim();
    // Too short to be a real JD — ask the user
    console.log(c.yellow(`      ↳ couldn't extract enough text (${text?.length || 0} chars).`));
  } catch (err) {
    console.log(c.yellow(`      ↳ fetch failed: ${err.message}`));
  }
  const choice = (await ask(c.bold('      [s]kip, [r]etry, or [p]aste JD manually? › '))).toLowerCase();
  if (choice === 'r') return fetchOrPrompt(url);
  if (choice === 'p') {
    console.log(c.dim('      Paste JD, empty line to finish:'));
    const lines = [];
    while (true) {
      const l = await ask(c.dim('      › '));
      if (!l) break;
      lines.push(l);
    }
    return lines.join('\n');
  }
  return null;
}

async function extractMetadata(jd) {
  return chatJSON({
    system: 'Extract job metadata. Return ONLY JSON: {company, role, location, remote, comp_band, posted_date}. Use null for unknowns.',
    user: `Extract from:\n\n${jd.slice(0, 4000)}`,
    temperature: 0,
  }).then((out) => ({
    company: out.company || 'unknown',
    role: out.role || 'unknown',
    location: out.location || 'unknown',
    remote: out.remote || 'unknown',
    comp_band: out.comp_band || null,
    posted_date: out.posted_date || null,
  }));
}

async function runEvaluation({ jd, cv, profile, modeShared, modeEval, meta, userNotes }) {
  const system = [
    modeShared, '', '---', '', modeEval, '', '---',
    'Return a JSON object with exactly: archetype, overall_score (1.0-5.0),',
    'role_summary, cv_match {strengths[], gaps[], score},',
    'level_strategy, comp_research, personalization, interview_prep {star_stories[], likely_questions[]},',
    'recommendation ("apply"|"maybe"|"skip"), recommendation_reason.',
    'Output ONLY JSON.',
  ].join('\n');

  const user = [
    userNotes ? `USER NOTES (consider these when scoring):\n${userNotes}\n\n---` : '',
    `CANDIDATE PROFILE:\n${JSON.stringify(profile, null, 2)}`,
    '',
    `CANDIDATE CV:\n${cv}`,
    '',
    `JOB DESCRIPTION (${meta.company} — ${meta.role}):\n${jd}`,
  ].filter(Boolean).join('\n');

  return chatJSON({ system, user, temperature: 0.3 });
}

function writeReport({ meta, report, jd }) {
  ensureDir(paths.reports);
  const name = `${timestamp()}-${slug(meta.company)}-${slug(meta.role)}.md`;
  const reportPath = path.join(paths.reports, name);
  const list = (arr) => (arr || []).map((x) => `- ${x}`).join('\n') || '- (none)';
  fs.writeFileSync(reportPath, `# ${meta.company} — ${meta.role}

**Score:** ${report.overall_score} / 5
**Archetype:** ${report.archetype}
**Recommendation:** ${String(report.recommendation || '').toUpperCase()} — ${report.recommendation_reason || ''}
**Location:** ${meta.location}${meta.remote && meta.remote !== 'unknown' ? ` (${meta.remote})` : ''}
${meta.comp_band ? `**Comp band:** ${meta.comp_band}\n` : ''}
---

## Role summary

${report.role_summary}

## CV match (${report.cv_match?.score ?? 'n/a'})

**Strengths**
${list(report.cv_match?.strengths)}

**Gaps**
${list(report.cv_match?.gaps)}

## Level strategy

${report.level_strategy}

## Compensation research

${report.comp_research}

## Personalization hooks

${report.personalization}

## Interview prep

**STAR+R stories**
${list(report.interview_prep?.star_stories)}

**Likely questions**
${list(report.interview_prep?.likely_questions)}

---

<details><summary>Original JD</summary>

\`\`\`
${jd}
\`\`\`

</details>
`);
  return reportPath;
}

function appendTracker({ meta, report, reportPath }) {
  ensureDir(paths.data);
  const p = path.join(paths.data, 'tracker.tsv');
  const header = ['date', 'company', 'role', 'location', 'remote', 'score', 'archetype', 'recommendation', 'status', 'report'].join('\t');
  if (!fs.existsSync(p)) fs.writeFileSync(p, header + '\n');
  const row = [
    new Date().toISOString().slice(0, 10),
    meta.company, meta.role, meta.location, meta.remote,
    report.overall_score, report.archetype, report.recommendation,
    'evaluated', path.relative(process.cwd(), reportPath),
  ].map((v) => String(v ?? '').replace(/\t/g, ' ')).join('\t');
  fs.appendFileSync(p, row + '\n');
}

function printScoreboard(evaluated) {
  const sorted = [...evaluated].sort((a, b) => b.report.overall_score - a.report.overall_score);
  const w = { n: 3, co: Math.max(7, ...sorted.map((e) => e.meta.company.length)), ro: Math.max(4, ...sorted.map((e) => e.meta.role.length)), sc: 5 };
  const pad = (s, n) => String(s).slice(0, n).padEnd(n);

  console.log(c.bold(`  #    ${pad('Company', w.co)}  ${pad('Role', w.ro)}  Score  Verdict`));
  console.log(c.dim(`  ─── ${'─'.repeat(w.co)}  ${'─'.repeat(w.ro)}  ─────  ───────`));
  sorted.forEach((e, i) => {
    const s = e.report.overall_score;
    const color = s >= 4.5 ? c.green : s >= 4.0 ? c.cyan : s >= 3.5 ? c.yellow : c.red;
    const verdict = s >= 4.5 ? 'strong' : s >= 4.0 ? 'apply'  : s >= 3.5 ? 'maybe'  : 'skip';
    console.log(color(`  ${pad(String(i + 1), 3)}  ${pad(e.meta.company, w.co)}  ${pad(e.meta.role, w.ro)}  ${pad(s.toFixed(1), w.sc)}  ${verdict}`));
  });
  // Return the sorted array so the caller can map picks back to original indices
  evaluated.length = 0;
  evaluated.push(...sorted);
}

async function pickJobs(evaluated) {
  console.log(c.bold('  Which jobs do you want to take forward?'));
  console.log('');
  console.log(`    ${c.cyan('[a]')} All of them`);
  console.log(`    ${c.cyan('[t]')} Top scorers only (score ≥ 4.0)`);
  console.log(`    ${c.cyan('[p]')} Top scorers only (score ≥ 4.5)`);
  console.log(`    ${c.cyan('[m]')} Manual pick — I'll give you row numbers`);
  console.log(`    ${c.cyan('[n]')} None, quit the pipeline`);
  console.log('');
  const choice = (await ask(c.bold('  Your choice › '))).toLowerCase();

  if (choice === 'n') return [];
  if (choice === 'a') return evaluated;
  if (choice === 't') return evaluated.filter((e) => e.report.overall_score >= 4.0);
  if (choice === 'p') return evaluated.filter((e) => e.report.overall_score >= 4.5);
  if (choice === 'm') {
    const line = await ask(c.bold('  Row numbers (e.g. "1,3,5" or "1-3") › '));
    const nums = parseRanges(line, evaluated.length);
    return nums.map((n) => evaluated[n - 1]).filter(Boolean);
  }
  console.log(c.red('  Unrecognized choice. Defaulting to top scorers (≥4.0).'));
  return evaluated.filter((e) => e.report.overall_score >= 4.0);
}

function parseRanges(s, max) {
  const out = new Set();
  for (const part of s.split(/[,\s]+/).filter(Boolean)) {
    const m = part.match(/^(\d+)-(\d+)$/);
    if (m) {
      for (let i = +m[1]; i <= +m[2]; i++) if (i >= 1 && i <= max) out.add(i);
    } else if (/^\d+$/.test(part)) {
      const n = +part;
      if (n >= 1 && n <= max) out.add(n);
    }
  }
  return [...out].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Gap analysis — honest version. We flag requirements that aren't in the CV,
// we do NOT invent new experience.

async function runGapAnalysis({ job, cv }) {
  console.log(c.dim('  → running gap analysis...'));
  const prompt = await chatJSON({
    system: [
      'You compare a job description to a candidate\'s CV and identify REQUIREMENTS',
      'from the JD that are not clearly evidenced in the CV.',
      '',
      'STRICT RULES:',
      '  1. Do NOT invent experience. Do NOT suggest the candidate add experience.',
      '  2. Your job is to LIST gaps, not fill them.',
      '  3. For each gap, label it:',
      '     - "probably_have_just_not_written"  (e.g. JD wants "Python", CV shows 5yr ML work — obvious)',
      '     - "learnable_quickly"              (e.g. JD wants "Terraform" and CV shows other IaC)',
      '     - "real_gap"                       (e.g. JD wants 10yr of something CV shows 2yr of)',
      '',
      'Return JSON: { gaps: [ { requirement, category, evidence_in_cv, suggestion } ] }',
      '  - evidence_in_cv: quote the relevant CV line if any, or null',
      '  - suggestion: what to surface in the resume IF the candidate confirms they have it,',
      '    OR for real_gaps, what to emphasize instead. Never suggest fabricating.',
    ].join('\n'),
    user: `JOB DESCRIPTION:\n${job.jd.slice(0, 6000)}\n\n---\n\nCV:\n${cv}`,
    temperature: 0.2,
  });

  const gaps = prompt.gaps || [];
  if (gaps.length === 0) {
    console.log(c.green('  ✓ No significant gaps detected.\n'));
    return;
  }

  console.log('');
  console.log(c.bold('  Gap analysis:'));
  console.log(c.dim('  (These are JD requirements your CV doesn\'t clearly show. You decide what\'s real.)'));
  console.log('');
  for (const g of gaps) {
    const icon = g.category === 'real_gap' ? c.red('●') :
                 g.category === 'learnable_quickly' ? c.yellow('●') :
                 c.dim('●');
    const label = g.category === 'real_gap' ? c.red('real gap') :
                  g.category === 'learnable_quickly' ? c.yellow('learnable') :
                  c.dim('probably have it');
    console.log(`  ${icon} ${c.bold(g.requirement)}  ${c.dim(`[${label}${c.dim(']')}`)}`);
    if (g.evidence_in_cv) console.log(c.dim(`      CV evidence: ${truncate(g.evidence_in_cv, 80)}`));
    if (g.suggestion) console.log(c.dim(`      ${g.suggestion}`));
    console.log('');
  }
  console.log(c.yellow('  ⚠ Only add something to your CV if you GENUINELY have that experience.'));
  console.log(c.yellow('    Inventing experience fails background checks and (on OPT/STEM OPT) can'));
  console.log(c.yellow('    jeopardize your visa. The PDF generator only rewords what\'s already in cv.md.'));
}

// ---------------------------------------------------------------------------

function runChildScript(scriptPath, args) {
  return new Promise((resolve) => {
    const proc = spawn(process.execPath, [scriptPath, ...args], { stdio: 'inherit', env: process.env });
    proc.on('close', (code) => resolve(code || 0));
  });
}

function truncate(s, n) { s = String(s).replace(/\s+/g, ' '); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

main().catch((err) => {
  console.error(c.red(`\nFatal: ${err.message}\n`));
  if (process.env.DEBUG) console.error(err.stack);
  rl.close();
  process.exit(1);
});
