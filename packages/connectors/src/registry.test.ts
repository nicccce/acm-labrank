import { expect, it } from 'vitest';
import { getConnector } from './registry';
import { ConnectorError } from './contracts/index';

it('reports an unavailable adapter explicitly', () => {
  expect(() => getConnector('codeforces')).toThrow(ConnectorError);
  try { getConnector('luogu'); } catch (error) {
    expect(error).toMatchObject({ code: 'NOT_IMPLEMENTED' });
  }
});
