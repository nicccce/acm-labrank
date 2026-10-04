import { getPool } from './client';
export interface SiteSettingsRecord { headerText: string; loginText: string; version: number }

const columns = 'header_text AS "headerText",login_text AS "loginText",version';
export async function initializeSiteSettings() { await getPool().query('INSERT INTO site_settings(id) VALUES (1) ON CONFLICT DO NOTHING'); }
export async function getSiteSettingsRecord(): Promise<SiteSettingsRecord> {
  return (await getPool().query<SiteSettingsRecord>(`SELECT ${columns} FROM site_settings WHERE id=1`)).rows[0] ?? { headerText: '', loginText: '', version: 1 };
}
export async function updateSiteSettingsRecord(input: SiteSettingsRecord, actorId: string): Promise<SiteSettingsRecord | null> {
  return (await getPool().query<SiteSettingsRecord>(`UPDATE site_settings SET header_text=$1,login_text=$2,version=version+1,updated_at=now(),updated_by=$3 WHERE id=1 AND version=$4 RETURNING ${columns}`, [input.headerText, input.loginText, actorId, input.version])).rows[0] ?? null;
}
