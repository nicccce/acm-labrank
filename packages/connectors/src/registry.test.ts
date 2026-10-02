import { expect, it } from 'vitest';
import { getConnector } from './registry';
import { ConnectorError } from './contracts/index';
import type { PlatformId } from './contracts/index';
import { codeforcesConnector } from './codeforces/index';
import { luoguConnector } from './luogu/index';
import { qojConnector } from './qoj/index';

it('explicitly registers Codeforces and rejects unregistered adapters', () => {
  expect(getConnector('codeforces')).toBe(codeforcesConnector);
  expect(() => getConnector('unregistered' as PlatformId)).toThrow(ConnectorError);
  expect(() => getConnector('unregistered' as PlatformId)).toThrow(expect.objectContaining({ code: 'NOT_IMPLEMENTED' }));
});

it('registers Luogu individual submissions without claiming teams or VP', () => {
  expect(getConnector('luogu')).toBe(luoguConnector);
  expect(getConnector('luogu').capabilities).toEqual({ submissions: true, teamEvidence: false, participations: 'none' });
});

it('registers QOJ individual submissions and rejects unregistered adapters explicitly', () => {
  expect(getConnector('qoj')).toBe(qojConnector);
  expect(getConnector('qoj').capabilities).toEqual({ submissions: true, teamEvidence: false, participations: 'none' });
  expect(() => getConnector('unregistered' as PlatformId)).toThrow(ConnectorError);
  expect(() => getConnector('unregistered' as PlatformId)).toThrow(expect.objectContaining({ code: 'NOT_IMPLEMENTED' }));
});
