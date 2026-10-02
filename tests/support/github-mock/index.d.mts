// Types of the server mock GitHub (13 §5.2). Implementation: ./index.mjs.

export interface StartMockOptions {
  /** Root of the repositories bare served (`<reposDir>/<owner>/<repo>.git`). Default: temporary folder deleted by `close()`. */
  reposDir?: string;
  /** Port TCP; default 0 = random. */
  port?: number;
  /** Listening address; default '127.0.0.1'. */
  host?: '127.0.0.1' | 'localhost';
  /** Token OAuth accepted and issued; default 'gho_test'. */
  token?: string;
  /** Login returned by GET /user; default 'octo-test'. */
  login?: string;
  /** Binaire git launched in `git http-backend`; default 'git' (PATH). */
  gitBin?: string;
}

/** A log entry (GET /__mock/calls). Never a token or password. */
export interface MockCall {
  seq: number;
  /** Receiving objects of the request, ms from the epoch. */
  t: number;
  method: string;
  path: string;
  /** Request string without `?` ('' if absent); sensitive values hidden by `***`. */
  query: string;
  /** Status of the reply, updated as soon as the header is sent; null until it is written (request retained, or cut before). */
  status: number | null;
  /** Header Authority reduced to schema (+ login for Basic); null if absent. */
  auth: { scheme: string; login?: string } | null;
  /** true upon receipt of a request retained by `hold`. Remains true afterwards (historical). */
  held: boolean;
  /** true once the selected request has been released by `release`. */
  released?: boolean;
  /** true if the client has shut down the connection before the end of the answer (killed action: RM-06). */
  aborted?: boolean;
  /** Corps OAuth non secret : client_id, scope, grant_type, device_code. */
  body?: Record<string, string>;
}

/** Gross response returned as per /login/oauth/access_token. */
export type OAuthRawResponse = Record<string, unknown>;
export type TokenStep = 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | 'success' | OAuthRawResponse;

/** Body of POST /__mock/config (fusion; any unknown key is refused). */
export interface MockConfigPatch {
  /** Remet config, poll counter, interval, retention and zero log (applied before other keys). */
  reset?: true;
  /** Sequence of the responses of access_token: the Ne call takes the element N, the last is repeated. null = default [depending, hanging, succeed]. */
  tokenSequence?: TokenStep[] | null;
  /** Overload (merged) of /login/device/code response. */
  deviceCode?: Partial<{ device_code: string; user_code: string; verification_uri: string; expires_in: number; interval: number }> | null;
  /** Status HTTP forced by exact path (or prefix if key ends with `*`); null removes entry. */
  forceStatus?: Record<string, number | null>;
  /** `path?query` substrings of smart requests HTTP to remember (e.g. 'git-upload-pack') up to `release()`, which also disarms `hold`. */
  hold?: string[];
}

export interface GithubMock {
  port: number;
  /** http://127.0.0.1:<port> */
  baseUrl: string;
  /** Base de l'API (= baseUrl). */
  apiBase: string;
  /** OAuth base, web host and credential (= baseUrl). */
  oauthBase: string;
  reposDir: string;
  /** Environment variables to switch to the app: GITMINI_GITHUB_API_BASE and GITMINI_GITHUB_OAUTH_BASE. */
  env(): { GITMINI_GITHUB_API_BASE: string; GITMINI_GITHUB_OAUTH_BASE: string };
  /** `<baseUrl>/<owner>/<repo>.git` (fullName = 'octo-test/alpha'). */
  cloneUrl(fullName: string): string;
  /** `<reposDir>/<owner>/<repo>.git`: where to create the bare served by the smart HTTP. */
  bareRepoPath(fullName: string): string;
  /** Copy of the diary. */
  calls(): MockCall[];
  /** Same effect as POST /__mock/config (takes if config is invalid). */
  config(patch: MockConfigPatch): void;
  /** Release selected requests and disarm `hold` (same effect as POST /__mock/release). */
  release(): void;
  /** Same effect as `config({ reset: true })`. */
  reset(): void;
  /** PID process CGI `git http-backend` in progress (diagnosis). */
  childPids(): number[];
  /** Finish the selected queries, kill the CGI, close the sockets, delete the temporary folders created by the mock. */
  close(): Promise<void>;
}

export function startMock(opts?: StartMockOptions): Promise<GithubMock>;

/** Started and unclosed instances (registry `globalThis[Symbol.for('gitmini.githubMocks')]`). */
export function liveMocks(): GithubMock[];
