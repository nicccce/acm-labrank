import type { PlatformId } from './contracts/index';

export const platforms = [
  { id: 'codeforces', name: 'Codeforces', milestone: 'P1', requiresLogin: false },
  { id: 'qoj', name: 'QOJ', milestone: 'P2', requiresLogin: true },
  { id: 'luogu', name: '洛谷', milestone: 'P2', requiresLogin: true },
] as const satisfies readonly { id: PlatformId; name: string; milestone: string; requiresLogin: boolean }[];

export function isPlatformId(input: string): input is PlatformId {
  return platforms.some((platform) => platform.id === input);
}
