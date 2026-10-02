// EMBBARQYED interface font of the e2e build (`GITMINI_TEST_MODE=1`, and 03): deterministic renderings from one machine to another
// (captures, width measurements) instead of `system-ui`. Inter and Roboto Mono (OFL-1.1, packages @fontsource, sous-ensemble Latin).
//
// Charged UNIQUEMENT if `app_info.e2e` and the build includes it (`VITE_GITMINI_E2E=1 pnpm build`, or the development server):
// neither the original bundle nor the production build contain it (CSP `font-src 'self'`, fonts served from dist/).
import '@fontsource/inter/latin-400.css';
import '@fontsource/inter/latin-600.css';
import '@fontsource/roboto-mono/latin-400.css';

const root = document.documentElement.style;
root.setProperty('--font-ui', "Inter, system-ui, sans-serif");
root.setProperty('--font-mono', "'Roboto Mono', ui-monospace, monospace");

/** Resolved when fonts are ready (or after `timeoutMs`: a load failure never blocks booting). */
export async function e2eFontReady(timeoutMs = 1500): Promise<void> {
  const ready = Promise.all([document.fonts.load("13px 'Inter'"), document.fonts.load("600 13px 'Inter'"), document.fonts.load("13px 'Roboto Mono'")]);
  await Promise.race([ready.catch(() => undefined), new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}
