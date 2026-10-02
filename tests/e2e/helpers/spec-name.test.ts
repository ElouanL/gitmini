import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isLinuxOnly, listSpecFiles, parseSpec, setupFileFor } from './spec-name';

describe('parseSpec', () => {
  it("deduces the ID and fixture from the file name (13 §4.4)", () => {
    assert.deepEqual(parseSpec('/x/specs/rb-01.divergent.e2e.ts'), { id: 'RB-01', fixture: 'divergent', file: '/x/specs/rb-01.divergent.e2e.ts' });
    assert.equal(parseSpec('graph-04.perf-100k.e2e.ts').fixture, 'perf-100k');
    assert.equal(parseSpec('ui-10.sha256.e2e.ts').id, 'UI-10');
  });

  it("refuses a name that does not follow <id>.<fixture>.e2e.ts", () => {
    for (const bad of ['rb-01.e2e.ts', 'rb01.divergent.e2e.ts', 'rb-01.divergent.ts', 'RB-01.divergent.e2e.ts', 'rb-1.divergent.e2e.ts', 'rb-01.divergent.setup.ts']) {
      assert.throws(() => parseSpec(bad), /nom de spec invalide/, bad);
    }
  });

  it("perf mode : perf.e2e.ts → starting fixture perf-100k", () => {
    assert.deepEqual(parseSpec('/t/perf/perf.e2e.ts', 'perf'), { id: 'PERF', fixture: 'perf-100k', file: '/t/perf/perf.e2e.ts' });
  });
});

describe('fichiers de spec', () => {
  it("setupFileFor finds the twin setup, listSpecFiles is sorted and recursive, isLinuxOnly reads the list and @linux-only", () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitmini-specname-'));
    try {
      mkdirSync(join(dir, 'sub'));
      const a = join(dir, 'rb-01.divergent.e2e.ts');
      const b = join(dir, 'sub', 'ui-07.linear.e2e.ts');
      const c = join(dir, 'cp-01.cherry-pick.e2e.ts');
      writeFileSync(a, "it('RB-01', () => {});\n");
      writeFileSync(b, "it('UI-07', () => {});\n");
      writeFileSync(c, '// @linux-only\nit("CP-01", () => {});\n');
      writeFileSync(join(dir, 'rb-01.divergent.setup.ts'), 'export const setup = () => {};\n');
      writeFileSync(join(dir, 'notes.md'), 'x');

      assert.deepEqual(listSpecFiles(dir), [c, a, b].sort());
      assert.equal(setupFileFor(parseSpec(a)), join(dir, 'rb-01.divergent.setup.ts'));
      assert.equal(setupFileFor(parseSpec(b)), null);
      assert.equal(isLinuxOnly(a), false);
      assert.equal(isLinuxOnly(b), true); // UI-07 is in the list
      assert.equal(isLinuxOnly(c), true); // marqueur @linux-only
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
