import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * What is allowed into the installer, executed rather than remembered.
 *
 * electron-builder copies production `dependencies` (and their transitive
 * trees) into the packaged app's node_modules, and leaves `devDependencies`
 * behind. The renderer, meanwhile, is bundled by Vite into out/renderer and
 * carries its own copy of everything it imports — so a renderer library listed
 * in `dependencies` ships TWICE: once compiled into the bundle, once as raw
 * source nothing will ever `require`.
 *
 * That is not hypothetical. `c2fe2bb` put twenty `@codemirror/*` packages in
 * `dependencies` "to match this repo's convention", because vue, pinia and
 * `@xterm/*` were already there — and the convention was itself the bug. The
 * package trees involved come to roughly 22 MB on disk. `keytar` and
 * `ssh2-sftp-client` were worse than that: both were in `dependencies`,
 * neither was imported by a single line of this app, and keytar is a native
 * module, so every `npm run dist` stopped to rebuild a binary nobody loads.
 *
 * The rule this file enforces is therefore not "keep the list short". It is:
 *
 *     `dependencies` means REQUIRED FROM DISK BY THE PACKAGED APP.
 *     Anything `import`ed by the renderer, or by main via a bundled path,
 *     belongs in `devDependencies` — it is a build input, not a shipped file.
 *
 * A new entry here is a claim that something reads it out of node_modules at
 * runtime. Write the reason next to it in ALLOWED, and the test passes.
 */

const ROOT = resolve(__dirname, '..', '..');
const pkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

/**
 * Every package the PACKAGED app loads from node_modules, and why.
 *
 * Both entries are external to the main bundle on purpose: `externalizeDepsPlugin`
 * in electron.vite.config.ts externalises exactly what is listed in
 * `dependencies`, so this list and that plugin are two views of one decision.
 */
const ALLOWED: Record<string, string> = {
  ssh2: 'Native/CJS transport for every SSH connection; main-process only, and left external because it carries a native binding and a helper .exe that Vite must not swallow.',
  '@lydell/node-pty': "Native ConPTY/pty bindings for the self connection's local PTY shells (session joins, the bare terminal); main-process only, required lazily from local/LocalHost. This fork ships prebuilt N-API binaries per platform, so no electron-rebuild step is needed for dev or for the packaged build.",
};

/**
 * Families that are always renderer build inputs. Listed separately from the
 * allow-list check so the failure message can say WHICH mistake was made — an
 * unexplained new runtime dependency and a re-imported bundled library are
 * different errors with different fixes.
 */
const BUNDLED_PREFIXES = ['@codemirror/', '@lezer/', '@xterm/', '@fontsource'];
const BUNDLED_EXACT = ['vue', 'vue-router', 'pinia', 'electron-store', 'marked'];

describe('what ships in the installer', () => {
  it('lists only packages the packaged app requires at runtime', () => {
    const declared = Object.keys(pkg.dependencies ?? {}).sort();
    const undocumented = declared.filter((name) => !(name in ALLOWED));
    expect(
      undocumented,
      'A package in `dependencies` ships into every installer. If the packaged app really does require() it from disk, add it to ALLOWED in this file with the reason. If it is imported and bundled instead (anything in the renderer, or main code Vite compiles in), move it to devDependencies.',
    ).toEqual([]);
  });

  it('keeps renderer-bundled libraries out of dependencies', () => {
    const declared = Object.keys(pkg.dependencies ?? {});
    const offenders = declared.filter(
      (name) =>
        BUNDLED_PREFIXES.some((prefix) => name.startsWith(prefix)) || BUNDLED_EXACT.includes(name),
    );
    expect(
      offenders,
      'These are compiled into out/renderer (or, for electron-store, into out/main) by Vite. Declaring them as runtime dependencies duplicates their source into the installer — the CodeMirror mistake.',
    ).toEqual([]);
  });

  it('still has those libraries as devDependencies, so the build can find them', () => {
    // The other half of the move: dropping a package rather than relocating it
    // would break `npm run build`, and would do it in a way this gate would
    // otherwise call a pass.
    const dev = pkg.devDependencies ?? {};
    for (const name of ['vue', 'pinia', 'vue-router', '@xterm/xterm', '@codemirror/state']) {
      expect(dev[name], `${name} must stay installed as a build input`).toBeTruthy();
    }
  });
});

/**
 * The same rule read off the BUILT bundle instead of off the intent.
 *
 * Only runs when out/ is present — `npm run test:unit` does not build — but it
 * is the check that would actually catch a package moved to devDependencies
 * that main still reaches for at runtime, which is a crash on the user's
 * machine and nowhere else.
 */
describe('the built main bundle', () => {
  const bundles = ['out/main/index.js', 'out/preload/index.js']
    .map((p) => resolve(ROOT, p))
    .filter((p) => existsSync(p));

  it.skipIf(bundles.length === 0)('requires nothing that is not declared', () => {
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const missing = new Set<string>();
    for (const file of bundles) {
      const source = readFileSync(file, 'utf8');
      // A require() that is not itself inside a string. ajv ships code
      // GENERATION templates — `equal.code = 'require("ajv/dist/runtime/equal")'`
      // — which are data for a standalone-compile mode this app never uses;
      // matching them would report a runtime dependency that does not exist.
      for (const match of source.matchAll(/(^|[^'"`\\])require\("([^"]+)"\)/g)) {
        const specifier = match[2] ?? '';
        if (specifier.startsWith('node:') || specifier.startsWith('.')) continue;
        if (specifier === 'electron') continue;
        // Node builtins are spelled bare in places too.
        if (!specifier.includes('/') && isBuiltin(specifier)) continue;
        const name = specifier.startsWith('@')
          ? specifier.split('/').slice(0, 2).join('/')
          : (specifier.split('/')[0] ?? specifier);
        if (!declared.has(name)) missing.add(name);
      }
    }
    expect(
      [...missing],
      'The built bundle require()s these from node_modules, but they are not in `dependencies`, so electron-builder will not ship them and the packaged app will crash on startup.',
    ).toEqual([]);
  });
});

/** Node's own modules, spelled without the `node:` prefix. */
function isBuiltin(name: string): boolean {
  return [
    'assert',
    'buffer',
    'child_process',
    'crypto',
    'events',
    'fs',
    'http',
    'https',
    'net',
    'os',
    'path',
    'process',
    'stream',
    'string_decoder',
    'timers',
    'tls',
    'tty',
    'url',
    'util',
    'zlib',
  ].includes(name);
}
