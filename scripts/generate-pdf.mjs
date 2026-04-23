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
  paths, c, parseArgs, readFileOr, readYaml, ensureDir, slug, timestamp,
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
  const stem = `${timestamp()}-${slug(company)}-${slug(role)}`;

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
    'You tailor a candidate\'s resume for a specific job. Output STRUCTURED JSON.',
    '',
    'STRICT RULES:',
    '  1. NEVER invent companies, titles, dates, projects, skills, or certifications.',
    '     Only reword, reorder, and surface what is already in the CV.',
    '  2. NEVER inflate years of experience, team sizes, or impact metrics.',
    '  3. You MAY:',
    '     - Reword bullets to surface JD-relevant keywords already implied by the work',
    '     - Reorder bullets so the most relevant ones appear first',
    '     - Tighten verbose bullets, remove fluff',
    '     - Promote a skill into the skills list if it is clearly demonstrated by',
    '       the work history (e.g. CV mentions "Kafka pipeline" → "Kafka" can be a skill)',
    '  4. Output ONLY valid JSON matching this exact shape:',
    '',
    '  {',
    '    "name": "Full Name",',
    '    "role_target": "the role you are applying for, e.g. Senior AI Engineer",',
    '    "contact": {',
    '      "location": "City, State, Country",',
    '      "email": "you@example.com",',
    '      "phone": "+1 555 555 5555",',
    '      "linkedin": "linkedin.com/in/handle",',
    '      "github": "github.com/handle",',
    '      "website": ""           // optional, "" or null if none',
    '    },',
    '    "summary": "3-4 sentence professional summary tailored for this role",',
    '    "experience": [',
    '      {',
    '        "title":   "Job Title",',
    '        "company": "Company Name",',
    '        "location": "City, State",',
    '        "dates":   "Feb 2025 – Present",',
    '        "bullets": ["impact-led bullet 1", "bullet 2", ...]   // 3-6 per role, most relevant first',
    '      }',
    '    ],',
    '    "projects": [',
    '      { "name": "Project Name", "link": "github.com/...", "description": "1-2 sentence description" }',
    '    ],',
    '    "skills": [',
    '      { "label": "AI / ML",          "items": ["GPT-4", "LangChain", "RAG", ...] },',
    '      { "label": "MLOps & Cloud",    "items": ["AWS SageMaker", "Docker", ...] },',
    '      { "label": "Data & Streaming", "items": ["Kafka", "Spark", ...] }',
    '      // Group skills into 3-5 logical buckets. Order buckets by relevance to the JD.',
    '    ],',
    '    "education": [',
    '      { "degree": "Master\'s in CS", "school": "Kent State University", "location": "Kent, OH", "dates": "" }',
    '    ],',
    '    "certifications": [',
    '      { "name": "AWS Cloud Practitioner", "issuer": "AWS" }',
    '    ]',
    '  }',
    '',
    'Output ONLY the JSON object. No markdown fences, no commentary.',
  ].join('\n');

  const user = [
    `TARGET ROLE: ${targetRole} at ${targetCompany}`,
    '',
    `EVALUATION REPORT (use this to identify what to emphasize):`,
    report,
    '',
    `---`,
    '',
    `CANDIDATE PROFILE:`,
    JSON.stringify(profile, null, 2),
    '',
    `---`,
    '',
    `CANDIDATE CV (markdown — do not preserve markdown syntax in your output):`,
    cv,
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

  // Contact list — only render entries that have values
  const contactItems = [];
  if (r.contact.location) contactItems.push(`<li>${esc(r.contact.location)}</li>`);
  if (r.contact.email)    contactItems.push(`<li><a href="mailto:${esc(r.contact.email)}">${esc(r.contact.email)}</a></li>`);
  if (r.contact.phone)    contactItems.push(`<li>${esc(r.contact.phone)}</li>`);
  if (r.contact.linkedin) contactItems.push(`<li><a href="https://${esc(r.contact.linkedin)}">${esc(r.contact.linkedin)}</a></li>`);
  if (r.contact.github)   contactItems.push(`<li><a href="https://${esc(r.contact.github)}">${esc(r.contact.github)}</a></li>`);
  if (r.contact.website)  contactItems.push(`<li><a href="https://${esc(r.contact.website)}">${esc(r.contact.website)}</a></li>`);

  // Skills — grouped buckets in the sidebar
  const skillsBlock = r.skills.map((s) =>
    `<div class="skill-group">
      <div class="label">${esc(s.label)}</div>
      <div class="items">${esc(s.items.join(' • '))}</div>
    </div>`
  ).join('\n');

  // Education
  const educationBlock = r.education.map((e) =>
    `<div class="edu-block">
      <div class="degree">${esc(e.degree)}</div>
      <div class="school">${esc([e.school, e.location].filter(Boolean).join(' · '))}${e.dates ? ` · ${esc(e.dates)}` : ''}</div>
    </div>`
  ).join('\n');

  // Certifications — whole section omitted if there are none
  const certsSection = r.certifications.length === 0 ? '' : `
    <h2>Certifications</h2>
    ${r.certifications.map((cert) =>
      `<div class="cert-block">
        <div class="name">${esc(cert.name)}</div>
        ${cert.issuer ? `<div class="issuer">${esc(cert.issuer)}</div>` : ''}
      </div>`
    ).join('\n')}
  `;

  // Experience — main column
  const experienceBlock = r.experience.map((j) =>
    `<div class="job">
      <div class="job-header">
        <div class="job-title-block">
          <div class="job-title">${esc(j.title)}</div>
          <div class="job-company">${esc([j.company, j.location].filter(Boolean).join(' · '))}</div>
        </div>
        <div class="job-meta">${esc(j.dates)}</div>
      </div>
      ${j.bullets.length ? `<ul class="bullets">${j.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
    </div>`
  ).join('\n');

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
    .replaceAll('{{CONTACT_LIST}}', contactItems.join('\n'))
    .replaceAll('{{SKILLS_BLOCK}}', skillsBlock)
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
