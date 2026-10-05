#!/usr/bin/env node
// Source-based checks do not depend on private design documents.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const conditionalSkips = new Set([
  'tests/perf/perf.e2e.ts',
  'tests/e2e/helpers/runners.test.ts',
  'tests/e2e/selftest/specs/st-06.linear.e2e.ts',
  'tests/e2e/selftest/specs/st-07.linear.e2e.ts',
  'tests/e2e/specs/ui-12.empty.e2e.ts',
]);

export function inspectSource(file, source) {
  const violations = [];
  const add = (position, rule) => violations.push({ file, line: source.slice(0, position).split('\n').length, rule });
  for (const match of source.matchAll(/@quarantine\b([^\n]*)/g)) {
    if (!/https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/issues\/\d+|#\d+/.test(match[1])) add(match.index, 'quarantine requires an issue link');
  }
  if (file.endsWith('.rs')) {
    // Attributes are code; mentions inside prose or string examples do not count.
    for (const match of source.matchAll(/^\s*#\[\s*ignore\b([^\]]*)\]/gm)) {
      if (!/^\s*=\s*"perf:/.test(match[1])) add(match.index, 'ignored Rust test must be an explicitly invoked performance test');
    }
  } else {
    const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const walk = (node) => {
      if (ts.isCallExpression(node)) {
        const name = node.expression.getText(ast);
        if (/^(?:it|test|describe)(?:\.[\w]+)*\.only$/.test(name) || /^(?:fit|fdescribe)$/.test(name)) {
          add(node.getStart(ast), 'focused tests are forbidden');
        }
        if (/^(?:it|test|describe)(?:\.[\w]+)*\.skip$|^(?:xit|xtest|xdescribe|this\.skip|ctx\.skip|t\.skip)$/.test(name)
          && !conditionalSkips.has(file)) add(node.getStart(ast), 'skipped tests are forbidden');
      }
      ts.forEachChild(node, walk);
    };
    walk(ast);
  }
  return violations;
}

function walk(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'target', '.git', 'artifacts', 'generated'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? walk(path) : /\.(?:rs|ts|mjs)$/.test(entry.name) ? [path] : [];
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const failures = ['src', 'crates', 'src-tauri', 'tests'].flatMap((dir) => walk(join(root, dir)))
    .flatMap((file) => inspectSource(relative(root, file).replaceAll('\\', '/'), readFileSync(file, 'utf8')));
  for (const { file, line, rule } of failures) console.error(`${file}:${line}: ${rule}`);
  if (failures.length) process.exitCode = 1;
  else console.log('Test policy passed: no focused tests, undocumented skips, or untracked quarantines.');
}
