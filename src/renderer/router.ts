import { createRouter, createMemoryHistory, type RouteRecordRaw } from 'vue-router';
import HostPickerView from '@ui/app/views/HostPickerView.vue';
import HostWorkspaceView from '@ui/app/views/HostWorkspaceView.vue';
import FolderWorkspaceView from '@ui/app/views/FolderWorkspaceView.vue';
import SessionPlaceholderView from '@ui/app/views/SessionPlaceholderView.vue';
import SessionRedirectView from '@ui/app/views/SessionRedirectView.vue';

// Memory history (not hash/history) — Electron loads a single file, and we
// navigate within the window without touching a real URL bar.
//
// Three levels, each with a route so "back" is a real navigation:
//   hosts          -> pick a host
//   host-sessions  -> connected host, no folder picked yet. The session panel
//                     is part of the host shell, so this route only supplies
//                     the right pane's empty state.
//   folder         -> one FOLDER's workspace: a tab per tmux session in it,
//                     plus one or more Files tabs.
//
// `:folder` is the folder's `directoryKey` — `~/git/dtc-website`. vue-router
// encodes route params, so the slashes and the `~` survive a round trip
// without any escaping of our own.
//
// The active tab is a QUERY parameter (`?tab=<id>`) rather than a path
// segment, for two reasons: it is a view preference within one destination
// rather than a destination of its own, and a Files tab has no name that
// belongs in a path. Omitting it selects the first tab.
//
// `session/:session` used to BE the workspace route. It is now a resolver that
// replaces itself with the folder holding that session — see
// views/SessionRedirectView.vue for why the old shape is honoured rather than
// deleted, and why that is not a backwards-compatibility shim.
const routes: RouteRecordRaw[] = [
  { path: '/', name: 'hosts', component: HostPickerView },
  {
    path: '/host/:name',
    component: HostWorkspaceView,
    children: [
      { path: '', name: 'host-sessions', component: SessionPlaceholderView },
      {
        path: 'folder/:folder',
        name: 'folder',
        component: FolderWorkspaceView,
      },
      {
        path: 'session/:session',
        name: 'session',
        component: SessionRedirectView,
      },
    ],
  },
];

export const router = createRouter({
  history: createMemoryHistory(),
  routes,
});
