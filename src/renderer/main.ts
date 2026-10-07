import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { markRaw } from 'vue';
import '@ui/styles.css';
import App from './App.vue';
import { router } from './router';
import { recordDiagError } from '@ui/app/diag';
import { provideApi, api } from '@ui/app/ipc';
import { provideExtensions } from '@ui/app/extensions';
import { useConnectionStore } from '@ui/app/stores/connection';
import LocalShellSettingsSection from './LocalShellSettingsSection.vue';

/**
 * The three nets under "an unhandled renderer error must be visible".
 *
 * `errorHandler` covers Vue's own pipeline — lifecycle hooks, watchers, and
 * RENDER FUNCTIONS, which is where the usage panel's blank-panel bug lived: a
 * throw mid-render used to abort the patch and leave the screen empty, with
 * the error going nowhere a packaged app could read. The two window listeners
 * cover everything outside Vue's knowledge: unhandled promise rejections
 * (`errorHandler` does not see them) and window-level `error` events, gated on
 * `e.error` because resource-load errors fire the same event with no error
 * object and no useful message.
 *
 * All three land in `recordDiagError`, which forwards to the desktop log and
 * raises the app-wide strip. None rethrows: the app continues past a failed
 * component rather than dying with it.
 */
// The Electron preload bridge IS the transport. Everything above the seam
// (@ui/app) is platform-agnostic; this is the one line that binds them. The
// hosts capability is composed here rather than living in the bridge: it is
// platform COPY, not transport — this platform names the config file it reads.
provideApi({
  ...window.api,
  hosts: {
    groupLabel: 'From ~/.ssh/config',
    sourceName: '~/.ssh/config',
    emptyHint: 'No hosts found in ~/.ssh/config. Add one there to get started.',
  },
});

// The desktop's own Settings section: the local terminal's shell (Settings →
// Advanced → Local terminal). Contributed, not shared — the shared app must
// not branch on platform, and a platform without local hosts has no use for
// the choice.
provideExtensions({
  'settings.sections': [
    {
      id: 'local-shell',
      title: 'Local terminal',
      component: markRaw(LocalShellSettingsSection),
    },
  ],
});

const app = createApp(App);
app.config.errorHandler = (err): void => {
  recordDiagError('render', err);
};
window.addEventListener('unhandledrejection', (e) => {
  recordDiagError('unhandledrejection', e.reason);
});
window.addEventListener('error', (e) => {
  if (e.error) recordDiagError('error', e.error);
});

const pinia = createPinia();
app.use(pinia).use(router).mount('#app');

// Sleep/wake (FEATURES.md F12): main announces the OS resume, the connection
// store answers with a liveness probe and reconnects if the link died in the
// night. The subscription lives HERE rather than inside the store's setup —
// the store must stay creatable under the partial ipc mocks every component
// test uses, and this is app-level wiring, not store state.
api.app.onResumed(() => void useConnectionStore(pinia).onOsResume());
