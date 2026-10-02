// Marques de performance (, ) : `gitmini:app-ready`, `gitmini:repo-open-start`, `gitmini:graph-first-paint`,
// `gitmini:graph-index-complete`, plus frame durations (requestAnimationFrame).
//
// - always: `performance.mark` + memory buffer (read by `window.__gitmini.perf` of the build e2e);
// - with `GITMINI_PERF_TRACE`: the backend defines `window.__gitminiPerfSink(line)` before loading the page (script
//   webview initialization); each brand and frame is transmitted to it in JSON (one line per call).
//   The IPC contract does not have a command to write a file: the channel and format are described in src/README.md.

export type PerfMarkName =
  | 'gitmini:app-ready'
  | 'gitmini:repo-open-start'
  | 'gitmini:graph-first-paint'
  | 'gitmini:graph-index-complete';

export interface PerfLine {
  kind: 'mark' | 'frame';
  /** Marque : son nom. */
  name?: PerfMarkName;
  /** Frame: duration in ms from the previous frame. */
  dt?: number;
  /** `performance.timeOrigin + startTime`: ms from epoch. */
  t: number;
}

type Sink = (line: PerfLine) => void;

declare global {
  interface Window {
    __gitminiPerfSink?: Sink;
  }
}

const marks: { name: string; t: number }[] = [];
const FRAME_BUFFER = 5000;
let frames: number[] = [];
let sink: Sink | null = null;
let frameLoop = 0;
let lastFrame = 0;

function resolveSink(): Sink | null {
  if (sink) return sink;
  if (typeof window !== 'undefined' && typeof window.__gitminiPerfSink === 'function') return window.__gitminiPerfSink;
  return null;
}

/** Connects a line receiver (tests, test deck). */
export function setPerfSink(s: Sink | null): void {
  sink = s;
}

export function perfMark(name: PerfMarkName): void {
  const t = performance.timeOrigin + performance.now();
  try {
    performance.mark(name);
  } catch {
    /* environment without User Timing */
  }
  marks.push({ name, t });
  resolveSink()?.({ kind: 'mark', name, t });
}

/**
 * Sets the mark to the PREMIER PAINT real: two `requestAnimationFrame` (the first callback runs before the paint of the frame, the
 * This is the "gitmini:app-ready" of the B1 start budget: it measures what the user sees, not the end of the JS.
 */
export function perfMarkAfterPaint(name: PerfMarkName, fallbackMs = 250): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      perfMark(name);
      resolve();
    };
    // Hidden or minimized window: `requestAnimationFrame` does not run; the fold prevents blocking the opening of the repository.
    setTimeout(finish, fallbackMs);
    const raf: (cb: () => void) => unknown = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    raf(() => raf(finish));
  });
}

export function perfMarks(): { name: string; t: number }[] {
  return marks.map((m) => ({ ...m }));
}

export function perfFrames(): number[] {
  return [...frames];
}

/** Resets frame durations (start marks are kept). */
export function perfReset(): void {
  frames = [];
}

/** Sets everything to zero (unit tests). */
export function perfResetAll(): void {
  marks.length = 0;
  frames = [];
}

/**
 * Measurement of frames, **without cost at rest** (B13: CPU < 0.5% inactive window, PERF-10): the loop `requestAnimationFrame` is not
 * armed only during an interaction (mollette, scrolling, pointer, keyboard) and stops itself `IDLE_MS` after the last.
 * The first delta after a recovery is discarded (it would contain the pause). Arming/unarming is free out of interaction.
 */
const IDLE_MS = 600;
const INPUT_EVENTS = ['wheel', 'scroll', 'pointermove', 'pointerdown', 'keydown'] as const;
let lastInput = 0;
let resumed = true;
let listening = false;

function onInput(): void {
  lastInput = performance.now();
  if (!frameLoop && typeof requestAnimationFrame !== 'undefined') {
    resumed = true;
    frameLoop = requestAnimationFrame(tick);
  }
}

function tick(now: number): void {
  if (resumed) {
    resumed = false;
  } else {
    const dt = now - lastFrame;
    frames.push(dt);
    if (frames.length > FRAME_BUFFER) frames = frames.slice(frames.length - FRAME_BUFFER);
    resolveSink()?.({ kind: 'frame', dt, t: performance.timeOrigin + now });
  }
  lastFrame = now;
  // More interaction from IDLE_MS: the loop stops (no callback at rest).
  frameLoop = now - lastInput > IDLE_MS ? 0 : requestAnimationFrame(tick);
}

export function startFrameMonitor(): void {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  for (const ev of INPUT_EVENTS) window.addEventListener(ev, onInput, { capture: true, passive: true });
}

export function stopFrameMonitor(): void {
  if (typeof window !== 'undefined') for (const ev of INPUT_EVENTS) window.removeEventListener(ev, onInput, { capture: true });
  listening = false;
  if (frameLoop && typeof cancelAnimationFrame !== 'undefined') cancelAnimationFrame(frameLoop);
  frameLoop = 0;
}

/** The tourne-t-elle frame loop right now? (tests: must be false at rest). */
export function frameLoopActive(): boolean {
  return frameLoop !== 0;
}

/** Start the frame monitor if the backend has requested a trace (`GITMINI_PERF_TRACE`). */
export function startPerfIfRequested(): void {
  if (resolveSink()) startFrameMonitor();
}
