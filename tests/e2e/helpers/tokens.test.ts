import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { hasToken, scanDirForTokens, scrub } from './tokens';

describe('filtre de tokens (13 §9.3)', () => {
  it("scrub replaces any gh[opsu]_... by keeping the prefix", () => {
    assert.equal(scrub("Authorization: Bearer gho_test and ghp_AbC123 ghs_x ghu_y"), "Authorization: Bearer gho_*** and ghp_*** ghs_*** ghu_***");
    assert.equal(scrub("nothing to see: ghost_writer, gh_pages, github"), "nothing to see: ghost_writer, gh_pages, github");
    assert.equal(hasToken('x gho_test y'), true);
    assert.equal(hasToken('x gho_ y'), false);
  });

  it("scanDirForTokens finds a token in a file, without ever rewriting it, and ignores objects/", () => {
    const dir = mkdtempSync(join(tmpdir(), 'gitmini-tokens-'));
    try {
      mkdirSync(join(dir, 'a', 'objects'), { recursive: true });
      writeFileSync(join(dir, 'a', 'clean.log'), 'rien\n');
      writeFileSync(join(dir, 'a', 'objects', 'pack'), 'gho_test'); // zlib in a real repository: ignored
      assert.deepEqual(scanDirForTokens(dir), []);
      writeFileSync(join(dir, 'a', 'config'), '[credential]\n\thelper = gho_test\n');
      const hits = scanDirForTokens(dir);
      assert.equal(hits.length, 1);
      assert.equal(hits[0]?.file, join(dir, 'a', 'config'));
      assert.equal(hits[0]?.prefix, 'gho_');
      assert.ok(!JSON.stringify(hits).includes('gho_test'));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
