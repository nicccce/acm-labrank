import { getPool } from './client';

export interface ScoringSettingsRecord { rules: unknown; version: number }
export async function getScoringSettingsRecord(): Promise<ScoringSettingsRecord> {
  const row = (await getPool().query<ScoringSettingsRecord>('SELECT rules,version FROM scoring_settings WHERE id=1')).rows[0];
  if (!row) throw new Error('SCORING_SETTINGS_MISSING');
  return row;
}
export async function updateScoringSettingsRecord(input: ScoringSettingsRecord, actorId: string): Promise<ScoringSettingsRecord | null> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query<ScoringSettingsRecord>('UPDATE scoring_settings SET rules=$1,version=version+1,updated_at=now(),updated_by=$2 WHERE id=1 AND version=$3 RETURNING rules,version', [JSON.stringify(input.rules), actorId, input.version])).rows[0];
    if (row) await client.query("INSERT INTO collection_audit_logs(actor_id,action,target,details) VALUES ($1,'scoring_settings_updated','scoring',$2)", [actorId, JSON.stringify(row)]);
    await client.query('COMMIT');
    return row ?? null;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}
