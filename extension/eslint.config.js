import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';
import { configs as regexpConfigs } from 'eslint-plugin-regexp';
import * as importX from 'eslint-plugin-import-x';
import sonarjs from 'eslint-plugin-sonarjs';
import n from 'eslint-plugin-n';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['dist', 'node_modules', 'public']),
  {
    files: ['**/*.{ts,mts,cts,mjs,js}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      unicorn.configs.recommended,
      regexpConfigs['flat/recommended'],
      importX.flatConfigs.recommended,
      sonarjs.configs.recommended,
      n.configs['flat/recommended-module'],
    ],
    settings: {
      'import-x/parsers': {
        '@typescript-eslint/parser': ['.ts', '.mts', '.cts'],
      },
      // Browser-extension code targets the modern web runtime.
      n: { version: '>=22.0.0' },
    },
    languageOptions: {
      ecmaVersion: 'latest',
      // The extension runs in browser/worker contexts (chrome.*, DOM, fetch);
      // the build scripts run in Node. Both global sets are valid here.
      globals: {
        ...globals.browser,
        ...globals.serviceworker,
        ...globals.node,
        chrome: 'readonly',
      },
    },
    rules: {
      // Relative paths and the vite virtual modules are validated by tsc.
      'import-x/no-unresolved': ['error', { ignore: [String.raw`^\.`] }],
      'import-x/order': 'error',
      // tsc already checks these for TS files (and they false-positive on
      // TS-only global types).
      'no-undef': 'off',
      'n/no-missing-import': 'off',
      // Node-builtin gating is meaningless for browser-runtime files.
      'n/no-unsupported-features/node-builtins': 'off',
      // `ctx`, `msg`, `err`, `opts` are deliberate, idiomatic names here.
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/name-replacements': 'off',
      // Chrome event listeners fire and forget: `.catch(() => {})` there is
      // deliberate, and the service worker keeps module state on purpose.
      'unicorn/prefer-await': 'off',
      'unicorn/no-top-level-assignment-in-function': 'off',
      // Naming, comment layout and control-flow shape are left to review;
      // these rules' rewrites (ternaries, early returns, inverted guards)
      // read worse here than the code they replace.
      'unicorn/consistent-boolean-name': 'off',
      'unicorn/single-line-block-comment-style': 'off',
      'unicorn/prefer-ternary': 'off',
      'unicorn/prefer-early-return': 'off',
      'unicorn/prefer-continue': 'off',
      'unicorn/prefer-combined-guards': 'off',
      'unicorn/prefer-simple-condition-first': 'off',
      'unicorn/prefer-minimal-ternary': 'off',
      'unicorn/prefer-logical-operator-over-ternary': 'off',
      'unicorn/no-unreadable-for-of-expression': 'off',
      // `.then(onOk, onError)` maps a promise to a value on purpose.
      'unicorn/prefer-then-catch': 'off',
      // `null` is part of the chrome/DOM API surface we mirror.
      'unicorn/no-null': 'off',
    },
  },
  {
    // Local development servers are plain ws:// and http:// on localhost.
    files: ['manifest.config.ts'],
    rules: {
      'sonarjs/no-clear-text-protocols': 'off',
    },
  },
  {
    // The test setup installs a fake `chrome` global for the code under test.
    files: ['src/test/**'],
    rules: {
      'unicorn/no-global-object-property-assignment': 'off',
      'unicorn/no-top-level-side-effects': 'off',
    },
  },
  {
    // CLI scripts legitimately exit with a status code, run as executables, and
    // shell out to dev tools (ImageMagick) resolved from PATH.
    files: ['scripts/**'],
    rules: {
      'n/no-process-exit': 'off',
      'unicorn/no-process-exit': 'off',
      'n/hashbang': 'off',
      'sonarjs/no-os-command-from-path': 'off',
    },
  },
]);
