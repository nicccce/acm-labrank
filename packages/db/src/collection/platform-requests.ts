import { getPool } from '../client';

/** One database row coordinates every process that talks to a platform. */
export interface PlatformRequestStore {
  acquire(platform: string, token: string, intervalMs: number, leaseMs: number): Promise<{ acquired: boolean; waitMs: number; intervalMs?: number }>;
  owns(platform: string, token: string): Promise<boolean>;
  release(platform: string, token: string, minimumIntervalMs?: number): Promise<boolean>;
  block(platform: string, retryAt: string): Promise<void>;
}

export const platformRequestStore: PlatformRequestStore = {
  async acquire(platform, token, intervalMs, leaseMs) {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL statement_timeout = 5000');
      await client.query(`INSERT INTO platform_request_limits(platform) VALUES ($1) ON CONFLICT DO NOTHING`, [platform]);
      await client.query('SELECT platform FROM platform_request_limits WHERE platform = $1 FOR UPDATE', [platform]);
      if (['codeforces', 'luogu', 'qoj'].includes(platform)) {
        const policy = await client.query('SELECT min_interval_ms,max_interval_ms FROM platform_request_policies WHERE platform=$1', [platform]);
        if (!policy.rowCount) throw new Error('PLATFORM_POLICY_MISSING');
        const limits = policy.rows[0];
        intervalMs = Number(limits.min_interval_ms) + Math.floor(Math.random() * (Number(limits.max_interval_ms) - Number(limits.min_interval_ms) + 1));
      }
      // clock_timestamp() advances while a transaction waits for its row lock.
      const result = await client.query(`UPDATE platform_request_limits SET
        next_request_at = clock_timestamp() + $3 * interval '1 millisecond',
        lease_token = $2, lease_expires_at = clock_timestamp() + $4 * interval '1 millisecond', lease_interval_ms = $3
        WHERE platform = $1 AND next_request_at <= clock_timestamp() AND blocked_until <= clock_timestamp()
        AND (lease_token IS NULL OR lease_expires_at <= clock_timestamp()) RETURNING platform`, [platform, token, intervalMs, leaseMs]);
      let waitMs = 0;
      if (!result.rowCount) {
        const wait = await client.query(`SELECT greatest(0, extract(epoch FROM
          (greatest(next_request_at, blocked_until, CASE WHEN lease_token IS NULL THEN clock_timestamp() ELSE lease_expires_at END)
          - clock_timestamp())) * 1000) AS wait_ms FROM platform_request_limits WHERE platform = $1`, [platform]);
        waitMs = Math.ceil(Number(wait.rows[0].wait_ms));
      }
      await client.query('COMMIT');
      return { acquired: result.rowCount === 1, waitMs, intervalMs };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  },
  async owns(platform, token) {
    const result = await getPool().query(`SELECT 1 FROM platform_request_limits
      WHERE platform = $1 AND lease_token = $2 AND lease_expires_at > clock_timestamp()`, [platform, token]);
    return result.rowCount === 1;
  },
  async release(platform, token, minimumIntervalMs = 0) {
    // Conservatively space from completion too: preparation/DB delays cannot compress real HTTP starts.
    const result = await getPool().query(`UPDATE platform_request_limits SET lease_token = NULL, lease_expires_at = NULL,
      next_request_at = greatest(next_request_at, clock_timestamp() + greatest(lease_interval_ms,$3) * interval '1 millisecond')
      WHERE platform = $1 AND lease_token = $2 AND lease_expires_at > clock_timestamp() RETURNING platform`, [platform, token, minimumIntervalMs]);
    return result.rowCount === 1;
  },
  async block(platform, retryAt) {
    await getPool().query(`INSERT INTO platform_request_limits(platform, blocked_until) VALUES ($1, $2::timestamptz)
      ON CONFLICT(platform) DO UPDATE SET blocked_until = greatest(platform_request_limits.blocked_until, EXCLUDED.blocked_until)`, [platform, retryAt]);
  },
};
