// scripts/lib/util.mjs
// Small utilities shared across every command.

import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import 'dotenv/config';

export const paths = {
  cv: process.env.CV_PATH || './cv.md',
  profile: process.env.PROFILE_PATH || './config/profile.yml',
  modes: process.env.MODES_DIR || './modes',
  reports: process.env.REPORTS_DIR || './reports',
  output: process.env.OUTPUT_DIR || './output',
  data: process.env.DATA_DIR || './data',
};

/** ANSI color helpers. No dependencies — the repo already has too many. */
export const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  blue: (s) => `\x1b[34m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

/**
 * Parse argv into { flags, positional }.
 * Supports --flag=value, --flag value, and bare positionals.
 */
export function parseArgs(argv = process.argv.slice(2)) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

/** Read a file if it exists, else return the fallback. */
export function readFileOr(p, fallback = '') {
  try { return fs.readFileSync(p, 'utf8'); } catch { return fallback; }
}

/** Read and parse a YAML file, or return {} if missing. */
export function readYaml(p) {
  try { return yaml.load(fs.readFileSync(p, 'utf8')) || {}; } catch { return {}; }
}

/** mkdir -p */
export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/** Slugify a string for filenames. */
export function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/** Timestamp suitable for filenames: 20260423-143012 */
export function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes()) +
    pad(d.getSeconds())
  );
}

/**
 * Fetch a URL and return readable text. Uses Playwright if available so we can
 * handle JS-rendered pages (most ATS portals are SPAs now).
 */
export async function fetchUrlText(url) {
  try {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // Give SPAs a moment to render
      await page.waitForTimeout(1500);
      const text = await page.evaluate(() => {
        // Strip scripts/styles and return visible text
        const clone = document.body.cloneNode(true);
        clone.querySelectorAll('script, style, noscript').forEach((el) => el.remove());
        return clone.innerText;
      });
      return text;
    } finally {
      await browser.close();
    }
  } catch (err) {
    // Fallback to plain fetch for environments without Playwright
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Fetch ${url}: ${res.status}`);
    return res.text();
  }
}

/**
 * Resolve a JD source — positional arg might be raw text, a file path,
 * or a URL. Returns the extracted job description text.
 */
export async function resolveJdSource({ flags, positional }) {
  if (flags.file) {
    return fs.readFileSync(flags.file, 'utf8');
  }
  if (flags.url) {
    return fetchUrlText(flags.url);
  }
  const arg = positional.join(' ').trim();
  if (!arg) {
    throw new Error('No job description provided. Pass text, --file PATH, or --url URL.');
  }
  if (/^https?:\/\//i.test(arg)) return fetchUrlText(arg);
  if (fs.existsSync(arg) && fs.statSync(arg).isFile()) {
    return fs.readFileSync(arg, 'utf8');
  }
  return arg; // raw text
}
