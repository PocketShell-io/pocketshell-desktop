// The preload bridge, typed by the preload's own api object. The shared app
// tree receives it through provideApi() in main.ts — this declaration is what
// makes `window.api` type-check at that one call site. Ambient module file,
// because the augmentation needs an import and env.d.ts must stay a global
// script for the `*.vue` shim.
import type { Api } from '../preload';

declare global {
  interface Window {
    api: Api;
  }
}
