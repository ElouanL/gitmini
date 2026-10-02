import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const host = process.env.TAURI_DEV_HOST;
// HTTP (axum crate) development bridge: the client speaks `POST /__gitmini/invoke/<cmd>` and `GET /__gitmini/events` (SSE).
const bridge = process.env.GITMINI_BRIDGE_URL ?? 'http://127.0.0.1:1430';

export default defineConfig(({ mode }) => ({
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url)),
      $i18n: fileURLToPath(new URL('./src/i18n', import.meta.url)),
    },
    // Svelte 5 under vitest: solves the "browser" version (mount, runes reactive).
    ...(mode === 'test' ? { conditions: ['browser'] } : {}),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    // GITMINI_NO_WATCH=1: no reloading with each file modification (stable screenshots).
    watch: process.env.GITMINI_NO_WATCH ? null : { ignored: ['**/crates/**', '**/target/**', '**/tests/**'] },
    proxy: {
      '/__gitmini': { target: bridge, changeOrigin: true },
    },
  },
  build: {
    // WKWebView, WebKitGTK and WebView2 recent.
    target: ['chrome105', 'safari15'],
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    // The budget is 150 kB gzippés; the wide size warning of Vit has no meeting here.
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/lib/test/setup.ts'],
    restoreMocks: true,
  },
}));
