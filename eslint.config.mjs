import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import ts from 'typescript-eslint';
import next from '@next/eslint-plugin-next';
import hooks from 'eslint-plugin-react-hooks';

export default defineConfig([
  globalIgnores(['**/.next/**', '**/node_modules/**', '**/next-env.d.ts', '**/drizzle/meta/**', '.local/**', '.kilo/**']),
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
    files: ['packages/core/src/domain/**/*.ts', 'packages/connectors/src/contracts/**/*.ts', 'packages/core/src/contracts/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['node:*', '@acm/db/*', '@acm/core/server', '@acm/core/reads', '@acm/connectors/server', '**/application/*'] }] },
  },
  {
    files: ['apps/web/src/components/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['@acm/db/*', '@acm/core/server', '@acm/core/reads', '@acm/connectors/server'] }] },
  },
  {
    files: ['packages/connectors/src/**/*.ts'],
    ignores: ['packages/connectors/src/contracts/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['@acm/db', '@acm/db/*', '@acm/core', '@acm/core/*', '**/apps/**'] }] },
  },
  {
    files: ['packages/core/src/application/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['**/apps/**'] }] },
  },
  {
    files: ['packages/db/src/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['@acm/core', '@acm/core/*', '@acm/connectors', '@acm/connectors/*', '**/apps/**'] }] },
  },
  {
    files: ['apps/web/src/app/**/page.tsx', 'apps/web/src/lib/member-page.tsx'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['@acm/db', '@acm/db/*'] }] },
  },
  {
    files: ['packages/core/src/domain/**/*.ts'],
    rules: { 'no-restricted-properties': ['error', { object: 'process', property: 'env' }, { object: 'Date', property: 'now' }], 'no-restricted-globals': ['error', 'fetch'] },
  },
  {
    files: ['apps/worker/src/runtime/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: [{ name: '@acm/db/server', importNames: ['getPool', 'getDb'], message: '运行入口只负责生命周期，业务 SQL 放在数据库 helpers。' }] }] },
  },
]);
