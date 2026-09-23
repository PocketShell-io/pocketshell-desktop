# Shared Vue UI source

This private source package is shared by PocketShell Desktop and the JS-first
Android app. Consumers pin the desktop repository commit and import these files
directly; this package is not published to npm.

## Browser entry points

- `src/index.ts` exports the theme and font policy, `AppIcon`, and
  `ComposerControls`.
- `src/styles.css` loads Inter Variable, the shared token defaults and common
  CSS primitives. Import it once in the browser app.
- `src/browser.ts` combines both entry points for an isolated Vite build.

## Consumer dependencies

The source package expects these modules in the consuming browser toolchain:

- `vue` 3.5 or compatible, as the runtime for the exported Vue components.
- `@xterm/xterm` 6 or compatible for the `ITheme` type used by the theme
  records; this is a type-only import and is absent from the runtime bundle.
- `@fontsource-variable/inter` 5 or compatible, resolved by `styles.css` and
  bundled locally so rendering does not depend on a network font fetch.

The consumer's bundler must process Vue single-file components and CSS imports.
The desktop app currently tests against Vue 3.5.13, `@xterm/xterm` 6.0.0,
`@fontsource-variable/inter` 5.3.0, and Vite 6. Android can use its existing
compatible versions or pin these tested versions in its rewrite.

The desktop app maps `@ui` to this directory. Android can map
`@pocketshell/ui` to a pinned checkout's `packages/ui/src` and import
`styles.css` alongside the entry. Components exchange state only through
props and emitted events. Keep Electron IPC, Pinia stores, SSH and host I/O in
the application.

The mono font policy accepts a consumer fallback stack. Desktop uses its
Consolas default; Android should provide the bundled JetBrains Mono stack
specified by the rewrite plan.

Build and typecheck this source without the Electron app from the desktop repo
with `npm run build:ui` and `npm run typecheck:ui`.
