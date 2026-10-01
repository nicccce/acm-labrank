import { describe, expect, it } from 'vitest';
import { csrfTokenForSession, validateCsrf, credentialsSchema } from './auth';

describe('session protection', () => {
  it('binds CSRF to the session and rejects malformed input', () => {
    const token = 'a'.repeat(43);
    const csrf = csrfTokenForSession(token);
    expect(validateCsrf(token, csrf)).toBe(true);
    expect(validateCsrf('b'.repeat(43), csrf)).toBe(false);
    expect(validateCsrf(token, null)).toBe(false);
    expect(validateCsrf(token, 'abcd')).toBe(false);
    expect(validateCsrf(token, 'x'.repeat(64))).toBe(false);
  });
  it('normalizes usernames without changing passwords', () => {
    const password = ' a long password ';
    expect(credentialsSchema.parse({ username: ' Member_01 ', password })).toEqual({ username: 'member_01', password });
    expect(credentialsSchema.safeParse({ username: 'ab', password }).success).toBe(false);
    expect(credentialsSchema.safeParse({ username: 'member', password: 'short' }).success).toBe(false);
  });
});
