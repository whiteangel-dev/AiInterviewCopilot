import { describe, expect, it } from 'vitest';
import { INVOKE_CHANNELS } from './channels';
import { ApiKeySchema, ExternalUrlSchema, invokeContract } from './contract';

describe('invoke contract', () => {
  it('has a schema for every channel', () => {
    expect(Object.keys(invokeContract).sort()).toEqual([...INVOKE_CHANNELS].sort());
  });

  it('validates API keys', () => {
    expect(ApiKeySchema.safeParse('  ' + 'A'.repeat(39) + '\n').data).toBe('A'.repeat(39));
    expect(ApiKeySchema.safeParse('short').success).toBe(false);
    expect(ApiKeySchema.safeParse('has a space in it, which is wrong').success).toBe(false);
  });

  it('only allows https links to known hosts', () => {
    expect(ExternalUrlSchema.safeParse('https://aistudio.google.com/apikey').success).toBe(true);
    expect(ExternalUrlSchema.safeParse('http://aistudio.google.com/apikey').success).toBe(false);
    expect(ExternalUrlSchema.safeParse('https://evil.example/aistudio.google.com').success).toBe(
      false,
    );
    expect(ExternalUrlSchema.safeParse('file:///etc/passwd').success).toBe(false);
  });
});
