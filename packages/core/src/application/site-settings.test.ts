import { describe, expect, it } from 'vitest';
import { siteSettingsSchema } from './site-settings';

describe('site text settings', () => {
  it('allows empty branding and keeps multiline text as plain text', () => {
    expect(siteSettingsSchema.parse({ headerText: '  ', loginText: '  ', version: 1 })).toEqual({ headerText: '', loginText: '', version: 1 });
    expect(siteSettingsSchema.parse({ headerText: '实验室', loginText: '训练记录\n<script>alert(1)</script>', version: 2 }).loginText).toBe('训练记录\n<script>alert(1)</script>');
  });
  it('rejects oversized text, missing concurrency versions and extra settings', () => {
    const input = { headerText: '', loginText: '', version: 1 };
    for (const value of [{ ...input, headerText: 'x'.repeat(81) }, { ...input, loginText: 'x'.repeat(801) }, { ...input, version: 0 }, { ...input, role: 'admin' }]) expect(siteSettingsSchema.safeParse(value).success).toBe(false);
    expect(siteSettingsSchema.safeParse({ headerText: '', loginText: '' }).success).toBe(false);
  });
});
