// Canvas graph helpers via the `window.__gitmini` test deck: line rectangles and refs, click on the
// Canvas, drag and drop ref → ref by Pointer Events.
//
//   const from = await refCenter('feature');
//   await dragPointer(from, await refCenter('main'));        // pointerdown → pointermove × n → pointerup
//   await click('graph-drop-menu-item-rebase');
//
// The Canvas contains no DOM elements per line: the only way to click a commit or label is to convert
// its position in contact with the viewport (`rowRect` / `refRect`, included scroll) and then send the entry via WebDriver.
//
// // The drag and drop app uses Pointer Events, never the API HTML5 Drag and Drop.
// with actions W3C `pointer` (`browser.performActions`): pointerMove → pointerDown → N × pointerMove → pointerUp.
//  - Chrome / chromedriver (local browser mode, `wdio.web.conf.ts`): shares are issued by DevTools
//    (`Input.dispatchMouseEvent`) ; the browser produces real `pointerdown` / `pointermove` / `pointerup`
//    (`pointerType: 'mouse'`, `buttons: 1` during slippage). Verified by self-test of harness
//    (tests/e2e/seftest, ST-02 scenario): down, 8 moves, up, `setPointerCapture`, Escape in motion.
//  - msedgedriver (Windows, WebView2): same Chromium engine, same path; identical expected behavior, to be confirmed by
//    the criterion of M0 (12) on `windows-2022`.
//  - WebKitWebDriver (Linux, WebKitGTK): Pointer actions are supported, but WebKit converts them to
//    mouse events then Pointer Events. Only one `pointerMove` action "sauted" does not always cross the threefold of
//    Starting the slide: TOUJOURS is cut to `steps` (8 default) steps of `stepMs`
//    (16 ms). A `draggable="true"` element would trigger a native drag that swallows events: this is the reason for
//    the prohibition of HTML5 DnD. Not verifiable under macOS: to be validated at the M0 criterion (12) under Xvfb.
//  - Fold: `GITMINI_DRAG_MODE=synthetic` (or `{ mode: 'synthetic' }`) sends the same events from the page by
//    `dispatchEvent` (`isTrusted: false`, no actual pointer capture: `setPointerCapture` is refused by the
//    (This is no longer a test of how to use the browser for an inactive pointer).
//    the actual entrance.

// `browser` is the overall injection by WebdriverIO (see ui.ts).
import { Key, MOD } from './ui';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Point {
  x: number;
  y: number;
}

export interface GitminiGraphBridge {
  rowOf(oid: string): number;
  rowRect(oid: string): Rect;
  refRect(refName: string): Rect;
  visibleRange(): { first: number; last: number };
  lanesOf(oid: string): { lane: number; color: number };
}

export type EventName = 'repo:changed' | 'op:progress' | 'op:state';

const POINTER_ID = 'gitmini-mouse';
const KEYBOARD_ID = 'gitmini-keyboard';

//
// Reading the graph (window._gitmini.graph)
//

/** Call `window.__gitmini.graph[method](...args)` in the page. `DOMRect` are flattened (not serializable everywhere). */
async function graphCall<T>(method: keyof GitminiGraphBridge, ...args: string[]): Promise<T> {
  const outcome = await browser.execute(
    (name: string, params: string[]) => {
      const bridge = (window as unknown as { __gitmini?: { graph?: Record<string, (...a: string[]) => unknown> } }).__gitmini;
      if (!bridge?.graph) return { error: "window.__gitmini.graph absent: building e2e required, graph not mounted?" };
      const fn = bridge.graph[name];
      if (typeof fn !== 'function') return { error: `window.__gitmini.graph.${name} absent` };
      const value = fn(...params) as unknown;
      if (value && typeof value === 'object' && 'width' in value && 'height' in value && 'x' in value) {
        const r = value as { x: number; y: number; width: number; height: number };
        return { value: { x: r.x, y: r.y, width: r.width, height: r.height } };
      }
      return { value };
    },
    method,
    args,
  );
  if ('error' in (outcome as object)) throw new Error((outcome as { error: string }).error);
  return (outcome as { value: T }).value;
}

/** `oid` Line Index (`'HEAD'` accepted), -1 if line is not loaded. */
export const rowOf = (oid: string): Promise<number> => graphCall<number>('rowOf', oid);
/** Rectangle (viewport coordinates, including scroll) of the line of `oid`. */
export const rowRect = (oid: string): Promise<Rect> => graphCall<Rect>('rowRect', oid);
/** Rectangle of the ref label (`feature`, `refs/heads/main`) in the graph. */
export const refRect = (refName: string): Promise<Rect> => graphCall<Rect>('refRect', refName);
export const visibleRange = (): Promise<{ first: number; last: number }> => graphCall('visibleRange');
export const lanesOf = (oid: string): Promise<{ lane: number; color: number }> => graphCall('lanesOf', oid);

export function center(rect: Rect): Point {
  return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) };
}

export async function rowCenter(oid: string): Promise<Point> {
  const rect = await rowRect(oid);
  if (rect.width === 0 && rect.height === 0) throw new Error(`ligne ${oid} outside the visible area of the graph (emptyrowRect)`);
  return center(rect);
}

export async function refCenter(refName: string): Promise<Point> {
  const rect = await refRect(refName);
  if (rect.width === 0 && rect.height === 0) throw new Error(`label ${refName} not found in the graph (refRect empty)`);
  return center(rect);
}

/** Number of times a backend event has happened (: `repo:changed`, `op:progress`, `op:state`). */
export async function eventCount(name: EventName): Promise<number> {
  return browser.execute((n: string) => {
    const g = (window as unknown as { __gitmini?: { events: { count(n: string): number } } }).__gitmini;
    if (!g) throw new Error('window.__gitmini absent');
    return g.events.count(n);
  }, name);
}

/** Payload for the last `name`, `null` event if it never happened. */
export async function lastEvent<T = unknown>(name: EventName): Promise<T | null> {
  return browser.execute((n: string) => {
    const g = (window as unknown as { __gitmini?: { events: { last(n: string): unknown } } }).__gitmini;
    if (!g) throw new Error('window.__gitmini absent');
    return g.events.last(n) ?? null;
  }, name) as Promise<T | null>;
}

/** Resets the bridge frame durations (`__gitmini.perf.reset`). */
export async function perfReset(): Promise<void> {
  await browser.execute(() => {
    const g = (window as unknown as { __gitmini?: { perf: { reset(): void } } }).__gitmini;
    if (!g) throw new Error('window.__gitmini absent');
    g.perf.reset();
  });
}

/** Frame durations (ms, rAF) since the last `perfReset`. */
export async function perfFrames(): Promise<number[]> {
  return browser.execute(() => {
    const g = (window as unknown as { __gitmini?: { perf: { frames(): number[] } } }).__gitmini;
    if (!g) throw new Error('window.__gitmini absent');
    return g.perf.frames();
  });
}

//
// Pointer inputs
//

type PointerAction = Record<string, unknown>;

async function pointer(actions: PointerAction[]): Promise<void> {
  await browser.performActions([{ type: 'pointer', id: POINTER_ID, parameters: { pointerType: 'mouse' }, actions }]);
}

const move = (p: Point, duration = 0): PointerAction => ({ type: 'pointerMove', duration, x: Math.round(p.x), y: Math.round(p.y), origin: 'viewport' });

export interface ClickOptions {
  button?: 'left' | 'right';
  /** Maintains `Mod` (Cmd / Ctrl) during the click: multiple selection (`Mod+clic`). */
  mod?: boolean;
  shift?: boolean;
  double?: boolean;
}

/** Click at the contact details of the viewport, with possible modifiers. */
export async function clickAt(point: Point, opts: ClickOptions = {}): Promise<void> {
  const button = opts.button === 'right' ? 2 : 0;
  const modifiers = [opts.mod ? MOD : null, opts.shift ? Key.Shift : null].filter((k): k is string => k !== null);
  const clicks = opts.double ? 2 : 1;
  const gesture: PointerAction[] = [move(point)];
  for (let i = 0; i < clicks; i++) gesture.push({ type: 'pointerDown', button }, { type: 'pointerUp', button });

  if (modifiers.length === 0) {
    await pointer(gesture);
  } else {
    // both input sources advance by "ticks" of the same length: modifiers pressed, gestures, modifiers released
    const pause = (): PointerAction => ({ type: 'pause', duration: 0 });
    await browser.performActions([
      {
        type: 'key',
        id: KEYBOARD_ID,
        actions: [
          ...modifiers.map((value) => ({ type: 'keyDown', value })),
          ...gesture.map(pause),
          ...[...modifiers].reverse().map((value) => ({ type: 'keyUp', value })),
        ],
      },
      { type: 'pointer', id: POINTER_ID, parameters: { pointerType: 'mouse' }, actions: [...modifiers.map(pause), ...gesture, ...modifiers.map(pause)] },
    ]);
  }
  await browser.releaseActions();
}

/** Click on the line of a commit (`opts.mod`: `Mod+clic`, `opts.button: 'right'`: context menu). */
export async function clickRow(oid: string, opts: ClickOptions = {}): Promise<void> {
  await clickAt(await rowCenter(oid), opts);
}

/** Click on the label of a ref in the graph. */
export async function clickRef(refName: string, opts: ClickOptions = {}): Promise<void> {
  await clickAt(await refCenter(refName), opts);
}

export interface DragOptions {
  /** Number of intermediate `pointermove`s (default 8): crosses the threshold for starting the gesture. */
  steps?: number;
  /** Duration of each movement in ms (default 16). */
  stepMs?: number;
  /** `actions` (default, actual input) or `synthetic` (reply, see header). Default: `GITMINI_DRAG_MODE`. */
  mode?: 'actions' | 'synthetic';
}

function dragMode(opts: DragOptions): 'actions' | 'synthetic' {
  return opts.mode ?? (process.env.GITMINI_DRAG_MODE === 'synthetic' ? 'synthetic' : 'actions');
}

/** Press the left button on `from` (start of gesture; the gesture remains in progress until `pointerUp`). */
export async function pointerDown(from: Point): Promise<void> {
  await pointer([move(from), { type: 'pointerDown', button: 0 }]);
}

/** Moves the pointer (button pressed) to `to` in `steps` steps. */
export async function pointerMoveTo(from: Point, to: Point, opts: DragOptions = {}): Promise<void> {
  const steps = Math.max(1, opts.steps ?? 8);
  const stepMs = opts.stepMs ?? 16;
  const actions: PointerAction[] = [];
  for (let i = 1; i <= steps; i++) {
    actions.push(move({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, stepMs));
  }
  await pointer(actions);
}

/** Release the button to the current position and reset the entry status to zero. */
export async function pointerUp(): Promise<void> {
  await pointer([{ type: 'pointerUp', button: 0 }]);
  await browser.releaseActions();
}

/**
 * `from` → `to` in one SEULE W3C (`performActions`): pointMove, pointerDown,
 * `steps` × pointMove, [touch pressed during gesture], pointUp. Only one request: no entry state has to survive between
 * Two driver calls (WebKitWebDriver doesn't guarantee it), and the gesture is identical from driver to driver.
 * `keyDuringDrag`: Press (`Key.Escape`) and release just before the button release (RB-04: cancel a
 * Sliding in progress by Echap).
 */
export async function dragPointer(from: Point, to: Point, opts: DragOptions & { keyDuringDrag?: string } = {}): Promise<void> {
  if (dragMode(opts) === 'synthetic') {
    await syntheticDrag(from, to, opts.steps ?? 8);
    return;
  }
  const steps = Math.max(1, opts.steps ?? 8);
  const stepMs = opts.stepMs ?? 16;
  const pointerActions: PointerAction[] = [move(from), { type: 'pointerDown', button: 0 }];
  for (let i = 1; i <= steps; i++) {
    pointerActions.push(move({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }, stepMs));
  }
  if (!opts.keyDuringDrag) {
    pointerActions.push({ type: 'pointerUp', button: 0 });
    await browser.performActions([{ type: 'pointer', id: POINTER_ID, parameters: { pointerType: 'mouse' }, actions: pointerActions }]);
  } else {
    // both sources move by ticks of the same length: the key is pressed and released between the last move and release
    const pause = (): PointerAction => ({ type: 'pause', duration: 0 });
    const keyActions: PointerAction[] = [...pointerActions.map(pause), { type: 'keyDown', value: opts.keyDuringDrag }, { type: 'keyUp', value: opts.keyDuringDrag }, pause()];
    pointerActions.push(pause(), pause(), { type: 'pointerUp', button: 0 });
    await browser.performActions([
      { type: 'key', id: KEYBOARD_ID, actions: keyActions },
      { type: 'pointer', id: POINTER_ID, parameters: { pointerType: 'mouse' }, actions: pointerActions },
    ]);
  }
  await browser.releaseActions();
}

/**
 * Slides the `fromRef` label on the `toRef` label (RB-01, BR-09). To interrupt the gesture (RB-04: Escape, release out
 * use `pointerDown` / `pointerMoveTo` / `press('Escape')` / `pointerUp` separately.
 */
export async function dragRef(fromRef: string, toRef: string, opts: DragOptions = {}): Promise<void> {
  await dragPointer(await refCenter(fromRef), await refCenter(toRef), opts);
}

/** Replies: same events, issued from the page (see "Known Limits" at the top of the file). */
async function syntheticDrag(from: Point, to: Point, steps: number): Promise<void> {
  await browser.execute(
    (a: Point, b: Point, n: number) => {
      const fire = (type: string, p: Point, buttons: number): void => {
        const target = document.elementFromPoint(p.x, p.y) ?? document.body;
        target.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            pointerId: 1,
            pointerType: 'mouse',
            isPrimary: true,
            button: type === 'pointermove' ? -1 : 0,
            buttons,
            clientX: p.x,
            clientY: p.y,
          }),
        );
      };
      fire('pointerdown', a, 1);
      for (let i = 1; i <= n; i++) fire('pointermove', { x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }, 1);
      fire('pointerup', b, 0);
    },
    from,
    to,
    steps,
  );
}
