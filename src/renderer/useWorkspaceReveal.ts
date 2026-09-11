import { computed, watch, type ComputedRef, type Ref } from 'vue';
import { rootHostPath } from './sessionRoots';
import type { WorkspaceTab } from '../shared/workspaceTabs';
import type { useFilesStore } from './stores/files';
import type { useProjectsStore } from './stores/projects';

export interface WorkspaceRevealDeps {
  files: ReturnType<typeof useFilesStore>;
  projects: ReturnType<typeof useProjectsStore>;
  /** The folder key from the route — `~/git/dtc-website`. */
  folderKey: ComputedRef<string>;
  /** The folder's real path, or null for an untracked session's pseudo-folder. */
  folderPath: ComputedRef<string | null>;
  tabs: ComputedRef<WorkspaceTab[]>;
  getActiveTab: () => WorkspaceTab | null;
  selected: Ref<string | null>;
  persist: () => void;
  /** Open a Files tab seeded at [path], of [kind], and select it. */
  onOpenInNewTab: (path: string, kind: 'dir' | 'file') => void;
  /** Another Files tab over the given seed directory. */
  addFilesTab: (seed?: string | null) => void;
}

/**
 * A path clicked in the terminal, routed to the right Files tab.
 *
 * The files store only PARKS the request (its `reveal` ref); FilesView takes
 * it in its own `onMounted`, after `files.open()` has restored the remembered
 * directory. This composable is the workspace's half of that handshake: it
 * watches the parked request, brings a Files tab forward, and — when the
 * target is OUTSIDE this folder — gives it a tab of its own so the folder's
 * own tab is never re-rooted. Extracted from the folder workspace; the
 * decision records below are the feature.
 */
export function useWorkspaceReveal(deps: WorkspaceRevealDeps): void {
  /**
   * This folder's root as an ABSOLUTE host path, or null when there is not one.
   *
   * `rootHostPath` expands `$HOME`, which is why the reveal comparison may
   * delegate to it rather than re-expanding here: the root is spelled the same
   * everywhere else in the app precisely because that function decides it, and a
   * second expansion written here is how the two spellings drift apart again.
   *
   * Null has two causes and one meaning. The host's `$HOME` may not be resolved
   * yet (`projects.ensureHome` is asked for it on mount but a workspace opened by
   * deep link renders first), and the untracked pseudo-folder has no path at all.
   * Either way: no root, so nothing can be shown to be outside it.
   */
  const rootPath = computed(() =>
    rootHostPath(deps.folderPath.value ?? deps.folderKey.value, deps.projects.home),
  );

  /**
   * A reveal target as an absolute host path, or null when it cannot be made one.
   *
   * What `requestReveal` parks is what SFTP needs — either absolute, or relative
   * to the LOGIN HOME, because an SFTP session's relative root is that home. That
   * is why a `~/…` path printed by an agent opens correctly without anyone
   * expanding `$HOME` (see `resolveRemotePath`/`stripTilde` in remotePaths.ts),
   * and it is why this function exists only for the COMPARISON below: telling
   * inside-the-folder from outside is the one job that does need the home spelled
   * out. When the host has not reported one, there is no comparison to make.
   */
  function absoluteRevealTarget(target: string): string | null {
    if (target.startsWith('/')) return target;
    const home = deps.projects.home;
    if (!home) return null;
    const base = home.replace(/\/+$/, '');
    return target === '.' ? base : `${base}/${target}`;
  }

  /** Is [abs] the directory [root] itself, or something under it? */
  function isUnder(abs: string, root: string): boolean {
    return abs === root || abs.startsWith(`${root}/`);
  }

  /**
   * A path clicked in the terminal brings a Files tab forward.
   *
   * The store only PARKS the request; FilesView takes it in its own onMounted,
   * after `files.open()` has restored the remembered directory. Whichever Files
   * tab is already selected takes it, and when none is, the first one does —
   * revealing into the tab the user last used beats opening a new one for every
   * click.
   */
  watch(
    () => deps.files.reveal,
    (target) => {
      if (target == null) return;
      if (openDedicatedRevealTab(target)) return;
      if (deps.getActiveTab()?.kind === 'files') return;
      const first = deps.tabs.value.find((tab) => tab.kind === 'files');
      if (first) {
        deps.selected.value = first.id;
        deps.persist();
        return;
      }
      // Every Files tab is closable now, so "the first one" can be NONE of
      // them — and the click must still land somewhere. `onOpenInNewTab` is
      // already written to open a tab and hand it the reveal, ordering and
      // all; this branch is why that helper, not `addFilesTab`, is the call.
      deps.onOpenInNewTab(target, 'file');
    },
  );

  /**
   * A path OUTSIDE this folder gets a Files tab of its own. Returns true when it
   * took one.
   *
   * The user's report is the whole specification: "also note that this image is
   * outside of the current repo. I still want to see it. we can open it in a
   * separate new tab."
   *
   * Nothing ever stopped it OPENING. The files store browses by absolute path
   * over SFTP and has no notion of a root — `revealPath` realpaths, stats and
   * `goTo`s anywhere on the host. What it did was open it in the FOLDER's own
   * Files tab, and because every Files tab its own remembered
   * directory, that tab then stayed re-rooted in `~/.codex/generated_images/…`
   * the next time it was opened. Which is the complaint underneath the request.
   *
   * The tab is seeded at the target's PARENT rather than the target, which is
   * `onOpenInNewTab`'s answer to the same question and works for either kind:
   * a parent always lists, and `revealPath` then either opens the file in it or,
   * for a directory, walks the listing on into the directory itself.
   */
  function openDedicatedRevealTab(target: string): boolean {
    const root = rootPath.value;
    const abs = absoluteRevealTarget(target);
    // Not knowing where the root is, or where the target is, is not evidence that
    // they are apart. Falling back leaves the click doing what it did before
    // rather than spraying tabs at a host whose `$HOME` never resolved.
    if (root === null || abs === null) return false;
    if (isUnder(abs, root)) return false;

    const active = deps.getActiveTab();
    // A tab already standing over this directory serves the next click in it too.
    // A folder of generated images gets looked at more than once and "a separate
    // new tab" did not mean one tab per image. It is also what stops the re-park
    // below from re-entering this branch.
    if (active?.kind === 'files' && active.path != null && isUnder(abs, active.path)) return false;

    // The order is `onOpenInNewTab`'s, for its reason: the new tab has to BE the
    // selected one before the request is parked, so that the FilesView which
    // mounts into it is the one that takes it. Re-parking cannot corrupt the
    // path — `resolveRemotePath` is idempotent on its own output, returning an
    // absolute path untouched and leaving a home-relative one alone when there is
    // no base to join it to.
    deps.files.takeReveal();
    deps.addFilesTab(abs.slice(0, abs.lastIndexOf('/')) || '/');
    deps.files.requestReveal(target);
    return true;
  }
}
