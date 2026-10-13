import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      // `NEXT_DIST_DIR` builds land beside it; build output is not source.
      '**/.next-*/**',
      '**/coverage/**',
      '**/generated/**',
      '**/.scratch/**',
      'design/**',
      'docs/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    // The market-kit operator UI ships plain browser JavaScript, deliberately: it has
    // no bundler and no framework, so there is nowhere for a key to hide in a build.
    files: ['apps/market-kit/web/**/*.js'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        fetch: 'readonly',
        Number: 'readonly',
        Object: 'readonly',
        JSON: 'readonly',
        String: 'readonly',
      },
    },
  },
  {
    // Standalone maintenance scripts run under node, not in a browser. They are plain
    // `.mjs` on purpose: each is meant to be run by hand against production with no
    // build step between reading it and trusting what it does.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    // The service worker is a browser file with its own globals, and it is deliberately
    // plain JavaScript in `public/`: it must be served byte for byte at a fixed URL,
    // which is the one thing a bundled module cannot promise.
    files: ['apps/trade/public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Promise: 'readonly',
      },
    },
  },
  {
    rules: {
      // A2.6 — all monetary math is bigint. Floats exist only in display formatting.
      'no-loss-of-precision': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'off',
    },
  },
);
