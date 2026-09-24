/*
 * reconnectBackoff lives in @pocketshell/core now (packages: src/shared) — one implementation
 * for desktop main, preload, renderer, and the web workspace. This file keeps
 * the desktop's import paths stable.
 */
export * from '@pocketshell/core/shared/reconnectBackoff';
