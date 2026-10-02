import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { encryptLuoguSession, decryptLuoguSession } from './luogu-session';

it('authenticates the encrypted jar, key version and connection identity', () => {
  const key = randomBytes(32);
  const secret = '{"jar":"fixture-only-cookie"}';
  const encrypted = encryptLuoguSession(secret, key, 'fixture-connection');
  expect(encrypted).not.toContain('fixture-only-cookie');
  expect(decryptLuoguSession(encrypted, key, 'fixture-connection')).toBe(secret);
  expect(() => decryptLuoguSession(encrypted, key, 'different-connection')).toThrow();
  expect(() => decryptLuoguSession(encrypted, randomBytes(32), 'fixture-connection')).toThrow();
  const envelope = JSON.parse(encrypted);
  envelope.ciphertext = Buffer.from('tampered').toString('base64');
  expect(() => decryptLuoguSession(JSON.stringify(envelope), key, 'fixture-connection')).toThrow();
});
