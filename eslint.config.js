/**
 * ESLint 9 flat config for pocketshell-desktop.
 *
 * This repo is an Electron app with three build targets (electron.vite.config.ts)
 * and two TypeScript projects:
 *
 *   src/main/**      Electron main process   node globals   tsconfig.node.json
 *   src/preload/**   contextBridge preload   node globals   tsconfig.node.json
 *   src/renderer/**  Vue 3 SPA, sandboxed    browser        tsconfig.web.json
 *   src/shared/**    types + channel names   (neither)      both projects
 *   tests/unit,integration                   node globals   tsconfig.node.json
 *   tests/e2e        Playwright + Electron   node globals   (no TS project)
 *
 * package.json has no "type": "module", so this file is CommonJS.
 *
 * File selection lives entirely in the `files` globs below — that is what makes
 * a bare `eslint .` pick up .ts and .vue now that ESLint 9 has removed --ext.
 *
 * Type-aware linting is ON (recommendedTypeChecked). It is what catches the
 * class of defect that actually matters in this codebase: unhandled promise
 * rejections in the Electron startup path and in vue-router navigation, and
 * `any` leaking out of JSON.parse at the helper-protocol boundary. The cost is
 * that ESLint builds the TS program, so a full run takes a few seconds.
 */

const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const pluginVue = require('eslint-plugin-vue');
const globals = require('globals');

/** Build artifacts, deps and non-source fixtures. */
const IGNORES = [
  'node_modules/**',
  // A nested checkout (teammate worktrees live here); never lint another
  // checkout's sources.
  'worktrees/**',
  // A nested checkout (teammate worktrees live here); never lint another
  // checkout's sources.
  'worktrees/**',
  'out/**',
  'dist/**',
  'dist-electron/**',
  'build/**',
  'release/**',
  'coverage/**',
  'playwright-report/**',
  'test-results/**',
  '.playwright/**',
  // Shell scripts, Dockerfiles and JSONL sample data — not app source.
  'tests-docker/**',
  'docs/**',
];

/** Everything we lint. */
const ALL = ['**/*.{js,cjs,mjs,ts,mts,cts,vue}'];
/** TypeScript, including the <script lang="ts"> block of an SFC. */
const TS = ['**/*.{ts,mts,cts,vue}'];

module.exports = tseslint.config(
  { ignores: IGNORES },

  // =====================================================================
  // Base rule sets
  // =====================================================================

  { files: ALL, ...js.configs.recommended },

  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: TS,
  })),

  // Vue: template correctness (flat/essential) + the strongly-recommended and
  // recommended tiers. The purely cosmetic subset is switched off further down.
  ...pluginVue.configs['flat/recommended'],

  // =====================================================================
  // Language options per target
  // =====================================================================

  // Type-aware parsing. There is no root tsconfig.json, so the two real
  // projects are named explicitly; src/shared is a member of both.
  {
    files: TS,
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.web.json'],
        tsconfigRootDir: __dirname,
      },
    },
  },

  // .vue is parsed by vue-eslint-parser (installed by flat/recommended), which
  // hands the script block to the TS parser. extraFileExtensions is required
  // for the TS program to accept .vue as a project file.
  {
    files: ['**/*.vue'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.browser,
      parserOptions: {
        parser: tseslint.parser,
        extraFileExtensions: ['.vue'],
      },
    },
  },

  // Renderer runs sandboxed (contextIsolation: true, nodeIntegration: false).
  // Its only path to Node is the preload contextBridge, so: browser globals only.
  {
    files: ['src/renderer/**/*.{ts,vue}'],
    languageOptions: { globals: globals.browser },
  },

  // Main, preload, build tooling and tests all run in Node.
  {
    files: [
      'src/main/**/*.ts',
      'src/preload/**/*.ts',
      'tests/**/*.ts',
      '*.config.ts',
      '*.config.js',
      'eslint.config.js',
      // scripts/ holds standalone build tooling run by `node`, not by any
      // bundler. .mjs so it can use ESM despite the package being CommonJS;
      // ESLint infers sourceType: module from the extension.
      'scripts/**/*.mjs',
    ],
    languageOptions: { globals: globals.node },
  },

  // This config file is CommonJS and is not part of any TS project.
  {
    files: ['**/*.js', '**/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },

  // tests/e2e is deliberately outside tsconfig.node.json's `include`, so no TS
  // program covers it. Syntax rules still apply; type-aware ones cannot.
  {
    files: ['tests/e2e/**/*.ts'],
    ...tseslint.configs.disableTypeChecked,
  },

  // =====================================================================
  // Rule tuning
  //
  // Every entry below is a deliberate deviation from the recommended sets,
  // with its reason. The bar used: switch a rule off only when it fires
  // broadly on an intentional, working pattern — never to hide a finding that
  // looks like an actual defect.
  // =====================================================================

  {
    files: TS,
    rules: {
      // The core rule cannot see TS syntax (type-only imports, parameter
      // properties), so the TS-aware version owns this. A leading underscore
      // is this repo's existing convention for "declared to satisfy a
      // signature, intentionally unused" — e.g. SshService.exec(_opts),
      // ipcMain.handle((_evt, ...)).
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],

      // Shadowing is a genuine hazard in the long nested callbacks around
      // ssh2/sftp; the TS-aware variant avoids false positives where a type
      // and a value legitimately share a name.
      'no-shadow': 'off',
      '@typescript-eslint/no-shadow': 'error',

      // OFF: `async` is used here as a *contract marker*, not as a promise of
      // internal awaiting. Every ipcMain.handle callback in src/main/ipc.ts is
      // declared async so the IPC surface is uniform even when the underlying
      // call is synchronous (ssh.shellInput, ssh.shellResize, ...); the same
      // applies to methods implementing an async interface
      // (AutoForwarderSupervisor.stop) and to the SFTP test doubles. Enforcing
      // this rule would mean either removing `async` from a public async
      // contract or adding no-op awaits — both worse than the current code.
      '@typescript-eslint/require-await': 'off',
    },
  },

  // ---------------------------------------------------------------------
  // Vue SFCs
  // ---------------------------------------------------------------------
  {
    files: ['**/*.vue'],
    rules: {
      // OFF: every component here is a single-word route target
      // (App, FileTree, TerminalView, UsageView, ...). The filenames are the
      // component names and are unambiguous; renaming them all would churn
      // every import and every route definition for zero safety gain.
      'vue/multi-word-component-names': 'off',

      // OFF (x4): pure whitespace/ordering formatters. This project has no
      // Prettier or any other formatter in its toolchain, and its templates
      // are deliberately compact — these four accounted for ~180 of the ~190
      // findings on the first run and carry no correctness signal whatsoever.
      // This is the same set eslint-config-prettier would disable. All of
      // eslint-plugin-vue's semantic rules (valid-v-*, require-v-for-key,
      // no-mutating-props, no-side-effects-in-computed-properties, ...) stay on.
      'vue/max-attributes-per-line': 'off',
      'vue/singleline-html-element-content-newline': 'off',
      'vue/html-self-closing': 'off',
      'vue/attributes-order': 'off',
    },
  },

  // ---------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------
  {
    files: ['tests/**/*.ts'],
    rules: {
      // OFF in tests only: test doubles stand in for the ssh2 / ssh2-sftp-client
      // surfaces, which are far larger than the slice under test, so they are
      // deliberately loosely typed (see the fake SFTP client in
      // tests/unit/AttachmentStager.test.ts).
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // NOTE on @typescript-eslint/no-require-imports: it stays ON everywhere,
  // including tests. This codebase already carries three hand-written
  // `// eslint-disable-next-line @typescript-eslint/no-require-imports`
  // comments (src/main/ssh-config/SshConfigParser.ts,
  // tests/integration/ForwardService.integration.test.ts), so the author's
  // intent is clearly "on, with targeted exemptions". Turning it off wholesale
  // would orphan those directives. The remaining unexempted call sites are
  // reported rather than silenced.
);
