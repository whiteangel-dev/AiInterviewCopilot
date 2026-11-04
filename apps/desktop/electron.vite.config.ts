import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

// drizzle-orm's driver imports `better-sqlite3`; we ship the encrypted build instead.
const sqliteAlias = { find: /^better-sqlite3$/, replacement: 'better-sqlite3-multiple-ciphers' };

export default defineConfig({
  main: {
    resolve: { alias: [sqliteAlias] },
    build: {
      // Only `dependencies` (the native SQLite module) stay external; everything else,
      // including the @aic/* workspace packages, is bundled for fast startup.
      externalizeDeps: true,
      sourcemap: true,
      // The engine (src/engine) is imported with `?modulePath`, which builds it as a
      // separate bundle that shares no chunks with the main process.
      rolldownOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    build: {
      // Sandboxed preloads can't load other files: bundle everything into one script.
      externalizeDeps: false,
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          capture: resolve(__dirname, 'src/preload/capture.ts'),
        },
        output: { format: 'cjs' },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    build: {
      minify: true,
      rolldownOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          copilot: resolve(__dirname, 'src/renderer/copilot.html'),
          capture: resolve(__dirname, 'src/renderer/capture.html'),
          // Served to phones on the local network (src/main/phone-server.ts).
          phone: resolve(__dirname, 'src/renderer/phone.html'),
        },
      },
    },
  },
});
