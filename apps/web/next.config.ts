import type { NextConfig } from 'next';
import { fileURLToPath } from 'node:url';

const config: NextConfig = {
  transpilePackages: ['@acm/core', '@acm/db', '@acm/connectors'],
  serverExternalPackages: ['argon2', 'pg', 'pg-boss'],
  turbopack: { root: fileURLToPath(new URL('../..', import.meta.url)) },
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'same-origin' },
      { key: 'X-Frame-Options', value: 'DENY' },
    ] }];
  },
};
export default config;
