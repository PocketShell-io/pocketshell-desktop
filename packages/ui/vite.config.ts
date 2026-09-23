import vue from '@vitejs/plugin-vue';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [vue()],
  build: {
    outDir: resolve(PACKAGE_ROOT, '../../out/ui'),
    emptyOutDir: true,
    lib: {
      entry: resolve(PACKAGE_ROOT, 'src/browser.ts'),
      formats: ['es'],
      fileName: 'ui',
    },
    rollupOptions: {
      // Vue is supplied by the consuming app; the theme module's xterm use is
      // type-only and disappears from this browser bundle.
      external: ['vue'],
    },
  },
});
