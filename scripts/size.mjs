#!/usr/bin/env node
// Weight budget of the frontend: the JS loaded at the start must weigh less than 150 Kg zipped.
// "JS initial" = the input script of dist/index.html, its `modulepreload` and all static dependencies of these chunks.
// The chunks loaded on demand (dialogues, secondary panels, e2e test deck: `import`) do not count, but their
// total is displayed to keep a reasonable order of magnitude.
//
//   pnpm size # built and then checked (failure if exceeded)
//   node scripts/size.mjs # checks dist/ as is
//   GITMINI_SIZE_BUDGET=140000 pnpm size
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import { gzipSync } from 'node:zlib';

const BUDGET = Number(process.env.GITMINI_SIZE_BUDGET ?? 150_000); // bytes gzippedd (150 KB)
const dist = new URL('../dist/', import.meta.url).pathname;

if (!existsSync(join(dist, 'index.html'))) {
  console.error('dist/index.html introuvable : lancer `pnpm build` (ou `pnpm size`).');
  process.exit(2);
}

const html = readFileSync(join(dist, 'index.html'), 'utf8');
const gz = (file) => gzipSync(readFileSync(join(dist, file)), { level: 9 }).length;
const rel = (href) => posix.normalize(href.replace(/^\.?\//, '')); // "/assets/x.js" → "assets/x.js"

const initial = new Set();
const queue = [];
for (const m of html.matchAll(/<script[^>]*\ssrc="([^"]+\.js)"/g)) queue.push(rel(m[1]));
for (const m of html.matchAll(/<link[^>]*rel="modulepreload"[^>]*href="([^"]+\.js)"/g)) queue.push(rel(m[1]));
const initialCss = [...html.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+\.css)"/g)].map((m) => rel(m[1]));

// Static dependencies (`import … from "./x.js"`, `import"./x.js"`); a dynamic `import("./x.js")` is not one.
const STATIC_IMPORT = /(?:^|[;{}\s])(?:import|export)\s*(?:[^'"()`]*?\sfrom\s*)?["'](\.{1,2}\/[^"']+\.js)["']/g;

while (queue.length) {
  const file = queue.pop();
  if (initial.has(file) || !existsSync(join(dist, file))) continue;
  initial.add(file);
  const dir = posix.dirname(file);
  const src = readFileSync(join(dist, file), 'utf8');
  for (const m of src.matchAll(STATIC_IMPORT)) queue.push(posix.normalize(posix.join(dir, m[1])));
}

const assets = readdirSync(join(dist, 'assets'), { recursive: true })
  .map((f) => `assets/${f}`)
  .filter((f) => f.endsWith('.js'));
const lazyChunks = assets.filter((f) => !initial.has(f));

const fmt = (n) => `${(n / 1000).toFixed(1).padStart(7)} Ko`;
let total = 0;
console.log('JS initial (gzip)');
for (const f of [...initial].sort()) {
  const n = gz(f);
  total += n;
  console.log(`  ${fmt(n)}  ${f}`);
}
console.log(`  ${fmt(total)}  TOTAL  (budget ${fmt(BUDGET).trim()})`);
if (initialCss.length) console.log(`CSS initial : ${fmt(initialCss.reduce((s, f) => s + gz(f), 0)).trim()} gzipped`);

const lazyTotal = lazyChunks.reduce((s, f) => s + gz(f), 0);
console.log(`Chunks on request: ${lazyChunks.length} file(s), ${fmt(lazyTotal).trim()} gzipped`);
for (const f of lazyChunks.sort((a, b) => gz(b) - gz(a)).slice(0, 8)) console.log(`  ${fmt(gz(f))}  ${f}`);

if (total >= BUDGET) {
  console.error(`\nFAILED: initial JS weighs ${fmt(total).trim()} gzipped, budget ${fmt(BUDGET).trim()} (02 §6).`);
  console.error("Charge on request: `registerDialog(id, () => import(\"./X.svelte\"))`, secondary panels idem (src/README.md).");
  process.exit(1);
}
console.log("\nBudget respected.");
