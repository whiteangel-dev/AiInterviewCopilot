import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    alias: [{ find: /^better-sqlite3$/, replacement: 'better-sqlite3-multiple-ciphers' }],
  },
  test: {
    name: '@aic/desktop',
    include: ['src/**/*.test.ts'],
    server: { deps: { inline: ['drizzle-orm'] } },
  },
});
