import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import vue from '@vitejs/plugin-vue';
import { resolve } from 'node:path';

// electron-vite builds three targets: main, preload (Node), and renderer (browser).
// The renderer is sandboxed (contextIsolation: true, nodeIntegration: false),
// so only the preload may bridge to Node via contextBridge.
export default defineConfig({
  main: {
    // `externalizeDepsPlugin` externalises whatever package.json lists under
    // `dependencies` — which is why that list is now exactly ONE package,
    // ssh2: a native binding plus a helper .exe that Vite must not swallow,
    // and the only thing the packaged app opens node_modules for. Everything
    // else is a build input and lives in devDependencies, so it is bundled
    // here and never copied into the installer. See
    // tests/unit/packagedDependencies.test.ts for the rule and what it cost to
    // learn it.
    //
    // electron-store MUST NOT. It is pure ESM (`"type": "module"` since v9),
    // while electron-vite emits CJS for main, so leaving it external makes the
    // bundle `require()` an ES module and Electron dies at startup with
    // ERR_REQUIRE_ESM before a window ever opens. Excluding it from
    // externalisation lets Vite transpile it into the CJS output.
    //
    // `marked` — the markdown preview's converter — is named here as a BELT to
    // the rule above's braces. Today it sits in devDependencies, so it is
    // bundled anyway and this entry changes nothing. It is written down because
    // moving it back to `dependencies` would look like a tidy-up and would in
    // fact be a crash: since v5 the package ships ESM only (`exports: { '.':
    // './lib/marked.esm.js' }`, no CJS entry) and Electron 33 is Node 20, which
    // predates `require(esm)` — so externalised it throws ERR_REQUIRE_ESM the
    // first time anyone opens a `.md`. Nothing would catch that, because unit
    // tests run under Vitest's ESM loader where the import works fine.
    plugins: [externalizeDepsPlugin({ exclude: ['electron-store', 'marked'] })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [vue()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        '@ui': resolve(__dirname, 'packages/ui/src'),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
  },
});
