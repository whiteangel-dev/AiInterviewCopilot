import { afterEach, describe, expect, it } from 'vitest';
import { redact, registerSecret, unregisterSecret } from './redact';

// Built at runtime so secret scanners don't flag the fixture.
const fakeGoogleKey = ['AI', 'za', 'Sy', 'X'.repeat(33)].join('');

describe('redact', () => {
  afterEach(() => unregisterSecret('custom-secret-value'));

  it('removes known key formats', () => {
    expect(redact(`key ${fakeGoogleKey} end`)).toBe('key <redacted-key> end');
    expect(redact('Bearer sk-' + 'a'.repeat(30))).toBe('Bearer <redacted-key>');
    expect(redact('https://x.test/v1/models?key=abc123&pageSize=5')).toBe(
      'https://x.test/v1/models?key=<redacted>&pageSize=5',
    );
    expect(redact('{"x-goog-api-key":"abcdef123456"}')).toBe('{"x-goog-api-key":"<redacted>"}');
  });

  it('removes registered secrets of any shape', () => {
    registerSecret('custom-secret-value');
    expect(redact('db key custom-secret-value!')).toBe('db key <redacted>!');
  });

  it('ignores secrets too short to match safely', () => {
    registerSecret('abc');
    expect(redact('abc')).toBe('abc');
  });
});
