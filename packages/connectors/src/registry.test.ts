import { expect, it } from 'vitest';
import { getConnector } from './registry';
import { ConnectorError, type PlatformId } from './contracts/index';
import { qojConnector } from './qoj/index';

it('registers QOJ individual submissions and rejects unregistered adapters explicitly', () => {
  expect(getConnector('qoj')).toBe(qojConnector);
  expect(getConnector('qoj').capabilities).toEqual({ submissions: true, teamEvidence: false, participations: 'none' });
  expect(() => getConnector('unregistered' as PlatformId)).toThrow(ConnectorError);
  expect(() => getConnector('unregistered' as PlatformId)).toThrow(expect.objectContaining({ code: 'NOT_IMPLEMENTED' }));
});
