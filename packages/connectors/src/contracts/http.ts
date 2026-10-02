/** HTTP Retry-After is either a delay in seconds or an HTTP date. Shared by all transports. */
export function parseRetryAfter(value: string | null, now = Date.now()): string | undefined {
  if (!value) return undefined;
  const ms = /^\d+(?:\.\d+)?$/.test(value.trim()) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isFinite(ms) ? new Date(Math.max(now, ms)).toISOString() : undefined;
}
