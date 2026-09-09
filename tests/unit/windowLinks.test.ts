import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The main window's link-opening policy. Two capture points — `window.open`
 * and navigations inside the preview frame — must behave identically: web
 * links are handed to the OS browser, everything else (including
 * `about:blank`, `file:`, and custom protocol handlers) is refused and
 * logged. A remote box linkified into the terminal must not be able to pick
 * which local program opens.
 */

const { openExternal } = vi.hoisted(() => ({ openExternal: vi.fn() }));

vi.mock('electron', () => ({ shell: { openExternal } }));

type Handler = (payload: never) => void;

function fakeWebContents() {
  const openHandler = vi.fn();
  const frameHandlers: Handler[] = [];
  const webContents = {
    setWindowOpenHandler: openHandler,
    on: vi.fn((_event: string, fn: Handler) => frameHandlers.push(fn)),
  };
  return { webContents: webContents as never, openHandler, frameHandlers };
}

const { applyLinkPolicy, isWebUrl } = await import('../../src/main/windowLinks');

beforeEach(() => {
  openExternal.mockClear();
});

describe('isWebUrl', () => {
  it('accepts http and https only', () => {
    expect(isWebUrl('https://example.com/a')).toBe(true);
    expect(isWebUrl('http://example.com')).toBe(true);
  });

  it('refuses every other scheme, including file and custom protocols', () => {
    for (const url of ['file:///etc/passwd', 'ms-settings:display', 'ssh://host', 'javascript:alert(1)']) {
      expect(isWebUrl(url)).toBe(false);
    }
  });

  it('refuses unparseable strings rather than throwing', () => {
    expect(isWebUrl('not a url')).toBe(false);
  });
});

describe('applyLinkPolicy — window.open', () => {
  it('denies the popup and hands web links to the system browser', () => {
    const { webContents, openHandler } = fakeWebContents();
    applyLinkPolicy(webContents);

    expect(openHandler).toHaveBeenCalled();
    const handler = openHandler.mock.calls[0]![0] as (d: { url: string }) => { action: string };
    expect(handler({ url: 'https://github.com/x' })).toEqual({ action: 'deny' });
    expect(openExternal).toHaveBeenCalledWith('https://github.com/x');
  });

  it('denies and logs non-web targets without touching the OS', () => {
    const { webContents, openHandler } = fakeWebContents();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    applyLinkPolicy(webContents);

    const handler = openHandler.mock.calls[0]![0] as (d: { url: string }) => { action: string };
    expect(handler({ url: 'about:blank' })).toEqual({ action: 'deny' });
    expect(openExternal).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('applyLinkPolicy — preview frame navigation', () => {
  function frameHandler(): (d: { isMainFrame: boolean; url: string; preventDefault: () => void }) => void {
    const { webContents } = fakeWebContents();
    applyLinkPolicy(webContents);
    const calls = (webContents as unknown as { on: ReturnType<typeof vi.fn> }).on.mock.calls;
    const entry = calls.find(([event]) => event === 'will-frame-navigate');
    return entry![1] as typeof frameHandler;
  }

  it('leaves the main frame alone — that is the app’s own routing', () => {
    const handler = frameHandler();
    const preventDefault = vi.fn();
    handler({ isMainFrame: true, url: 'https://evil.example', preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('allows navigation within the preview scheme', () => {
    const handler = frameHandler();
    const preventDefault = vi.fn();
    handler({ isMainFrame: false, url: 'psview://tok/page2.html', preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('hands web links to the browser and still cancels the in-app navigation', () => {
    const handler = frameHandler();
    const preventDefault = vi.fn();
    handler({ isMainFrame: false, url: 'https://example.com/next', preventDefault });
    expect(openExternal).toHaveBeenCalledWith('https://example.com/next');
    expect(preventDefault).toHaveBeenCalled();
  });

  it('refuses, logs and cancels every other scheme', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = frameHandler();
    const preventDefault = vi.fn();
    handler({ isMainFrame: false, url: 'file:///C:/x', preventDefault });
    expect(openExternal).not.toHaveBeenCalled();
    expect(preventDefault).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
