import { defineStore } from 'pinia';
import { computed, reactive, toRefs, watch } from 'vue';
import {
  EDITOR_FONT_SIZE_DEFAULT,
  parseFontSize,
  sanitiseFontFamily,
  TERMINAL_FONT_SIZE_DEFAULT,
} from '../fonts';
import { type FolderOrder, normaliseFolderOrder } from '../folderOrder';
import { normaliseRootList, normaliseRootPath, SESSION_ROOTS_MAX } from '../sessionRoots';
import { parseThemeChoice, THEME_CHOICE_DEFAULT } from '../themes';
import { parseZoomPercent, stepZoomPercent, ZOOM_PERCENT_DEFAULT } from '../zoom';
import { isLaunchableKind, type LaunchableKind } from '../../shared/agentLaunch';
import {
  type BindingRefusal,
  type Chord,
  chordToString,
  parseChord,
  resolveBindings,
  shortcutById,
  validateBinding,
} from '../../shared/shortcuts';

/**
 * App-level preferences — the settings screen's model.
 *
 * "App-level" is the whole point of this store existing separately. The
 * composer store already persists preferences, but they are preferences ABOUT
 * THE COMPOSER, written by the composer as a side effect of using it (where
 * the card sits, whether it is open). What lives here is the other kind: things
 * the user goes somewhere to *decide*, which no feature writes on its own, and
 * which a feature elsewhere then obeys. Keeping those in the feature stores is
 * how preferences ended up scattered across `pocketshell.composer.*` and a bare
 * `pocketshell.sessionPanelWidth` key inside a view — three storage schemes for
 * one idea.
 *
 * ---------------------------------------------------------------------------
 * HOW TO ADD A SETTING — three lines, one place each, and nothing else.
 * ---------------------------------------------------------------------------
 *   1. Add the field to {@link AppSettings}. That is the type the whole app
 *      sees; `toRefs` below means the store exposes it automatically, so
 *      `useSettingsStore().myNewKey` starts working with no other change.
 *   2. Add one entry to {@link SETTING_SPECS} — its default and its parser.
 *      The parser is what makes a hand-edited or half-written blob survivable:
 *      a value that fails it falls back to that key's default and the REST OF
 *      THE BLOB IS STILL HONOURED. Never write a parser that trusts the stored
 *      type; it is user-writable JSON on disk, not a value we produced. If the
 *      value is a collection, degrade per ENTRY too — see `asRootMap` — and
 *      note that a reference-typed default is copied on the way out
 *      ({@link applyDefault}) so instances are never shared.
 *   3. Render a control for it in `views/SettingsView.vue`.
 * There is no fourth step: persistence, restore and validation are generic over
 * the specs, so nothing here needs touching per key.
 *
 * ---------------------------------------------------------------------------
 * WHY localStorage AND NOT electron-store
 * ---------------------------------------------------------------------------
 * `electron-store` is already a dependency and is already used in main
 * (src/main/portfwd/PortfwdStore.ts), so it was the obvious candidate. It is
 * the wrong tool here for two reasons:
 *
 *   - It lives in the MAIN process. The renderer is sandboxed
 *     (contextIsolation, no node integration), so reaching it means a new pair
 *     of IPC channels and an inherently ASYNC read. Settings are read during
 *     the first render — `defaultHost` decides whether the host picker even
 *     appears — so an async read means either an await before mount or a frame
 *     of wrong UI. localStorage is synchronous and available at store
 *     construction, which is exactly the shape this data needs.
 *   - The composer store already established the convention for renderer-owned
 *     preferences (a versioned key, a tolerant loader, a silent failure path).
 *     A second mechanism for the same class of data would leave the app with
 *     two answers to "where are preferences?", which is the problem this store
 *     is meant to end.
 *
 * The rule that falls out: preferences the RENDERER owns live here; anything
 * main must read at boot (window bounds, forward rules) stays in electron-store
 * where main can reach it without a renderer being alive.
 */

/**
 * Every renderer-owned preference, in one shape.
 *
 * `typingOpensComposer` and `closeComposerOnSend` are consumed by the prompt
 * composer, which owns its own files; this store only holds the answers. The
 * names are a contract with that code — do not rename them here.
 */
export interface AppSettings {
  /**
   * Typing into the terminal opens the prompt composer and routes the
   * keystrokes into it, instead of sending them to the remote shell.
   */
  typingOpensComposer: boolean;
  /** The composer closes itself after a send, reopening the next time you type. */
  closeComposerOnSend: boolean;
  /**
   * `Host` alias (as it appears in ~/.ssh/config) to connect to on launch, or
   * null to always start on the host picker. A name that no longer resolves to
   * a config host is NOT an error and is NOT rewritten — see
   * `src/renderer/autoConnect.ts`.
   */
  defaultHost: string | null;
  /**
   * One monospace family for every mono surface — terminal, file editor and the
   * app's mono chrome alike — or null for the shipped stack. Stored as a bare
   * family NAME, never a stack: `src/renderer/fonts.ts` appends the fallbacks,
   * which is what stops an uninstalled choice landing on a proportional face.
   */
  monospaceFontFamily: string | null;
  /** Terminal cell size, in px. Changing it re-fits the PTY's rows/columns. */
  terminalFontSize: number;
  /** File-editor text size, in px. Separate from the terminal's — see fonts.ts. */
  editorFontSize: number;
  /**
   * The colour theme: a theme id from `src/renderer/themes.ts`, or `system`
   * to follow the OS between the designated light and dark themes. Stored as
   * a plain string rather than a union so a build that gains or loses a theme
   * does not change this type; `parseThemeChoice` is what keeps stored ids
   * honest, and an id this build does not know falls back to the default.
   */
  theme: string;
  /**
   * Whole-window zoom, as a percentage; 100 is unzoomed.
   *
   * THE SINGLE SOURCE OF TRUTH FOR ZOOM. The Ctrl+= / Ctrl+- / Ctrl+0 chords
   * do not touch Chromium's zoom themselves — main forwards the intent here,
   * this store steps the number, and exactly one watcher (App.vue) turns it
   * into a `setZoom` call. That is what stops the Settings percentage and the
   * keyboard drifting apart, which they would the instant either one was
   * allowed its own copy of the value. See src/renderer/zoom.ts.
   */
  zoomPercent: number;
  /**
   * The top level of the session panel's tree, keyed by the SSH config host
   * alias. Each host owns the project roots the user registered there, in the
   * order they registered them (`~/git`, `~/tmp`, …). Sessions under none of
   * that host's roots collect in the panel's `other` bucket.
   *
   * **An empty map or an empty host entry is meaningful.** With no roots
   * registered for the active host, the panel derives roots from that host's
   * `$HOME` children exactly as it always has, so an existing install sees no
   * change until somebody configures something — see
   * `sessionGrouping.groupSessionsIntoRoots`.
   *
   * The host alias is the stable instance identity here. A connection id is a
   * transient handle minted on every dial, while the alias survives restarts
   * and is also the key used by `folderOrder`. A home-relative path is not
   * enough to identify a root: `~/git` can exist on one instance and not on
   * another, which is why the old app-wide list leaked roots between hosts.
   */
  sessionRoots: Record<string, string[]>;
  /**
   * The session panel's HAND-ARRANGED folder order, per host alias.
   *
   * > "but I can also pull them up and down to rearraange"
   *
   * A RANKING of `SessionDirectory` keys, best first — not a list of the rows
   * that exist. The whole argument is in `renderer/folderOrder.ts`,
   * which the panel is reusing: the folder set changes
   * under a five-second poll, so a stored list would need reconciling on every
   * tick and every reconciliation is a chance to invent a row or lose one.
   *
   * **Empty is meaningful and is the default**, the same way `sessionRoots`'
   * empty is: nothing arranged means the panel renders the host's order, which
   * is what it does for a user who never drags anything.
   *
   * PER HOST, keyed on the `~/.ssh/config` alias. The alias rather than the
   * connection id for the reason the tab order gives (§15.3): a connection id
   * is an opaque handle minted per connect, so an order keyed on it would be a
   * fresh key every launch and would never survive a restart.
   *
   * It lives in this store rather than in `localStorage`, which is where the
   * tab order went. §15.3's rule — "the settings store is for preferences a
   * user sets BY NAME in the Settings overlay" — points the other way, and it
   * is overruled here because the two cases differ in scope: a tab order
   * belongs to ONE folder of ONE host and is written by the workspace that owns
   * it, whereas this is a per-host map the panel has to read before any
   * workspace is mounted, and this store is already the thing that loads a
   * validated per-user blob synchronously at construction. Splitting it across
   * N `localStorage` keys would mean the panel enumerating storage to find
   * them.
   */
  folderOrder: FolderOrder;
  /**
   * What the agent-launch dialog pre-selects, carried over from last time.
   *
   * The phone deliberately does NOT persist these — its picker is plain
   * `remember { mutableStateOf(…) }`, so every open resets to
   * claude / skip-permissions ON / no profile. On a desktop that is the wrong
   * call: the dialog is opened from a `+` menu many times a session, and a
   * user who always wants the same engine and the same profile should not
   * re-answer three questions each time. So this is a deliberate divergence,
   * not a port.
   *
   * `profiles` is keyed by ENGINE rather than being a single name because a
   * profile only means anything within its engine — the host's `Claude (Z.AI)`
   * is not a codex profile, and remembering one flat name would offer it to
   * codex and get `unknown codex profile` back. A remembered name that the
   * host no longer lists is dropped at render time rather than rewritten here:
   * profiles live on the host and can come and go per host, and a stale entry
   * costs nothing until that host lists it again.
   *
   * The defaults match the helper's own (`skipPermissions: true` is
   * `[default: skip-permissions]`) and the phone's first segment (claude), so
   * a fresh install behaves exactly like the phone's picker does.
   */
  agentLaunchDefaults: AgentLaunchDefaults;
  /**
   * Keyboard chords the user has MOVED, keyed by the registry's shortcut id.
   *
   * Only the differences are stored, never the whole table. That is the same
   * choice `sessionRoots` makes and it matters more here: the defaults are the
   * thing most likely to change between builds — a chord gets a better key, a
   * command is renamed, a binding is retired — and a stored full table would
   * freeze whatever shipped on the day the user first opened this screen. An
   * override map means a user who never touched a shortcut always gets the
   * current defaults, and a user who moved one keeps exactly the one decision
   * they made.
   *
   * The value is a chord in `src/shared/shortcuts.ts`'s stored spelling
   * (`Ctrl+Shift+V`). It is deliberately NOT the platform's spelling: `Ctrl`
   * means Ctrl-or-Command everywhere, so a settings file carried between a Mac
   * and a Windows box keeps working.
   */
  shortcutOverrides: Record<string, string>;
}

/** @see AppSettings.agentLaunchDefaults */
export interface AgentLaunchDefaults {
  kind: LaunchableKind;
  skipPermissions: boolean;
  /** Last profile NAME chosen per engine (`claude` / `codex`). */
  profiles: Record<string, string>;
}

/**
 * One setting's default and its parser. `parse` returns `undefined` for a value
 * that cannot be trusted, which the loader reads as "use the default".
 */
interface SettingSpec<K extends keyof AppSettings> {
  default: AppSettings[K];
  parse: (raw: unknown) => AppSettings[K] | undefined;
}

type SettingSpecs = { [K in keyof AppSettings]: SettingSpec<K> };

function asBoolean(raw: unknown): boolean | undefined {
  return typeof raw === 'boolean' ? raw : undefined;
}

/**
 * A host alias, or null. An empty/whitespace string is normalised to null
 * rather than rejected: "" is what a `<select>` bound to a nullable value can
 * emit, and it means the same thing the user meant — no default host.
 */
function asHostAlias(raw: unknown): string | null | undefined {
  if (raw === null) return null;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/** Maximum number of SSH config aliases retained in the root map. */
export const SESSION_ROOT_HOSTS_MAX = 64;

/**
 * The registered session roots, keyed by SSH config alias, or `undefined` for
 * a value whose outer shape this build cannot trust.
 *
 * Only a non-object (or an array) is rejected outright, because that is the
 * one shape with no salvageable meaning. Inside the map, damage is per HOST:
 * a host whose value is not an array loses its roots without costing any other
 * host, and invalid entries inside a valid array are dropped by
 * `normaliseRootList`. The path rules themselves live in
 * `sessionGrouping.ts` — the module that already owns what a path means —
 * rather than being restated here where they could drift.
 */
function asRootMap(raw: unknown): Record<string, string[]> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [host, value] of Object.entries(raw as Record<string, unknown>)) {
    if (Object.keys(out).length >= SESSION_ROOT_HOSTS_MAX) break;
    if (host.trim() === '' || !Array.isArray(value)) continue;
    const roots = normaliseRootList(value);
    if (roots.length > 0) {
      // `__proto__` is a legal JSON object key even though it is not a useful
      // SSH alias. Define it as data rather than assigning through Object's
      // legacy setter, so a hand-edited blob cannot change the map's prototype.
      Object.defineProperty(out, host, {
        configurable: true,
        enumerable: true,
        value: roots,
        writable: true,
      });
    }
  }
  return out;
}

/** The launch dialog's remembered answers. @see AppSettings.agentLaunchDefaults */
const AGENT_LAUNCH_DEFAULTS: AgentLaunchDefaults = {
  kind: 'claude',
  skipPermissions: true,
  profiles: {},
};

/**
 * Degrade the launch defaults per FIELD, the way `asRootMap` degrades per
 * entry. A blob whose `kind` is a stale engine the helper dropped must not
 * cost the user their skip-permissions answer too, and it especially must not
 * survive into {@link buildLaunchCommand} — `isLaunchableKind` is the same
 * guard the dialog uses, so a value that gets past here is one the helper can
 * actually launch.
 */
function asAgentLaunchDefaults(raw: unknown): AgentLaunchDefaults | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const profiles: Record<string, string> = {};
  if (typeof r['profiles'] === 'object' && r['profiles'] !== null) {
    for (const [engine, name] of Object.entries(r['profiles'] as Record<string, unknown>)) {
      if (typeof name === 'string' && name.trim() !== '') profiles[engine] = name.trim();
    }
  }
  return {
    kind: isLaunchableKind(r['kind'] as never) ? (r['kind'] as LaunchableKind) : AGENT_LAUNCH_DEFAULTS.kind,
    skipPermissions:
      typeof r['skipPermissions'] === 'boolean'
        ? r['skipPermissions']
        : AGENT_LAUNCH_DEFAULTS.skipPermissions,
    profiles,
  };
}

/**
 * The keyboard overrides, degraded per ENTRY like `asRootMap` and
 * `asAgentLaunchDefaults` before it.
 *
 * Three ways one entry can be untrustworthy, and each costs only that entry:
 *
 *   - the id names a shortcut this build does not have (a rename, a retired
 *     command, a downgrade);
 *   - the value is not a chord this app's own spelling can express;
 *   - the shortcut is one this build made NON-rebindable since the override was
 *     written. That last one is the reason this check is here and not only in
 *     the UI: locking a chord is how the app protects a key that turned out to
 *     be load-bearing, and a stored override must not be able to reach around
 *     the decision.
 *
 * A full validation — reserved chords, menu accelerators, conflicts — is NOT
 * done here, and that is deliberate. It needs the resolved map of every other
 * binding, which does not exist yet at parse time; `resolveBindings` runs it
 * while building that map, and drops what it must. Doing it twice would mean
 * two answers to the same question.
 */
function asShortcutOverrides(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const spec = shortcutById(id);
    if (!spec || !spec.rebindable) continue;
    const chord = parseChord(value);
    if (!chord) continue;
    // Re-spelled rather than stored verbatim, so a hand-written `shift+ctrl+v`
    // becomes the one canonical `Ctrl+Shift+V` on the next write and the map
    // cannot hold two spellings of one chord.
    out[id] = chordToString(chord);
  }
  return out;
}

/** The registry the loader, the defaults and the validator are all generic over. */
const SETTING_SPECS: SettingSpecs = {
  // Both composer defaults are TRUE: typing into a terminal that fronts an
  // agent is far more often the start of a prompt than a shell command, and a
  // composer that clears itself out of the way after sending is what makes the
  // terminal readable while the agent answers.
  typingOpensComposer: { default: true, parse: asBoolean },
  closeComposerOnSend: { default: true, parse: asBoolean },
  defaultHost: { default: null, parse: asHostAlias },
  // Typography. Every default here is EXACTLY what shipped before the setting
  // existed — the shipped stack, TERMINAL_OPTIONS.fontSize, and the `--fs-300`
  // the editor theme has always used — so upgrading changes nothing on screen
  // until the user asks for a change.
  monospaceFontFamily: { default: null, parse: sanitiseFontFamily },
  terminalFontSize: { default: TERMINAL_FONT_SIZE_DEFAULT, parse: parseFontSize },
  editorFontSize: { default: EDITOR_FONT_SIZE_DEFAULT, parse: parseFontSize },
  // `dark`, NOT `system`, for the same reason every default here is what it
  // is: dark is what shipped, and an upgrade must not repaint the app of a
  // user whose OS happens to be in light mode until they ask for it.
  theme: { default: THEME_CHOICE_DEFAULT, parse: parseThemeChoice },
  // 100 for the same reason every typography default is what it is: an
  // upgrade must change nothing on screen until the user asks it to.
  zoomPercent: { default: ZOOM_PERCENT_DEFAULT, parse: parseZoomPercent },
  // Empty means "derive roots from $HOME", which is what shipped before this
  // setting existed — the same rule the typography defaults follow. The map
  // is keyed by SSH config alias so one host's layout cannot leak into another.
  sessionRoots: { default: {}, parse: asRootMap },
  // Empty means "the host's order, as the listing reported it", which is what
  // the panel does for a user who has never dragged a row — the same rule
  // every other default here follows.
  folderOrder: { default: {}, parse: normaliseFolderOrder },
  // Matches the helper's own `[default: skip-permissions]` and the phone's
  // first segment, so a fresh install opens the dialog on claude / skip ON.
  agentLaunchDefaults: { default: AGENT_LAUNCH_DEFAULTS, parse: asAgentLaunchDefaults },
  // Empty means "every chord is where the registry put it", which is what
  // shipped before this setting existed — the same rule every other default
  // here follows.
  shortcutOverrides: { default: {}, parse: asShortcutOverrides },
};

const STORAGE_KEY = 'pocketshell.settings.v1';

/**
 * The setting names, typed. `Object.keys` widens to `string[]`, and this is the
 * one place that narrowing is asserted rather than proved — everything
 * downstream stays generic in a single key and is checked normally.
 */
function settingKeys(): (keyof AppSettings)[] {
  return Object.keys(SETTING_SPECS) as (keyof AppSettings)[];
}

/**
 * Per-key writes live in these two helpers, each generic in ONE key `K`. That
 * is what keeps the loops below type-safe without a cast per assignment:
 * `SETTING_SPECS[key]` is `SettingSpec<K>`, so its `default` and its `parse`
 * result are exactly `AppSettings[K]` and the target slot accepts them.
 */
function applyDefault<K extends keyof AppSettings>(out: Partial<AppSettings>, key: K): void {
  const value = SETTING_SPECS[key].default;
  // `sessionRoots` was the first default that is a REFERENCE rather than a
  // primitive. Handing out the spec's own map would mean every defaulted
  // settings object shares one instance, so a mutation anywhere rewrites the
  // default itself — a bug that would only surface on the second load. Copy on
  // the way out.
  //
  // The copy is DEEP, and was not always: it began as `[...value]`, which was
  // right for a flat array and silently wrong for the first nested default
  // (`agentLaunchDefaults`, whose `profiles` map survived a spread by
  // reference — so remembering a profile once rewrote the shipped default for
  // every later load). A JSON round-trip rather than a hand-written walk
  // because this object is JSON BY CONSTRUCTION: it is the same value that
  // goes through `JSON.stringify` into localStorage a few lines below, so
  // anything the round-trip could not carry could not have been a setting.
  //
  // The cast is the same narrowing the loops below need: the compiler cannot
  // see that a copy of `AppSettings[K]` is an `AppSettings[K]`.
  const copied: unknown =
    value !== null && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
  out[key] = copied as AppSettings[K];
}

function applyParsed<K extends keyof AppSettings>(
  out: Partial<AppSettings>,
  key: K,
  raw: unknown,
): void {
  const parsed = SETTING_SPECS[key].parse(raw);
  // `undefined` is the spec's "do not trust this"; every other value —
  // `false`, `null`, `''` — is a legitimate stored setting, so the check is
  // against undefined specifically and never a truthiness test.
  if (parsed === undefined) return;
  out[key] = parsed;
}

/** A fresh, fully-defaulted settings object. */
export function settingsDefaults(): AppSettings {
  const out: Partial<AppSettings> = {};
  for (const key of settingKeys()) applyDefault(out, key);
  // Every key of AppSettings was just written, which the loop cannot prove to
  // the compiler; this is the assertion of that fact and the only one here.
  return out as AppSettings;
}

/**
 * Turn whatever was on disk into a complete {@link AppSettings}.
 *
 * Degradation is per key, not per blob. A single bad value — a hand edit, a
 * field whose type changed across versions, a truncated write — must not cost
 * the user every other preference they set, so each key is parsed on its own
 * and only the failures fall back. Unknown keys are dropped: they are either
 * from a newer build or from a rename, and neither is something this build can
 * act on.
 */
export function coerceSettings(raw: unknown): AppSettings {
  const out = settingsDefaults();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out;
  const source = raw as Record<string, unknown>;
  for (const key of settingKeys()) {
    if (!(key in source)) continue;
    applyParsed(out, key, source[key]);
  }
  // Before roots were scoped, this key held one array shared by every host.
  // There is no reliable host identity in that old value, so only migrate it
  // when the saved default host gives us an explicit owner. Dropping it when
  // there is no owner is intentional: replaying it for every host would keep
  // the cross-instance leak this migration is meant to remove.
  if (Array.isArray(source['sessionRoots']) && out.defaultHost) {
    const legacyRoots = normaliseRootList(source['sessionRoots']);
    if (legacyRoots.length > 0) out.sessionRoots = { [out.defaultHost]: legacyRoots };
  }
  return out;
}

function load(): AppSettings {
  if (typeof localStorage === 'undefined') return settingsDefaults();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return settingsDefaults();
    return coerceSettings(JSON.parse(raw));
  } catch {
    // Corrupt JSON, or a profile we cannot read. Booting with defaults beats
    // not booting: this store is constructed before the first render.
    return settingsDefaults();
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const values = reactive<AppSettings>(load());

  /**
   * Written on EVERY mutation, synchronously (`flush: 'sync'`).
   *
   * The composer debounces its writes because it persists on every keystroke.
   * Settings change when a human clicks a switch — a handful of times a
   * session — so there is nothing to coalesce, and a synchronous write means
   * the value is durable the moment the user sees the control move. It also
   * means no persistence is lost if the window is closed in the same tick.
   */
  watch(
    values,
    () => {
      if (typeof localStorage === 'undefined') return;
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(values));
      } catch {
        // Quota, or a locked profile. Losing a preference on restart is not
        // worth throwing out of a click handler.
      }
    },
    { deep: true, flush: 'sync' },
  );

  /**
   * Type-safe generic write, for call sites that are themselves generic (a
   * settings row rendered from a list, a future import/restore). Direct
   * assignment — `settings.defaultHost = 'hetzner'` — is equally valid and is
   * what the hand-written controls use.
   */
  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void {
    values[key] = value;
  }

  /**
   * The three zoom moves, as ACTIONS rather than as arithmetic at the call
   * sites.
   *
   * This is the mechanism behind "one source of truth", not a convenience. The
   * keyboard path (main -> App.vue) and the Settings buttons both call these,
   * so there is exactly one place that knows what a step is and exactly one
   * value being stepped. Had the shortcuts been allowed to call Chromium
   * directly — which is what Electron's default menu was doing, and the reason
   * this work exists — the number in Settings would have gone stale on the
   * first Ctrl+- and stayed stale, with no way to notice from either side.
   *
   * `resetZoom` deliberately assigns the constant rather than stepping toward
   * it: Ctrl+0 must return to 100% from anywhere, including from a value that
   * is not on the ladder at all.
   */
  function zoomIn(): void {
    values.zoomPercent = stepZoomPercent(values.zoomPercent, 1);
  }

  function zoomOut(): void {
    values.zoomPercent = stepZoomPercent(values.zoomPercent, -1);
  }

  function resetZoom(): void {
    values.zoomPercent = ZOOM_PERCENT_DEFAULT;
  }

  /**
   * The roots registered for [host], or `[]` when that host has no entry.
   *
   * A read helper rather than a bare map lookup keeps every consumer on the
   * same blank-host behaviour. In particular, a host that has never been
   * configured must use the session panel's derived-root fallback rather than
   * accidentally reading another alias' list.
   */
  function sessionRootsFor(host: string): string[] {
    if (host.trim() === '') return [];
    return Object.prototype.hasOwnProperty.call(values.sessionRoots, host)
      ? values.sessionRoots[host]!
      : [];
  }

  /**
   * Register a session root for [host], returning whether the list changed.
   *
   * The rules live here rather than in the settings screen so that every route
   * into the list — the Add field, a suggestion chip, a future import —
   * normalises and dedupes identically. A rejected value is not an error worth
   * throwing: the caller shows the field's own validation, and `false` is the
   * whole report it needs.
   *
   * The host's list and the outer map are REPLACED rather than mutated. That
   * keeps persistence synchronous and makes it impossible for a caller to
   * mutate the default map through a shared reference.
   */
  function addSessionRoot(host: string, path: string): boolean {
    if (host.trim() === '') return false;
    const root = normaliseRootPath(path);
    if (root === null) return false;
    const roots = sessionRootsFor(host);
    if (roots.includes(root)) return false;
    if (roots.length >= SESSION_ROOTS_MAX) return false;
    values.sessionRoots = { ...values.sessionRoots, [host]: [...roots, root] };
    return true;
  }

  /**
   * Unregister a root for [host]. Matches on the STORED spelling, which is
   * what the settings list renders — removing `~/git` does not remove a
   * separately registered `/home/alexey/git`, because those are two entries
   * the user made two decisions about, even though one host folds them onto
   * one branch.
   */
  function removeSessionRoot(host: string, path: string): void {
    if (host.trim() === '') return;
    const roots = sessionRootsFor(host);
    const nextRoots = roots.filter((root) => root !== path);
    if (nextRoots.length === roots.length) return;
    const next = { ...values.sessionRoots };
    if (nextRoots.length === 0) delete next[host];
    else next[host] = nextRoots;
    values.sessionRoots = next;
  }

  /**
   * The folder rows [host] has been arranged into, or `[]` when it has none.
   *
   * A read helper rather than a bare index, so every caller gets the same
   * answer for an alias that has never been arranged — an empty array, which is
   * what `applyFolderOrder` reads as "use the host's order" — instead of one
   * caller having to remember the `?? []` and another forgetting it. A blank
   * alias (no host connected yet) is answered the same way, because there is no
   * arrangement to have.
   */
  function folderOrderFor(host: string): string[] {
    return values.folderOrder[host] ?? [];
  }

  /**
   * Record a drag: [order] becomes [host]'s arrangement.
   *
   * REPLACED rather than merged, because `reorderFolders` already returns the
   * whole panel's keys in draw order — merging here would be a second opinion
   * about an answer that module has already given, and the two would drift.
   *
   * An EMPTY order removes the host's entry rather than storing `[]`. "This
   * host is not arranged" and "there is no entry for this host" are one state,
   * and keeping one spelling of it means a host whose sessions all went away
   * does not leave a key behind forever. Same rule the tab order follows on the
   * way out and the same one `normaliseFolderOrder`
   * applies on the way in, so a blob written by this app is already in the form
   * the parser would have produced.
   *
   * The map is rebuilt rather than mutated in place, for the reason
   * `sessionRoots` and `shortcutOverrides` are: the spec's default `{}` is a
   * shared object until `applyDefault` copies it, and an in-place write is one
   * way to reach a copy that was never made.
   */
  function setFolderOrder(host: string, order: readonly string[]): void {
    if (host === '') return;
    const next = { ...values.folderOrder };
    if (order.length === 0) delete next[host];
    else next[host] = [...order];
    values.folderOrder = next;
  }

  /* --- Keyboard ----------------------------------------------------------
   * The bindings IN FORCE, and the three moves that change them.
   *
   * The rules all live in `src/shared/shortcuts.ts` and none of them live here:
   * this store owns the persisted overrides and nothing else. That split is
   * what lets the registry be the single source of truth the whole feature was
   * asked for — a call site asking "is this Ctrl+Shift+V?" and the Settings
   * screen asking "may I put Ctrl+Shift+V here?" go through the same module and
   * cannot disagree.
   * -------------------------------------------------------------------- */

  /**
   * Every binding's chords, defaults with the user's overrides applied.
   *
   * A computed, so a call site can hold it and re-read it: rebinding a chord
   * while a terminal is open must take effect on the NEXT keystroke, not on the
   * next mount. That is the whole reason handlers are told to consult this
   * rather than to capture a chord at setup time.
   */
  const shortcutBindings = computed(() => resolveBindings(values.shortcutOverrides));

  /**
   * Move a shortcut to [chord], or report why not.
   *
   * Returns the refusal rather than throwing, and returns `null` for success,
   * because every caller is a click handler that wants to render the reason
   * next to the control. The validation is the registry's, run against the
   * bindings currently IN FORCE — so a chord freed by an earlier rebinding is
   * genuinely free, and a conflict names the command that holds it.
   */
  function rebindShortcut(id: string, chord: Chord): BindingRefusal | null {
    const refusal = validateBinding(id, chord, shortcutBindings.value);
    if (refusal) return refusal;
    // Replaced rather than mutated, for the same reason `sessionRoots` is: the
    // spec's default `{}` is a shared object until `applyDefault` copies it,
    // and an in-place write is one way to reach a copy that was never made.
    values.shortcutOverrides = { ...values.shortcutOverrides, [id]: chordToString(chord) };
    return null;
  }

  /**
   * Put one shortcut back to its shipped chord.
   *
   * Deleting the override rather than writing the default INTO it: an override
   * that happens to equal today's default would silently pin the old chord if a
   * later build moved it. Absence is the only spelling of "whatever the app
   * currently thinks is right".
   */
  function resetShortcut(id: string): void {
    if (!(id in values.shortcutOverrides)) return;
    const next = { ...values.shortcutOverrides };
    delete next[id];
    values.shortcutOverrides = next;
  }

  /** Put every shortcut back. One assignment, so one persist and one repaint. */
  function resetAllShortcuts(): void {
    values.shortcutOverrides = {};
  }

  /** Whether the user has moved anything at all — the "Reset all" button's state. */
  const hasShortcutOverrides = computed(
    () => Object.keys(values.shortcutOverrides).length > 0,
  );

  /** Whether THIS binding has been moved, for its own reset control. */
  function isShortcutOverridden(id: string): boolean {
    return id in values.shortcutOverrides;
  }

  // `toRefs` is what makes step 1 of "how to add a setting" sufficient: every
  // key of AppSettings becomes a writable ref on the store automatically, so
  // consumers write `useSettingsStore().typingOpensComposer` and nothing in
  // this file enumerates the keys by hand.
  return {
    ...toRefs(values),
    set,
    zoomIn,
    zoomOut,
    resetZoom,
    sessionRootsFor,
    addSessionRoot,
    removeSessionRoot,
    folderOrderFor,
    setFolderOrder,
    shortcutBindings,
    hasShortcutOverrides,
    rebindShortcut,
    resetShortcut,
    resetAllShortcuts,
    isShortcutOverridden,
  };
});
