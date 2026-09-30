import { createRouter, createMemoryHistory } from 'vue-router';
import { createAppRoutes } from '@ui/app/routes';

// The shared route map (@ui/app/routes.ts documents its shape) on memory
// history — Electron loads a single file, and we navigate within the window
// without touching a real URL bar. The desktop adds no routes of its own:
// its account surface is a second WINDOW (App.vue), not a route.
export const router = createRouter({
  history: createMemoryHistory(),
  routes: createAppRoutes(),
});
