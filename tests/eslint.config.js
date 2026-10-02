// ESLint tests/ (e2e harness, support, perf; , §9.2): same blocking rules as root lint, plus
// the prohibition of fixed-term expectations in specs and test helpers. The root lint ignores tests/**; celui-ci
// is launched by `pnpm --dir tests/e2e run lint`. Its dependencies (@eslint/js, globals, typescript-eslint) come from the
// node_modules of the root of repository (the same as the root lint).
import js from '@eslint/js';
import globals from 'globals';
import ts from 'typescript-eslint';

const noFixedWait = [
  {
    selector: "CallExpression[callee.object.name='browser'][callee.property.name='pause']",
    message: "browser.pause() forbidden (13 §5.4): wait for an observable condition (idle(), until(), waitForTestId(), sentinel, retained mock).",
  },
  {
    selector: "CallExpression[callee.name='setTimeout']",
    message: "setTimeout() prohibited in tests (13 §5.4): wait for an observable condition (idle(), until(), sentinel, retained mock).",
  },
  {
    selector: "CallExpression[callee.object.name='globalThis'][callee.property.name='setTimeout']",
    message: "setTimeout() prohibited in tests (13 §5.4).",
  },
];

// Specs also do not have the right to import the `setTimeout` of times/promises (including aliases); libraries
// support (sentinel.ts, fixture.ts) and helpers use it for limited surveys on a condition.
const noTimersInSpecs = {
  selector: "ImportDeclaration[source.value='node:timers/promises'] ImportSpecifier[imported.name='setTimeout']",
  message: "timers/promise.setTimeout prohibited in specs (13 §5.4): wait for an observable condition.",
};

export default ts.config(
  { ignores: ['**/node_modules/**', '**/.artifacts/**', '**/reports/**', 'perf/hello-tauri/**', 'fixtures/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node, ...globals.mocha, browser: 'readonly', $: 'readonly', $$: 'readonly', expect: 'readonly' } },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      // Drag & drop : Pointer Events only
      'no-restricted-syntax': [
        'error',
        { selector: "Identifier[name='dataTransfer']", message: "HTML5 Drag and Drop prohibited: use Pointer Events (13 §1)." },
      ],
    },
  },
  {
    // Specs, setups, autotest: no fixed expectation. Harness helpers (tests/e2e/helpers) sound a condition with
    // an interval; they are excluded from this rule.
    files: ['e2e/specs/**/*.ts', 'e2e/selftest/**/*.ts', 'support/**/*.ts', 'perf/**/*.ts'],
    ignores: ['**/helpers/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "Identifier[name='dataTransfer']", message: "HTML5 Drag and Drop prohibited: use Pointer Events (13 §1)." },
        ...noFixedWait,
      ],
    },
  },
  {
    files: ['e2e/specs/**/*.ts', 'e2e/selftest/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        { selector: "Identifier[name='dataTransfer']", message: "HTML5 Drag and Drop prohibited: use Pointer Events (13 §1)." },
        ...noFixedWait,
        noTimersInSpecs,
      ],
    },
  },
  {
    files: ['*.config.js', '*.config.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
);
