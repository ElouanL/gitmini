// Play file `GITMINI_PERF_TRACE` (, ) : JSON lines, a mark or a frame duration per line.
//   {"kind":"mark","name":"gitmini:app-ready","t":1790972000123.4}
//   {"kind":"frame","dt":16.7,"t":1790972000140.1}
// `t` = `performance.timeOrigin + startTime` (ms from epoch): comparable to `Date.now` of the harness.
// The parser is tolerant: an illegible, truncated (file read during writing) or unknown line is ignored.
import { readFileSync } from 'node:fs';

export const MARKS = {
  appReady: 'gitmini:app-ready',
  repoOpenStart: 'gitmini:repo-open-start',
  graphFirstPaint: 'gitmini:graph-first-paint',
  graphIndexComplete: 'gitmini:graph-index-complete',
};

/**
 * @param {string} text
 * @returns {{ marks: { name: string; t: number }[]; frames: { dt: number; t: number }[]; skipped: number }}
 */
export function parseTrace(text) {
  const marks = [];
  const frames = [];
  let skipped = 0;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    if (obj === null || typeof obj !== 'object' || !Number.isFinite(obj.t)) {
      skipped++;
      continue;
    }
    const dt = [obj.dt, obj.frame, obj.duration].find((v) => typeof v === 'number' && Number.isFinite(v));
    if (obj.kind === 'frame' || (obj.kind === undefined && dt !== undefined && typeof obj.name !== 'string')) {
      if (dt === undefined) {
        skipped++;
        continue;
      }
      frames.push({ dt, t: obj.t });
    } else if ((obj.kind === 'mark' || obj.kind === undefined) && typeof obj.name === 'string') {
      marks.push({ name: obj.name, t: obj.t });
    } else {
      skipped++;
    }
  }
  return { marks, frames, skipped };
}

/** Reads and parses a trace file; an absent file gives an empty trace. */
export function readTraceFile(file) {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    /* not yet created */
  }
  return parseTrace(text);
}

/** First brand `name` (of `t` ≥ `after` if supplied), if not `undefined`. */
export function firstMark(marks, name, { after = -Infinity } = {}) {
  return marks.find((m) => m.name === name && m.t >= after);
}

/** Last brand `name`, otherwise `undefined`. */
export function lastMark(marks, name) {
  for (let i = marks.length - 1; i >= 0; i--) if (marks[i].name === name) return marks[i];
  return undefined;
}

/** Duration (ms) of frames with time stamping in `[t0, t1]`. */
export function frameDurationsBetween(frames, t0, t1) {
  return frames.filter((f) => f.t >= t0 && f.t <= t1).map((f) => f.dt);
}
