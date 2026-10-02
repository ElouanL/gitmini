import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { archiveDir, archiveMaxBytes, copyScrubbed, dirSizeBytes, writeJson, writeText } from './artifacts';

describe('artefacts', () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const d = mkdtempSync(join(tmpdir(), 'gitmini-artifacts-'));
    dirs.push(d);
    return d;
  };
  after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

  it("archiveDir produces a .tar.zst (or .tar.gz without zstd) rereadable with tar", () => {
    const base = tmp();
    const src = join(base, 'gitmini-test-1-1');
    mkdirSync(join(src, 'repo'), { recursive: true });
    writeFileSync(join(src, 'repo', 'a.txt'), 'contenu');
    const archive = archiveDir(src, join(base, 'out', 'tmpdir'));
    assert.ok(archive, "tar is required for this test");
    assert.match(basename(archive), /^tmpdir\.tar\.(zst|gz)$/);
    const flag = archive.endsWith('.zst') ? ['--zstd'] : ['-z'];
    const list = spawnSync('tar', [...flag, '-tf', archive], { encoding: 'utf8' });
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /gitmini-test-1-1\/repo\/a\.txt/);
  });

  it("dirSizeBytes stops beyond the limit; archiveMaxBytes reads GITMINI_E2E_ARCHIVE_MAX_MB", () => {
    const base = tmp();
    mkdirSync(join(base, 'a', 'b'), { recursive: true });
    writeFileSync(join(base, 'a', 'x'), Buffer.alloc(1000));
    writeFileSync(join(base, 'a', 'b', 'y'), Buffer.alloc(2000));
    assert.equal(dirSizeBytes(base), 3000);
    assert.ok(dirSizeBytes(base, 500) > 500);
    assert.equal(archiveMaxBytes({}), 40 * 1024 * 1024);
    assert.equal(archiveMaxBytes({ GITMINI_E2E_ARCHIVE_MAX_MB: '5' }), 5 * 1024 * 1024);
    assert.equal(archiveMaxBytes({ GITMINI_E2E_ARCHIVE_MAX_MB: 'x' }), 40 * 1024 * 1024);
  });

  it("writeText / writeJson / copyScrubbed remove tokens", () => {
    const base = tmp();
    writeText(join(base, 'a', 'x.log'), 'Authorization: Bearer gho_test\n');
    assert.equal(readFileSync(join(base, 'a', 'x.log'), 'utf8'), 'Authorization: Bearer gho_***\n');
    writeJson(join(base, 'c.json'), { header: 'password=ghp_AbCdEf' });
    assert.ok(!readFileSync(join(base, 'c.json'), 'utf8').includes('AbCdEf'));
    writeFileSync(join(base, 'src.log'), 'token gho_secret123');
    copyScrubbed(join(base, 'src.log'), join(base, 'dst', 'src.log'));
    assert.equal(readFileSync(join(base, 'dst', 'src.log'), 'utf8'), 'token gho_***');
    assert.ok(existsSync(join(base, 'src.log')));
  });
});
