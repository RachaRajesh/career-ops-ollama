#!/usr/bin/env node
// scripts/evaluate.mjs
// Evaluate a single job description end-to-end:
//   1. Load CV + profile + shared context + evaluation mode prompt
//   2. Send the combined prompt to Ollama
//   3. Write a structured markdown report to reports/
//   4. Append a row to the tracker TSV
//
// This is the Ollama replacement for upstream's `/career-ops <JD>` command.

import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';
import { chat, chatJSON, getConfig, PROVIDER_NAME } from './lib/llm.mjs';
import {
  paths, c, parseArgs, readFileOr, readYaml, ensureDir, slug, timestamp, resolveJdSource,
} from './lib/util.mjs';

const args = parseArgs();

async function main() {
  console.log(c.bold('\nCareer-Ops evaluate — Ollama edition\n'));

  // 1. Gather inputs ----------------------------------------------------------
  const jd = (await resolveJdSource(args)).trim();
  if (!jd) throw new Error('Empty JD.');

  const cv = readFileOr(paths.cv);
  if (!cv) throw new Error(`No CV at ${paths.cv}. See examples/cv.example.md.`);

  const profile = readYaml(paths.profile);
  const sharedContext = readFileOr(path.join(paths.modes, '_shared.md'));
  const evalMode = readFileOr(path.join(paths.modes, 'oferta.md'));
  if (!evalMode) throw new Error(`Missing ${paths.modes}/oferta.md — the evaluation prompt.`);

  const llmConfig = await getConfig();
  console.log(c.dim(`  provider: ${PROVIDER_NAME}`));
  console.log(c.dim(`  model:    ${llmConfig.MODEL}`));
  console.log(c.dim(`  JD size: ${jd.length} chars`));
  console.log(c.dim(`  CV size: ${cv.length} chars`));
  console.log('');

  // 2. Extract structured metadata first (company, role, etc.) ---------------
  console.log(c.cyan('→ extracting metadata'));
  const meta = await extractMetadata(jd);
  console.log(c.dim(`  company: ${meta.company || '(unknown)'}`));
  console.log(c.dim(`  role:    ${meta.role || '(unknown)'}`));
  console.log('');

  // 3. Full evaluation --------------------------------------------------------
  console.log(c.cyan('→ running evaluation (this may take a minute)'));
  const t0 = Date.now();
  const report = await runEvaluation({ jd, cv, profile, sharedContext, evalMode, meta });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(c.dim(`  completed in ${elapsed}s`));
  console.log('');

  // 4. Persist ---------------------------------------------------------------
  ensureDir(paths.reports);
  const reportName = `${timestamp()}-${slug(meta.company || 'unknown')}-${slug(meta.role || 'role')}.md`;
  const reportPath = path.join(paths.reports, reportName);
  fs.writeFileSync(reportPath, formatReport({ meta, report, jd }));
  console.log(c.green(`✓ report: ${reportPath}`));

  appendTracker({ meta, report, reportPath });
  console.log(c.green(`✓ tracker updated: ${path.join(paths.data, 'tracker.tsv')}`));

  // 5. Summary for the human -------------------------------------------------
  const score = report.overall_score;
  const verdict =
    score >= 4.5 ? c.green('APPLY — strong fit') :
    score >= 4.0 ? c.green('APPLY — good fit') :
    score >= 3.5 ? c.yellow('MAYBE — borderline, read the report') :
    c.red('SKIP — below the cutoff');
  console.log('');
  console.log(c.bold(`  Score: ${score}/5   ${verdict}`));
  console.log('');
}

// ---------------------------------------------------------------------------

async function extractMetadata(jd) {
  const sys = `You extract job posting metadata. Return ONLY valid JSON, no prose.
Fields: company, role, location, remote ("yes"|"no"|"hybrid"|"unknown"), comp_band (string or null), posted_date (string or null).`;
  const out = await chatJSON({
    system: sys,
    user: `Extract from this JD:\n\n${jd.slice(0, 4000)}`,
    temperature: 0,
  });
  return {
    company: out.company || 'unknown',
    role: out.role || 'unknown',
    location: out.location || 'unknown',
    remote: out.remote || 'unknown',
    comp_band: out.comp_band || null,
    posted_date: out.posted_date || null,
  };
}

async function runEvaluation({ jd, cv, profile, sharedContext, evalMode, meta }) {
  // Compose the full prompt the way upstream's modes/oferta.md expects it.
  // The mode file is the system prompt; CV + profile + JD go into the user message.
  const system = [
    sharedContext,
    '',
    '---',
    '',
    evalMode,
    '',
    '---',
    '',
    'Return a JSON object with EXACTLY these keys:',
    '  archetype            (string) — e.g. "LLMOps", "Agentic", "PM", "SA", "FDE", "Transformation"',
    '  overall_score        (number 1.0 to 5.0)',
    '  role_summary         (string, 3–5 sentences)',
    '  cv_match             (object: {strengths: string[], gaps: string[], score: number})',
    '  level_strategy       (string) — how to position yourself vs the level bar',
    '  comp_research        (string) — expected comp range + reasoning',
    '  personalization      (string) — 3 bullet hooks for a cover letter / outreach',
    '  interview_prep       (object: {star_stories: string[], likely_questions: string[]})',
    '  recommendation       (string: "apply" | "maybe" | "skip")',
    '  recommendation_reason(string, 2–3 sentences)',
    '',
    'Output ONLY the JSON object. No markdown fences, no commentary before or after.',
  ].join('\n');

  const user = [
    `CANDIDATE PROFILE:\n${JSON.stringify(profile, null, 2)}`,
    '',
    `CANDIDATE CV (markdown):\n${cv}`,
    '',
    `JOB DESCRIPTION (company=${meta.company}, role=${meta.role}):\n${jd}`,
  ].join('\n');

  return chatJSON({ system, user, temperature: 0.3 });
}

function formatReport({ meta, report, jd }) {
  const r = report;
  const list = (arr) => (arr || []).map((x) => `- ${x}`).join('\n') || '- (none)';
  return `# ${meta.company} — ${meta.role}

**Score:** ${r.overall_score} / 5
**Archetype:** ${r.archetype}
**Recommendation:** ${String(r.recommendation || '').toUpperCase()} — ${r.recommendation_reason || ''}
**Location:** ${meta.location}${meta.remote && meta.remote !== 'unknown' ? ` (${meta.remote})` : ''}
${meta.comp_band ? `**Comp band (posted):** ${meta.comp_band}\n` : ''}
---

## Role summary

${r.role_summary}

## CV match (score: ${r.cv_match?.score ?? 'n/a'})

**Strengths**
${list(r.cv_match?.strengths)}

**Gaps**
${list(r.cv_match?.gaps)}

## Level strategy

${r.level_strategy}

## Compensation research

${r.comp_research}

## Personalization hooks

${r.personalization}

## Interview prep

**STAR+R stories to prepare**
${list(r.interview_prep?.star_stories)}

**Likely questions**
${list(r.interview_prep?.likely_questions)}

---

<details><summary>Original JD</summary>

\`\`\`
${jd}
\`\`\`

</details>
`;
}

function appendTracker({ meta, report, reportPath }) {
  ensureDir(paths.data);
  const trackerPath = path.join(paths.data, 'tracker.tsv');
  const header = ['date', 'company', 'role', 'location', 'remote', 'score', 'archetype', 'recommendation', 'status', 'report'].join('\t');
  if (!fs.existsSync(trackerPath)) {
    fs.writeFileSync(trackerPath, header + '\n');
  }
  const row = [
    new Date().toISOString().slice(0, 10),
    meta.company,
    meta.role,
    meta.location,
    meta.remote,
    report.overall_score,
    report.archetype,
    report.recommendation,
    'evaluated',
    path.relative(process.cwd(), reportPath),
  ].map((v) => String(v ?? '').replace(/\t/g, ' ')).join('\t');
  fs.appendFileSync(trackerPath, row + '\n');
}

main().catch((err) => {
  console.error(c.red(`\nError: ${err.message}\n`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
