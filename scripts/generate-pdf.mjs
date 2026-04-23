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
    'YOUR PRIMARY GOAL: produce a resume that looks like the candidate wrote it,',
    'not a machine-optimized keyword dump. Modern ATS systems and recruiters flag',
    'resumes that match a JD too perfectly. AIM FOR ROUGHLY 70% KEYWORD OVERLAP',
    'WITH THE JD — not 100%. A resume that hits every JD keyword reads as fake.',
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
    '      in the original CV only mention SageMaker (not AWS broadly), do NOT add',
    '      "AWS" to the UnitedHealth bullets. SageMaker is on AWS — but if the',
    '      original bullet said SageMaker, your tailored bullet should still say',
    '      SageMaker, not "AWS SageMaker" unless the original CV explicitly used',
    '      "AWS" at that job.',
    '',
    '      Example: if the JD wants "Snowflake" and the candidate\'s TCS bullets',
    '      mention Snowflake, you MAY emphasize Snowflake in TCS bullets. If the',
    '      candidate\'s Goldman Sachs bullets do NOT mention Snowflake, do NOT add',
    '      Snowflake to Goldman Sachs bullets.',
    '',
    '      The Skills section is allowed to mention any tech the CV lists anywhere.',
    '      But per-job bullets MUST stay grounded to that job\'s actual stack.',
    '',
    '  R4. KEEP THE CANDIDATE\'S ORIGINAL BULLETS as the foundation. You may:',
    '      - Reword for clarity',
    '      - Reorder so the most JD-relevant bullets come first',
    '      - Slightly tighten verbose bullets',
    '      You may NOT:',
    '      - Drop bullets unless they are clearly redundant or off-topic',
    '      - Add brand-new bullets that aren\'t in the original CV',
    '      - Combine multiple bullets into one (loses information)',
    '',
    '  R5. WRITE LIKE A HUMAN. Avoid these AI-tells:',
    '      - "Spearheaded", "Leveraged", "Architected" (in every bullet)',
    '      - Three-clause structures: "X by doing Y, resulting in Z" repeated',
    '      - Symmetric sentence lengths',
    '      - Buzzword density. ATS readers and humans both flag these.',
    '      Mix bullet lengths. Use varied verbs. Be conversational.',
    '',
    '  R6. THE ROLE TITLE IN THE HEADER must match the actual job title from the',
    '      JD/report. Do NOT make up alternate titles.',
    '',
    '  R7. THE SUMMARY should be 2-3 sentences, written as if the candidate wrote',
    '      it themselves. Do not parrot back the JD. Mention the candidate\'s',
    '      actual background and what they bring.',
    '',
    'Output ONLY valid JSON, no markdown fences, no commentary, matching this shape:',
    '',
    '  {',
    '    "name": "Full Name",',
    '    "role_target": "the actual job title from the JD",',
    '    "contact": {',
    '      "location": "City, State, Country",',
    '      "email": "you@example.com",',
    '      "phone": "+1 555 555 5555",',
    '      "linkedin": "linkedin.com/in/handle",',
    '      "github": "github.com/handle",',
    '      "website": ""',
    '    },',
    '    "summary": "2-3 sentence professional summary, conversational tone",',
    '    "experience": [',
    '      {',
    '        "title":   "Job Title (exactly as in CV)",',
    '        "company": "Company Name (exactly as in CV)",',
    '        "location": "City, State (exactly as in CV)",',
    '        "dates":   "Feb 2025 – Present (exactly as in CV)",',
    '        "bullets": ["bullet 1", "bullet 2", ...]   // KEEP all original bullets, reorder for relevance',
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
    `Role:    ${targetRole}`,
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
    `Every bullet in your output must trace back to a bullet or sentence in this CV.)`,
    '',
    cv,
    '',
    `═══ REMINDER ═══`,
    `Aim for ~70% JD-keyword overlap, not 100%. Keep technologies grounded to the company`,
    `where the CV says they were used. Write like a human, not an SEO bot.`,
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
