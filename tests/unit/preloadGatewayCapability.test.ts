import { describe, expect, it, vi } from 'vitest';

/**
 * The capability gate: the shared tree's gateway device source appears only
 * when the preload's `gateway` group satisfies the defensive probe
 * (gatewayCapability) — defaultServerUrl plus four callable methods. This is
 * the test that keeps a preload regression from silently hiding the picker
 * section again.
 */

const state = vi.hoisted(() => {
  (globalThis as { window?: unknown }).window = {};
  return { expose: vi.fn() };
});
vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: state.expose },
  ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), invoke: vi.fn(async () => undefined), send: vi.fn() },
  webFrame: {},
}));
import '../../src/preload/index';
import { provideApi } from '@ui/app/ipc';
import { gatewayCapability } from '@ui/app/platformCapabilities';
import type { PocketShellApi } from '@ui/app/api';

describe('preload gateway capability', () => {
  it('exposes a gateway group the shared capability probe accepts', () => {
    // Without context isolation the preload assigns window.api directly.
    const exposed = (globalThis as { window?: { api?: PocketShellApi } }).window?.api;
    expect(exposed).toBeTruthy();
    provideApi(exposed!);
    expect(gatewayCapability()).toBe(exposed?.gateway);
    expect(exposed?.gateway?.defaultServerUrl).toBe('wss://gateway.pocketshell.io');
    expect(exposed?.gateway?.devices).toBeTypeOf('function');
    expect(exposed?.gateway?.pairings).toBeTypeOf('function');
    expect(exposed?.gateway?.clientKeys).toBeTypeOf('function');
    expect(exposed?.gateway?.addDevice).toBeTypeOf('function');
    expect(exposed?.gateway?.createClientKey).toBeTypeOf('function');
  });
});
