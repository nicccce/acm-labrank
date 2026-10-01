import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import ts from 'typescript-eslint';
import next from '@next/eslint-plugin-next';
import hooks from 'eslint-plugin-react-hooks';

export default defineConfig([
  globalIgnores(['**/.next/**', '**/node_modules/**', '**/next-env.d.ts', '**/drizzle/meta/**', '.local/**']),
  js.configs.recommended,
  ...ts.configs.recommended,
  {
    languageOptions: { globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly', fetch: 'readonly', URL: 'readonly', AbortSignal: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly' } },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { '@next/next': next, 'react-hooks': hooks },
    rules: { ...next.configs['core-web-vitals'].rules, ...hooks.configs.recommended.rules },
    settings: { next: { rootDir: 'apps/web/' } },
  },
  {
    files: ['packages/core/src/domain/**/*.ts', 'packages/connectors/src/contracts/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['node:*', '@acm/db/*', '@acm/core/server', '@acm/connectors/server', '**/application/*'] }] },
  },
  {
    files: ['apps/web/src/components/**/*.tsx'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['@acm/db/*', '@acm/core/server', '@acm/connectors/server'] }] },
  },
]);
