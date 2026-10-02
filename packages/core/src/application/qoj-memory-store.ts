import type { PlatformRequestStore } from '@acm/db/server';

/** One-process debug/test store, explicitly unsuitable for deployed multi-process use. */
export function createQojMemoryStore(): PlatformRequestStore {
  let owner: string | null = null;
  let expires = 0;
  let nextAt = 0;
  return {
    async acquire(_platform, token, intervalMs, leaseMs) {
      const now = Date.now();
      if (now < nextAt || (owner && now < expires)) return { acquired: false, waitMs: Math.max(nextAt, expires) - now };
      owner = token; expires = now + leaseMs; nextAt = now + intervalMs;
      return { acquired: true, waitMs: 0 };
    },
    async owns(_platform, token) { return owner === token && Date.now() < expires; },
    async release(_platform, token) {
      if (owner !== token || Date.now() >= expires) return false;
      owner = null; expires = 0; return true;
    },
    async block(_platform, retryAt) { nextAt = Math.max(nextAt, Date.parse(retryAt)); },
  };
}
