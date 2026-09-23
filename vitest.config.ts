import { defineConfig, type Plugin } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

// Unit + integration tests share one vitest config. Integration tests use
// testcontainers and auto-skip when Docker is unavailable (see
// tests/integration/helpers.ts). The "test:unit" and "test:integration"
// npm scripts select a subset via --dir.
//
// The Vue plugin is here so a renderer COMPONENT can be tested directly rather
// than only through its store. It compiles `.vue` files and is inert for every
// other test. The suite's default environment stays `node`; the handful of
// specs that need a DOM opt in per file with `@vitest-environment jsdom`, which
// keeps the cost of jsdom off the ~30 tests that have no use for it.
export default defineConfig({
  // The cast bridges two copies of Vite, not two behaviours. vitest 2.x depends
  // on Vite 5 and resolves its own nested copy, while the app builds on the
  // Vite 6 that electron-vite pulls in; `Plugin` is structurally the same type
  // in both and nominally different, so tsc rejects the value that works
  // perfectly at runtime. Re-exporting vitest's own `Plugin` keeps the assertion
  // pointed at the version this file is actually type-checked against.
  plugins: [vue() as unknown as Plugin],
  test: {
    environment: 'node',
    globals: false,
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000, // testcontainers builds can be slow on first run
    hookTimeout: 120_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      // Renderer and shared code are covered by the unit suite too (stores,
      // pure modules, mounted components), so the report has to include them
      // or it would silently claim the whole tree is main-only.
      include: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'src/renderer/**/*.ts', 'src/shared/**/*.ts'],
      exclude: ['**/*.d.ts', 'tests/**', 'src/renderer/env.d.ts'],
    },
  },
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@ui': resolve(__dirname, '../pocketshell-core/packages/ui/src'),
    },
  },
});
