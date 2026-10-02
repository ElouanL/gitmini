// Pool of lines DOM of the graph: `ceil(height / 28) + 20` elements `graph-row` recycled by `transform: translateY`.
// no node is not created or deleted during the scroll: each line carriages all the elements it may have from the moment it is created
// need (2 fusionable refs labels, badge "+n", author tablet, WIP counters...), alternately masked by
// the `hidden` attribute; the text is updated by `Text.data` (never `textContent`, which recreates a node).
// that when the viewport is enlarged.
import type { LabelLayout, Pill, PillPart } from '../model/labels';
import { t } from '$i18n/index';
import { ROW_H, laneX } from '../model/geometry';

let idSeq = 0;
const SVG_NS = 'http://www.w3.org/2000/svg';
const TAG_PATH = 'M3 12V4h8l10 10-8 8z M7.5 8.5h.01';

export interface RowDesc {
  kind: 'wip' | 'commit' | 'stash' | 'skeleton';
  /** Real rang (−1 for WIP). */
  index: number;
  oid: string;
  stashIndex: number | null;
  summary: string;
  author: string;
  /** Tablets: 0.7 (basket of lans) and initials. */
  avatar: number;
  initials: string;
  date: string;
  sha: string;
  /** Lane colour of the line (local branch labels). */
  color: number;
  labels: LabelLayout | null;
  /** WIP line meters. */
  wip: { unstaged: number; staged: number; conflicts: number } | null;
  /** Off line HEAD (opacity 0.75 if `graph.dimUnreachable`). */
  dim: boolean;
  /** Accessible text of the line. */
  label: string;
  /** Root of a superficial repository (shallow): `⋯` under the node (`graph-shallow-marker`), in the `lane` lane. */
  shallow: boolean;
  lane: number;
}

interface PartEl {
  el: HTMLSpanElement;
  icon: SVGSVGElement;
  text: Text;
  /** Last `fullRef` writes (avoids unnecessary attribute writings). */
  ref: string;
}

interface PillEl {
  root: HTMLSpanElement;
  parts: [PartEl, PartEl];
  sep: HTMLSpanElement;
}

export interface Slot {
  el: HTMLDivElement;
  /** Message (infobulle: the complete subject when the column truncates it). */
  msgEl: HTMLSpanElement;
  /** Virtual line represented (−1 = free) and revision of written data. */
  vrow: number;
  rev: number;
  selected: boolean;
  /** Oid / current content index (selection, overview, tests). */
  oid: string;
  index: number;
  kind: RowDesc['kind'] | '';
  pills: [PillEl, PillEl];
  overflow: HTMLSpanElement;
  overflowText: Text;
  msg: Text;
  badges: { box: HTMLSpanElement; unstaged: Text; staged: Text; conflict: HTMLSpanElement; conflictText: Text };
  avatar: HTMLSpanElement;
  avatarText: Text;
  author: Text;
  date: Text;
  sha: Text;
  marker: HTMLDivElement;
  shallow: HTMLSpanElement;
}

const setText = (t: Text, s: string): void => {
  if (t.data !== s) t.data = s;
};

function setAttr(el: Element, name: string, value: string): void {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function el<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  e.className = cls;
  return e;
}

function makePart(doc: Document): PartEl {
  const span = el(doc, 'span', 'gr-ref');
  const icon = doc.createElementNS(SVG_NS, 'svg');
  icon.setAttribute('viewBox', '0 0 24 24');
  icon.setAttribute('class', 'gr-ref-icon');
  icon.setAttribute('aria-hidden', 'true');
  const path = doc.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', TAG_PATH);
  icon.appendChild(path);
  const text = doc.createTextNode('');
  span.append(icon, text);
  span.hidden = true;
  return { el: span, icon, text, ref: '' };
}

function makePill(doc: Document): PillEl {
  const root = el(doc, 'span', 'gr-pill');
  const a = makePart(doc);
  const sep = el(doc, 'span', 'gr-pill-sep');
  sep.textContent = '⇅'; // created once: creating the pool is not a scroll mutation
  sep.hidden = true;
  const b = makePart(doc);
  root.append(a.el, sep, b.el);
  root.hidden = true;
  return { root, parts: [a, b], sep };
}

export function createSlot(doc: Document): Slot {
  const row = el(doc, 'div', 'gr-row');
  row.setAttribute('role', 'option');
  row.id = `gr-row-${idSeq++}`; // target of aria-activedescendant (focus remains on viewport)
  row.hidden = true;

  const refs = el(doc, 'div', 'gr-c gr-c-refs');
  const pills: [PillEl, PillEl] = [makePill(doc), makePill(doc)];
  const overflow = el(doc, 'span', 'gr-overflow');
  overflow.setAttribute('data-testid', 'graph-ref-overflow');
  const overflowText = doc.createTextNode('');
  overflow.appendChild(overflowText);
  overflow.hidden = true;
  refs.append(pills[0].root, pills[1].root, overflow);

  const lanes = el(doc, 'div', 'gr-c gr-c-graph');
  const shallow = el(doc, 'span', 'gr-shallow');
  shallow.textContent = '⋯';
  shallow.hidden = true;
  lanes.appendChild(shallow);

  const msgCell = el(doc, 'div', 'gr-c gr-c-msg');
  const msgSpan = el(doc, 'span', 'gr-msg');
  const msg = doc.createTextNode('');
  msgSpan.appendChild(msg);
  const bbox = el(doc, 'span', 'gr-badges');
  const unstaged = el(doc, 'span', 'gr-badge');
  const unstagedText = doc.createTextNode('');
  unstaged.appendChild(unstagedText);
  const staged = el(doc, 'span', 'gr-badge');
  const stagedText = doc.createTextNode('');
  staged.appendChild(stagedText);
  const conflict = el(doc, 'span', 'gr-badge gr-badge-danger');
  const conflictText = doc.createTextNode('');
  conflict.appendChild(conflictText);
  conflict.hidden = true;
  bbox.append(unstaged, staged, conflict);
  bbox.hidden = true;
  msgCell.append(msgSpan, bbox);

  const authorCell = el(doc, 'div', 'gr-c gr-c-author');
  const avatar = el(doc, 'span', 'gr-avatar');
  const avatarText = doc.createTextNode('');
  avatar.appendChild(avatarText);
  const authorSpan = el(doc, 'span', 'gr-author');
  const author = doc.createTextNode('');
  authorSpan.appendChild(author);
  authorCell.append(avatar, authorSpan);

  const dateCell = el(doc, 'div', 'gr-c gr-c-date');
  const date = doc.createTextNode('');
  dateCell.appendChild(date);
  const shaCell = el(doc, 'div', 'gr-c gr-c-sha');
  const sha = doc.createTextNode('');
  shaCell.appendChild(sha);

  // Cover the line WIP / stash: door `graph-wip-row` / `graph-stash-row` (04) and receive the clicks.
  const marker = el(doc, 'div', 'gr-marker');
  marker.hidden = true;

  row.append(refs, lanes, msgCell, authorCell, dateCell, shaCell, marker);
  return {
    el: row, msgEl: msgSpan, vrow: -1, rev: -1, selected: false, oid: '', index: -2, kind: '', pills, overflow, overflowText, msg,
    badges: { box: bbox, unstaged: unstagedText, staged: stagedText, conflict, conflictText }, avatar, avatarText, author, date, sha, marker, shallow,
  };
}

function bindPart(part: PartEl, p: PillPart | null, color: number): void {
  if (!p) {
    part.el.hidden = true;
    if (part.ref !== '') {
      part.el.removeAttribute('data-testid');
      part.ref = '';
    }
    return;
  }
  part.el.hidden = false;
  if (part.ref !== p.ref) {
    part.ref = p.ref;
    setAttr(part.el, 'data-testid', 'graph-ref-label');
    setAttr(part.el, 'data-ref', p.ref);
  }
  setAttr(part.el, 'data-ref-kind', p.kind);
  setAttr(part.el, 'data-color', String(color));
  setAttr(part.el, 'data-head', p.isHead ? 'true' : 'false');
  // `data-drag-source` replaces the attribute HTML5 `draggable` (spec 04): celui-ci would trigger the API Drag and Drop native,
  // which cancels Pointer Events and WebDriver does not drive . See dnd-controller.ts.
  setAttr(part.el, 'data-drag-source', p.branch ? 'true' : 'false');
  part.icon.style.display = p.kind === 'tag' ? '' : 'none';
  setText(part.text, p.text);
}

function bindPill(pill: PillEl, p: Pill | null, color: number): void {
  if (!p) {
    pill.root.hidden = true;
    bindPart(pill.parts[0], null, color);
    bindPart(pill.parts[1], null, color);
    return;
  }
  pill.root.hidden = false;
  setAttr(pill.root, 'data-merged', p.merged ? 'true' : 'false');
  setAttr(pill.root, 'data-head', p.isHead ? 'true' : 'false');
  bindPart(pill.parts[0], p.parts[0] ?? null, color);
  pill.sep.hidden = !p.merged;
  bindPart(pill.parts[1], p.merged ? (p.parts[1] ?? null) : null, color);
}

/** Writes the content of a line (except the position and the status of selection). */
export function bindRow(s: Slot, d: RowDesc): void {
  const row = s.el;
  row.hidden = false;
  s.kind = d.kind;
  s.oid = d.oid;
  s.index = d.index;
  setAttr(row, 'data-testid', 'graph-row');
  setAttr(row, 'data-index', String(d.index));
  setAttr(row, 'data-oid', d.oid);
  setAttr(row, 'data-kind', d.kind === 'skeleton' ? 'commit' : d.kind);
  setAttr(row, 'data-loaded', d.kind === 'skeleton' ? 'false' : 'true');
  setAttr(row, 'data-dim', d.dim ? 'true' : 'false');
  setAttr(row, 'aria-label', d.label);

  // Marqueur WIP / stash.
  if (d.kind === 'wip') {
    s.marker.hidden = false;
    setAttr(s.marker, 'data-testid', 'graph-wip-row');
    setAttr(s.marker, 'data-kind', 'wip');
    s.marker.removeAttribute('data-stash-index');
    s.marker.removeAttribute('data-oid');
  } else if (d.kind === 'stash') {
    s.marker.hidden = false;
    setAttr(s.marker, 'data-testid', 'graph-stash-row');
    setAttr(s.marker, 'data-stash-index', String(d.stashIndex ?? 0));
    setAttr(s.marker, 'data-oid', d.oid);
    s.marker.removeAttribute('data-kind');
  } else {
    s.marker.hidden = true;
    s.marker.removeAttribute('data-testid');
    s.marker.removeAttribute('data-stash-index');
    s.marker.removeAttribute('data-oid');
    s.marker.removeAttribute('data-kind');
  }

  // Tags of refs.
  const color = d.color & 7;
  const l = d.labels;
  bindPill(s.pills[0], l?.shown[0] ?? null, color);
  bindPill(s.pills[1], l?.shown[1] ?? null, color);
  if (l && l.hidden > 0) {
    s.overflow.hidden = false;
    setText(s.overflowText, `+${l.hidden}`);
    setAttr(s.overflow, 'title', l.tooltip);
  } else s.overflow.hidden = true;

  // Root of a superficial repository.
  if (d.shallow) {
    s.shallow.hidden = false;
    setAttr(s.shallow, 'data-testid', 'graph-shallow-marker');
    setAttr(s.shallow, 'data-oid', d.oid);
    s.shallow.style.left = `${laneX(d.lane) - 4}px`;
  } else {
    s.shallow.hidden = true;
    s.shallow.removeAttribute('data-testid');
  }

  // Text columns.
  setText(s.msg, d.summary);
  setAttr(s.msgEl, 'title', d.summary);
  if (d.wip) {
    s.badges.box.hidden = false;
    setText(s.badges.unstaged, `✎ ${d.wip.unstaged}`);
    setText(s.badges.staged, `+ ${d.wip.staged}`);
    s.badges.conflict.hidden = d.wip.conflicts === 0;
    setText(s.badges.conflictText, d.wip.conflicts > 0 ? t('graph.wip.conflicts', { n: d.wip.conflicts }) : '');
  } else s.badges.box.hidden = true;
  setText(s.author, d.author);
  s.avatar.hidden = d.author === '';
  setText(s.avatarText, d.initials);
  setAttr(s.avatar, 'data-color', String(d.avatar));
  setText(s.date, d.date);
  setText(s.sha, d.sha);
}

/** Release the line (no data to display): hidden, no more test ID (pool keeps its knots). */
export function clearRow(s: Slot): void {
  s.el.hidden = true;
  s.el.removeAttribute('data-testid');
  s.kind = '';
  s.oid = '';
  s.index = -2;
  s.marker.removeAttribute('data-testid');
  s.shallow.removeAttribute('data-testid');
  s.shallow.hidden = true;
  for (const pill of s.pills) {
    for (const part of pill.parts) part.el.removeAttribute('data-testid');
  }
  s.overflow.hidden = true;
  for (const pill of s.pills) pill.parts.forEach((p) => (p.ref = ''));
}

export function setSelected(s: Slot, selected: boolean): void {
  s.selected = selected;
  setAttr(s.el, 'data-selected', selected ? 'true' : 'false');
  setAttr(s.el, 'aria-selected', selected ? 'true' : 'false');
}

export function place(s: Slot, vrow: number): void {
  s.vrow = vrow;
  s.el.style.transform = `translateY(${vrow * ROW_H}px)`;
}

export class RowPool {
  readonly slots: Slot[] = [];
  readonly #doc: Document;
  readonly #host: HTMLElement;

  constructor(host: HTMLElement) {
    this.#host = host;
    this.#doc = host.ownerDocument;
  }

  get size(): number {
    return this.slots.length;
  }

  /** Expands the pool to `n` locations (viewport resize only: never during scrolling). */
  grow(n: number): boolean {
    if (n <= this.slots.length) return false;
    const frag = this.#doc.createDocumentFragment();
    while (this.slots.length < n) {
      const s = createSlot(this.#doc);
      this.slots.push(s);
      frag.appendChild(s.el);
    }
    this.#host.appendChild(frag);
    return true;
  }

  /** Location of the `vrow` virtual line (`vrow mod taille` bijection). */
  slotFor(vrow: number): Slot {
    return this.slots[vrow % this.slots.length]!;
  }
}
