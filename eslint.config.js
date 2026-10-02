// ESlint (flat config). Blocking rules of: no `{@html}`, no tauri fs/shell/opener plugin,
// `invoke` / `listen` / `fetch` only in src/lib/ipc.
import js from '@eslint/js';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';
import ts from 'typescript-eslint';
import svelteConfig from './svelte.config.js';

const noTauriPlugins = {
  group: ['@tauri-apps/plugin-*', '!@tauri-apps/plugin-dialog'],
  message: "Only @tauri-apps/plugin-dialog (dialog:open) is allowed (01 §1): any opening is via open_external.",
};

const noIpcOutsideIpc = [
  {
    group: ['@tauri-apps/api/*', '@tauri-apps/api', '@tauri-apps/plugin-dialog'],
    message: "invoke / listen / dialog: only in src/lib/ipc (commands.ts, events.ts, transport.ts, dialog.ts).",
  },
];

export default ts.config(
  { ignores: ['dist/**', 'node_modules/**', 'target/**', 'crates/**', 'src-tauri/**', 'tests/**', '.svelte-kit/**', 'src/lib/ipc/types.ts'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      // `{@html}` is forbidden in src/: XSS to a WebView that speaks to a privileged backend.
      'svelte/no-at-html-tags': 'error',
      'no-restricted-imports': ['error', { patterns: [noTauriPlugins, ...noIpcOutsideIpc] }],
      'no-restricted-globals': [
        'error',
        { name: 'fetch', message: "Network calls: only in src/lib/ipc/transport.ts." },
        { name: 'EventSource', message: "Events: only in src/lib/ipc/transport.ts." },
        { name: 'XMLHttpRequest', message: "Network calls: only in src/lib/ipc/transport.ts." },
        { name: 'WebSocket', message: "No direct connection: go through src/lib/ipc." },
        { name: 'open', message: "window.open prohibits: any opening of the URL or file passes through open_external (01 §1)." },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'window', property: 'open', message: 'window.open interdit : utiliser open_external (01 §1).' },
        { object: 'globalThis', property: 'open', message: 'window.open interdit : utiliser open_external (01 §1).' },
        { object: 'location', property: 'assign', message: "Forbidden navigation: the interface never leaves its page (open_external)." },
        { object: 'location', property: 'replace', message: "Forbidden navigation: the interface never leaves its page (open_external)." },
      ],
      // Drag & drop : Pointer Events only, never the API HTML5 (WebDriver does not drive it).
      'no-restricted-syntax': [
        'error',
        { selector: "Identifier[name='dataTransfer']", message: "HTML5 Drag and Drop prohibited: use Pointer Events." },
        {
          selector: "AssignmentExpression[left.type='MemberExpression'][left.property.name='href'][left.object.name='location']",
          message: "Forbidden navigation: the interface never leaves its page (open_external).",
        },
        {
          selector: "AssignmentExpression[left.type='MemberExpression'][left.property.name='location'][left.object.name='window']",
          message: "Forbidden navigation: the interface never leaves its page (open_external).",
        },
      ],
    },
  },
  {
    files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
    languageOptions: { parserOptions: { projectService: false, extraFileExtensions: ['.svelte'], parser: ts.parser, svelteConfig } },
  },
  {
    // Only the ipc folder touches the backend.
    files: ['src/lib/ipc/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [noTauriPlugins] }],
      'no-restricted-globals': 'off',
    },
  },
  {
    files: ['**/*.test.ts', 'src/lib/test/**', 'src/lib/mock/**', 'vite.config.ts', 'eslint.config.js'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-restricted-globals': 'off',
    },
  },
);

