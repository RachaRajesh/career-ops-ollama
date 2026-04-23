#!/usr/bin/env node
// scripts/scan.mjs
// Scan configured job portals (Greenhouse, Ashby, Lever, etc.) and dump
// listings into ./jds/ so you can batch-evaluate them. This is a stripped-down
// port of upstream's scan.mjs that works with Ollama for the
// "is this listing worth saving?" prefilter step.
//
// Reads templates/portals.yml (copy from portals.example.yml and edit).

import fs from 'node:fs';
import path from 'node:path';
import { paths, c, readYaml, ensureDir, slug, parseArgs } from './lib/util.mjs';

const args = parseArgs();
const portalsPath = args.flags.portals || 'portals.yml';

if (!fs.existsSync(portalsPath)) {
  console.error(c.red(`No ${portalsPath}. Copy templates/portals.example.yml to ${portalsPath} first.`));
  process.exit(1);
}

const portals = readYaml(portalsPath);
const companies = portals.companies || [];

if (companies.length === 0) {
  console.error(c.yellow(`No companies in ${portalsPath}.`));
  process.exit(0);
}

const { chromium } = await import('playwright');
const browser = await chromium.launch({ headless: true });
const outDir = args.flags.out || './jds';
ensureDir(outDir);

console.log(c.bold(`\nScanning ${companies.length} portals → ${outDir}/\n`));

let total = 0;
try {
  const page = await browser.newPage();
  for (const company of companies) {
    const name = typeof company === 'string' ? company : company.name;
    const url = typeof company === 'string' ? null : company.url;
    if (!url) { console.log(c.dim(`  skip ${name} (no url)`)); continue; }

    console.log(c.cyan(`  ${name}: ${url}`));
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);

      // Generic link-extraction — works surprisingly well on Greenhouse/Lever/Ashby
      // since they all render <a href="..."> with role titles. For proprietary
      // portals you'd add a per-host extractor.
      const jobs = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        return links
          .map((a) => ({ href: a.href, text: (a.innerText || '').trim() }))
          .filter((l) => l.text.length > 8 && l.text.length < 120)
          .filter((l) => /engineer|developer|scientist|lead|manager|architect|analyst|designer|director/i.test(l.text))
          .filter((l) => /\/jobs?\/|\/careers?\/|\/positions?\//i.test(l.href))
          .slice(0, 50);
      });

      for (const job of jobs) {
        const filename = `${slug(name)}-${slug(job.text)}.txt`;
        const outPath = path.join(outDir, filename);
        if (fs.existsSync(outPath)) continue; // skip dupes
        fs.writeFileSync(outPath, `Company: ${name}\nTitle: ${job.text}\nURL: ${job.href}\n\n(Fetch this URL and paste the JD body here, or run: npm run evaluate -- --url "${job.href}")\n`);
        total++;
      }
      console.log(c.dim(`     found ${jobs.length} listings`));
    } catch (err) {
      console.log(c.red(`     error: ${err.message}`));
    }
  }
} finally {
  await browser.close();
}

console.log('');
console.log(c.green(`✓ ${total} new job stubs saved to ${outDir}/`));
console.log(c.dim(`  Next: npm run batch -- --dir ${outDir}`));
console.log('');
