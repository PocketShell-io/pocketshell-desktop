// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The typing intercept's DELIVERY, as opposed to its predicate.
 *
 * `isTypingKey` decides which keys are typing; composerText.test.ts pins that.
 * This file pins what happens to a key once the answer is yes, because that is
 * where the doubled-first-letter bug lived and no test of the predicate could
 * ever have caught it.
 *
 * ## Why the assertion is `defaultPrevented`
 *
 * The bug: `attachCustomKeyEventHandler` returning false stops XTERM, but
 * xterm's `_keyDown` bails at the custom handler and never calls its own
 * `cancel()` (its `_keyPress` does — that arm was not the one being taken). So
 * the DOM event survived un-cancelled, the browser performed the default
 * action, and by then the composer we had just opened owned the focus — so the
 * character was typed into the draft a second time, natively, on top of the
 * copy `typeInto` had planted.
 *
 * jsdom implements no default action for text input, so it cannot reproduce
 * that second copy and no jsdom test can assert "the draft is 'a' not 'aa'"
 * against the real mechanism. What it CAN assert is the thing that makes the
 * second copy impossible: the handler cancels the event. That is the contract,
 * it is exactly what regressed, and it fails if `preventDefault()` is removed.
 * The end-to-end proof over a real browser lives in tests/e2e/composer.spec.ts.
 */

/** Captures the handler TerminalView hands to xterm, so a test can drive it. */
let terminalWrites: string[] = [];
let selected = false;
let terminalData: ((data: string) => void) | null = null;
let customKeyHandler: ((e: KeyboardEvent) => boolean) | null = null;

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    loadAddon(): void {}
    open(): void {}
    focus(): void {}
    reset(): void {}
    write(data: string): void { terminalWrites.push(data); }
    paste(): void {}
    input(data: string): void { terminalData?.(data); }
    dispose(): void {}
    hasSelection(): boolean {
      return selected;
    }
    getSelection(): string {
      return 'selected text';
    }
    onData(fn: (data: string) => void): { dispose: () => void } {
      terminalData = fn;
      return { dispose: () => { terminalData = null; } };
    }
    onResize(): { dispose: () => void } {
      return { dispose: () => {} };
    }
    registerLinkProvider(): { dispose: () => void } {
      return { dispose: () => {} };
    }
    parser = {
      registerOscHandler(): { dispose: () => void } {
        return { dispose: () => {} };
      },
    };
    unicode = { activeVersion: '6', register: (): void => {} };
    attachCustomKeyEventHandler(fn: (e: KeyboardEvent) => boolean): void {
      customKeyHandler = fn;
    }
  },
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit(): void {}
    proposeDimensions(): undefined {
      return undefined;
    }
  },
}));
vi.mock('@xterm/addon-web-links', () => ({ WebLinksAddon: class {} }));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));

vi.mock('@ui/app/ipc', () => ({
  api: {
    ssh: { onState: vi.fn(() => () => {}) },
    helper: { sessionsList: vi.fn(async () => [{ name: 'main', tag: 'main', workspace: 'C:/workspace', aplexerId: '11111111-1111-4111-8111-111111111111', aplexerPhase: 'running' }]) },
    shell: {
      open: vi.fn(async () => 'shell-1'),
      attachSession: vi.fn(async () => ({ ok: true, shellId: 'shell-1' })),
      input: vi.fn(async () => true),
      resize: vi.fn(async () => true),
      close: vi.fn(async () => true),
      onData: vi.fn(() => () => {}),
      onExited: vi.fn(() => () => {}),
    },
  },
}));

enableAutoUnmount(afterEach);
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const TerminalView = (await import('@ui/app/components/TerminalView.vue')).default;

/** A keydown the way the browser makes one: cancelable, so it can be cancelled. */
function keydown(key: string, mods: Partial<KeyboardEventInit> = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, cancelable: true, bubbles: true, ...mods });
}

function mountTerminal(interceptTyping: boolean) {
  return mount(TerminalView, {
    props: { connectionId: 'conn-1', sessionKey: 'main', interceptTyping },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  setActivePinia(createPinia());
  customKeyHandler = null;
  terminalData = null;
  selected = false;
  terminalWrites = [];
});

describe('typing intercept — delivery', () => {
  it('CANCELS the key event, so the browser cannot type it a second time', () => {
    const wrapper = mountTerminal(true);
    const e = keydown('a');

    expect(customKeyHandler).not.toBeNull();
    expect(customKeyHandler!(e)).toBe(false);

    // The whole regression, in one line: an un-cancelled event is one the
    // browser goes on to deliver natively into whatever now has focus.
    expect(e.defaultPrevented).toBe(true);
    expect(wrapper.emitted('typed')).toEqual([['a']]);
  });

  it('emits the character exactly ONCE per keystroke', () => {
    const wrapper = mountTerminal(true);
    customKeyHandler!(keydown('a'));
    expect(wrapper.emitted('typed')).toHaveLength(1);
  });

  it('carries a capital through Shift without dropping or doubling it', () => {
    // Shift is deliberately not a "modifier" for this purpose: Shift-A is a
    // letter, and it takes the same path as any other letter.
    const wrapper = mountTerminal(true);
    const e = keydown('A', { shiftKey: true });
    expect(customKeyHandler!(e)).toBe(false);
    expect(e.defaultPrevented).toBe(true);
    expect(wrapper.emitted('typed')).toEqual([['A']]);
  });

  it('leaves control keys to the shell, uncancelled and unannounced', () => {
    const wrapper = mountTerminal(true);
    for (const e of [
      keydown('c', { ctrlKey: true }),
      keydown('Enter'),
      keydown('Escape'),
      keydown('ArrowUp'),
      keydown('Tab'),
      keydown(' '),
    ]) {
      expect(customKeyHandler!(e)).toBe(true);
      expect(e.defaultPrevented).toBe(false);
    }
    expect(wrapper.emitted('typed')).toBeUndefined();
  });

  it('does nothing at all when the intercept is off', () => {
    const wrapper = mountTerminal(false);
    const e = keydown('a');
    expect(customKeyHandler!(e)).toBe(true);
    expect(e.defaultPrevented).toBe(false);
    expect(wrapper.emitted('typed')).toBeUndefined();
  });

  it('ignores keyup and keypress, so one keystroke cannot emit twice', () => {
    // xterm consults this handler for more than keydown. Only keydown decides.
    const wrapper = mountTerminal(true);
    customKeyHandler!(keydown('a'));
    customKeyHandler!(new KeyboardEvent('keypress', { key: 'a', cancelable: true }));
    customKeyHandler!(new KeyboardEvent('keyup', { key: 'a', cancelable: true }));
    expect(wrapper.emitted('typed')).toHaveLength(1);
  });
});


describe('native Ctrl-b suffix remains terminal-owned with default composer typing', () => {
  it('passes Ctrl-b then d through the mounted production component without opening composer', async () => {
    const { api } = await import('@ui/app/ipc');
    const { useConnectionStore } = await import('@ui/app/stores/connection');
    const { useSettingsStore } = await import('@ui/app/stores/settings');
    const { useShellsStore } = await import('@ui/app/stores/shells');
    const { sessionIdentityKey } = await import('@ui/app/sessionIdentity');
    useConnectionStore().$patch({ state: 'connected', connectionId: 'conn-1' });
    const settings = useSettingsStore();
    expect(settings.typingOpensComposer).toBe(true);
    const uuid = '11111111-1111-4111-8111-111111111111';
    const wrapper = mount(TerminalView, { props: { connectionId: 'conn-1',
      sessionKey: 'C:/workspace::main', sessionName: 'main', workspace: 'C:/workspace',
      backend: 'aplexer', aplexerId: uuid, interceptTyping: true } });
    visible(terminalElement(wrapper));
    await flushPromises();
    expect(customKeyHandler).not.toBeNull();
    expect(terminalData).not.toBeNull();
    expect(useShellsStore().shellIdFor(sessionIdentityKey('main', { backend: 'aplexer', workspace: 'C:/workspace' }))).toBe('shell-1');
    vi.mocked(api.shell.input).mockClear();
    // The xterm fixture forwards bytes only if the real component handler permits it.
    const prefixEvent = keydown('b', { ctrlKey: true });
    expect(customKeyHandler!(prefixEvent)).toBe(true);
    terminalData!('');
    await flushPromises();
    expect(api.shell.input).toHaveBeenCalledWith('shell-1', '');
    const suffix = keydown('d');
    const allowed = customKeyHandler!(suffix);
    if (allowed) terminalData!('d');
    const evidence = { allowed, defaultPrevented: suffix.defaultPrevented,
      typed: wrapper.emitted('typed'), inputCalls: vi.mocked(api.shell.input).mock.calls };
    console.log('mounted-native-prefix-baseline', JSON.stringify(evidence));
    wrapper.unmount();
    expect(evidence).toMatchObject({ allowed: true, defaultPrevented: false });
    expect(evidence.typed).toBeUndefined();
    expect(evidence.inputCalls).toEqual([['shell-1', ''], ['shell-1', 'd']]);
  });
});


function terminalElement(wrapper: { element: unknown }): HTMLElement {
  if (!(wrapper.element instanceof HTMLElement)) throw new Error('Expected mounted terminal element');
  return wrapper.element;
}

function visible(element: Element, width = 800, height = 600): void {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: width },
    clientHeight: { configurable: true, value: height },
  });
}

async function nativePane(overrides: Partial<{
  connectionId: string; sessionKey: string; sessionName: string; workspace: string;
  backend: 'aplexer' | 'tmux'; aplexerId: string | null; bare: boolean; interceptTyping: boolean;
}> = {}) {
  const { useConnectionStore } = await import('@ui/app/stores/connection');
  const { useSettingsStore } = await import('@ui/app/stores/settings');
  const { useShellsStore } = await import('@ui/app/stores/shells');
  const { sessionIdentityKey } = await import('@ui/app/sessionIdentity');
  const connection = useConnectionStore();
  connection.$patch({ state: 'connected', connectionId: 'conn-1' });
  const props = { connectionId: 'conn-1', sessionKey: 'workspace-main', sessionName: 'main',
    workspace: 'C:/workspace', backend: 'aplexer' as const,
    aplexerId: '11111111-1111-4111-8111-111111111111', interceptTyping: true, ...overrides };
  const wrapper = mount(TerminalView, { props, attachTo: document.body });
  visible(terminalElement(wrapper));
  await flushPromises();
  expect(customKeyHandler).not.toBeNull();
  return { wrapper, connection, settings: useSettingsStore(), shells: useShellsStore(),
    key: sessionIdentityKey(props.sessionName, { backend: props.backend, workspace: props.workspace }) };
}

function prefix(mods: Partial<KeyboardEventInit> = {}): void {
  expect(customKeyHandler!(keydown('b', { ctrlKey: true, ...mods }))).toBe(true);
}

function composerKey(key = 'd'): void {
  const event = keydown(key);
  expect(customKeyHandler!(event)).toBe(false);
  expect(event.defaultPrevented).toBe(true);
}

describe('pane-local prefix ownership controls', () => {
  it.each(['d', 'p', '[', 'D', '☃'])('owns only the next suffix %s, then restores plain typing', async (suffix) => {
    const { wrapper, settings } = await nativePane();
    expect(settings.typingOpensComposer).toBe(true);
    prefix();
    const e = keydown(suffix, { shiftKey: suffix === 'D' });
    expect(customKeyHandler!(e)).toBe(true);
    expect(e.defaultPrevented).toBe(false);
    expect(wrapper.emitted('typed')).toBeUndefined();
    composerKey('a');
    expect(wrapper.emitted('typed')).toEqual([['a']]);
  });

  it('double Ctrl-b delivers the literal prefix without owning a third key', async () => {
    const { wrapper } = await nativePane();
    prefix(); prefix(); composerKey();
    expect(wrapper.emitted('typed')).toEqual([['d']]);
  });

  it('Shift Ctrl-B arms the same suffix ownership', async () => {
    await nativePane();
    expect(customKeyHandler!(keydown('B', { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(customKeyHandler!(keydown('d'))).toBe(true);
  });

  it.each([{ altKey: true }, { metaKey: true }, { isComposing: true }, { repeat: true }])(
    'does not arm for modified/composing/repeated prefix %j', async (mods) => {
      await nativePane(); prefix(mods); composerKey();
    },
  );

  it('modifier-only keydown, keyup and keypress do not consume the suffix', async () => {
    await nativePane(); prefix();
    for (const key of ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph']) customKeyHandler!(keydown(key));
    customKeyHandler!(new KeyboardEvent('keyup', { key: 'b', ctrlKey: true }));
    customKeyHandler!(new KeyboardEvent('keypress', { key: 'b', ctrlKey: true }));
    expect(customKeyHandler!(keydown('d'))).toBe(true);
    composerKey();
  });

  it('a repeated suffix consumes once; a following repeat retains composer behavior', async () => {
    await nativePane(); prefix();
    expect(customKeyHandler!(keydown('d', { repeat: true }))).toBe(true);
    expect(customKeyHandler!(keydown('d', { repeat: true }))).toBe(false);
  });

  it('a named/control suffix consumes ownership without changing its normal route', async () => {
    await nativePane(); prefix();
    expect(customKeyHandler!(keydown('ArrowUp'))).toBe(true);
    composerKey();
  });

  it.each([{ backend: 'tmux' as const }, { bare: true }, { aplexerId: null }])(
    'does not arm without explicit attached aplexer UUID authority %j', async (props) => {
      await nativePane(props); prefix(); composerKey();
    },
  );

  it('does not arm without a connected matching connection or registered shell', async () => {
    const { connection, shells, key } = await nativePane();
    connection.$patch({ state: 'lost' }); prefix(); composerKey();
    connection.$patch({ state: 'connected', connectionId: 'other' }); prefix(); composerKey();
    connection.$patch({ connectionId: 'conn-1' }); shells.unregister(key); prefix(); composerKey();
  });

  it('connection loss and restoration between keys clears ownership', async () => {
    const { connection } = await nativePane(); prefix();
    connection.$patch({ state: 'lost' }); connection.$patch({ state: 'connected' });
    composerKey();
  });

  it('registered shell removal/replacement, including same ID return, clears ownership', async () => {
    const { shells, key } = await nativePane(); prefix();
    shells.unregister(key); shells.register(key, 'shell-1'); composerKey();
    prefix(); shells.register(key, 'shell-2'); composerKey();
  });

  it.each([
    { sessionKey: 'other-key' }, { sessionName: 'renamed' }, { workspace: 'C:/other' },
    { aplexerId: '22222222-2222-4222-8222-222222222222' }, { connectionId: 'conn-2' },
    { backend: 'tmux' as const }, { bare: true },
  ])('session/connection identity change %j does not inherit ownership', async (props) => {
    const { wrapper } = await nativePane(); prefix();
    await wrapper.setProps(props); await flushPromises(); composerKey();
  });

  it('composer interception transition off and back on clears ownership', async () => {
    const { wrapper } = await nativePane(); prefix();
    await wrapper.setProps({ interceptTyping: false });
    expect(customKeyHandler!(keydown('a'))).toBe(true);
    await wrapper.setProps({ interceptTyping: true }); composerKey();
  });

  it.each(['compositionstart', 'paste', 'drop', 'focusout'])('%s cancels pane keyboard ownership', async (type) => {
    const { wrapper } = await nativePane(); prefix();
    terminalElement(wrapper).dispatchEvent(new Event(type)); composerKey();
  });

  it('focus moving inside the same terminal keeps ownership; leaving it clears it', async () => {
    const { wrapper } = await nativePane(); const inside = document.createElement('textarea');
    terminalElement(wrapper).appendChild(inside); prefix();
    terminalElement(wrapper).dispatchEvent(new FocusEvent('focusout', { relatedTarget: inside }));
    expect(customKeyHandler!(keydown('d'))).toBe(true);
    prefix(); terminalElement(wrapper).dispatchEvent(new FocusEvent('focusout', { relatedTarget: document.body }));
    composerKey();
  });

  it('window blur and document hiding clear ownership without sending cancellation bytes', async () => {
    const { wrapper } = await nativePane(); prefix(); window.dispatchEvent(new Event('blur')); composerKey();
    prefix(); const state = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange')); state.mockReturnValue('visible');
    composerKey(); expect(wrapper.emitted('typed')).toHaveLength(2);
  });

  it('hidden geometry cannot arm or consume a stale prefix', async () => {
    const { wrapper } = await nativePane(); prefix(); visible(terminalElement(wrapper), 0, 0); composerKey();
    visible(terminalElement(wrapper)); composerKey();
  });

  it('ResizeObserver clears ownership across hide and show without another key', async () => {
    const callbacks: Array<() => void> = [];
    const disconnected = vi.fn();
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { callbacks.push(callback); }
      observe(): void {} disconnect(): void { disconnected(); }
    });
    const { wrapper } = await nativePane(); prefix(); visible(terminalElement(wrapper), 0, 0);
    callbacks[callbacks.length - 1]!(); visible(terminalElement(wrapper)); composerKey();
    wrapper.unmount(); expect(disconnected).toHaveBeenCalled();
  });

  it('local paste and tab shortcuts still own suffixes and cancel the lease', async () => {
    const { wrapper } = await nativePane(); prefix();
    const paste = keydown('v', { ctrlKey: true });
    expect(customKeyHandler!(paste)).toBe(false); expect(paste.defaultPrevented).toBe(true);
    expect(wrapper.emitted('paste-into-composer')).toEqual([[]]); composerKey();
    prefix(); const tab = keydown('[', { ctrlKey: true });
    expect(customKeyHandler!(tab)).toBe(false); expect(tab.defaultPrevented).toBe(true); composerKey();
  });

  it('even a colliding in-memory local shortcut cannot arm remote suffix ownership', async () => {
    const { settings, wrapper } = await nativePane();
    const { parseChord } = await import('@pocketshell/core/shared/shortcuts');
    // Corrupt in-memory bindings control: supported settings reserve Ctrl+B.
    settings.shortcutBindings.set('terminal.pasteIntoComposer', [parseChord('Ctrl+B')!]);
    const e = keydown('b', { ctrlKey: true });
    expect(customKeyHandler!(e)).toBe(false);
    expect(wrapper.emitted('paste-into-composer')).toEqual([[]]); composerKey();
  });

  it('programmatic dock input clears pending ownership and uses the existing input route', async () => {
    const { wrapper } = await nativePane(); prefix();
    (wrapper.vm as unknown as { sendInput: (data: string) => void }).sendInput('programmatic');
    composerKey();
  });

  it('unmount clears ownership and removes listeners before a new pane is mounted', async () => {
    const { wrapper } = await nativePane(); prefix();
    const remove = vi.spyOn(window, 'removeEventListener'); wrapper.unmount();
    expect(remove).toHaveBeenCalledWith('blur', expect.any(Function), true);
    await nativePane(); composerKey();
  });
});


describe('existing shortcut authority with prefix ownership', () => {
  it('supported settings refuse rebinding the locked paste shortcut and keep native prefix available', async () => {
    const { settings } = await nativePane();
    const { parseChord } = await import('@pocketshell/core/shared/shortcuts');
    expect(settings.rebindShortcut('terminal.pasteIntoComposer', parseChord('Ctrl+B')!)).toMatchObject({ kind: 'locked' });
    prefix(); expect(customKeyHandler!(keydown('d'))).toBe(true);
  });

  it('copy with selection retains local ownership; no selection retains control-byte route', async () => {
    await nativePane(); prefix(); selected = true;
    const copy = keydown('c', { ctrlKey: true });
    expect(customKeyHandler!(copy)).toBe(false); expect(copy.defaultPrevented).toBe(true); composerKey();
    prefix(); selected = false;
    expect(customKeyHandler!(keydown('c', { ctrlKey: true }))).toBe(true); composerKey();
  });
});


describe('intentional native detach versus unexpected client exit', () => {
  it('keeps the mounted pane detached after the actual Ctrl-b d input and client exit', async () => {
    const { api } = await import('@ui/app/ipc');
    const { wrapper, shells, key } = await nativePane();
    prefix(); terminalData!('\u0002');
    expect(customKeyHandler!(keydown('d'))).toBe(true);
    terminalData!('d');
    await flushPromises();
    const exit = vi.mocked(api.shell.onExited).mock.calls.at(-1)![0];
    exit({ shellId: 'shell-1', exitCode: 0 });
    await flushPromises();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(1);
    expect(api.helper.sessionsList).not.toHaveBeenCalled();
    expect(shells.shellIdFor(key)).toBeNull();
    expect(wrapper.emitted('typed')).toBeUndefined();
    expect(api.shell.input).toHaveBeenCalledWith('shell-1', 'd');
  });

  it('reattaches a genuine client drop with the same exit code and no intentional chord', async () => {
    const { api } = await import('@ui/app/ipc');
    await nativePane();
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
    await flushPromises();
    expect(api.helper.sessionsList).toHaveBeenCalledWith('conn-1');
    expect(api.shell.attachSession).toHaveBeenCalledTimes(2);
  });

  it.each(['no prefix bytes', 'no suffix bytes', 'rejected prefix', 'rejected suffix', 'wrong suffix', 'modified suffix'])(
  'does not suppress recovery for %s', async (control) => {
    const { api } = await import('@ui/app/ipc');
    await nativePane();
    if (control === 'rejected prefix') vi.mocked(api.shell.input).mockResolvedValueOnce(false);
    prefix();
    if (control !== 'no prefix bytes') terminalData!('\u0002');
    await flushPromises();
    if (control === 'rejected suffix') vi.mocked(api.shell.input).mockResolvedValueOnce(false);
    expect(customKeyHandler!(keydown(control === 'wrong suffix' ? 'p' : 'd',
      { ctrlKey: control === 'modified suffix' }))).toBe(true);
    if (control !== 'no suffix bytes') terminalData!(control === 'wrong suffix' ? 'p' : 'd');
    await flushPromises();
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
    await flushPromises();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(2);
  });

  it('refuses a stale target even if its old shell ID remains the same', async () => {
    const { api } = await import('@ui/app/ipc');
    const { wrapper } = await nativePane();
    // UUID-only change does not itself open a different shell. The old attach
    // must neither detach the new identity nor recover against that identity.
    await wrapper.setProps({ aplexerId: '22222222-2222-4222-8222-222222222222' });
    prefix(); terminalData!('\u0002');
    expect(customKeyHandler!(keydown('d'))).toBe(true); terminalData!('d');
    await flushPromises();
    const count = vi.mocked(api.shell.attachSession).mock.calls.length;
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
    await flushPromises();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(count);
    expect(api.helper.sessionsList).not.toHaveBeenCalled();
  });

  it('refuses recovery when target identity changes during the live-session verdict', async () => {
    const { api } = await import('@ui/app/ipc');
    const { wrapper } = await nativePane();
    let finish: ((rows: Awaited<ReturnType<typeof api.helper.sessionsList>>) => void) | undefined;
    vi.mocked(api.helper.sessionsList).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
    await wrapper.setProps({ aplexerId: '22222222-2222-4222-8222-222222222222' });
    finish!([{ name: 'main', tag: 'main', workspace: 'C:/workspace',
      aplexerId: '11111111-1111-4111-8111-111111111111', aplexerPhase: 'running',
      backend: 'aplexer', created: 1, activity: 1, attached: true, path: 'C:/workspace' }]);
    await flushPromises();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(1);
    expect(api.shell.close).not.toHaveBeenCalled();
  });

  it('keeps intentional detach across hidden-to-visible container callbacks', async () => {
    const { api } = await import('@ui/app/ipc');
    const observers: ResizeObserverCallback[] = [];
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { observers.push(callback); }
      observe(): void {} disconnect(): void {}
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    const { FitAddon } = await import('@xterm/addon-fit');
    vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue({ cols: 80, rows: 24 });
    const { wrapper } = await nativePane();
    prefix(); terminalData!('\u0002');
    expect(customKeyHandler!(keydown('d'))).toBe(true); terminalData!('d');
    await flushPromises();
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
    visible(terminalElement(wrapper), 0, 0);
    observers[0]!([], {} as ResizeObserver); frames.splice(0).forEach(fn => fn(0));
    visible(terminalElement(wrapper));
    observers[0]!([], {} as ResizeObserver); frames.splice(0).forEach(fn => fn(1));
    await flushPromises();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(1);
    expect(api.helper.sessionsList).not.toHaveBeenCalled();
  });

  it('an explicit new attach resets the intentional-detach receipt', async () => {
    const { api } = await import('@ui/app/ipc');
    const { wrapper } = await nativePane();
    prefix(); terminalData!('\u0002');
    expect(customKeyHandler!(keydown('d'))).toBe(true); terminalData!('d');
    await flushPromises();
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
    await flushPromises();
    await wrapper.setProps({ sessionKey: 'workspace-next', sessionName: 'next' });
    await flushPromises();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(2);
    vi.mocked(api.helper.sessionsList).mockResolvedValueOnce([{ name: 'next', tag: 'next', workspace: 'C:/workspace',
      aplexerId: '11111111-1111-4111-8111-111111111111', aplexerPhase: 'running',
      backend: 'aplexer', created: 1, activity: 1, attached: true, path: 'C:/workspace' }]);
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
    await flushPromises();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(3);
  });

});

async function deliveredDetachChord(): Promise<void> {
  prefix(); terminalData!('\u0002');
  expect(customKeyHandler!(keydown('d'))).toBe(true);
  terminalData!('d');
  await flushPromises();
}

describe('detach load-bearing network cancellation and generation controls', () => {
  it('leaves a real lost-link exit to reconnect ownership and attaches on the new connection', async () => {
    const { api } = await import('@ui/app/ipc');
    const { wrapper, connection, shells, key } = await nativePane();
    connection.$patch({ state: 'lost' });
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
    await flushPromises();
    expect(api.helper.sessionsList).not.toHaveBeenCalled();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(1);
    expect(shells.shellIdFor(key)).toBeNull();
    vi.mocked(api.shell.attachSession).mockResolvedValueOnce({ shellId: 'shell-2', switched: false });
    connection.$patch({ state: 'connected', connectionId: 'conn-2' });
    await wrapper.setProps({ connectionId: 'conn-2' });
    await flushPromises();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(2);
    expect(api.shell.attachSession).toHaveBeenLastCalledWith(expect.objectContaining({ connectionId: 'conn-2' }));
    expect(shells.shellIdFor(key)).toBe('shell-2');
    expect(wrapper.emitted('typed')).toBeUndefined();
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-2', exitCode: 0 });
    await flushPromises();
    expect(api.helper.sessionsList).toHaveBeenCalledWith('conn-2');
    expect(api.shell.attachSession).toHaveBeenCalledTimes(3);
  });

  it.each(['focusout', 'paste', 'double Ctrl-b', 'named suffix', 'local shortcut', 'connection loss'])(
    '%s cancels prefix intent and a subsequent genuine client exit still recovers', async (cancel) => {
      const { api } = await import('@ui/app/ipc');
      const { wrapper, connection } = await nativePane();
      prefix(); terminalData!('\u0002');
      if (cancel === 'focusout' || cancel === 'paste') terminalElement(wrapper).dispatchEvent(new Event(cancel));
      else if (cancel === 'double Ctrl-b') { prefix(); terminalData!('\u0002'); }
      else if (cancel === 'named suffix') {
        expect(customKeyHandler!(keydown('ArrowUp'))).toBe(true); terminalData!('\u001b[A');
      } else if (cancel === 'local shortcut') {
        const tab = keydown('[', { ctrlKey: true });
        expect(customKeyHandler!(tab)).toBe(false); expect(tab.defaultPrevented).toBe(true);
      } else {
        connection.$patch({ state: 'lost' }); connection.$patch({ state: 'connected' });
      }
      composerKey('d');
      expect(wrapper.emitted('typed')).toEqual([['d']]);
      expect(api.shell.input).not.toHaveBeenCalledWith('shell-1', 'd');
      vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
      await flushPromises();
      expect(api.helper.sessionsList).toHaveBeenCalledWith('conn-1');
      expect(api.shell.attachSession).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['session', 'connection', 'workspace'])(
    'a %s switch cannot transfer prefix intent or recover an old pane generation', async (switchKind) => {
      const { api } = await import('@ui/app/ipc');
      const { wrapper, connection } = await nativePane();
      const staleExit = vi.mocked(api.shell.onExited).mock.calls.at(-1)![0];
      prefix(); terminalData!('\u0002');
      vi.mocked(api.shell.attachSession).mockResolvedValueOnce({ shellId: 'shell-2', switched: false });
      if (switchKind === 'connection') {
        connection.$patch({ connectionId: 'conn-2' });
        await wrapper.setProps({ connectionId: 'conn-2' });
      } else if (switchKind === 'session') {
        await wrapper.setProps({ sessionKey: 'next', sessionName: 'next', aplexerId: '22222222-2222-4222-8222-222222222222' });
      } else {
        await wrapper.setProps({ sessionKey: 'other-workspace', workspace: 'C:/other' });
      }
      await flushPromises();
      composerKey('d');
      expect(wrapper.emitted('typed')).toEqual([['d']]);
      staleExit({ shellId: 'shell-1', exitCode: 0 });
      await flushPromises();
      expect(api.shell.attachSession).toHaveBeenCalledTimes(2);
      expect(api.helper.sessionsList).not.toHaveBeenCalled();
      expect(api.shell.close).not.toHaveBeenCalled();
      expect(api.shell.input).not.toHaveBeenCalledWith('shell-2', 'd');
    },
  );

  it('reconnect after intentional detach explicitly attaches and restores genuine drop recovery', async () => {
    const { api } = await import('@ui/app/ipc');
    const { wrapper, connection, shells, key, settings } = await nativePane();
    await deliveredDetachChord();
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
    await flushPromises();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(1);
    expect(api.helper.sessionsList).not.toHaveBeenCalled();
    connection.$patch({ state: 'lost' });
    vi.mocked(api.shell.attachSession).mockResolvedValueOnce({ shellId: 'shell-2', switched: false });
    connection.$patch({ state: 'connected', connectionId: 'conn-2' });
    await wrapper.setProps({ connectionId: 'conn-2' });
    await flushPromises();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(2);
    expect(shells.shellIdFor(key)).toBe('shell-2');
    expect(settings.typingOpensComposer).toBe(true);
    composerKey('a');
    expect(wrapper.emitted('typed')).toEqual([['a']]);
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-2', exitCode: 0 });
    await flushPromises();
    expect(api.helper.sessionsList).toHaveBeenCalledWith('conn-2');
    expect(api.shell.attachSession).toHaveBeenCalledTimes(3);
  });
});


describe('deferred suffix acknowledgement versus client exit ordering', () => {
  it.each(['false', 'rejection', 'true'])(
    'exit before suffix ACK %s decides detach only after acknowledgement', async (result) => {
      const { api } = await import('@ui/app/ipc');
      await nativePane();
      prefix(); terminalData!('\u0002'); await flushPromises();
      let accept: ((value: boolean) => void) | undefined;
      let refuse: ((error: Error) => void) | undefined;
      vi.mocked(api.shell.input).mockImplementationOnce(() => new Promise<boolean>((resolve, reject) => {
        accept = resolve; refuse = reject;
      }));
      expect(customKeyHandler!(keydown('d'))).toBe(true); terminalData!('d');
      vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
      await flushPromises();
      expect(api.shell.attachSession).toHaveBeenCalledTimes(1);
      expect(api.helper.sessionsList).not.toHaveBeenCalled();
      const reportedDetachBeforeAck = terminalWrites.join('').includes('[detached]');
      if (result === 'rejection') refuse!(new Error('input refused'));
      else accept!(result === 'true');
      await flushPromises();
      if (result === 'true') {
        expect(api.shell.attachSession).toHaveBeenCalledTimes(1);
        expect(api.helper.sessionsList).not.toHaveBeenCalled();
        expect(terminalWrites.join('')).toContain('[detached]');
      } else {
        expect(api.helper.sessionsList).toHaveBeenCalledWith('conn-1');
        expect(api.shell.attachSession).toHaveBeenCalledTimes(2);
        expect(terminalWrites.join('')).not.toContain('[detached]');
      }
      expect(reportedDetachBeforeAck).toBe(false);
    },
  );
});

async function pendingSuffixAck() {
  const { api } = await import('@ui/app/ipc');
  prefix(); terminalData!('\u0002'); await flushPromises();
  let resolveAck: ((value: boolean) => void) | undefined;
  vi.mocked(api.shell.input).mockImplementationOnce(() => new Promise<boolean>(resolve => { resolveAck = resolve; }));
  expect(customKeyHandler!(keydown('d'))).toBe(true); terminalData!('d');
  return { api, resolveAck: (value: boolean): void => { resolveAck!(value); } };
}

describe('deferred detach acknowledgement lifetime and network guards', () => {
  it.each(['false', 'rejection', 'true'])(
    'a deferred prefix ACK %s also participates in the exit verdict', async (result) => {
      const { api } = await import('@ui/app/ipc');
      await nativePane();
      let accept: ((value: boolean) => void) | undefined;
      let refuse: ((error: Error) => void) | undefined;
      vi.mocked(api.shell.input).mockImplementationOnce(() => new Promise<boolean>((resolve, reject) => {
        accept = resolve; refuse = reject;
      }));
      prefix(); terminalData!('\u0002');
      expect(customKeyHandler!(keydown('d'))).toBe(true); terminalData!('d');
      vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
      await flushPromises();
      expect(api.shell.attachSession).toHaveBeenCalledTimes(1);
      expect(terminalWrites.join('')).not.toContain('[detached]');
      if (result === 'rejection') refuse!(new Error('prefix write refused'));
      else accept!(result === 'true');
      await flushPromises();
      expect(api.shell.attachSession).toHaveBeenCalledTimes(result === 'true' ? 1 : 2);
      expect(terminalWrites.join('').includes('[detached]')).toBe(result === 'true');
    },
  );

  it('bounds an unresolved ACK, recovers once on duplicate exits, and ignores late success', async () => {
    const { wrapper } = await nativePane();
    const { api, resolveAck } = await pendingSuffixAck();
    vi.useFakeTimers();
    try {
      const exit = vi.mocked(api.shell.onExited).mock.calls.at(-1)![0];
      exit({ shellId: 'shell-1', exitCode: 0 }); exit({ shellId: 'shell-1', exitCode: 0 });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(api.shell.attachSession).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1); await flushPromises();
      expect(api.helper.sessionsList).toHaveBeenCalledTimes(1);
      expect(api.shell.attachSession).toHaveBeenCalledTimes(2);
      resolveAck(true); await flushPromises();
      expect(api.shell.attachSession).toHaveBeenCalledTimes(2);
      expect(terminalWrites.join('')).not.toContain('[detached]');
      wrapper.unmount(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('new connection generation cancels the old wait and rejects its late successful ACK', async () => {
    const { wrapper, connection } = await nativePane();
    const { api, resolveAck } = await pendingSuffixAck();
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
    vi.mocked(api.shell.attachSession).mockResolvedValueOnce({ shellId: 'shell-2', switched: false });
    connection.$patch({ connectionId: 'conn-2' });
    await wrapper.setProps({ connectionId: 'conn-2' }); await flushPromises();
    resolveAck(true); await flushPromises();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(2);
    expect(api.helper.sessionsList).not.toHaveBeenCalled();
    expect(terminalWrites.join('')).not.toContain('[detached]');
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-2', exitCode: 0 });
    await flushPromises();
    expect(api.helper.sessionsList).toHaveBeenCalledWith('conn-2');
    expect(api.shell.attachSession).toHaveBeenCalledTimes(3);
  });

  it('unmount cancels the owned ACK timer and a late reply cannot recover or print', async () => {
    const { wrapper } = await nativePane();
    const { api, resolveAck } = await pendingSuffixAck();
    vi.useFakeTimers();
    try {
      vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
      wrapper.unmount(); expect(vi.getTimerCount()).toBe(0);
      resolveAck(false); await flushPromises();
      expect(api.helper.sessionsList).not.toHaveBeenCalled();
      expect(api.shell.attachSession).toHaveBeenCalledTimes(1);
      expect(terminalWrites.join('')).not.toContain('[detached]');
    } finally { vi.useRealTimers(); }
  });

  it('loss of the link while waiting cannot turn a successful ACK into a detach verdict', async () => {
    const { connection } = await nativePane();
    const { api, resolveAck } = await pendingSuffixAck();
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
    connection.$patch({ state: 'lost' }); resolveAck(true); await flushPromises();
    expect(api.helper.sessionsList).not.toHaveBeenCalled();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(1);
    expect(terminalWrites.join('')).not.toContain('[detached]');
    expect(terminalWrites.join('')).toContain('[process exited]');
  });

  it('a repeated confirmed exit keeps the already detached pane detached', async () => {
    const { api } = await import('@ui/app/ipc');
    await nativePane(); await deliveredDetachChord();
    const exit = vi.mocked(api.shell.onExited).mock.calls.at(-1)![0];
    exit({ shellId: 'shell-1', exitCode: 0 }); await flushPromises();
    exit({ shellId: 'shell-1', exitCode: 0 }); await flushPromises();
    expect(api.helper.sessionsList).not.toHaveBeenCalled();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(1);
  });
});

describe('deferred detach acknowledgement container visibility', () => {
  it('does not bypass a pending suffix ACK when the pane is hidden and shown', async () => {
    const observers: ResizeObserverCallback[] = [];
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: ResizeObserverCallback) { observers.push(callback); }
      observe(): void {} disconnect(): void {}
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length; });
    const { FitAddon } = await import('@xterm/addon-fit');
    vi.spyOn(FitAddon.prototype, 'proposeDimensions').mockReturnValue({ cols: 80, rows: 24 });
    const { wrapper } = await nativePane();
    const { api, resolveAck } = await pendingSuffixAck();
    vi.mocked(api.shell.onExited).mock.calls.at(-1)![0]({ shellId: 'shell-1', exitCode: 0 });
    visible(terminalElement(wrapper), 0, 0);
    observers[0]!([], {} as ResizeObserver); frames.splice(0).forEach(fn => fn(0));
    visible(terminalElement(wrapper));
    observers[0]!([], {} as ResizeObserver); frames.splice(0).forEach(fn => fn(1));
    await flushPromises();
    expect(api.shell.attachSession).toHaveBeenCalledTimes(1);
    expect(terminalWrites.join('')).not.toContain('[detached]');
    resolveAck(false); await flushPromises();
    expect(api.helper.sessionsList).toHaveBeenCalledTimes(1);
    expect(api.shell.attachSession).toHaveBeenCalledTimes(2);
  });
});
