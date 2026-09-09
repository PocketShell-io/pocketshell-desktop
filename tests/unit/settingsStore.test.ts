// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The settings store's three jobs: hand back the documented defaults, survive a
 * restart, and survive a blob it did not write.
 *
 * jsdom, not the suite's default `node` environment, because the whole point of
 * the middle one is the localStorage round-trip — the store's `typeof
 * localStorage === 'undefined'` guard would make every persistence assertion
 * pass vacuously under `node`.
 */

const { useSettingsStore, coerceSettings, settingsDefaults } = await import(
  '../../src/renderer/stores/settings'
);

import { chordToString, isShortcut, parseChord } from '../../src/shared/shortcuts';

const KEY = 'pocketshell.settings.v1';

/** What is actually on disk, parsed. */
function stored(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>;
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});

describe('defaults', () => {
  it('seeds the documented keys, composer switches ON', () => {
    const settings = useSettingsStore();
    expect(settings.typingOpensComposer).toBe(true);
    expect(settings.closeComposerOnSend).toBe(true);
    expect(settings.defaultHost).toBeNull();
  });

  it('seeds typography with exactly what shipped before it was settable', () => {
    const settings = useSettingsStore();
    expect(settings.monospaceFontFamily).toBeNull();
    expect(settings.terminalFontSize).toBe(16);
    expect(settings.editorFontSize).toBe(13);
  });

  it('seeds zoom at 100%, so an upgrade changes nothing on screen', () => {
    expect(useSettingsStore().zoomPercent).toBe(100);
  });

  it('seeds the theme as dark — never system — for the same reason', () => {
    // `system` as the default would repaint the app on upgrade for every user
    // whose OS is in light mode. Dark is what shipped.
    expect(useSettingsStore().theme).toBe('dark');
  });

  it('exposes every key of AppSettings on the store, not behind a container', () => {
    // The contract another agent is coding against: `settings.typingOpensComposer`.
    const settings = useSettingsStore();
    for (const key of Object.keys(settingsDefaults())) {
      expect(settings).toHaveProperty(key);
    }
  });

  it('writes nothing until something changes', () => {
    useSettingsStore();
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe('persistence', () => {
  it('round-trips a change through localStorage into a fresh store', () => {
    const first = useSettingsStore();
    first.set('defaultHost', 'hetzner');
    first.set('typingOpensComposer', false);

    // A brand-new pinia, i.e. a fresh app launch reading the same profile.
    setActivePinia(createPinia());
    const second = useSettingsStore();
    expect(second.defaultHost).toBe('hetzner');
    expect(second.typingOpensComposer).toBe(false);
    expect(second.closeComposerOnSend).toBe(true);
  });

  it('persists direct assignment too, not only set()', () => {
    const settings = useSettingsStore();
    settings.closeComposerOnSend = false;
    expect(stored()['closeComposerOnSend']).toBe(false);
  });

  it('writes synchronously, so a value is durable the moment the UI moves', () => {
    const settings = useSettingsStore();
    settings.set('defaultHost', 'fixture');
    // No await, no nextTick: `flush: 'sync'` is the reason this holds.
    expect(stored()['defaultHost']).toBe('fixture');
  });

  it('normalises a blank host alias to null — the select emits ""', () => {
    const settings = useSettingsStore();
    settings.set('defaultHost', '  ');
    setActivePinia(createPinia());
    expect(useSettingsStore().defaultHost).toBeNull();
  });
});

describe('degrading a stored blob', () => {
  it('falls back to defaults on unparseable JSON', () => {
    localStorage.setItem(KEY, '{"defaultHost": "hetzn');
    const settings = useSettingsStore();
    expect(settings.defaultHost).toBeNull();
    expect(settings.typingOpensComposer).toBe(true);
  });

  it('falls back to defaults when the blob is not an object', () => {
    for (const blob of ['null', '42', '"hetzner"', '[]']) {
      localStorage.setItem(KEY, blob);
      setActivePinia(createPinia());
      expect(useSettingsStore().defaultHost).toBeNull();
    }
  });

  it('degrades PER KEY — one bad value does not cost the others', () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ typingOpensComposer: 'yes', defaultHost: 'hetzner' }),
    );
    const settings = useSettingsStore();
    // The string is not a boolean, so that key alone reverts...
    expect(settings.typingOpensComposer).toBe(true);
    // ...and the perfectly good host beside it survives.
    expect(settings.defaultHost).toBe('hetzner');
  });

  it('ignores unknown keys rather than carrying them forward', () => {
    localStorage.setItem(KEY, JSON.stringify({ defaultHost: 'a', fromTheFuture: 1 }));
    const settings = useSettingsStore();
    expect(settings).not.toHaveProperty('fromTheFuture');
    settings.set('defaultHost', 'b');
    expect(stored()).not.toHaveProperty('fromTheFuture');
  });

  it('clamps a stored font size instead of discarding it', () => {
    localStorage.setItem(KEY, JSON.stringify({ terminalFontSize: 400, editorFontSize: 2 }));
    const settings = useSettingsStore();
    expect(settings.terminalFontSize).toBe(32);
    expect(settings.editorFontSize).toBe(8);
  });

  it('falls back to the shipped size when the stored one is not a number', () => {
    localStorage.setItem(KEY, JSON.stringify({ terminalFontSize: 'big' }));
    expect(useSettingsStore().terminalFontSize).toBe(16);
  });

  it('sanitises a stored font family rather than trusting it', () => {
    localStorage.setItem(KEY, JSON.stringify({ monospaceFontFamily: 'Fira Code"; }' }));
    expect(useSettingsStore().monospaceFontFamily).toBe('Fira Code');
  });

  it('round-trips the typography keys', () => {
    const first = useSettingsStore();
    first.set('monospaceFontFamily', 'JetBrains Mono');
    first.set('terminalFontSize', 20);
    setActivePinia(createPinia());
    const second = useSettingsStore();
    expect(second.monospaceFontFamily).toBe('JetBrains Mono');
    expect(second.terminalFontSize).toBe(20);
    expect(second.editorFontSize).toBe(13);
  });

  it('keeps a stored theme it knows, drops one it does not', () => {
    localStorage.setItem(KEY, JSON.stringify({ theme: 'nord' }));
    expect(useSettingsStore().theme).toBe('nord');

    // An id from a newer build (or a typo in a hand-edited blob) reverts to
    // the default rather than leaving the app trying to apply nothing.
    localStorage.setItem(KEY, JSON.stringify({ theme: 'vaporwave' }));
    setActivePinia(createPinia());
    expect(useSettingsStore().theme).toBe('dark');

    localStorage.setItem(KEY, JSON.stringify({ theme: 'system' }));
    setActivePinia(createPinia());
    expect(useSettingsStore().theme).toBe('system');
  });

  it('rejects a non-string, non-null defaultHost', () => {
    expect(coerceSettings({ defaultHost: 7 }).defaultHost).toBeNull();
    expect(coerceSettings({ defaultHost: null }).defaultHost).toBeNull();
    expect(coerceSettings({ defaultHost: 'hetzner' }).defaultHost).toBe('hetzner');
  });
});

/**
 * Zoom lives in this store rather than beside the code that calls Chromium,
 * and these are the tests that say why: the keyboard chords and the settings
 * screen both go through these actions, so there is one value and it is the
 * one that persists.
 */
describe('zoom', () => {
  it('steps up and down through the store, not around it', () => {
    const settings = useSettingsStore();
    settings.zoomIn();
    expect(settings.zoomPercent).toBe(110);
    settings.zoomOut();
    expect(settings.zoomPercent).toBe(100);
  });

  it('resets to 100% from anywhere — the guaranteed way back', () => {
    const settings = useSettingsStore();
    for (let i = 0; i < 10; i++) settings.zoomOut();
    expect(settings.zoomPercent).toBe(50);
    settings.resetZoom();
    expect(settings.zoomPercent).toBe(100);
  });

  it('cannot be stepped out of its bounds however long a key is held', () => {
    const settings = useSettingsStore();
    for (let i = 0; i < 50; i++) settings.zoomIn();
    expect(settings.zoomPercent).toBe(200);
    for (let i = 0; i < 50; i++) settings.zoomOut();
    expect(settings.zoomPercent).toBe(50);
  });

  it('persists a keyboard zoom, so it survives a restart like any setting', () => {
    // The chord path (main -> App.vue -> zoomIn) writes the SAME value the
    // settings panel shows, which is the whole design point.
    useSettingsStore().zoomIn();
    expect(stored()['zoomPercent']).toBe(110);
    setActivePinia(createPinia());
    expect(useSettingsStore().zoomPercent).toBe(110);
  });

  it('clamps a hand-edited zoom instead of discarding it', () => {
    localStorage.setItem(KEY, JSON.stringify({ zoomPercent: 5000 }));
    expect(useSettingsStore().zoomPercent).toBe(200);
  });

  it('falls back to 100% when the stored zoom is not a number', () => {
    localStorage.setItem(KEY, JSON.stringify({ zoomPercent: 'huge' }));
    expect(useSettingsStore().zoomPercent).toBe(100);
  });
});

describe('session roots', () => {
  it('defaults to an empty map, which means "derive roots from $HOME" for every host', () => {
    expect(useSettingsStore().sessionRoots).toEqual({});
  });

  it('hands every caller its own map, never the spec default itself', () => {
    // A shared reference here would let one mutation rewrite the default for
    // every future load — a bug that only shows up on the second boot.
    const a = settingsDefaults();
    a.sessionRoots.hetzner = ['~/git'];
    expect(settingsDefaults().sessionRoots).toEqual({});
  });

  it('adds, normalises and persists a root for one host', () => {
    const settings = useSettingsStore();
    expect(settings.addSessionRoot('hetzner', '  ~/git/  ')).toBe(true);
    expect(settings.sessionRootsFor('hetzner')).toEqual(['~/git']);
    expect(stored()['sessionRoots']).toEqual({ hetzner: ['~/git'] });
  });

  it('keeps registered order independently for each host', () => {
    const settings = useSettingsStore();
    settings.addSessionRoot('hetzner', '~/tmp');
    settings.addSessionRoot('hetzner', '~/git');
    settings.addSessionRoot('aws', '~/work');
    expect(settings.sessionRootsFor('hetzner')).toEqual(['~/tmp', '~/git']);
    expect(settings.sessionRootsFor('aws')).toEqual(['~/work']);
  });

  it('refuses a duplicate, a path anchored to nothing, and a blank host', () => {
    const settings = useSettingsStore();
    expect(settings.addSessionRoot('hetzner', '~/git')).toBe(true);
    expect(settings.addSessionRoot('hetzner', '~/git/')).toBe(false);
    expect(settings.addSessionRoot('hetzner', 'git')).toBe(false);
    expect(settings.addSessionRoot('hetzner', '')).toBe(false);
    expect(settings.addSessionRoot('', '~/git')).toBe(false);
    expect(settings.sessionRootsFor('hetzner')).toEqual(['~/git']);
  });

  it('removes by the stored spelling and host', () => {
    const settings = useSettingsStore();
    settings.addSessionRoot('hetzner', '~/git');
    settings.addSessionRoot('hetzner', '~/tmp');
    settings.addSessionRoot('aws', '~/git');
    settings.removeSessionRoot('hetzner', '~/git');
    expect(settings.sessionRootsFor('hetzner')).toEqual(['~/tmp']);
    expect(settings.sessionRootsFor('aws')).toEqual(['~/git']);
    // A spelling that was never registered is a no-op, not an error.
    settings.removeSessionRoot('hetzner', '/home/alexey/tmp');
    expect(settings.sessionRootsFor('hetzner')).toEqual(['~/tmp']);
  });

  it('survives a restart', () => {
    useSettingsStore().addSessionRoot('hetzner', '~/git');
    setActivePinia(createPinia());
    expect(useSettingsStore().sessionRootsFor('hetzner')).toEqual(['~/git']);
    expect(useSettingsStore().sessionRootsFor('aws')).toEqual([]);
  });

  it('degrades a corrupt map per HOST and per ENTRY', () => {
    expect(
      coerceSettings({
        sessionRoots: {
          hetzner: ['~/git', 7, 'relative', '~/tmp/'],
          aws: 'not-a-list',
          laptop: ['~/work'],
        },
      }).sessionRoots,
    ).toEqual({ hetzner: ['~/git', '~/tmp'], laptop: ['~/work'] });
  });

  it('falls back to the default when the value is not a map at all', () => {
    expect(coerceSettings({ sessionRoots: ['~/git'] }).sessionRoots).toEqual({});
    expect(coerceSettings({ sessionRoots: '~/git' }).sessionRoots).toEqual({});
    expect(coerceSettings({ sessionRoots: null }).sessionRoots).toEqual({});
  });

  it('migrates an old shared list only to an explicit default host', () => {
    expect(
      coerceSettings({
        defaultHost: 'hetzner',
        sessionRoots: ['~/git', 7, 'relative', '~/tmp/'],
      }).sessionRoots,
    ).toEqual({ hetzner: ['~/git', '~/tmp'] });
    // With no owner, retaining the old list for every host would preserve the
    // cross-instance leak, so it is intentionally discarded.
    expect(coerceSettings({ sessionRoots: ['~/git'] }).sessionRoots).toEqual({});
  });

  it('keeps the rest of the blob when only the root map is corrupt', () => {
    const settings = coerceSettings({ sessionRoots: 3, defaultHost: 'hetzner' });
    expect(settings.sessionRoots).toEqual({});
    expect(settings.defaultHost).toBe('hetzner');
  });
});

/**
 * The launch dialog's remembered answers. The defaults matter as much as the
 * degradation here: they are the helper's own (`[default: skip-permissions]`)
 * and the phone's first segment, so a fresh install opens the dialog exactly
 * where the phone's picker opens.
 */
describe('agentLaunchDefaults', () => {
  it('defaults to claude with skip-permissions ON and no profile', () => {
    const settings = useSettingsStore();
    expect(settings.agentLaunchDefaults).toEqual({
      kind: 'claude',
      skipPermissions: true,
      profiles: {},
    });
  });

  it('hands every caller its own object, never the spec default itself', () => {
    const a = settingsDefaults();
    a.agentLaunchDefaults.profiles['claude'] = 'Claude (Z.AI)';
    expect(settingsDefaults().agentLaunchDefaults.profiles).toEqual({});
  });

  it('round-trips a full choice', () => {
    const settings = useSettingsStore();
    settings.agentLaunchDefaults = {
      kind: 'codex',
      skipPermissions: false,
      profiles: { codex: 'work' },
    };
    expect(stored()['agentLaunchDefaults']).toEqual({
      kind: 'codex',
      skipPermissions: false,
      profiles: { codex: 'work' },
    });
  });

  it('drops a kind that is not launchable, keeping the other answers', () => {
    // `shell` is in SessionAgentKind but is a classification, not something
    // `pocketshell agent` can start, so a blob naming it must not reach the
    // command builder.
    const out = coerceSettings({
      agentLaunchDefaults: { kind: 'shell', skipPermissions: false, profiles: { claude: 'Z' } },
    }).agentLaunchDefaults;
    expect(out).toEqual({ kind: 'claude', skipPermissions: false, profiles: { claude: 'Z' } });
  });

  it('keeps a remembered grok, which is now a launchable kind', () => {
    // Remembering it is safe even on a host that cannot run it: the launch
    // dialog probes the host and refuses with a message rather than typing a
    // command that exits 2 (shared/agentLaunch.ts).
    const out = coerceSettings({
      agentLaunchDefaults: { kind: 'grok', skipPermissions: true, profiles: {} },
    }).agentLaunchDefaults;
    expect(out.kind).toBe('grok');
  });

  it('degrades a corrupt profile map per ENTRY', () => {
    expect(
      coerceSettings({
        agentLaunchDefaults: { kind: 'claude', profiles: { claude: 7, codex: '  ', x: ' ok ' } },
      }).agentLaunchDefaults,
    ).toEqual({ kind: 'claude', skipPermissions: true, profiles: { x: 'ok' } });
  });

  it('falls back wholesale only when the value is not an object', () => {
    expect(coerceSettings({ agentLaunchDefaults: 'claude' }).agentLaunchDefaults).toEqual({
      kind: 'claude',
      skipPermissions: true,
      profiles: {},
    });
  });

  it('keeps the rest of the blob when only this key is corrupt', () => {
    const settings = coerceSettings({ agentLaunchDefaults: 3, defaultHost: 'hetzner' });
    expect(settings.agentLaunchDefaults.kind).toBe('claude');
    expect(settings.defaultHost).toBe('hetzner');
  });
});

/**
 * Keyboard overrides.
 *
 * The store owns exactly one thing here — the persisted differences — and every
 * rule lives in `src/shared/shortcuts.ts`, which `tests/unit/shortcuts.test.ts`
 * pins on its own. So these assert the SEAM: that a refusal is passed through
 * rather than swallowed, that only differences are written, and that a blob
 * this build cannot trust costs one entry rather than a keyboard.
 */
describe('shortcut overrides', () => {
  it('starts empty, so a fresh install gets whatever the registry currently says', () => {
    const settings = useSettingsStore();
    expect(settings.shortcutOverrides).toEqual({});
    expect(settings.hasShortcutOverrides).toBe(false);
    expect(chordToString(settings.shortcutBindings.get('files.save')![0]!)).toBe('Ctrl+S');
  });

  it('stores only the difference, never the whole table', () => {
    // A stored full table would freeze whatever shipped on the day the user
    // first opened the screen, and a later build that moved a chord would never
    // reach them.
    const settings = useSettingsStore();
    expect(settings.rebindShortcut('files.filterTree', parseChord('Ctrl+Shift+F')!)).toBeNull();
    expect(stored()['shortcutOverrides']).toEqual({ 'files.filterTree': 'Ctrl+Shift+F' });
  });

  it('puts the new chord in force immediately, for the handlers reading it', () => {
    const settings = useSettingsStore();
    settings.rebindShortcut('files.filterTree', parseChord('Ctrl+Shift+F')!);
    expect(isShortcut(settings.shortcutBindings, 'files.filterTree', { key: 'F', ctrlKey: true, shiftKey: true })).toBe(true);
    expect(isShortcut(settings.shortcutBindings, 'files.filterTree', { key: 'f', ctrlKey: true })).toBe(false);
  });

  it('hands the refusal back rather than throwing out of a click handler', () => {
    const settings = useSettingsStore();
    const refusal = settings.rebindShortcut('terminal.copySelection', parseChord('Ctrl+C')!);
    // SIGINT. Not the menu's `copy` role, which a cancelled keydown suppresses
    // — the shell is the reason this one can never be taken.
    expect(refusal?.kind).toBe('reserved');
    // And nothing was written: a refused rebinding must leave no trace.
    expect(settings.shortcutOverrides).toEqual({});
  });

  it('names the command a conflicting chord already belongs to', () => {
    const settings = useSettingsStore();
    const refusal = settings.rebindShortcut('files.filterTree', parseChord('Ctrl+L')!);
    expect(refusal).toMatchObject({ kind: 'conflict', withId: 'files.gotoPath' });
  });

  it('lets a chord be moved onto one that was vacated in the same session', () => {
    const settings = useSettingsStore();
    expect(settings.rebindShortcut('files.gotoPath', parseChord('Ctrl+Shift+L')!)).toBeNull();
    expect(settings.rebindShortcut('files.filterTree', parseChord('Ctrl+L')!)).toBeNull();
  });

  it('resets one binding by DELETING the override, not by writing the default', () => {
    // An override equal to today's default would silently pin the old chord if
    // a later build moved it.
    const settings = useSettingsStore();
    settings.rebindShortcut('files.save', parseChord('Ctrl+Shift+S')!);
    expect(settings.isShortcutOverridden('files.save')).toBe(true);
    settings.resetShortcut('files.save');
    expect(settings.shortcutOverrides).toEqual({});
    expect(chordToString(settings.shortcutBindings.get('files.save')![0]!)).toBe('Ctrl+S');
  });

  it('resets everything in one write', () => {
    const settings = useSettingsStore();
    settings.rebindShortcut('files.save', parseChord('Ctrl+Shift+S')!);
    settings.rebindShortcut('files.filterTree', parseChord('Ctrl+Shift+F')!);
    settings.resetAllShortcuts();
    expect(settings.hasShortcutOverrides).toBe(false);
    expect(stored()['shortcutOverrides']).toEqual({});
  });

  it('survives a restart', () => {
    const first = useSettingsStore();
    first.rebindShortcut('composer.attach', parseChord('Ctrl+Shift+P')!);
    setActivePinia(createPinia());
    const second = useSettingsStore();
    expect(chordToString(second.shortcutBindings.get('composer.attach')![0]!)).toBe('Ctrl+Shift+P');
  });

  it('degrades a hand-edited blob per ENTRY', () => {
    const out = coerceSettings({
      shortcutOverrides: {
        'files.save': 'Ctrl+Shift+S',
        // Not a chord this app's spelling can express.
        'files.gotoPath': 'Hyper+L',
        // Not a shortcut this build has.
        'gone.away': 'Ctrl+Shift+G',
        // A binding this build made fixed — a stored override must not reach
        // around that decision.
        'zoom.in': 'Ctrl+Shift+Y',
        // Not a string at all.
        'files.filterTree': 7,
      },
    }).shortcutOverrides;
    expect(out).toEqual({ 'files.save': 'Ctrl+Shift+S' });
  });

  it('re-spells a hand-written chord into the one canonical form', () => {
    // Otherwise the map could hold two spellings of one chord and the conflict
    // check would miss the pair.
    expect(
      coerceSettings({ shortcutOverrides: { 'files.save': 'shift+cmd+s' } }).shortcutOverrides,
    ).toEqual({ 'files.save': 'Ctrl+Shift+S' });
  });

  it('falls back wholesale only when the value is not an object', () => {
    expect(coerceSettings({ shortcutOverrides: ['Ctrl+S'] }).shortcutOverrides).toEqual({});
    expect(coerceSettings({ shortcutOverrides: 'Ctrl+S' }).shortcutOverrides).toEqual({});
  });

  it('keeps the rest of the blob when only this key is corrupt', () => {
    const settings = coerceSettings({ shortcutOverrides: 3, defaultHost: 'hetzner' });
    expect(settings.shortcutOverrides).toEqual({});
    expect(settings.defaultHost).toBe('hetzner');
  });
});

/**
 * The session panel's hand-arranged folder order.
 *
 * The RULES live in `renderer/folderOrder.ts` and are tested there; what this
 * store owns is the three things a store owns — the default, the round trip,
 * and refusing to trust what was on disk. Plus one decision that is genuinely
 * this file's: an empty arrangement is an absent key, not a stored `[]`.
 */
describe('folder order', () => {
  it('defaults to nothing arranged, which means "creation order"', () => {
    expect(useSettingsStore().folderOrder).toEqual({});
    expect(useSettingsStore().folderOrderFor('hetzner')).toEqual([]);
  });

  it('hands every caller its own object, never the spec default itself', () => {
    const a = settingsDefaults();
    a.folderOrder['hetzner'] = ['~/git/a'];
    expect(settingsDefaults().folderOrder).toEqual({});
  });

  it('records a drag against the host alias and persists it', () => {
    const settings = useSettingsStore();
    settings.setFolderOrder('hetzner', ['~/git/c', '~/git/a']);
    expect(settings.folderOrderFor('hetzner')).toEqual(['~/git/c', '~/git/a']);
    expect(stored()['folderOrder']).toEqual({ hetzner: ['~/git/c', '~/git/a'] });
  });

  it('keeps hosts apart, because no two hosts hold the same folders', () => {
    const settings = useSettingsStore();
    settings.setFolderOrder('hetzner', ['~/git/a']);
    settings.setFolderOrder('laptop', ['~/git/b']);
    expect(settings.folderOrderFor('hetzner')).toEqual(['~/git/a']);
    expect(settings.folderOrderFor('laptop')).toEqual(['~/git/b']);
  });

  it('REMOVES a host entry rather than storing an empty arrangement', () => {
    // "This host is not arranged" and "there is no entry for it" are one
    // state, so a host whose folders all went away leaves no key behind.
    const settings = useSettingsStore();
    settings.setFolderOrder('hetzner', ['~/git/a']);
    settings.setFolderOrder('hetzner', []);
    expect(settings.folderOrder).toEqual({});
  });

  it('ignores a write with no host, because there is nothing to key it on', () => {
    const settings = useSettingsStore();
    settings.setFolderOrder('', ['~/git/a']);
    expect(settings.folderOrder).toEqual({});
  });

  it('survives a restart', () => {
    useSettingsStore().setFolderOrder('hetzner', ['~/git/c', '~/git/a']);
    setActivePinia(createPinia());
    expect(useSettingsStore().folderOrderFor('hetzner')).toEqual(['~/git/c', '~/git/a']);
  });

  it('degrades a corrupt blob per HOST and per KEY, not per setting', () => {
    expect(
      coerceSettings({
        folderOrder: { good: ['~/git/a', 7, '~/git/b'], broken: 'not-a-list' },
      }).folderOrder,
    ).toEqual({ good: ['~/git/a', '~/git/b'] });
  });

  it('falls back to the default when the value is not an object at all', () => {
    expect(coerceSettings({ folderOrder: ['~/git/a'] }).folderOrder).toEqual({});
    expect(coerceSettings({ folderOrder: null }).folderOrder).toEqual({});
  });

  it('keeps the rest of the blob when only the arrangement is corrupt', () => {
    const settings = coerceSettings({ folderOrder: 3, defaultHost: 'hetzner' });
    expect(settings.folderOrder).toEqual({});
    expect(settings.defaultHost).toBe('hetzner');
  });
});
