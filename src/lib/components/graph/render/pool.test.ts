import { describe, expect, it } from 'vitest';
import { layoutLabels } from '../model/labels';
import { label } from '../test-utils';
import { RowPool, bindRow, clearRow, place, setSelected, type RowDesc } from './pool';

const desc = (over: Partial<RowDesc> = {}): RowDesc => ({
  kind: 'commit', index: 3, oid: 'a'.repeat(40), stashIndex: null, summary: 'fix: crash', author: 'Alice Martin', avatar: 2, initials: 'AM', date: '2026-10-01 10:00',
  sha: 'aaaaaaa', color: 1, labels: null, wip: null, dim: false, label: 'fix: crash', shallow: false, lane: 0, ...over,
});

const q = (el: Element, id: string): Element[] => [...el.querySelectorAll(`[data-testid="${id}"]`)];

function setup(n = 5) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const pool = new RowPool(host);
  pool.grow(n);
  return { host, pool };
}

describe("row pool", () => {
  it("only grows (never deleted) and one line occupies the location r mod size", () => {
    const { host, pool } = setup(5);
    expect(pool.size).toBe(5);
    expect(pool.grow(3)).toBe(false);
    expect(pool.grow(8)).toBe(true);
    expect(host.children).toHaveLength(8);
    expect(pool.slotFor(13)).toBe(pool.slots[5]);
  });

  it("bindRow: test attributes and column text", () => {
    const { pool } = setup();
    const s = pool.slots[0]!;
    bindRow(s, desc());
    expect(s.el.getAttribute('data-testid')).toBe('graph-row');
    expect(s.el.dataset).toMatchObject({ index: '3', oid: 'a'.repeat(40), kind: 'commit', loaded: 'true', dim: 'false' });
    expect(s.el.textContent).toContain('fix: crash');
    expect(s.el.textContent).toContain('Alice Martin');
    expect(s.el.textContent).toContain('aaaaaaa');
    expect(s.avatar.textContent).toBe('AM');
    expect(s.avatar.getAttribute('data-color')).toBe('2');
  });

  it("Recycle a line does not create or remove any DOM (MutationObserver) node", async () => {
    const { host, pool } = setup(4);
    const mo = new MutationObserver(() => undefined);
    mo.observe(host, { childList: true, subtree: true });
    const l = layoutLabels([label('main', "local", true), label('origin/main', 'remote'), label('v1', 'tag'), label('x', "local")]);
    for (let i = 0; i < 40; i++) {
      const s = pool.slotFor(i);
      place(s, i);
      if (i % 3 === 0) clearRow(s);
      else bindRow(s, desc({ index: i, oid: String(i).padStart(40, '0'), summary: `commit ${i}`, labels: i % 2 ? l : null, kind: i % 5 === 0 ? 'stash' : i % 7 === 0 ? 'wip' : 'commit', shallow: i % 4 === 0 }));
      setSelected(s, i % 2 === 0);
    }
    const records = mo.takeRecords().filter((r) => r.type === 'childList');
    expect(records).toEqual([]); // textContent / appendChild / removeChild have never been used
    mo.disconnect();
  });

  it("labels: hand graph-ref-label , badge +n", () => {
    const { pool } = setup();
    const s = pool.slots[0]!;
    bindRow(s, desc({ labels: layoutLabels([label('main', "local", true), label('origin/main', 'remote'), label('v1', 'tag'), label('w', "local")]) }));
    const refs = q(s.el, 'graph-ref-label') as HTMLElement[];
    // 3 pellets (hand
    expect(refs.map((r) => r.dataset.ref)).toEqual(['refs/heads/main', 'refs/remotes/origin/main', 'refs/heads/w']);
    expect(refs.map((r) => r.dataset.refKind)).toEqual(["local", 'remote', "local"]);
    // HTML5 `draggable` never landed; data-drag-source for branches
    expect(refs.every((r) => !r.hasAttribute('draggable'))).toBe(true);
    expect(refs.map((r) => r.dataset.dragSource)).toEqual(['true', 'true', 'true']);
    expect(q(s.el, 'graph-ref-overflow')[0]).toHaveProperty('hidden', false);
    expect(q(s.el, 'graph-ref-overflow')[0]!.textContent).toBe('+1');
    expect((q(s.el, 'graph-ref-overflow')[0] as HTMLElement).title).toContain('v1');
  });

  it("a tag is not a source of drag and drop", () => {
    const { pool } = setup();
    const s = pool.slots[0]!;
    bindRow(s, desc({ labels: layoutLabels([label('v1', 'tag')]) }));
    const tag = q(s.el, 'graph-ref-label')[0] as HTMLElement;
    expect(tag.dataset).toMatchObject({ ref: 'refs/tags/v1', refKind: 'tag', dragSource: 'false' });
  });

  it("a line without a label does not expose any graph-ref-label", () => {
    const { pool } = setup();
    const s = pool.slots[0]!;
    bindRow(s, desc({ labels: layoutLabels([label('main', "local")]) }));
    expect(q(s.el, 'graph-ref-label')).toHaveLength(1);
    bindRow(s, desc({ labels: null }));
    expect(q(s.el, 'graph-ref-label')).toHaveLength(0);
  });

  it("WIP and stash : marker graph-wip-row / graph-stash-row in line graph-row", () => {
    const { pool } = setup();
    const s = pool.slots[0]!;
    bindRow(s, desc({ kind: 'wip', index: -1, oid: '', summary: '// WIP', wip: { unstaged: 2, staged: 1, conflicts: 3 } }));
    expect(s.el.dataset.kind).toBe('wip');
    expect(s.marker.getAttribute('data-testid')).toBe('graph-wip-row');
    expect(s.marker.dataset.kind).toBe('wip');
    expect(s.el.textContent).toContain('✎ 2');
    expect(s.el.textContent).toContain('+ 1');
    expect(s.el.textContent).toContain("⚠ 3 in conflict");
    bindRow(s, desc({ kind: 'stash', index: 4, oid: 'b'.repeat(40), stashIndex: 2, summary: 'stash@{2}: wip' }));
    expect(s.marker.getAttribute('data-testid')).toBe('graph-stash-row');
    expect(s.marker.dataset).toMatchObject({ stashIndex: '2', oid: 'b'.repeat(40) });
    bindRow(s, desc());
    expect(s.marker.hasAttribute('data-testid')).toBe(false);
    expect(s.marker.hidden).toBe(true);
  });

  it("Conflict-free WIP: no red badge", () => {
    const { pool } = setup();
    const s = pool.slots[0]!;
    bindRow(s, desc({ kind: 'wip', index: -1, wip: { unstaged: 1, staged: 0, conflicts: 0 } }));
    expect(s.badges.conflict.hidden).toBe(true);
  });

  it("free line: hidden and without data-testid (number of graph-row = rendered lines)", () => {
    const { host, pool } = setup(3);
    bindRow(pool.slots[0]!, desc());
    bindRow(pool.slots[1]!, desc({ index: 4 }));
    clearRow(pool.slots[2]!);
    expect(q(host, 'graph-row')).toHaveLength(2);
    expect(pool.slots[2]!.el.hidden).toBe(true);
  });

  it('squelette : ligne visible mais data-loaded=false', () => {
    const { pool } = setup();
    const s = pool.slots[0]!;
    bindRow(s, desc({ kind: 'skeleton', oid: '', summary: '', author: '' }));
    expect(s.el.dataset.loaded).toBe('false');
    expect(s.el.dataset.kind).toBe('commit');
  });

  it("root of a superficial repository: graph-shallow-marker", () => {
    const { pool } = setup();
    const s = pool.slots[0]!;
    bindRow(s, desc({ shallow: true, lane: 2 }));
    expect(s.shallow.getAttribute('data-testid')).toBe('graph-shallow-marker');
    expect(s.shallow.hidden).toBe(false);
    bindRow(s, desc());
    expect(s.shallow.hidden).toBe(true);
  });

  it("selection and position", () => {
    const { pool } = setup();
    const s = pool.slots[0]!;
    bindRow(s, desc());
    place(s, 12);
    setSelected(s, true);
    expect(s.el.style.transform).toBe('translateY(336px)');
    expect(s.el.dataset.selected).toBe('true');
    expect(s.el.getAttribute('aria-selected')).toBe('true');
    setSelected(s, false);
    expect(s.el.dataset.selected).toBe('false');
  });

  it("dim: data-dim for the opacity of commits off-line HEAD", () => {
    const { pool } = setup();
    bindRow(pool.slots[0]!, desc({ dim: true }));
    expect(pool.slots[0]!.el.dataset.dim).toBe('true');
  });
});
