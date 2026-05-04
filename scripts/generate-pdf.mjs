#!/usr/bin/env node
// scripts/generate-pdf.mjs
//
// Tailored CV PDF generation — resume.io-style output.
//
// What changed from the previous version:
//   1. The LLM now returns STRUCTURED JSON (name, contact, summary, experience
//      with bullets, projects, skills grouped, education, certs) instead of
//      free markdown. This kills the "literal ** and ## leaking into the PDF"
//      bug at the source.
//   2. The renderer fills a real HTML template (templates/cv-resumeio.html)
//      with proper fields, then Playwright prints it to PDF.
//   3. Tailoring rules unchanged: reword/reorder/surface what's already in
//      cv.md, never invent new experience.

import fs from 'node:fs';
import path from 'node:path';
import { chatJSON } from './lib/llm.mjs';
import {
  paths, c, parseArgs, readFileOr, readYaml, ensureDir, slug, timestamp, jobFilename,
} from './lib/util.mjs';

const args = parseArgs();

async function main() {
  const reportPath = args.flags.report;
  if (!reportPath) throw new Error('Pass --report path/to/report.md');
  if (!fs.existsSync(reportPath)) throw new Error(`Report not found: ${reportPath}`);

  const report = fs.readFileSync(reportPath, 'utf8');
  const cv = readFileOr(paths.cv);
  if (!cv) throw new Error(`No CV at ${paths.cv}`);
  const profile = readYaml(paths.profile);

  const company = (report.match(/^# (.+?) —/m)?.[1] || 'company').trim();
  // Try to extract role from report; if it's junk, fall back to the user's
  // primary desired role from profile.yml, then to a safe generic.
  let role = cleanRoleTitle((report.match(/^# .+? — (.+)$/m)?.[1] || '').trim());
  if (!role) {
    const desired = Array.isArray(profile.desired_roles) ? profile.desired_roles[0] : null;
    role = desired ? cleanRoleTitle(desired) : '';
  }
  if (!role) role = 'AI Engineer';   // last-resort default, never "unknown"

  console.log(c.cyan(`→ tailoring CV for ${company} / ${role}`));
  console.log(c.dim('  asking the model for structured resume data...'));

  const resume = await tailorResume({ cv, profile, report, targetCompany: company, targetRole: role });

  ensureDir(paths.output);
  // Allow caller to override the filename stem via --out-name flag.
  // Used by process-excel.mjs to write directly with the final
  // "{ROW}_{Name}_Resume" filename, so PDFs are immediately usable as
  // they're generated (no rename step at the end of the run).
  const stem = args.flags['out-name'] || jobFilename(company, role);

  // Save the structured JSON too — useful for debugging and for users who
  // want to manually polish the data before re-rendering.
  const jsonPath = path.join(paths.output, `${stem}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(resume, null, 2));
  console.log(c.dim(`  structured data: ${jsonPath}`));

  // Render
  const templatePath = path.join('templates', 'cv-resumeio.html');
  if (!fs.existsSync(templatePath)) {
    throw new Error(`Missing ${templatePath}. Did you copy templates/cv-resumeio.html into your project?`);
  }
  const template = fs.readFileSync(templatePath, 'utf8');
  const html = renderTemplate(template, resume);

  const htmlPath = path.join(paths.output, `${stem}.html`);
  fs.writeFileSync(htmlPath, html);

  // PDF
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdfPath = path.join(paths.output, `${stem}.pdf`);
    await page.pdf({
      path: pdfPath,
      format: 'Letter',
      printBackground: true,
      // Uniform margins on all sides since the header is now white (no full-bleed).
      // These are PER-PAGE margins, so continuation pages also get breathing room
      // from the page edges.
      margin: { top: '0.5in', bottom: '0.4in', left: '0', right: '0' },
    });
    console.log(c.green(`✓ PDF: ${pdfPath}`));
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// LLM call: ask for structured resume JSON

async function tailorResume({ cv, profile, report, targetCompany, targetRole }) {
  // ─── PASS 1: Generate the tailored resume in JSON form ────────────────
  // System prompt encodes the "honest engineer" style: short summary, sparse
  // metrics with technical context, varied verbs, no LinkedIn buzzwords.
  // Adapted from the user's plain-text spec into our JSON schema — the rules
  // apply to bullet/summary CONTENT, the schema dictates the wrapper.
  const system = [
    'You are rewriting a resume for a specific job. The output is STRUCTURED JSON.',
    'Goal: produce a resume that reads like an engineer wrote it, not a recruiting tool —',
    'while still passing ATS keyword filters.',
    '',
    '═══════════════════════════════════════════════════════════════════════════',
    'PART 1 — INTEGRITY (non-negotiable)',
    '═══════════════════════════════════════════════════════════════════════════',
    '',
    '  • NEVER invent companies, titles, dates, projects, certifications, or degrees.',
    '    Use exactly what the CV says.',
    '  • NEVER inflate years of experience, team sizes, or impact metrics.',
    '  • COMPANY-GROUNDED TECH: For each job\'s bullets, only mention technologies that',
    '    the CV says were used AT THAT specific company. The Skills section may list',
    '    any tech the CV mentions anywhere; per-job bullets stay grounded to that job.',
    '  • Never invent a number. If the CV has no metric, do NOT add one.',
    '  • ROLE TITLE: Use EXACTLY the title provided in the user message. Do not modify,',
    '    add parentheticals, or invent variations.',
    '',
    '═══════════════════════════════════════════════════════════════════════════',
    'PART 2 — PROFESSIONAL SUMMARY',
    '═══════════════════════════════════════════════════════════════════════════',
    '',
    '  • Maximum 50 words across 3 sentences. Hard cap.',
    '  • Zero percentages. Zero metrics. Zero numbers except "5 years" (or whatever',
    '    the actual years count is).',
    '  • Mention: current role, years of experience, 1-2 specialty areas, what kind',
    '    of work the candidate is focused on now.',
    '  • Sound like the candidate is talking to another engineer.',
    '',
    '═══════════════════════════════════════════════════════════════════════════',
    'PART 3 — METRICS (credibility filter)',
    '═══════════════════════════════════════════════════════════════════════════',
    '',
    '  • Default: ZERO metrics. Add a number ONLY if you can attach concrete',
    '    technical context (model name, dataset size, methodology that produced it).',
    '  • Maximum 3 metrics per role TOTAL — across all bullets in that role combined.',
    '  • DELETE suspiciously round metrics (40%, 50%, 30%, 25%, 20%) unless paired',
    '    with concrete technical context.',
    '  • DELETE metrics implying scale the role wouldn\'t realistically have. A hotel',
    '    chain does NOT process "500K events/sec" — that\'s Netflix scale. Either',
    '    replace with believable numbers or remove the metric entirely.',
    '  • When you keep a metric, give it methodology context.',
    '    BAD:  "reduced latency by 30%"',
    '    GOOD: "cut p95 latency from ~12s to ~8s on a 50K-document corpus by adding',
    '          embedding cache and reranker batching"',
    '  • Never combine two near-perfect metrics in one bullet (e.g. "98% recall AND',
    '    92% precision"). Pick one.',
    '',
    '═══════════════════════════════════════════════════════════════════════════',
    'PART 4 — BULLET STRUCTURE',
    '═══════════════════════════════════════════════════════════════════════════',
    '',
    '  • Stop the "verb + tool list + percentage" pattern. Vary it.',
    '  • Mix in bullets that describe architecture decisions, trade-offs, or',
    '    debugging — without numbers.',
    '  • Vary sentence length. Some short. Some longer with a clause that explains',
    '    WHY a decision was made.',
    '  • At least 1 bullet per role MUST describe a specific technical trade-off',
    '    or failure mode addressed. Example: "switched from pure dense retrieval',
    '    to hybrid BM25+dense after seeing recall drop on acronym-heavy queries."',
    '  • Don\'t list every tool used in every bullet. Mention tools when they',
    '    matter to the story.',
    '  • Do not start consecutive bullets with the same verb.',
    '  • 4-6 bullets per role maximum.',
    '',
    '═══════════════════════════════════════════════════════════════════════════',
    'PART 5 — SKILLS (modernize for 2026)',
    '═══════════════════════════════════════════════════════════════════════════',
    '',
    '  • REMOVE generic activity-words like "RAG Pipelines" and "Prompt Engineering"',
    '    from skills — these are activities, not skills. Replace with actual tools.',
    '  • If the CV mentions any of these, INCLUDE them: LangGraph, LlamaIndex, DSPy,',
    '    Ragas, DeepEval, Langfuse, Phoenix, Pydantic, instructor, vLLM, LiteLLM,',
    '    structured outputs, function calling, OpenAI text-embedding-3, BGE',
    '    embeddings, Cohere rerank, CrossEncoder reranking.',
    '  • Do NOT invent skills the CV doesn\'t mention.',
    '  • If the CV shows frontend work, include React, Next.js, TypeScript, Tailwind.',
    '  • Group skills by category. Suggested groups:',
    '      LLM & GenAI / ML & Data / MLOps & Cloud / Backend & APIs / Frontend / Streaming',
    '    Keep each group to one comma-separated line.',
    '',
    '═══════════════════════════════════════════════════════════════════════════',
    'PART 6 — TONE',
    '═══════════════════════════════════════════════════════════════════════════',
    '',
    '  BANNED PHRASES — do not use any:',
    '    "results-driven", "demonstrated expertise", "proven ability",',
    '    "proven track record", "cross-functional", "scalable solutions",',
    '    "end-to-end", "business-aligned", "leveraging", "spearheaded",',
    '    "robust", "seamlessly", "synergy", "passionate", "deep expertise",',
    '    "extensive experience", "strong focus on"',
    '',
    '  • It is OK for a bullet to describe work that did NOT have a measurable',
    '    improvement — real engineering includes infrastructure, refactors, and',
    '    migrations that don\'t generate clean percentages.',
    '  • Plain technical language, not marketing language.',
    '',
    '═══════════════════════════════════════════════════════════════════════════',
    'PART 7 — ATS KEYWORDS',
    '═══════════════════════════════════════════════════════════════════════════',
    '',
    '  • If a target JD context is provided in the user message, mirror its key',
    '    technical terms naturally inside the bullets — do NOT stuff them in a',
    '    separate keyword section.',
    '  • Match terminology when possible (if JD says "LLM evaluation", use that',
    '    phrase, not "model assessment"). But: don\'t repeat any single JD term',
    '    more than twice across the resume — repetition reads as AI-generated.',
    '',
    '═══════════════════════════════════════════════════════════════════════════',
    'OUTPUT — JSON ONLY, no markdown fences, no commentary',
    '═══════════════════════════════════════════════════════════════════════════',
    '',
    '  {',
    '    "name": "Full Name",',
    '    "role_target": "EXACT role title from the user message",',
    '    "contact": {',
    '      "location": "...", "email": "...", "phone": "...",',
    '      "linkedin": "...", "github": "...", "website": ""',
    '    },',
    '    "summary": "≤50 words, 3 sentences, zero metrics — see PART 2",',
    '    "experience": [',
    '      {',
    '        "title":   "Job Title (exactly as in CV)",',
    '        "company": "Company Name (exactly as in CV)",',
    '        "location": "City, State (exactly as in CV)",',
    '        "dates":   "Feb 2025 – Present (exactly as in CV)",',
    '        "bullets": ["bullet 1", "bullet 2", ...]    // 4-6 bullets, see PART 4',
    '      }',
    '    ],',
    '    "skills": [',
    '      { "label": "LLM & GenAI", "items": ["..."] },',
    '      { "label": "ML & Data",   "items": ["..."] },',
    '      { "label": "MLOps & Cloud", "items": ["..."] }',
    '      // 3-6 groups, see PART 5',
    '    ],',
    '    "education": [{ "degree": "...", "school": "...", "location": "...", "dates": "" }],',
    '    "certifications": [{ "name": "...", "issuer": "..." }]',
    '  }',
    '',
    'CRITICAL — last reminder before output:',
    '  Banned words: "leveraging", "spearheaded", "results-driven",',
    '  "cross-functional", "robust", "seamlessly". Scan your output. If any of',
    '  these appear, REWRITE THE BULLET BEFORE RETURNING JSON.',
  ].join('\n');

  const user = [
    `═══ TARGET JOB ═══`,
    `Company: ${targetCompany}`,
    `EXACT ROLE TITLE TO USE: ${targetRole}`,
    `(Put this EXACT string in role_target. Do not modify or add parentheticals.)`,
    '',
    `═══ EVALUATION REPORT (use to identify what to emphasize, not invent) ═══`,
    report,
    '',
    `═══ CANDIDATE PROFILE ═══`,
    JSON.stringify(profile, null, 2),
    '',
    `═══ CANDIDATE CV (sole source of truth for experience) ═══`,
    `(Markdown is for input only — do not preserve ** or ## in JSON output.)`,
    cv,
  ].join('\n');

  const out = await chatJSON({ system, user, temperature: 0.4 });
  const normalized = normalizeResume(out, profile, { forcedRoleTitle: targetRole });

  // ─── PASS 2: Critique-and-fix ─────────────────────────────────────────
  // Local models routinely violate global constraints (banned phrases, metric
  // limits) on the first pass. Single-pass self-checks don't actually verify
  // anything — the model just claims it checked. A SECOND call that takes the
  // first output as input and grades it against the rules catches real issues.
  // This costs one extra LLM call per resume; worth it for cleaner output.
  await critiqueAndFix(normalized, { targetCompany, targetRole, cv });

  return normalized;
}

/**
 * Second-pass critique. Takes the resume produced in pass 1, runs it against
 * the rules, and rewrites any violating bullets. This is where the "self-check"
 * actually happens — single-pass self-check is theater on local models.
 *
 * Mutates the resume in-place. If the critique fails or returns nothing usable,
 * silently no-ops (we'd rather ship the pass-1 output than crash).
 */
async function critiqueAndFix(resume, { targetCompany, targetRole, cv }) {
  // Quick pre-check: is there anything obvious to fix? If not, skip the LLM call.
  const allBulletText = (resume.experience || [])
    .flatMap((j) => j.bullets || [])
    .join(' ');
  const summary = resume.summary || '';
  const banned = /\b(results[- ]driven|demonstrated expertise|proven ability|proven track record|cross[- ]functional|scalable solutions|end[- ]to[- ]end|business[- ]aligned|leveraging|spearheaded|robust|seamlessly|synergy|passionate|deep expertise|extensive experience|strong focus on)\b/i;
  const hasBanned = banned.test(allBulletText) || banned.test(summary);
  const summaryTooLong = summary.split(/\s+/).filter(Boolean).length > 55;
  // Rough metric-density check: count digits-followed-by-% across bullets
  const tooManyMetrics = (resume.experience || []).some((j) => {
    const numericClaims = (j.bullets || []).join(' ').match(/\d+\s?%|\d+x\b|\d+\s?ms\b|p\d{2,3}\b/gi) || [];
    return numericClaims.length > 3;
  });

  if (!hasBanned && !summaryTooLong && !tooManyMetrics) {
    // First pass passed all the cheap checks; skip the expensive critique call.
    return;
  }

  const system = [
    'You are reviewing a draft resume against strict style rules and rewriting',
    'sections that violate them. Output the SAME JSON shape you receive, with',
    'violations fixed. Do not change facts, dates, companies, or schemas.',
    '',
    'RULES TO ENFORCE:',
    '  1. Banned phrases (rewrite bullets to remove these):',
    '     "leveraging", "spearheaded", "results-driven", "cross-functional",',
    '     "robust", "seamlessly", "synergy", "demonstrated expertise",',
    '     "proven ability", "proven track record", "scalable solutions",',
    '     "end-to-end", "business-aligned", "passionate", "deep expertise",',
    '     "extensive experience", "strong focus on"',
    '  2. Summary must be ≤50 words across 3 sentences with zero metrics.',
    '     If the current summary is longer, REWRITE it shorter.',
    '  3. Each role: maximum 3 metrics total. If a role has more, REMOVE the',
    '     least-defensible metrics (especially round numbers like 30%, 40%).',
    '  4. Do not invent new content. Only rewrite or remove existing content.',
    '',
    'Output ONLY valid JSON, same schema as input.',
  ].join('\n');

  const user = [
    `═══ DRAFT RESUME (rewrite violations, keep everything else) ═══`,
    JSON.stringify(resume, null, 2),
  ].join('\n');

  try {
    const fixed = await chatJSON({ system, user, temperature: 0.3 });
    if (fixed && typeof fixed === 'object') {
      // Apply only safe fields back — don't accept changes to identity/dates/schools
      if (typeof fixed.summary === 'string') resume.summary = fixed.summary;
      if (Array.isArray(fixed.experience)) {
        for (let i = 0; i < resume.experience.length && i < fixed.experience.length; i++) {
          if (Array.isArray(fixed.experience[i]?.bullets)) {
            resume.experience[i].bullets = fixed.experience[i].bullets;
          }
        }
      }
      if (Array.isArray(fixed.skills)) resume.skills = fixed.skills;
    }
  } catch {
    // Critique call failed — keep the pass-1 output. Better than crashing.
  }
}

/**
 * Defensive normalization — local LLMs sometimes return slightly different
 * shapes (skills as a flat array, experience.bullets as a string, missing
 * contact fields). This function shapes whatever came back into the canonical
 * structure the template expects, falling back to profile.yml values where
 * the model omitted things.
 */
function normalizeResume(raw, profile, opts = {}) {
  const r = raw || {};
  const contact = r.contact || {};
  // ★ Forced role title — bypasses whatever the LLM returned. This kills
  // the "AI Engineer (.NET, Claude Code)" hallucination at the source by
  // never trusting the LLM for this one specific field.
  const forcedRoleTitle = opts.forcedRoleTitle;

  // Skills: tolerate flat array or array-of-strings
  let skills = r.skills;
  if (Array.isArray(skills) && skills.length && typeof skills[0] === 'string') {
    skills = [{ label: 'Skills', items: skills }];
  }
  if (!Array.isArray(skills)) skills = [];

  // Experience: ensure bullets is always an array
  const experience = (r.experience || []).map((j) => ({
    title:    j.title || '',
    company:  j.company || '',
    location: j.location || '',
    dates:    j.dates || '',
    bullets:  Array.isArray(j.bullets) ? j.bullets : (j.bullets ? [String(j.bullets)] : []),
  }));

  return {
    name: r.name || profile.name || 'Your Name',
    role_target: forcedRoleTitle || r.role_target || (Array.isArray(profile.desired_roles) ? profile.desired_roles[0] : '') || '',
    contact: {
      location: contact.location || profile.location || '',
      email:    contact.email    || profile.email    || '',
      phone:    contact.phone    || profile.phone    || '',
      linkedin: stripProtocol(contact.linkedin || profile.linkedin || ''),
      github:   stripProtocol(contact.github   || profile.github   || ''),
      website:  stripProtocol(contact.website  || profile.website  || ''),
    },
    summary: r.summary || '',
    experience,
    projects: (r.projects || []).map((p) => ({
      name:        p.name || '',
      link:        stripProtocol(p.link || ''),
      description: p.description || '',
    })),
    skills: skills.map((s) => ({
      label: s.label || 'Skills',
      items: Array.isArray(s.items) ? s.items : [],
    })),
    education: (r.education || []).map((e) => ({
      degree:   e.degree   || '',
      school:   e.school   || '',
      location: e.location || '',
      dates:    e.dates    || '',
    })),
    certifications: (r.certifications || []).map((cert) => ({
      name:   cert.name   || '',
      issuer: cert.issuer || '',
    })),
  };
}

function stripProtocol(url) {
  return String(url || '').replace(/^https?:\/\//, '').replace(/^www\./, '');
}

/**
 * Normalize a JD role title to a short canonical form.
 *
 * Rules in priority order:
 *   1. Strip ALL parentheticals anywhere (not just trailing) — kills "(.NET, Claude Code)"
 *   2. Strip seniority prefixes (Sr./Senior/Staff/Principal/Lead/Junior/Jr./Associate)
 *   3. Strip level suffixes (II, III, IV, L5, L6, etc.)
 *   4. Strip trailing dashes/colons + descriptors ("- Healthcare GenAI", ": Backend")
 *   5. Pattern-match to one of these canonical buckets:
 *        - Software AI Engineer       (if "software" appears)
 *        - GenAI Engineer             (if "genai" / "generative ai" appears)
 *        - ML Engineer                (if "ml" / "machine learning" appears)
 *        - Data Scientist             (if "data scientist" appears)
 *        - AI Engineer                (DEFAULT for anything else AI-related)
 *
 * Examples:
 *   "Software AI Engineer (Backend, .NET)"     → "Software AI Engineer"
 *   "AI Engineer III - Healthcare GenAI"       → "AI Engineer"
 *   "Senior Machine Learning Engineer"         → "ML Engineer"
 *   "Sr. Staff GenAI Engineer (L6)"            → "GenAI Engineer"
 *   "AI Infrastructure Engineer (Remote)"      → "AI Engineer"
 *   "Data Scientist II"                        → "Data Scientist"
 */
function cleanRoleTitle(s) {
  let cleaned = String(s || '')
    .trim()
    // 1. Strip all parentheticals (anywhere, not just trailing)
    .replace(/\s*\([^)]*\)\s*/g, ' ')
    // 2. Strip square brackets too just in case
    .replace(/\s*\[[^\]]*\]\s*/g, ' ')
    // 3. Strip trailing " - description" or ": description"
    .replace(/\s*[-–:]\s+[A-Z].*$/, '')
    // 4. Strip seniority prefixes (case-insensitive)
    .replace(/^(Senior|Sr\.?|Staff|Principal|Lead|Junior|Jr\.?|Associate)\s+/i, '')
    // 5. Strip second-pass seniority (e.g. "Sr. Staff" → first removes Sr., then Staff)
    .replace(/^(Senior|Sr\.?|Staff|Principal|Lead|Junior|Jr\.?|Associate)\s+/i, '')
    // 6. Strip level suffixes — Roman numerals or L-numbers
    .replace(/\s+(I{1,3}V?|IV|V|VI|L\d+|G\d+|E\d+|\d+)\s*$/, '')
    // 7. Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();

  // ★ Reject junk values before canonical matching. When the evaluator can't
  // extract a title from a blocked page (Workday, Oracle) it returns "unknown"
  // or "role" or empty. Previously this fell through and printed as-is on the
  // resume ("UNKNOWN" uppercased by CSS). Now return empty so the caller can
  // fall back to profile.yml's desired_roles[0].
  const junkValues = /^(unknown|role|n\/?a|null|none|tbd|t\.b\.d|\?|-)$/i;
  if (!cleaned || junkValues.test(cleaned)) {
    return '';
  }

  // Now pattern-match to one of the canonical buckets.
  const lower = cleaned.toLowerCase();

  // Software AI Engineer — "software" in the title
  if (/\bsoftware\b/.test(lower) && /\b(ai|ml|machine|gen)\b/.test(lower)) {
    return 'Software AI Engineer';
  }
  // GenAI Engineer — "genai" or "generative ai"
  if (/\b(genai|generative\s*ai)\b/.test(lower)) {
    return 'GenAI Engineer';
  }
  // Data Scientist — explicit
  if (/\bdata\s*scientist\b/.test(lower)) {
    return 'Data Scientist';
  }
  // ML Engineer — "ml engineer", "machine learning engineer", etc.
  if (/\b(ml|machine\s*learning)\b/.test(lower) && /\bengineer\b/.test(lower)) {
    return 'ML Engineer';
  }
  // Default catch-all for anything mentioning AI/ML
  if (/\b(ai|ml|machine|llm|nlp)\b/.test(lower)) {
    return 'AI Engineer';
  }

  // Last resort: return the cleaned form as-is, capitalized.
  // (Hits if the JD is for something non-AI like "Backend Engineer".)
  return cleaned || 'Engineer';
}

/**
 * After the LLM returns its tailored resume, scan each job's bullets. If any
 * are too short (one-liners, < 150 chars), make a SECOND LLM call to expand
 * THOSE specific bullets to 2-3 substantive lines. The original CV is provided
 * as context so the expansion stays grounded.
 *
 * This is the "self-healing" pass — it compensates for local models that
 * understand the prompt but don't follow the length instruction reliably.
 */
/**
 * DEPRECATED — kept for reference, not currently called.
 *
 * Previously this expanded short bullets to 2-3 lines after generation. The
 * current style philosophy (per the resume rewrite spec) explicitly prefers
 * varied bullet lengths — "some short, some longer" — so forcing every short
 * bullet to be longer would undo what the main prompt is trying to achieve.
 *
 * If you want to re-enable, call from tailorResume() AFTER critiqueAndFix.
 */
async function expandShortBullets(resume, { cv, profile }) {
  const SHORT_THRESHOLD = 150;  // chars — bullets shorter than this get expanded

  for (const job of resume.experience) {
    const shortBullets = job.bullets
      .map((b, i) => ({ text: b, index: i, len: b.length }))
      .filter((b) => b.len < SHORT_THRESHOLD);

    if (shortBullets.length === 0) continue; // all bullets already long enough

    console.log(c.dim(`  expanding ${shortBullets.length} short bullet(s) for ${job.company}...`));

    try {
      const expanded = await chatJSON({
        system: [
          'You expand short resume bullets into longer, detailed 2-3 line versions.',
          '',
          'STRICT RULES:',
          '  1. Use ONLY context from the candidate\'s CV. Never invent technologies,',
          '     metrics, or accomplishments not already in the CV.',
          '  2. Each expanded bullet should be 2-3 lines (~180-280 chars), weaving:',
          '     - What was built (the action)',
          '     - How it was built (technologies, methods — must be from CV)',
          '     - Outcome or scope (only if the CV mentions it)',
          '  3. Tech mentioned must be tech the CV says was used at THIS specific company.',
          `     This job is at: ${job.company}.`,
          '  4. Do NOT change verb tense, dates, or factual claims.',
          '  5. Output ONLY JSON: { "expanded": ["bullet 1", "bullet 2", ...] }',
          '     (in same order as input)',
        ].join('\n'),
        user: [
          `═══ CANDIDATE'S FULL CV (source of truth) ═══`,
          cv,
          '',
          `═══ JOB BEING EXPANDED ═══`,
          `${job.title} at ${job.company} (${job.dates})`,
          '',
          `═══ BULLETS TO EXPAND (these are too short — make them 2-3 lines each) ═══`,
          ...shortBullets.map((b, i) => `${i + 1}. ${b.text}`),
        ].join('\n'),
        temperature: 0.4,
      });

      const expandedList = Array.isArray(expanded.expanded) ? expanded.expanded : [];
      shortBullets.forEach((sb, i) => {
        const newText = expandedList[i];
        if (newText && typeof newText === 'string' && newText.length > sb.len) {
          job.bullets[sb.index] = newText.trim();
        }
      });
    } catch (err) {
      console.log(c.yellow(`  (expansion failed for ${job.company}: ${err.message} — keeping originals)`));
    }
  }
}

// ---------------------------------------------------------------------------
// Template rendering — fills {{TOKENS}} in the HTML with real content

function renderTemplate(tpl, r) {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Contact — centered line with bullet separators between items.
  // Example: "Cleveland, OH  •  email@x.com  •  +1 555 555 5555  •  linkedin.com/in/..."
  const contactParts = [];
  if (r.contact.location) contactParts.push(esc(r.contact.location));
  if (r.contact.email)    contactParts.push(`<a href="mailto:${esc(r.contact.email)}">${esc(r.contact.email)}</a>`);
  if (r.contact.phone)    contactParts.push(esc(r.contact.phone));
  if (r.contact.linkedin) contactParts.push(`<a href="https://${esc(r.contact.linkedin)}">${esc(r.contact.linkedin)}</a>`);
  if (r.contact.github)   contactParts.push(`<a href="https://${esc(r.contact.github)}">${esc(r.contact.github)}</a>`);
  if (r.contact.website)  contactParts.push(`<a href="https://${esc(r.contact.website)}">${esc(r.contact.website)}</a>`);
  const contactInline = contactParts.join('<span class="sep">•</span>');

  // Skills — flatten the grouped buckets into a single readable paragraph,
  // formatted like the original resume.io style: "Group: items, items. Group: items."
  const skillsParagraph = r.skills.map((s) => {
    const items = s.items.join(', ');
    return `<strong>${esc(s.label)}:</strong> ${esc(items)}`;
  }).join('. &nbsp;&nbsp; ');

  // Education — degree bold, school + location + dates on subline
  const educationBlock = r.education.map((e) => {
    const schoolParts = [e.school, e.location].filter(Boolean).join(', ');
    const schoolLine = e.dates
      ? `${esc(schoolParts)} · ${esc(e.dates)}`
      : esc(schoolParts);
    return `<div class="edu-block">
      <div class="degree">${esc(e.degree)}</div>
      <div class="school">${schoolLine}</div>
    </div>`;
  }).join('\n');

  // Certifications — section omitted if there are none. Cert name + issuer inline.
  const certsSection = r.certifications.length === 0 ? '' : `
    <section>
      <h2>Certifications</h2>
      ${r.certifications.map((cert) =>
        `<div class="cert-block">
          <span class="name">${esc(cert.name)}</span>${cert.issuer ? ` <span class="issuer">— ${esc(cert.issuer)}</span>` : ''}
        </div>`
      ).join('\n')}
    </section>
  `;

  // Experience — ORG layout: dates row in small-caps gray, title row bold uppercase,
  // company in italic. Bullets render as paragraph blocks (no list markers).
  const experienceBlock = r.experience.map((j) => {
    const companyLine = [j.company, j.location].filter(Boolean).join(', ');
    return `<div class="job">
      <div class="job-header">
        ${j.dates ? `<div class="job-dates">${esc(j.dates)}</div>` : ''}
        <div class="job-title">${esc(j.title)}</div>
        ${companyLine ? `<div class="job-company">${esc(companyLine)}</div>` : ''}
      </div>
      ${j.bullets.length ? `<ul class="bullets">${j.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
    </div>`;
  }).join('\n');

  // Projects section removed — template no longer renders it.
  // GitHub link is in the contact row at the top instead, so recruiters
  // can still see code without a dedicated section eating real estate.

  return tpl
    .replaceAll('{{NAME}}', esc(r.name))
    .replaceAll('{{ROLE_TARGET}}', esc(r.role_target))
    .replaceAll('{{SUMMARY}}', esc(r.summary))
    .replaceAll('{{CONTACT_INLINE}}', contactInline)
    .replaceAll('{{SKILLS_PARAGRAPH}}', skillsParagraph)
    .replaceAll('{{EDUCATION_BLOCK}}', educationBlock)
    .replaceAll('{{CERTS_SECTION}}', certsSection)
    .replaceAll('{{EXPERIENCE_BLOCK}}', experienceBlock);
}

main().catch((err) => {
  console.error(c.red(`\nError: ${err.message}\n`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
