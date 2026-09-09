// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils';
import { defineComponent, type PropType } from 'vue';
import type { HostEntry, SessionSummary } from '../../src/shared/types';

/**
 * The session panel's creation controls.
 *
 * The user's ask was one sentence — "a `+` near git, near tmp, and just a plus
 * to create a random session in any place; then we don't need 'new session'
 * button anymore" — and it contains a removal, which is what these tests are
 * really guarding. Deleting the foot button is only safe while both `+`s
 * exist, so the properties checked here are:
 *
 *   1. **There is always a way to create a session.** The header's `+` renders
 *      before the session list has loaded, on a host with no sessions at all,
 *      and on a host that failed to resolve `$HOME`. A panel that can show
 *      "no sessions" and no way to make one is the state the removal could
 *      have introduced.
 *   2. **A root's `+` starts the picker IN that root**, expanded to a real
 *      absolute path — not at `$HOME`, and never at the literal `~/git`, which
 *      SFTP would read as a directory named `~`.
 *   3. **`other` has no `+`**, because it is a bucket rather than a directory.
 *   4. **An EMPTY registered root has one**, which is the case the whole
 *      feature is most useful for: a root registered in Settings that nothing
 *      is running in yet.
 *
 * The dialog itself is stubbed. What matters at this seam is which folder it
 * is handed, and NewSessionDialog's own behaviour (browse, derive, start) is
 * not this component's to prove.
 */

const sessionsList = vi.fn<() => Promise<SessionSummary[]>>();
const projectsHome = vi.fn<() => Promise<{ ok: boolean; home?: string; error?: string }>>();
/**
 * `projects:killSession`, which the panel now reaches for once per session in a
 * stopped folder. It never throws in the real preload — a refusal comes back as
 * `ok: false` with a code — so the default here is the ordinary success and the
 * tests that care about refusals set their own.
 */
const killSession =
  vi.fn<
    (connectionId: string, name: string) => Promise<{ ok: boolean; code?: string; error?: string }>
  >();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    // The two calls the panel makes on mount.
    helper: { sessionsList: () => sessionsList() },
    projects: {
      home: () => projectsHome(),
      killSession: (connectionId: string, name: string) => killSession(connectionId, name),
      onCloneProgress: vi.fn(),
    },
    // Present because constructing the connection store subscribes to them,
    // not because this component uses them.
    ssh: { onState: vi.fn(), listConfigHosts: vi.fn().mockResolvedValue([]) },
  },
}));

const SessionTree = (await import('../../src/renderer/components/SessionTree.vue')).default;
const { useConnectionStore } = await import('../../src/renderer/stores/connection');
const { useSettingsStore } = await import('../../src/renderer/stores/settings');

/** Terse SessionSummary factory — only the fields grouping reads. */
function session(name: string, path: string | null, activity = 100): SessionSummary {
  return { name, created: activity, activity, attached: false, path };
}

const HOME = '/home/alexey';

/**
 * The creation dialog, stubbed so its own onMounted browse never runs.
 *
 * Declared as a component rather than inline in `global.stubs` so it can be
 * handed back to `findComponent`: a stub registered only by NAME gets a
 * generated one, and `findComponent({ name: 'NewSessionDialog' })` misses it.
 * `startIn` is what the tests read off it, and it is the whole contract here.
 */
const DialogStub = defineComponent({
  props: {
    startIn: { type: String as PropType<string | null>, default: undefined },
    roots: { type: Array as PropType<{ label: string; path: string }[]>, default: undefined },
  },
  template: '<div class="dialog-stub" />',
});

/**
 * PopupMenu, flattened into the component tree.
 *
 * The real one teleports to `<body>`, which is exactly right in the app and
 * exactly wrong here: a teleported node is outside the wrapper, so every
 * `wrapper.find` in these tests would miss it and the assertions would read as
 * "the menu did not open". What is being checked at this seam is which items a
 * folder row offers and which folder they are pointed at; the teleport and the
 * placement are PopupMenu's own, and popupPlacement.test.ts holds them.
 *
 * Plain options object rather than `defineComponent`, unlike the dialog above:
 * nothing here is ever read back off the instance — the items are found by
 * class — so it needs no identity, and one `defineComponent` per file is the
 * shape the lint rule is asking for.
 */
const MenuStub = {
  props: ['anchor', 'label'],
  template: '<div class="menu-stub" :aria-label="label"><slot /></div>',
};

/**
 * Mount the panel against a host holding `sessions`, with `roots` registered
 * in Settings, and let the two mounted fetches settle.
 */
const mounted: VueWrapper[] = [];

async function open(
  sessions: SessionSummary[],
  roots: string[] = [],
  home: string | null = HOME,
  host = 'hetzner',
  rootsByHost: Record<string, string[]> | null = null,
): Promise<VueWrapper> {
  sessionsList.mockResolvedValue(sessions);
  projectsHome.mockResolvedValue(
    home === null ? { ok: false, error: 'no $HOME' } : { ok: true, home },
  );
  const connection = useConnectionStore();
  connection.connectionId = 'conn-1';
  // The manual folder order is keyed on the host ALIAS (`HostEntry.name`), so
  // the panel needs a connected host before a drag has anywhere to persist to.
  // The rest of the entry is inert here — nothing in this component reads it.
  connection.activeHost = { name: host } as HostEntry;
  useSettingsStore().sessionRoots =
    rootsByHost ?? (roots.length ? { [host]: roots } : {});

  const wrapper = mount(SessionTree, {
    global: { stubs: { NewSessionDialog: DialogStub, PopupMenu: MenuStub } },
  });
  mounted.push(wrapper);
  await flush(wrapper);
  return wrapper;
}

async function flush(wrapper: VueWrapper): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  // The poll tests install fake timers BEFORE mounting, because the panel's
  // `setInterval` is created in `onMounted` and one taken out against the real
  // clock cannot be advanced afterwards. That makes the plain `setTimeout(0)`
  // below never fire, so the settle step has to be spelled whichever way the
  // clock currently works.
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
  else await new Promise((r) => setTimeout(r, 0));
  await wrapper.vm.$nextTick();
}

/** The header's general `+` — "a session anywhere". */
function generalAdd(wrapper: VueWrapper): DOMWrapper<Element> {
  return wrapper.find('[title="New session in any folder"]');
}

/** Every control in the header strip, in rendered order, by its title. */
function headerControls(wrapper: VueWrapper): string[] {
  return wrapper
    .findAll('.tree-header button')
    .map((b) => b.attributes('title') ?? '');
}

/** Every root row's `+`, in rendered order, with the root it points at. */
function rootAdds(wrapper: VueWrapper): { title: string; disabled: boolean }[] {
  return wrapper.findAll('.root-add').map((b) => ({
    title: b.attributes('title') ?? '',
    disabled: b.attributes('disabled') !== undefined,
  }));
}

/** Every folder row's label, in rendered order. */
function dirLabels(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.dir-header .label').map((l) => l.text());
}

/** The items in the open row menu, with whether each is takeable. */
function menuItems(wrapper: VueWrapper): { text: string; disabled: boolean }[] {
  return wrapper.findAll('.menu-stub .menu-item').map((b) => ({
    text: b.text(),
    disabled: b.attributes('disabled') !== undefined,
  }));
}

/**
 * The FIRST class of each child element, in DOM order.
 *
 * DOM order is the assertion for a layout request like "move 10 closer to git":
 * the field order in the markup is what the row's reading order rests on, and
 * it is the half a jsdom test can see — scoped-SFC CSS is not applied here, so
 * `margin-left: auto` has to be verified by reading the stylesheet.
 */
function childClasses(el: Element): string[] {
  // An indexed loop rather than a spread: `HTMLCollection` is only iterable
  // under `lib.dom.iterable`, which this project does not enable, so spreading
  // it yields `any[]` and the lint rules — rightly — refuse it.
  const out: string[] = [];
  for (let i = 0; i < el.children.length; i += 1) {
    out.push(el.children[i]?.className.split(' ')[0] ?? '');
  }
  return out;
}

/** The stubbed dialog's `startIn`, or `undefined` when it is shut. */
function dialogStartIn(wrapper: VueWrapper): string | null | undefined {
  const stub = wrapper.findComponent(DialogStub);
  return stub.exists() ? stub.props('startIn') : undefined;
}

/** The stubbed dialog's `roots` menu list, or `undefined` when it is shut. */
function dialogRoots(wrapper: VueWrapper): { label: string; path: string }[] | undefined {
  const stub = wrapper.findComponent(DialogStub);
  return stub.exists() ? stub.props('roots') : undefined;
}

beforeEach(() => {
  setActivePinia(createPinia());
  window.localStorage.clear();
  vi.clearAllMocks();
  killSession.mockResolvedValue({ ok: true });
});

// A panel left mounted keeps its REAL-clock 5 s poll running for the rest of
// the file, and every stray tick lands in the shared `sessionsList` spy —
// count assertions then depend on how much wall time the file happened to
// take, which under a loaded parallel run is "some tests randomly fail".
// Unmounting everything at test end is what stops the clock they tick on.
afterEach(() => {
  while (mounted.length) {
    try {
      mounted.pop()!.unmount();
    } catch {
      // A test that unmounted its own wrapper already stopped its clock.
    }
  }
});

describe('SessionTree — the foot button is gone, and nothing went with it', () => {
  it('no longer renders the full-width "New session" button', async () => {
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    expect(wrapper.find('.new-session-btn').exists()).toBe(false);
  });

  it('offers the general + even on a host with no sessions at all', async () => {
    // The state the removal could have stranded: an empty panel used to have
    // exactly one creation control, and it was the one that was deleted.
    const wrapper = await open([]);
    expect(wrapper.find('.empty').text()).toContain('no sessions');
    expect(generalAdd(wrapper).exists()).toBe(true);
  });

  it('offers a worded "New session…" in the empty state, not only the header glyph', async () => {
    // The sentence alone was a dead end: the header's `+` exists but is an
    // unlabelled 14px mark in a strip of five, and an empty panel is exactly
    // when a user has no habits to find it by. The folder workspace's empty
    // state set the pattern — say what is empty AND offer the action in words.
    const wrapper = await open([]);
    const cta = wrapper.find('.empty .btn-ghost');
    expect(cta.exists()).toBe(true);
    expect(cta.text()).toBe('New session…');
    await cta.trigger('click');
    // Null: no sessions and no registered roots leaves no root to start in, so
    // this door falls back to the dialog's own `$HOME` behaviour the same way
    // the header `+` does.
    expect(dialogStartIn(wrapper)).toBeNull();
  });

  it('opens the picker in the first root the panel draws', async () => {
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    expect(dialogStartIn(wrapper)).toBeUndefined();
    await generalAdd(wrapper).trigger('click');
    // The user's ask: "by default + creates a workspace in the first
    // configured project root". Derived or registered, the first root the
    // panel draws is where the browse lands — `$HOME` is now only the
    // fallback for a panel with no root at all.
    expect(dialogStartIn(wrapper)).toBe(`${HOME}/git`);
  });

  it('starts the general + in the first REGISTERED root when nothing is running', async () => {
    // The state the default is most useful for: roots registered in Settings,
    // nothing live yet. The empty panel still names a starting point.
    const wrapper = await open([], ['~/git', '~/work']);
    await generalAdd(wrapper).trigger('click');
    expect(dialogStartIn(wrapper)).toBe(`${HOME}/git`);
  });

  it('skips the other bucket when choosing the default', async () => {
    // A session under no root renders the catch-all row, and a bucket is not
    // a place to create in — the first REAL root is what the `+` opens.
    const wrapper = await open([session('loose', '/srv/elsewhere')], ['~/git']);
    await generalAdd(wrapper).trigger('click');
    expect(dialogStartIn(wrapper)).toBe(`${HOME}/git`);
  });

  it('falls back to $HOME (null) when no root can be resolved', async () => {
    // No sessions, nothing registered, and a host whose $HOME never answered:
    // there is no first root, and the picker must still open.
    const wrapper = await open([], [], null);
    await generalAdd(wrapper).trigger('click');
    expect(dialogStartIn(wrapper)).toBeNull();
  });

  it('hands the picker the resolved roots for its dropdown', async () => {
    // The picker's crumb bar offers the roots as a menu — the "select a
    // different one" half of the general + default. Labels stay the panel's
    // home-relative keys; paths arrive absolute, ready to browse.
    const wrapper = await open([session('git-a', `${HOME}/git/a`)], ['~/git', '~/work']);
    await generalAdd(wrapper).trigger('click');
    expect(dialogRoots(wrapper)).toEqual([
      { label: '~/git', path: `${HOME}/git` },
      { label: '~/work', path: `${HOME}/work` },
    ]);
  });

  it('leaves the bucket and unresolvable roots out of that list', async () => {
    // A session under no root makes the `other` row, and a `~`-keyed root on a
    // host with no $HOME has no absolute path — neither is a menu item that
    // can be followed, so neither is offered.
    const wrapper = await open([session('loose', '/srv/elsewhere')], ['~/git'], null);
    await generalAdd(wrapper).trigger('click');
    expect(dialogRoots(wrapper)).toEqual([]);
  });
});

describe('SessionTree — the creation chord (sessions.new)', () => {
  function pressChord(target: EventTarget = window): void {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, shiftKey: true, bubbles: true }),
    );
  }

  it('opens the picker in the first root, from wherever focus sits', async () => {
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    pressChord();
    await flush(wrapper);
    // The same door as the header `+`: same default root, one object of state.
    expect(dialogStartIn(wrapper)).toBe(`${HOME}/git`);
  });

  it('stands down while the user is typing in a field', async () => {
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    pressChord(input);
    await flush(wrapper);
    expect(dialogStartIn(wrapper)).toBeUndefined();
    input.remove();
  });

  it('does not reset a picker that is already open', async () => {
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    await generalAdd(wrapper).trigger('click');
    expect(dialogStartIn(wrapper)).toBe(`${HOME}/git`);
    pressChord();
    await flush(wrapper);
    // A second press must not rebuild the dialog's `creating` state mid-browse;
    // Escape is how the picker closes.
    const stub = wrapper.findComponent(DialogStub);
    expect(stub.exists()).toBe(true);
    expect(wrapper.findAllComponents(DialogStub)).toHaveLength(1);
  });
});

describe('SessionTree — the header strip', () => {
  it('reads back, +, ports, usage, refresh, settings, hide', async () => {
    // The user's own order for the last four ("here have ... then refresh then
    // settings then hide"), with the `+` leading the actions group because it
    // is the panel's primary action and the rest is chrome. The header expansion made
    // their `⋯` into its two overlays at the same user's ask, so Ports and
    // Usage are now two buttons between `+` and Refresh — the words in the
    // test are their tooltips/accessible names, as they were for the kebab.
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    expect(headerControls(wrapper)).toEqual([
      'Back to hosts',
      'New session in any folder',
      'Port forwarding',
      'Provider usage',
      'Refresh',
      'Settings',
      'Hide session panel',
    ]);
  });

  it('opens Settings from its own control', async () => {
    const wrapper = await open([]);
    await wrapper.get('[title="Settings"]').trigger('click');
    expect(wrapper.emitted('panel')).toEqual([['settings']]);
  });

  it('opens each overlay straight from its icon — no intermediate menu', async () => {
    // The whole point: one click, not open-the-kebab-then-pick. Each
    // button announces itself, so a regression back to an overflow trigger
    // fails here before it fails anywhere else.
    const wrapper = await open([]);
    await wrapper.get('[title="Port forwarding"]').trigger('click');
    await wrapper.get('[title="Provider usage"]').trigger('click');
    expect(wrapper.emitted('panel')).toEqual([['ports'], ['usage']]);
  });
});

describe('SessionTree — the Ports button carries the auto-forward indicator', () => {
  it('leaves the glyph plain while auto-forward is off', async () => {
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    expect(wrapper.get('[title="Port forwarding"]').classes()).not.toContain('auto-on');
    expect(wrapper.find('.auto-dot').exists()).toBe(false);
  });

  it('marks the PORTS button — ring, dot, truthful title — and not its sibling', async () => {
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    await wrapper.setProps({ autoForward: true });

    // The title is how the test knows which button it is holding: the marked
    // one is Ports, its word extended, and Usage stays unmarked and plain.
    const ports = wrapper.get('[title="Port forwarding — auto-forward on"]');
    expect(ports.classes()).toContain('auto-on');
    expect(ports.find('.auto-dot').exists()).toBe(true);
    expect(wrapper.find('[title="Provider usage"].auto-on').exists()).toBe(false);
    expect(wrapper.get('[title="Provider usage"]').find('.auto-dot').exists()).toBe(false);
  });

  it('relays the live forward count into the pill', async () => {
    // The count is the workspace's value like auto-forward is; the tree only
    // carries it through, and this header must read like the collapsed rail.
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    await wrapper.setProps({ autoForward: true, forwardCount: 2 });

    const ports = wrapper.get('[title="Port forwarding — auto-forward on, 2 ports"]');
    expect(ports.get('.auto-count').text().trim()).toBe('2');
    expect(wrapper.find('[title="Provider usage"].auto-on').exists()).toBe(false);
  });
});

describe('SessionTree — the per-root +', () => {
  it('does not render another host\'s registered roots', async () => {
    const wrapper = await open(
      [session('tmp-b', `${HOME}/tmp/b`, 100)],
      [],
      HOME,
      'aws',
      { hetzner: ['~/git'] },
    );

    // The AWS host has no root entry, so it uses its own derived `tmp` root;
    // Hetzner's registered `git` must not leak in as an empty header.
    expect(wrapper.findAll('.folder-label').map((label) => label.text())).toEqual(['~/tmp']);
  });

  it('puts one on every real root and none on `other`', async () => {
    const wrapper = await open([
      session('git-a', `${HOME}/git/a`, 100),
      session('tmp-b', `${HOME}/tmp/b`, 200),
      session('elsewhere', '/srv/app', 300),
    ]);
    expect(wrapper.findAll('.folder-label').map((l) => l.text())).toEqual([
      '~/git',
      '~/tmp',
      'other',
    ]);
    // Three roots, two `+`s. `other` is where paths that matched no root went;
    // there is no directory for the picker to start in.
    expect(rootAdds(wrapper).map((a) => a.title)).toEqual([
      'New session in ~/git',
      'New session in ~/tmp',
    ]);
  });

  it('hands the picker the root expanded to an absolute path', async () => {
    const wrapper = await open([session('git-a', `${HOME}/git/a`)]);
    await wrapper.get('.root-add').trigger('click');
    // NOT `~/git`. The dialog browses over SFTP, which runs no shell.
    expect(dialogStartIn(wrapper)).toBe('/home/alexey/git');
  });

  it('works on a registered root with nothing running in it', async () => {
    // A registered root renders even when empty, deliberately — and this is
    // the case the `+` is most useful for, so it must not be conditioned on
    // the root having directories under it.
    const wrapper = await open([session('git-a', `${HOME}/git/a`)], ['~/git', '~/tmp']);
    expect(wrapper.findAll('.empty-root')).toHaveLength(1);
    const adds = wrapper.findAll('.root-add');
    expect(adds).toHaveLength(2);
    await adds[1]!.trigger('click');
    expect(dialogStartIn(wrapper)).toBe('/home/alexey/tmp');
  });

  it('resolves a root registered outside $HOME without rewriting it', async () => {
    const wrapper = await open([session('app', '/srv/apps/x')], ['/srv/apps']);
    await wrapper.get('.root-add').trigger('click');
    expect(dialogStartIn(wrapper)).toBe('/srv/apps');
  });

  it('falls back to the home inferred from the paths when $HOME will not resolve', async () => {
    // Grouping already infers a home rather than dumping everything into
    // `other`; the `+` reads the same inferred value, so the two cannot
    // disagree about which directory `~/git` is.
    const wrapper = await open([session('git-a', `${HOME}/git/a`)], [], null);
    const [add] = rootAdds(wrapper);
    expect(add?.disabled).toBe(false);
    await wrapper.get('.root-add').trigger('click');
    expect(dialogStartIn(wrapper)).toBe('/home/alexey/git');
  });

  it('disables the + rather than hiding it when no home can be found at all', async () => {
    // A registered root on a host whose $HOME failed AND whose sessions offer
    // nothing to infer from. The control stays: a button that vanishes on a
    // failed fetch reads as a feature that is not there, and the title says
    // what went wrong.
    const wrapper = await open([session('nowhere', null)], ['~/git'], null);
    const [add] = rootAdds(wrapper);
    expect(add?.disabled).toBe(true);
    expect(add?.title).toContain('cannot resolve $HOME');
  });
});

/**
 * The folder row's context menu.
 *
 * The gap it closes is one the two `+`s cannot: standing on the row that says
 * `dataqna` and wanting a session IN `dataqna` meant opening the picker at
 * `~/git` and browsing back down to the folder already under the cursor. The
 * row knows its own directory, so the properties here are that it HANDS that
 * directory over, absolute, and that it refuses rather than guesses when it has
 * none.
 */
describe('SessionTree — right-clicking a folder row', () => {
  it('offers a new session in the folder that was right-clicked', async () => {
    const wrapper = await open([
      session('git-dataqna', `${HOME}/git/dataqna`, 200),
      session('git-other', `${HOME}/git/other`, 300),
    ]);
    expect(dirLabels(wrapper)).toEqual(['dataqna', 'other']);
    expect(wrapper.find('.menu-stub').exists()).toBe(false);

    await wrapper.findAll('.dir-header')[0]!.trigger('contextmenu');
    expect(menuItems(wrapper)).toEqual([
      { text: 'New session…', disabled: false },
      { text: 'Stop session…', disabled: false },
    ]);

    await wrapper.get('.menu-stub .menu-item').trigger('click');
    // The whole point: the picker opens IN the folder, expanded to a real
    // absolute path — never at `$HOME`, and never at the literal `~/git/dataqna`,
    // which SFTP would read as a directory named `~`.
    expect(dialogStartIn(wrapper)).toBe('/home/alexey/git/dataqna');
    // Taking the item closes the menu; two overlapping surfaces is not a state
    // this should be able to reach.
    expect(wrapper.find('.menu-stub').exists()).toBe(false);
  });

  it('acts on the row under the cursor, not on the first one', async () => {
    const wrapper = await open([
      session('git-dataqna', `${HOME}/git/dataqna`, 200),
      session('git-other', `${HOME}/git/other`, 300),
    ]);
    await wrapper.findAll('.dir-header')[1]!.trigger('contextmenu');
    await wrapper.get('.menu-stub .menu-item').trigger('click');
    expect(dialogStartIn(wrapper)).toBe('/home/alexey/git/other');
  });

  it('suppresses the browser default menu', async () => {
    // In a packaged Electron app the default here is Chromium's own menu, which
    // carries nothing that applies to a session row. Dispatched by hand because
    // `trigger` does not hand the event back, and `defaultPrevented` is the only
    // thing that actually proves the `.prevent`.
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    wrapper.get('.dir-header').element.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves the row left-click exactly as it was', async () => {
    // The menu is additive. A left-click still opens the folder's workspace,
    // and a right-click still does NOT — a right-click the user then dismisses
    // must not have navigated them somewhere in the meantime.
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    await wrapper.get('.dir-header').trigger('contextmenu');
    expect(wrapper.emitted('select')).toBeUndefined();
    await wrapper.get('.dir-header').trigger('click');
    expect(wrapper.emitted('select')).toHaveLength(1);
  });

  it('disables the item on a folder with no directory on the host', async () => {
    // An untracked session — tmux reported no cwd — is rendered as a folder row
    // labelled by the session name. There is no directory behind it, so there is
    // nowhere to create anything; the item stays, disabled, because `startIn`
    // does not FAIL when it is null, it silently means `$HOME`, and that is a
    // session in the wrong place rather than a session that was not created.
    const wrapper = await open([session('nowhere', null)]);
    expect(dirLabels(wrapper)).toEqual(['nowhere']);
    await wrapper.get('.dir-header').trigger('contextmenu');
    // Only the CREATE half is disabled. Stopping needs a session name and not a
    // directory, so the folder tmux could not place is still one this menu can
    // clear — the two items fail independently because they depend on different
    // things.
    expect(menuItems(wrapper)).toEqual([
      { text: 'New session…', disabled: true },
      { text: 'Stop session…', disabled: false },
    ]);
    expect(wrapper.get('.menu-stub .menu-item').attributes('title')).toContain(
      'no directory on this host',
    );
    await wrapper.get('.menu-stub .menu-item').trigger('click');
    expect(dialogStartIn(wrapper)).toBeUndefined();
  });
});

/**
 * Stopping every session in a folder.
 *
 * The tab menu can already stop ONE session; what it
 * cannot do is clear a folder without opening its workspace and confirming once
 * per tab. The folder row is the only control that stands for the whole set, so
 * this is the only place the action can live.
 *
 * It is the second destructive thing in the app and it multiplies the first, so
 * what is pinned here is mostly what must NOT happen: nothing dies before the
 * confirm, nothing outside the folder dies at all, the sessions are named on
 * screen before the user agrees to lose them, and a partial failure says which
 * ones survived instead of reporting a clean sweep.
 */
describe('SessionTree — stopping every session in a folder', () => {
  /** The names in the open confirm, in rendered order. */
  function confirmList(wrapper: VueWrapper): string[] {
    return wrapper.findAll('.stop-list li').map((li) => li.text());
  }

  async function openStopConfirm(wrapper: VueWrapper, row = 0): Promise<void> {
    await wrapper.findAll('.dir-header')[row]!.trigger('contextmenu');
    await wrapper.get('.menu-stub .menu-item.danger').trigger('click');
  }

  // The rows arrive in the order the assertions expect: the panel renders
  // the host's order, and the fixture lists its
  // sessions the way the host would print them — `dataqna` first, its second
  // session after it, `other` last.
  const FOLDER = [
    session('git-dataqna', `${HOME}/git/dataqna`, 200),
    session('git-dataqna-2', `${HOME}/git/dataqna`, 250),
    session('git-other', `${HOME}/git/other`, 300),
  ];

  it('counts the folder in the item and names every session in the confirm', async () => {
    const wrapper = await open(FOLDER);
    await wrapper.findAll('.dir-header')[0]!.trigger('contextmenu');
    // Counted, because the row shows a number and no names: `Stop session…`
    // on a folder holding two would understate what the click does.
    expect(menuItems(wrapper)).toEqual([
      { text: 'New session…', disabled: false },
      { text: 'Stop all 2 sessions…', disabled: false },
    ]);

    await wrapper.get('.menu-stub .menu-item.danger').trigger('click');
    // Opening the confirm closes the menu, and kills nothing: the dialog is a
    // question, and everything before the answer has to cost the user nothing.
    expect(wrapper.find('.menu-stub').exists()).toBe(false);
    expect(killSession).not.toHaveBeenCalled();
    // The names are the point. A folder row carries a dot, a label and a count,
    // so without this the user would be agreeing to two things they cannot
    // see — and the sibling folder must be visibly NOT among them.
    expect(confirmList(wrapper)).toEqual(['git-dataqna', 'git-dataqna-2']);
    expect(wrapper.get('.stop-confirm').text()).toContain('dataqna');
  });

  it('kills exactly the folder it was opened on, by tmux name', async () => {
    const wrapper = await open(FOLDER);
    await openStopConfirm(wrapper);
    await wrapper.get('.stop-confirm .btn-danger').trigger('click');
    await flush(wrapper);

    expect(killSession.mock.calls).toEqual([
      ['conn-1', 'git-dataqna'],
      ['conn-1', 'git-dataqna-2'],
    ]);
    // The listing is re-read rather than left to the poll: the rows the user
    // just cleared have to be gone by the time the dialog is.
    expect(sessionsList).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.stop-confirm').exists()).toBe(false);
    expect(wrapper.find('.stop-error').exists()).toBe(false);
  });

  it('takes the rows down even when the listing still carries them', async () => {
    // The window the bug lived in: `a kill` answers ok once the worker
    // accepts the stop, and the record leaves the host's snapshot only when
    // the worker has finished terminating the workload. This listing answers
    // with the killed rows forever — the ordinary corpse a slow finalization
    // leaves in every snapshot read inside that window — and the folder's
    // rows must still come off the tree the moment the kills land, instead
    // of sitting there looking live above a pane that already said
    // "[process exited]".
    const wrapper = await open(FOLDER);
    await openStopConfirm(wrapper);
    await wrapper.get('.stop-confirm .btn-danger').trigger('click');
    await flush(wrapper);

    expect(wrapper.text()).not.toContain('dataqna');
    // The folder the confirm did not touch is untouched.
    const headers = wrapper.findAll('.dir-header').map((h) => h.text());
    expect(headers).toHaveLength(1);
    expect(headers[0]).toContain('other');
  });

  it('acts on the row under the cursor, not on the first one', async () => {
    const wrapper = await open(FOLDER);
    await openStopConfirm(wrapper, 1);
    // One session in that folder, so the confirm names it in the sentence
    // rather than in a list — and the two it did NOT open on are absent.
    expect(wrapper.get('.stop-confirm p').text()).toBe('Stop git-other ?');
    await wrapper.get('.stop-confirm .btn-danger').trigger('click');
    await flush(wrapper);
    expect(killSession.mock.calls).toEqual([['conn-1', 'git-other']]);
  });

  it('asks the tab menu\'s own question when the folder holds one session', async () => {
    // Not a near-miss of it: the same words, so the two confirms read as one
    // feature reached from two menus rather than as two features. The list goes
    // with the count — it could only repeat the name the sentence now carries.
    const wrapper = await open([session('git-solo', `${HOME}/git/solo`)]);
    await wrapper.get('.dir-header').trigger('contextmenu');
    expect(menuItems(wrapper)[1]).toEqual({ text: 'Stop session…', disabled: false });
    await wrapper.get('.menu-stub .menu-item.danger').trigger('click');
    expect(wrapper.get('.stop-confirm p').text()).toBe('Stop git-solo ?');
    expect(confirmList(wrapper)).toEqual([]);
    expect(wrapper.get('.stop-confirm .btn-danger').text()).toBe('Stop session');
  });

  it('says Stop, never Kill or Close, everywhere a user can read it', async () => {
    // `Close` in this app closes a TAB and leaves the session running, and the
    // tab menu's word for killing one is `Stop`. Two words for one destructive
    // act, in two menus a click apart, is how one of them starts looking like
    // the safe one. `kills` survives inside the confirm's explanation, where
    // the tab menu's dialog uses it too — that is the sentence saying what
    // Stop actually costs.
    const wrapper = await open(FOLDER);
    await wrapper.findAll('.dir-header')[0]!.trigger('contextmenu');
    const item = wrapper.get('.menu-stub .menu-item.danger');
    expect(item.text()).toContain('Stop');
    expect(item.attributes('title')).toBe('Stop 2 sessions on the host');
    await item.trigger('click');
    for (const text of [
      wrapper.get('.stop-confirm p').text(),
      wrapper.get('.stop-confirm .btn-danger').text(),
    ]) {
      expect(text).not.toMatch(/close|kill/i);
    }
  });

  it('kills nothing when the confirm is cancelled', async () => {
    const wrapper = await open(FOLDER);
    await openStopConfirm(wrapper);
    await wrapper.get('.stop-confirm .btn-secondary').trigger('click');
    expect(killSession).not.toHaveBeenCalled();
    expect(wrapper.find('.stop-confirm').exists()).toBe(false);
  });

  it('treats a session the host says is already gone as stopped', async () => {
    // The ordinary race, not an exotic one: the panel refreshes on a timer, so
    // a session can go away between the right-click and the confirm. The state
    // the user asked for is the state that exists — reporting it as a failure
    // would teach them to distrust a message that means nothing went wrong.
    killSession.mockResolvedValueOnce({ ok: false, code: 'not-found' });
    const wrapper = await open(FOLDER);
    await openStopConfirm(wrapper);
    await wrapper.get('.stop-confirm .btn-danger').trigger('click');
    await flush(wrapper);
    expect(killSession).toHaveBeenCalledTimes(2);
    expect(wrapper.find('.stop-error').exists()).toBe(false);
  });

  it('names the sessions that survived a refused batch, and stops the rest', async () => {
    // A batch that half-worked is the case a single "could not stop" sentence
    // would lie about. Worded as the tab bar words its own refusals — the
    // session in double quotes, the host's sentence carried rather than
    // replaced — and it NAMES what survived rather than counting it: `1 of 2`
    // says how much of the folder is still up, but not which half the user can
    // act on.
    killSession.mockResolvedValueOnce({ ok: false, code: 'kill-failed', error: 'server refused' });
    const wrapper = await open(FOLDER);
    await openStopConfirm(wrapper);
    await wrapper.get('.stop-confirm .btn-danger').trigger('click');
    await flush(wrapper);

    // The refusal does not abort the batch: the second session still dies.
    expect(killSession).toHaveBeenCalledTimes(2);
    const error = wrapper.get('.stop-error').text();
    expect(error).toContain('Could not stop "git-dataqna" in dataqna.');
    expect(error).toContain('server refused');
    // The one that DID die is not in the sentence: a refusal that names every
    // session it was asked about reads as a batch that failed outright.
    expect(error).not.toContain('git-dataqna-2');

    // And it is dismissable, because nothing else clears it: the listing's own
    // error belongs to the poll, which rewrites it every few seconds.
    await wrapper.get('.stop-error button').trigger('click');
    expect(wrapper.find('.stop-error').exists()).toBe(false);
  });

  it('a rejected kill counts as a failed session and the batch continues', async () => {
    // The invoke underneath the store can REJECT (the transport dies mid-kill),
    // which used to escape the loop: the remaining sessions were never
    // attempted and `stopBusy` stayed latched, disabling the Stop action until
    // remount.
    killSession.mockRejectedValueOnce(new Error('channel closed'));
    const wrapper = await open(FOLDER);
    await openStopConfirm(wrapper);
    await wrapper.get('.stop-confirm .btn-danger').trigger('click');
    await flush(wrapper);

    expect(killSession).toHaveBeenCalledTimes(2);
    const error = wrapper.get('.stop-error').text();
    expect(error).toContain('Could not stop "git-dataqna" in dataqna.');
    expect(error).toContain('channel closed');
  });
});

/**
 * The panel keeping up with the host, which is what "I stopped the last session
 * and the row stayed" turned out to be about.
 *
 * The grouping never emits a folder with no sessions in it — sessionGrouping's
 * own tests pin that — so a row that outlives its last session is not a
 * projection bug. It is the session list never being re-read: before this, the
 * only `setInterval` in the renderer was the cosmetic clock behind the relative
 * timestamps, while the old spec argued a dozen
 * decisions against "the refresh timer" that did not exist. A session killed
 * from the phone, from a terminal, or by an agent exiting stayed on screen
 * until the user pressed Refresh.
 */
describe('SessionTree — the panel keeps up with the host', () => {
  // Installed before the mount on purpose: the interval is created in
  // `onMounted`, and one taken out against the real clock cannot be advanced.
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops a folder row once its last session is gone from the host', async () => {
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    expect(dirLabels(wrapper)).toEqual(['dataqna']);

    // The session was stopped — here, from the phone, or from the user's own
    // terminal. The panel is told nothing; it has to notice.
    sessionsList.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(5_000);
    await wrapper.vm.$nextTick();

    expect(dirLabels(wrapper)).toEqual([]);
    expect(wrapper.find('.empty').text()).toContain('no sessions');
  });

  it('keeps the other sessions in a folder when only one of them goes', async () => {
    // The removal must be driven by what the host reports and nothing else. A
    // folder losing one of two sessions keeps its row, with the survivor in it.
    const wrapper = await open([
      session('git-dataqna', `${HOME}/git/dataqna`, 300),
      session('git-dataqna-2', `${HOME}/git/dataqna`, 200),
    ]);
    sessionsList.mockResolvedValue([session('git-dataqna', `${HOME}/git/dataqna`, 300)]);
    await vi.advanceTimersByTimeAsync(5_000);
    await wrapper.vm.$nextTick();

    expect(dirLabels(wrapper)).toEqual(['dataqna']);
  });

  it('keeps the row AND says why when the list cannot be re-read', async () => {
    // The failure mode the user could not interpret. Blanking the tree on one
    // bad round trip would be worse than showing a list a few seconds old, so
    // the row stays — and the message is then the only thing standing between
    // the user and a tree they have no reason to distrust.
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    sessionsList.mockRejectedValue(new Error('ssh channel closed'));
    await vi.advanceTimersByTimeAsync(5_000);
    await wrapper.vm.$nextTick();

    expect(dirLabels(wrapper)).toEqual(['dataqna']);
    expect(wrapper.get('.error').text()).toContain('ssh channel closed');
  });

  it('polls quietly, without spinning the Refresh glyph', async () => {
    // `loading` is not "a request is in flight", it is "the user asked and is
    // waiting". A poll that set it would spin that glyph and grey the button
    // out for a moment every few seconds forever, which reads as a panel
    // permanently working rather than one quietly keeping up.
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    // Left pending, so the assertion lands while the listing is genuinely out.
    sessionsList.mockReturnValue(new Promise<SessionSummary[]>(() => {}));
    await vi.advanceTimersByTimeAsync(5_000);
    await wrapper.vm.$nextTick();

    const refresh = wrapper.get('[title="Refresh"]');
    expect(refresh.attributes('disabled')).toBeUndefined();
    expect(refresh.find('.spin').exists()).toBe(false);
  });

  it('does not stack listings on a host slower than the poll', async () => {
    // Five seconds is shorter than a round trip over a bad link, and without
    // the in-flight guard every tick would put another pair of execs on a
    // connection that is already struggling.
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    const listedOnMount = sessionsList.mock.calls.length;
    sessionsList.mockReturnValue(new Promise<SessionSummary[]>(() => {}));
    await vi.advanceTimersByTimeAsync(30_000);
    await wrapper.vm.$nextTick();
    expect(sessionsList.mock.calls.length).toBe(listedOnMount + 1);
  });

  it('stops asking once main has declared the transport lost', async () => {
    // Each tick against a dead link fails, and the failure is not quiet — it
    // rewrites `sessions.error` with a raw IPC message every five seconds,
    // forever, over the top of the one report the drop already produced. A
    // poll cannot revive a dead transport; only the reconnect can, so a lost
    // link is a skip exactly like a hidden window.
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    const listedOnMount = sessionsList.mock.calls.length;
    useConnectionStore().state = 'lost';
    await vi.advanceTimersByTimeAsync(30_000);
    await wrapper.vm.$nextTick();
    expect(sessionsList.mock.calls.length).toBe(listedOnMount);
    // The stale rows stay: a tree a few seconds old beats a blank panel while
    // the link is being re-dialled.
    expect(dirLabels(wrapper)).toEqual(['dataqna']);
  });

  it('stops polling once the panel goes away', async () => {
    const wrapper = await open([session('git-dataqna', `${HOME}/git/dataqna`)]);
    wrapper.unmount();
    const after = sessionsList.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessionsList.mock.calls.length).toBe(after);
  });
});

/**
 * The root header row's anatomy.
 *
 * > "for git and tmp let's show ~/git ~/tmp (~/ part can be somewhat muted) and
 * > move 10 closer to git"
 *
 * Two presentation changes over values the row already carried, so what is
 * pinned here is that neither invented anything: the header prints the root's
 * own KEY (which `rootTooltip` has always printed) with the shared `~/` in a
 * span of its own, and the count sits beside the label instead of being thrown
 * to the right edge — where the `+` now lives alone.
 */
describe('SessionTree — the root header row', () => {
  /** Each root header, as its full text and its muted prefix (or ''). */
  function headers(wrapper: VueWrapper): { text: string; prefix: string }[] {
    return wrapper.findAll('.folder-header').map((h) => ({
      text: h.get('.folder-label').text(),
      prefix: h.find('.path-prefix').exists() ? h.get('.path-prefix').text() : '',
    }));
  }

  it('names the real directory, with `~/` in its own span so it can recede', async () => {
    const wrapper = await open([
      session('git-a', `${HOME}/git/a`, 100),
      session('tmp-b', `${HOME}/tmp/b`, 200),
    ]);
    expect(headers(wrapper)).toEqual([
      { text: '~/git', prefix: '~/' },
      { text: '~/tmp', prefix: '~/' },
    ]);
  });

  it('gives the `other` bucket no prefix, because it names no directory', async () => {
    // `~/other` would be a folder that exists nowhere. The bucket keeps its
    // word and its toned-down `.bucket` styling.
    const wrapper = await open([session('nowhere', null, 100)]);
    expect(headers(wrapper)).toEqual([{ text: 'other', prefix: '' }]);
    expect(wrapper.get('.folder-label').classes()).toContain('bucket');
  });

  it('renders a registered root outside $HOME verbatim, with nothing muted', async () => {
    // The same promise the `~/` form makes — the header names the real
    // directory — kept for a root whose real directory is not under home.
    const wrapper = await open([session('app', '/srv/apps/x', 100)], ['/srv/apps']);
    expect(headers(wrapper)).toEqual([{ text: '/srv/apps', prefix: '' }]);
  });

  it('keeps the named form for $HOME itself rather than muting it away', async () => {
    // A key of `~` would split into a muted `~` and nothing at all, i.e. a
    // header whose only legible content is the part meant to recede.
    const wrapper = await open([session('home-alexey', HOME, 100)], ['~']);
    expect(headers(wrapper)).toEqual([{ text: '~ (home)', prefix: '' }]);
  });

  it('puts the count beside the label and leaves the right edge to the +', async () => {
    // DOM order is the assertion: label, then count, then the `+`. "Move 10
    // closer to git" is a layout request, and the layout is what carries it.
    const wrapper = await open([
      session('git-a', `${HOME}/git/a`, 100),
      session('git-b', `${HOME}/git/b`, 200),
    ]);
    const header = wrapper.get('.folder-header');
    expect(header.get('.folder-count').text()).toBe('2');
    expect(childClasses(header.element)).toEqual([
      'dot',
      'folder-label',
      'folder-count',
      'icon-btn',
    ]);
    // The `+` is still there and still reachable — it took over the right edge
    // rather than being displaced by the count arriving.
    expect(header.get('.root-add').attributes('title')).toBe('New session in ~/git');
  });

  it('puts a folder row count beside its label too, ahead of the badges', async () => {
    // One convention down the whole panel: a count that hugged its label on the
    // header and floated right on the rows beneath would be two.
    const wrapper = await open([
      { ...session('git-app-a', `${HOME}/git/app`, 100), agentKind: 'claude' as const },
      session('git-app-b', `${HOME}/git/app`, 200),
    ]);
    const row = wrapper.get('.dir-header');
    expect(childClasses(row.element)).toEqual([
      'dot',
      'label',
      'folder-count',
      'agent-badge',
      'row-time',
    ]);
  });

  it('renders the whole label in one span and hands the full name to the tooltip', async () => {
    // The head/tail span pair is gone — a long name
    // now degrades by CSS to one end ellipsis, and the row `title` is where
    // the full name is read. Scoped CSS does not apply under jsdom, so what is
    // pinned here is the DOM contract the stylesheet works on: a single
    // childless span holding the whole label, on a row whose title carries the
    // path that names it.
    const wrapper = await open([
      session('git-course-management-agent', `${HOME}/git/course-management-agent`),
    ]);
    const label = wrapper.get('.dir-header .label');
    expect(label.text()).toBe('course-management-agent');
    expect(label.element.children).toHaveLength(0);
    expect(wrapper.get('.dir-header').attributes('title')).toContain(
      '~/git/course-management-agent',
    );
  });
});

/**
 * Dragging a folder row up and down.
 *
 * > "but I can also pull them up and down to rearraange"
 *
 * The properties worth pinning are the ones a reader cannot check by looking at
 * the handlers: that the arrangement is PERSISTED as a ranking rather than
 * applied to a list in place, that it therefore survives the five-second poll,
 * that a row cannot be dragged out of its root, and that none of this disturbs
 * what the row already did on click and on right-click.
 *
 * jsdom has no drag machinery, so the events are synthesised. `clientY` is the
 * one field that matters: `getBoundingClientRect` is all zeros here, so the
 * midpoint of every row is 0 — `clientY: -1` means "above this row" and
 * `clientY: 0` means "below it", which is exactly the flip the real handler
 * computes against a real box.
 */
describe('SessionTree — dragging a folder row', () => {
  /** Three folders under `git`, created a, b, c — so creation order is a, b, c. */
  const THREE = [
    session('git-a', `${HOME}/git/a`, 100),
    session('git-b', `${HOME}/git/b`, 200),
    session('git-c', `${HOME}/git/c`, 300),
  ];

  /** Drag row [from] onto row [to], landing above it or below it. */
  async function drag(
    wrapper: VueWrapper,
    from: number,
    to: number,
    where: 'above' | 'below' = 'above',
  ): Promise<void> {
    const rows = wrapper.findAll('.dir-header');
    await rows[from]!.trigger('dragstart');
    await rows[to]!.trigger('dragover', { clientY: where === 'above' ? -1 : 0 });
    await rows[to]!.trigger('drop');
    await wrapper.vm.$nextTick();
  }

  /** What was written for this host, as a ranking. */
  function storedOrder(): string[] {
    return useSettingsStore().folderOrderFor('hetzner');
  }

  it('renders creation order until something is dragged', async () => {
    const wrapper = await open(THREE);
    expect(dirLabels(wrapper)).toEqual(['a', 'b', 'c']);
    expect(storedOrder()).toEqual([]);
  });

  it('moves a row to the top and persists the WHOLE panel as a ranking', async () => {
    const wrapper = await open(THREE);
    await drag(wrapper, 2, 0);
    expect(dirLabels(wrapper)).toEqual(['c', 'a', 'b']);
    // The whole list, not a delta: with only the moved row ranked, every other
    // row would be unranked and the one drag would have moved everything.
    expect(storedOrder()).toEqual(['~/git/c', '~/git/a', '~/git/b']);
  });

  it('moves a row down, past the row it was dropped on', async () => {
    const wrapper = await open(THREE);
    await drag(wrapper, 0, 2, 'below');
    expect(dirLabels(wrapper)).toEqual(['b', 'c', 'a']);
  });

  it('SURVIVES THE POLL, because the order is re-applied and not remembered', async () => {
    // The property the whole design turns on. The panel re-reads the host every
    // five seconds; a drag that were applied to a list in place would be undone
    // by the very next tick.
    const wrapper = await open(THREE);
    await drag(wrapper, 2, 0);
    expect(dirLabels(wrapper)).toEqual(['c', 'a', 'b']);

    // A refresh that brings a NEW folder and drops one of the arranged ones.
    sessionsList.mockResolvedValue([
      session('git-a', `${HOME}/git/a`, 100),
      session('git-c', `${HOME}/git/c`, 300),
      session('git-e', `${HOME}/git/e`, 500),
    ]);
    await wrapper.get('[title="Refresh"]').trigger('click');
    await flush(wrapper);
    // `c` keeps the place the user gave it, `a` follows it, and the folder
    // nobody has arranged lands at the bottom — where creation order would
    // have put it anyway.
    expect(dirLabels(wrapper)).toEqual(['c', 'a', 'e']);
  });

  it('REFUSES a drop in another root, and draws nothing while refusing', async () => {
    const wrapper = await open([
      session('git-a', `${HOME}/git/a`, 100),
      session('git-b', `${HOME}/git/b`, 200),
      session('tmp-d', `${HOME}/tmp/d`, 300),
    ]);
    const rows = wrapper.findAll('.dir-header');
    await rows[0]!.trigger('dragstart');
    await rows[2]!.trigger('dragover', { clientY: -1 });
    // No indicator anywhere — a refused drop draws nothing, and that absence
    // IS the refusal. A root is a real directory, so a row that left it would
    // be a claim about where the folder lives.
    expect(wrapper.findAll('.drop-above, .drop-below')).toHaveLength(0);
    await rows[2]!.trigger('drop');
    expect(dirLabels(wrapper)).toEqual(['a', 'b', 'd']);
    expect(storedOrder()).toEqual([]);
  });

  it('draws the landing place on the row it would land above', async () => {
    const wrapper = await open(THREE);
    const rows = wrapper.findAll('.dir-header');
    await rows[2]!.trigger('dragstart');
    await rows[0]!.trigger('dragover', { clientY: -1 });
    expect(wrapper.findAll('.dir-list li')[0]!.classes()).toContain('drop-above');
    // And the row being carried fades in place rather than leaving the flow.
    expect(wrapper.findAll('.dir-header')[2]!.classes()).toContain('dragging');
  });

  it('clears the indicator when a drag is abandoned', async () => {
    const wrapper = await open(THREE);
    const rows = wrapper.findAll('.dir-header');
    await rows[2]!.trigger('dragstart');
    await rows[0]!.trigger('dragover', { clientY: -1 });
    // `dragend` is listened for on the LIST, so a drag released over anything
    // — including nothing at all — still resets the row.
    await wrapper.get('.folder-list').trigger('dragend');
    expect(wrapper.findAll('.drop-above, .drop-below')).toHaveLength(0);
    expect(wrapper.findAll('.dragging')).toHaveLength(0);
  });

  it('writes nothing for a drag that ended where it started', async () => {
    const wrapper = await open(THREE);
    await drag(wrapper, 1, 1, 'above');
    expect(storedOrder()).toEqual([]);
    expect(dirLabels(wrapper)).toEqual(['a', 'b', 'c']);
  });

  it('does NOT open the folder it was dragging', async () => {
    // A row is a `<button>` that navigates. Native DnD suppresses the click
    // that would otherwise follow a drag, and neither the start nor the drop
    // may stand in for one.
    const wrapper = await open(THREE);
    await drag(wrapper, 2, 0);
    expect(wrapper.emitted('select')).toBeUndefined();
    // The click itself still works, unchanged.
    await wrapper.findAll('.dir-header')[0]!.trigger('click');
    expect(wrapper.emitted('select')).toHaveLength(1);
  });

  it('leaves the row right-click menu exactly as it was', async () => {
    const wrapper = await open(THREE);
    await drag(wrapper, 2, 0);
    // The row now at the top is `c`, and its menu is still its own.
    await wrapper.findAll('.dir-header')[0]!.trigger('contextmenu');
    await wrapper.get('.menu-stub .menu-item').trigger('click');
    expect(dialogStartIn(wrapper)).toBe('/home/alexey/git/c');
  });

  it('marks every row draggable, so the affordance is not one row deep', async () => {
    const wrapper = await open(THREE);
    expect(wrapper.findAll('.dir-header').map((r) => r.attributes('draggable'))).toEqual([
      'true',
      'true',
      'true',
    ]);
  });
});
