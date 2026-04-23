#!/usr/bin/env node
// scripts/tracker.mjs
// Pretty-print the tracker TSV. This is a stand-in for the Go Bubble Tea
// dashboard upstream ships — that dashboard is entirely provider-agnostic so
// you can still `cd dashboard && go build` and use the real thing if you want.

import fs from 'node:fs';
import path from 'node:path';
import { paths, c, parseArgs } from './lib/util.mjs';

const args = parseArgs();
const trackerPath = path.join(paths.data, 'tracker.tsv');

if (!fs.existsSync(trackerPath)) {
  console.error(c.yellow(`No tracker yet. Run: npm run evaluate -- <JD>`));
  process.exit(0);
}

const rows = fs.readFileSync(trackerPath, 'utf8').trim().split('\n').map((r) => r.split('\t'));
const header = rows.shift();
const minScore = parseFloat(args.flags.min || '0');
const filtered = rows
  .filter((r) => parseFloat(r[5] || '0') >= minScore)
  .sort((a, b) => parseFloat(b[5] || '0') - parseFloat(a[5] || '0'));

const widths = header.map((h, i) => Math.max(h.length, ...filtered.map((r) => (r[i] || '').length)));
const fmt = (row) => row.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ');

console.log('');
console.log(c.bold(fmt(header)));
console.log(c.dim(widths.map((w) => '─'.repeat(w)).join('  ')));
for (const r of filtered) {
  const score = parseFloat(r[5] || '0');
  const color = score >= 4.5 ? c.green : score >= 4.0 ? c.cyan : score >= 3.5 ? c.yellow : c.dim;
  console.log(color(fmt(r)));
}
console.log('');
console.log(c.dim(`  ${filtered.length}/${rows.length} shown${minScore ? ` (min score ${minScore})` : ''}`));
console.log('');
