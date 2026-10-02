import { describe, expect, it } from 'vitest';
import { label } from '../test-utils';
import { layoutLabels, remoteShortName } from './labels';

describe("labels of refs", () => {
  it("local branch + remote of the same name merged: hand origin", () => {
    const l = layoutLabels([label('main', "local", true), label('origin/main', 'remote')]);
    expect(l.shown).toHaveLength(1);
    const pill = l.shown[0]!;
    expect(pill.merged).toBe(true);
    expect(pill.isHead).toBe(true);
    expect(pill.parts.map((p) => p.text)).toEqual(['main', 'origin']);
    // the two halves remain separate drag and drop targets
    expect(pill.parts.map((p) => p.ref)).toEqual(['refs/heads/main', 'refs/remotes/origin/main']);
    expect(pill.parts.every((p) => p.branch)).toBe(true);
  });

  it("the remote is not merged if the upstream is another branch", () => {
    const l = layoutLabels([label('feature', "local"), label('origin/main', 'remote')], (n) => (n === 'feature' ? 'origin/feature' : null));
    expect(l.shown.map((p) => p.merged)).toEqual([false, false]);
  });

  it("a known upstream merges even under another name", () => {
    const l = layoutLabels([label('work', "local"), label('origin/main', 'remote')], (n) => (n === 'work' ? 'origin/main' : null));
    expect(l.shown).toHaveLength(1);
    expect(l.shown[0]!.merged).toBe(true);
  });

  it("one slash branch is not merged with the remote of another interlocked remote", () => {
    const l = layoutLabels([label('x', "local"), label('origin/feat/x', 'remote')]);
    expect(l.shown).toHaveLength(2);
  });

  it("HEAD detached, branch running first, then local, remote, tags", () => {
    const l = layoutLabels([label('v1', 'tag'), label('origin/dev', 'remote'), label('dev', "local"), label('HEAD', 'head', true), label('main', "local", true)]);
    expect(l.shown.map((p) => p.parts[0]!.text)).toEqual(["HEAD (detached)", 'main']);
    expect(l.hidden).toBe(2);
    expect(l.tooltip.split('\n')).toEqual(["HEAD → HEAD (detached)", 'HEAD → main', 'dev ⇅ origin', 'v1']);
  });

  it("beyond 2 labels: +n badge and complete list in infobulle", () => {
    const l = layoutLabels([label('a', "local"), label('b', "local"), label('c', "local"), label('v1', 'tag')]);
    expect(l.shown).toHaveLength(2);
    expect(l.hidden).toBe(2);
    expect(l.tooltip).toBe('a\nb\nc\nv1');
  });

  it("tags are neither source nor target; origin/HEAD is hidden", () => {
    const l = layoutLabels([label('v1', 'tag'), label('origin/HEAD', 'remote')]);
    expect(l.shown).toHaveLength(1);
    expect(l.shown[0]!.parts[0]!.branch).toBe(false);
  });

  it('remoteShortName', () => {
    expect(remoteShortName('refs/remotes/origin/main')).toBe('origin/main');
  });
});
