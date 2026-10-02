export function median(values: number[]): number;
export function percentile(values: number[], p: number): number;
export function mean(values: number[]): number;
export function max(values: number[]): number;
export function round(value: number, digits?: number): number;

export const MARKS: {
  appReady: 'gitmini:app-ready';
  repoOpenStart: 'gitmini:repo-open-start';
  graphFirstPaint: 'gitmini:graph-first-paint';
  graphIndexComplete: 'gitmini:graph-index-complete';
};
export interface TraceMark { name: string; t: number }
export interface TraceFrame { dt: number; t: number }
export interface Trace { marks: TraceMark[]; frames: TraceFrame[]; skipped: number }
export function parseTrace(text: string): Trace;
export function readTraceFile(file: string): Trace;
export function firstMark(marks: TraceMark[], name: string, opts?: { after?: number }): TraceMark | undefined;
export function lastMark(marks: TraceMark[], name: string): TraceMark | undefined;
export function frameDurationsBetween(frames: TraceFrame[], t0: number, t1: number): number[];

export interface BudgetSpec {
  id: string; part: string | null; budget: string; section: string; metric: string; unit: string;
  comparator: '<' | '<='; limit: number; limitByOs?: Partial<Record<'win32' | 'darwin' | 'linux', number>>;
  limitLinux?: number; limitVariant?: Record<string, number>; blocking: boolean; when: 'pr' | 'nightly';
}
export const BUDGETS: BudgetSpec[];
export const BLOCKING_IDS: string[];
export const MB: number;
export function getBudget(id: string, part?: string | null): BudgetSpec | undefined;
export function resolveLimit(spec: BudgetSpec, ctx?: { os?: string; column?: 'fx100k' | 'linux'; variant?: string | null }): number;
export function within(value: number, limit: number, comparator: '<' | '<='): boolean;

export interface PerfResult {
  id: string; part?: string; budget: string | null; metric: string; value: number; unit: string | null;
  limit: number | null; comparator: '<' | '<=' | null; status: 'pass' | 'fail' | 'info'; blocking: boolean;
  os: string; fixture?: string; column: 'fx100k' | 'linux'; variant?: string; samples?: number[]; note?: string;
}
export function makeResult(r: {
  id: string; part?: string | null; value: number; os?: string; fixture?: string; column?: 'fx100k' | 'linux';
  variant?: string | null; samples?: number[]; note?: string; metric?: string; forceInfo?: boolean; limitOverride?: number;
}): PerfResult;
export function recordPerf(result: PerfResult, opts?: { file?: string }): string;
export function readResultsFile(file: string): PerfResult[];
export function resultsDir(): string;
export function osName(): 'linux' | 'darwin' | 'win32';

export interface ProcInfo { pid: number; ppid: number; command: string }
export function listProcesses(platform?: string): ProcInfo[];
export function findByExe(list: ProcInfo[], exePath: string): ProcInfo[];
export function descendants(list: ProcInfo[], rootPid: number): number[];
export function killTree(pid: number, opts?: { graceMs?: number; platform?: string }): Promise<number[]>;
export function cpuSeconds(pids: number[], platform?: string): Map<number, number>;

export interface TreeMeasure {
  backendBytes: number; webviewBytes: number;
  processes: { pid: number; role: 'backend' | 'webview'; command: string; bytes: number | null }[];
}
export function measureTree(rootPid: number, opts?: { platform?: string; beforeWebKitPids?: Set<number> }): TreeMeasure;
export function webKitPids(platform?: string): Set<number>;
