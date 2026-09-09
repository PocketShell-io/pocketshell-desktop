/**
 * The session panel's tree, derived once and read by everything that needs it.
 *
 * `SessionTree.vue` computed this privately, and that was fine while it was the
 * only reader. It is not any more: `Ctrl+↑` / `Ctrl+↓` move to the previous or
 * next FOLDER WORKSPACE, and the chord is owned by `HostWorkspaceView` because
 * that is where the route lives — so two components now need the same list, in
 * the same order, keyed the same way.
 *
 * Deriving it twice would be the exact failure this codebase has already paid
 * for once. `$HOME` decides whether a folder is keyed `~/git/foo` or
 * `/home/me/git/foo`, and two spellings of one key is a panel row that opens a
 * workspace with no tabs in it — the bug `sessionGrouping`'s `rootHostPath`
 * exists to prevent on the other side of the same conversion. A chord that
 * navigated by a key the panel spells differently would put the user in an
 * empty workspace and highlight no row, which reads as the folder having
 * vanished.
 *
 * So the derivation moves HERE, and both call sites read it. Everything in it
 * is the code that used to sit in `SessionTree`, unchanged in behaviour: the
 * store reads are the same, the `$HOME` fallback is the same, and
 * `groupSessionsIntoRoots` is the same pure function it always was.
 *
 * ## The user's manual arrangement is applied HERE, for the same reason
 *
 * A dragged folder row changes the order the panel
 * draws, and `Ctrl+↑`/`Ctrl+↓` must walk the order the panel draws — the chord
 * exists to move between the rows the user can see, and a chord that skipped a
 * row or visited them in a second order would be a different feature wearing
 * the same keys. So the ranking is applied in this file, on top of the
 * projection and below both readers, exactly as `$HOME` is: one derivation, two
 * consumers, no chance of disagreement.
 */
import { computed, type ComputedRef } from 'vue';
import { applyFolderOrder } from './folderOrder';
import { inferHome } from './sessionRoots';
import { groupSessionsIntoRoots, type SessionDirectory, type SessionRootFolder } from './sessionTree';
import { useConnectionStore } from './stores/connection';
import { useProjectsStore } from './stores/projects';
import { useSessionsStore } from './stores/sessions';
import { useSettingsStore } from './stores/settings';

export interface FolderTree {
  /**
   * The host's `$HOME`, resolved or inferred. Null only when it could not be
   * had either way, which is the case the panel's `+` renders disabled for.
   */
  home: ComputedRef<string | null>;
  /**
   * The `~/.ssh/config` alias of the host these folders are on, or `''` when
   * nothing is connected.
   *
   * Published because it is the key the manual arrangement is stored under, and
   * the component that WRITES a drag has to spell that key exactly as the code
   * that reads it does. One definition, handed out, rather than two call sites
   * both reaching into the connection store and one of them eventually reaching
   * for `hostname` or `connectionId` instead.
   */
  host: ComputedRef<string>;
  /** Root sections, in panel order — the host's order with the user's drags applied. */
  roots: ComputedRef<SessionRootFolder[]>;
  /**
   * Every folder row, flattened in the order they are drawn — root by root,
   * folders inside each. This is the list an arrow key walks, and it is
   * flattened rather than nested because a `Ctrl+↓` at the last folder of `git`
   * means the first folder of the next root: the user is stepping down the
   * PANEL, and the root headers they pass are not stops, they are labels.
   */
  folders: ComputedRef<SessionDirectory[]>;
}

export function useFolderTree(): FolderTree {
  const connection = useConnectionStore();
  const projects = useProjectsStore();
  const sessions = useSessionsStore();
  const settings = useSettingsStore();

  /**
   * Read from the projects store, with an inference from the session paths as
   * the fallback so a host whose `$HOME` never resolved still groups instead of
   * dropping every session into `other`. `groupSessionsIntoRoots` infers on its
   * own when handed null, so passing an already-inferred home through it is
   * idempotent — this widens where the answer is visible, it does not change it.
   */
  const home = computed(() => projects.home ?? inferHome(sessions.sessions.map((s) => s.path)));

  /**
   * `HostEntry.name` is the `Host` directive from `~/.ssh/config` — the same
   * string `FolderWorkspaceView` reads off the route as `:name` and keys its
   * tab order on, so the two persisted arrangements agree about what a host is
   * called without either of them knowing about the other.
   */
  const host = computed(() => connection.activeHost?.name ?? '');

  const roots = computed(() =>
    // Derived first, the user's own arrangement on top. The ORDER OF THE TWO
    // STEPS is the resolution of the two halves of one request: the host's
    // order is what a folder row gets until the user moves it, and a manual
    // position wins once there is one. Same shape, same order, as the
    // workspace's tab bar.
    //
    // A pure projection, deliberately: the sessions store refreshes every five
    // seconds and this recomputes each time, so the arrangement has to be
    // re-APPLIED rather than remembered. Nothing here mutates the store, holds
    // a copy of the row list, or reconciles anything — which is what makes a
    // drag survive the poll instead of racing it.
    applyFolderOrder(
      groupSessionsIntoRoots(sessions.sessions, home.value, settings.sessionRootsFor(host.value)),
      settings.folderOrderFor(host.value),
    ),
  );

  const folders = computed(() => roots.value.flatMap((root) => root.directories));

  return { home, host, roots, folders };
}
