export const PRODUCT_TIMEZONE = 'Asia/Shanghai';
export const SCORING_VERSION = 'v2';
export * from './scoring';

export function displayName(user: { username: string; realName: string | null; verifiedCfHandle?: string | null }): string {
  return user.realName?.trim() || user.verifiedCfHandle || user.username;
}
