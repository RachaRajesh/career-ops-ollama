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
  const role    = (report.match(/^# .+? — (.+)$/m)?.[1] || 'role').trim();

  console.log(c.cyan(`→ tailoring CV for ${company} / ${role}`));
  console.log(c.dim('  asking the model for structured resume data...'));

  const resume = await tailorResume({ cv, profile, report, targetCompany: company, targetRole: role });

  ensureDir(paths.output);
  const stem = jobFilename(company, role);

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
      // Margins are zero because the template uses a full-bleed sidebar that
      // bleeds to the page edge. Internal padding is handled in CSS.
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
    });
    console.log(c.green(`✓ PDF: ${pdfPath}`));
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------------
// LLM call: ask for structured resume JSON

async function tailorResume({ cv, profile, report, targetCompany, targetRole }) {
  const system = [
    'You are tailoring a candidate\'s resume for a specific job. The output is STRUCTURED JSON.',
    '',
    '═══════════════════════════════════════════════════════════════════════════',
    'YOUR PRIMARY GOAL: produce a resume that a senior technical recruiter would',
    'shortlist on the first pass. That means:',
    '  - Long, detailed, expanded bullets (2-3 lines each, not one-liners)',
    '  - A rich, multi-sentence professional summary (6-10 sentences)',
    '  - The actual job title from the JD (NOT a fabricated one)',
    '  - Tech grounded to the company where the candidate actually used it',
    '  - ~70% JD keyword overlap, NOT 100% (perfect matches read as AI-generated)',
    '═══════════════════════════════════════════════════════════════════════════',
    '',
    'INTEGRITY RULES — violating these is a serious failure:',
    '',
    '  R1. NEVER invent companies, titles, dates, projects, certifications, or',
    '      educational degrees. Use exactly what the CV says.',
    '',
    '  R2. NEVER inflate years of experience, team sizes, or impact metrics.',
    '      If a CV bullet says "improved X by 34%", do not change it to 50%.',
    '      If a CV bullet has no number, do not invent one.',
    '',
    '  R3. ★ COMPANY-GROUNDED TECHNOLOGY RULE ★',
    '      For each job\'s bullets, you may ONLY mention technologies that the',
    '      ORIGINAL CV says were used at THAT specific company.',
    '',
    '      Example: if the JD wants "AWS" but the candidate\'s UnitedHealth bullets',
    '      in the original CV only mention SageMaker, do NOT add "AWS" to the',
    '      UnitedHealth bullets. Keep the bullet saying SageMaker.',
    '',
    '      Example: if the JD wants "Snowflake" and the candidate\'s TCS bullets',
    '      mention Snowflake, you MAY emphasize Snowflake in TCS bullets. If the',
    '      candidate\'s Goldman Sachs bullets do NOT mention Snowflake, do NOT add',
    '      Snowflake to Goldman Sachs bullets.',
    '',
    '      The Skills section is allowed to mention any tech the CV lists anywhere.',
    '      But per-job bullets MUST stay grounded to that job\'s actual stack.',
    '',
    '  R4. ★ EXPAND BULLETS — DO NOT SHORTEN THEM ★',
    '      Each bullet should be 2-3 lines of substantive content, weaving',
    '      together: what was built, how it was built (technologies, methods),',
    '      and the outcome or scope (where known from the CV). Match the depth',
    '      of the candidate\'s most detailed bullets, NOT the shortest ones.',
    '',
    '      WRONG (too short, generic):',
    '        "Built RAG pipelines using LangChain and Pinecone."',
    '',
    '      RIGHT (expanded, detailed):',
    '        "Architected and deployed production RAG pipelines using LangChain,',
    '         FAISS, Pinecone, and ChromaDB, integrating GPT-4 and LLaMA2 to',
    '         deliver knowledge-grounded responses across enterprise document',
    '         repositories with hybrid retrieval and reranking."',
    '',
    '      You may keep all the candidate\'s original bullets and EXPAND them with',
    '      adjacent context already present elsewhere in their CV. Do NOT invent',
    '      new content. Do NOT combine multiple bullets into one (it loses signal).',
    '',
    '  R5. ★ FULL PROFESSIONAL SUMMARY ★',
    '      The summary must be 6-10 sentences. Structure:',
    '        - Sentence 1: positioning (role, years, domains)',
    '        - Sentences 2-7: 2-3 expanded accomplishment statements that pull',
    '          from the candidate\'s actual experience, with technologies named',
    '        - Final sentence: cross-functional or business-impact closer',
    '      Match the depth and tone of the candidate\'s richest CV writing.',
    '      Do NOT write 2-3 generic sentences. Do NOT parrot the JD verbatim.',
    '',
    '  R6. ROLE TITLE: Use EXACTLY the role title provided in the user message',
    '      under "EXACT ROLE TITLE TO USE". Do NOT modify it. Do NOT add framework',
    '      names or technologies in parentheses. Do NOT invent variations.',
    '',
    '  R7. WRITE LIKE A HUMAN. Avoid AI-tells:',
    '      - Every bullet starting with "Spearheaded" / "Leveraged" / "Architected"',
    '      - Symmetric three-clause structures repeated bullet after bullet',
    '      - Buzzword density without specifics',
    '      Mix verb choices. Vary sentence rhythm. Let bullets breathe naturally.',
    '',
    '  R8. SELF-CHECK BEFORE OUTPUT: After drafting, mentally review:',
    '      - Does the role_target match the JD title exactly? (No fabrications)',
    '      - Are bullets 2-3 lines each, not one-liners?',
    '      - Is the summary 6+ sentences with named technologies?',
    '      - Does every per-job tech actually appear at that job in the CV?',
    '      - Would a senior recruiter shortlist this on first read?',
    '      If any answer is no, fix it before producing JSON.',
    '',
    'Output ONLY valid JSON, no markdown fences, no commentary, matching this shape:',
    '',
    '  {',
    '    "name": "Full Name",',
    '    "role_target": "EXACT role title from the JD — do not modify",',
    '    "contact": {',
    '      "location": "City, State, Country",',
    '      "email": "you@example.com",',
    '      "phone": "+1 555 555 5555",',
    '      "linkedin": "linkedin.com/in/handle",',
    '      "github": "github.com/handle",',
    '      "website": ""',
    '    },',
    '    "summary": "6-10 sentences, expanded and detailed, see R5",',
    '    "experience": [',
    '      {',
    '        "title":   "Job Title (exactly as in CV)",',
    '        "company": "Company Name (exactly as in CV)",',
    '        "location": "City, State (exactly as in CV)",',
    '        "dates":   "Feb 2025 – Present (exactly as in CV)",',
    '        "bullets": ["expanded 2-3 line bullet 1", "expanded 2-3 line bullet 2", ...]',
    '      }',
    '    ],',
    '    "projects": [',
    '      { "name": "Project Name", "link": "github.com/...", "description": "1-2 sentence description (from CV)" }',
    '    ],',
    '    "skills": [',
    '      { "label": "AI / ML",          "items": ["..."] },',
    '      { "label": "MLOps & Cloud",    "items": ["..."] },',
    '      { "label": "Data & Streaming", "items": ["..."] }',
    '      // Group into 3-5 buckets. Order buckets by JD relevance.',
    '      // Skills section may mention any tech the CV lists anywhere.',
    '      // Do NOT add a tech the CV doesn\'t mention at all.',
    '    ],',
    '    "education": [',
    '      { "degree": "...", "school": "...", "location": "...", "dates": "" }',
    '    ],',
    '    "certifications": [',
    '      { "name": "...", "issuer": "..." }',
    '    ]',
    '  }',
  ].join('\n');

  const user = [
    `═══ TARGET JOB ═══`,
    `Company: ${targetCompany}`,
    `EXACT ROLE TITLE TO USE: ${targetRole}`,
    `(Put this EXACT string in the "role_target" field. Do not modify, paraphrase,`,
    `or add parentheticals like "(Python, AWS)". Use it as-is.)`,
    '',
    `═══ EVALUATION REPORT ═══`,
    `(Use this to identify which of the candidate's existing experiences to emphasize.`,
    `DO NOT use this to invent new experiences.)`,
    '',
    report,
    '',
    `═══ CANDIDATE PROFILE ═══`,
    JSON.stringify(profile, null, 2),
    '',
    `═══ CANDIDATE CV (THIS IS THE ONLY SOURCE OF TRUTH FOR EXPERIENCE) ═══`,
    `(Markdown formatting is for input only — do not preserve ** or ## in your JSON output.`,
    `Every bullet in your output must trace back to a bullet or sentence in this CV.`,
    `EXPAND each bullet to 2-3 detailed lines using context from elsewhere in the CV.)`,
    '',
    cv,
    '',
    `═══ FINAL CHECK BEFORE OUTPUTTING JSON ═══`,
    `1. role_target = the EXACT title given above (no parentheticals, no rewrites)`,
    `2. summary = 6-10 sentences with named technologies, not 2-3 generic ones`,
    `3. Each bullet = 2-3 lines of substantive content, not one-liners`,
    `4. Per-job tech only mentions what the CV says was used at THAT company`,
    `5. ~70% JD-keyword overlap — perfect matches read as AI-generated`,
    `6. No "Spearheaded/Leveraged/Architected" stacking — vary your verbs`,
    ``,
    `If the resume doesn't pass these checks, fix it before producing JSON.`,
  ].join('\n');

  const out = await chatJSON({ system, user, temperature: 0.4 });
  return normalizeResume(out, profile);
}

/**
 * Defensive normalization — local LLMs sometimes return slightly different
 * shapes (skills as a flat array, experience.bullets as a string, missing
 * contact fields). This function shapes whatever came back into the canonical
 * structure the template expects, falling back to profile.yml values where
 * the model omitted things.
 */
function normalizeResume(raw, profile) {
  const r = raw || {};
  const contact = r.contact || {};

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
    role_target: r.role_target || (Array.isArray(profile.desired_roles) ? profile.desired_roles[0] : '') || '',
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

// ---------------------------------------------------------------------------
// Template rendering — fills {{TOKENS}} in the HTML with real content

function renderTemplate(tpl, r) {
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // Contact — single inline line (matches ORG_resume.pdf style: comma/dot separated)
  const contactParts = [];
  if (r.contact.location) contactParts.push(`<span>${esc(r.contact.location)}</span>`);
  if (r.contact.email)    contactParts.push(`<span><a href="mailto:${esc(r.contact.email)}">${esc(r.contact.email)}</a></span>`);
  if (r.contact.phone)    contactParts.push(`<span>${esc(r.contact.phone)}</span>`);
  if (r.contact.linkedin) contactParts.push(`<span><a href="https://${esc(r.contact.linkedin)}">${esc(r.contact.linkedin)}</a></span>`);
  if (r.contact.github)   contactParts.push(`<span><a href="https://${esc(r.contact.github)}">${esc(r.contact.github)}</a></span>`);
  if (r.contact.website)  contactParts.push(`<span><a href="https://${esc(r.contact.website)}">${esc(r.contact.website)}</a></span>`);
  const contactInline = contactParts.join('');

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

  // Experience — single column, title bold, company · location · dates on subline
  const experienceBlock = r.experience.map((j) => {
    const metaParts = [j.company, j.location].filter(Boolean).join(', ');
    const metaLine = j.dates
      ? `${esc(metaParts)} <span class="dates">· ${esc(j.dates)}</span>`
      : esc(metaParts);
    return `<div class="job">
      <div class="job-title">${esc(j.title)}</div>
      <div class="job-meta-line">${metaLine}</div>
      ${j.bullets.length ? `<ul class="bullets">${j.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
    </div>`;
  }).join('\n');

  // Projects — section omitted if none
  const projectsSection = r.projects.length === 0 ? '' : `
    <section>
      <h2>Projects</h2>
      ${r.projects.map((p) =>
        `<div class="project">
          <div class="project-name">${esc(p.name)}</div>
          ${p.link ? `<div class="project-link">${esc(p.link)}</div>` : ''}
          <div class="project-desc">${esc(p.description)}</div>
        </div>`
      ).join('\n')}
    </section>
  `;

  return tpl
    .replaceAll('{{NAME}}', esc(r.name))
    .replaceAll('{{ROLE_TARGET}}', esc(r.role_target))
    .replaceAll('{{SUMMARY}}', esc(r.summary))
    .replaceAll('{{CONTACT_INLINE}}', contactInline)
    .replaceAll('{{SKILLS_PARAGRAPH}}', skillsParagraph)
    .replaceAll('{{EDUCATION_BLOCK}}', educationBlock)
    .replaceAll('{{CERTS_SECTION}}', certsSection)
    .replaceAll('{{EXPERIENCE_BLOCK}}', experienceBlock)
    .replaceAll('{{PROJECTS_SECTION}}', projectsSection);
}

main().catch((err) => {
  console.error(c.red(`\nError: ${err.message}\n`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
