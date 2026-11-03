import { defineProject } from 'vitest/config';

export default defineProject({
  resolve: {
    // drizzle-orm's driver imports `better-sqlite3`; we ship the encrypted build instead.
    alias: [{ find: /^better-sqlite3$/, replacement: 'better-sqlite3-multiple-ciphers' }],
  },
  test: {
    name: '@aic/db',
    server: { deps: { inline: ['drizzle-orm'] } },
  },
});
