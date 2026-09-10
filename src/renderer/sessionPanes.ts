/**
 * The folder workspace's mounted-pane records, as pure functions.
 *
 * A pane record used to carry only the bare session name, and the workspace
 * deduped, matched and pruned panes on it. Under aplexer that broke: a tag is
 * unique only within its workspace, so every workspace's default session is
 * called `main`, and navigating from a folder whose `main` had a mounted pane
 * straight into another folder with its own `main` found the leftover record,
 * reused it — and showed the PREVIOUS workspace's session under the new
 * workspace's tab. The new workspace's pane was never mounted at all, and
 * TerminalView, which re-points on a session-key change, never noticed
 * anything: the key had not changed.
 *
 * So the record carries the workspace-qualified identity
 * (`sessionIdentityKey`: `aplexer:<workspace>:<tag>`, bare name for tmux)
 * beside the name, and every match in the workspace reads the identity. A
 * same-named tag in another workspace is a different identity and can never
 * answer for this one; a leftover from the folder just left is a foreign
 * identity, pruned like any other session that is not on the bar.
 *
 * The rules live here rather than in the component for the usual reason this
 * repo separates things: a rule with a unit test beats a rule inside a setup
 * block, and both rules are exactly the shape the tab bar's own MRU and manual
 * order are — lists kept beside a set that changes underneath them, where a
 * stale entry is worse than a missing one.
 */

/** One mounted TerminalView in the folder workspace. */
export interface SessionPaneRecord {
  /** Stable for the pane's life; the v-for key. Never the session name. */
  id: string;
  /** The session name this pane is currently pointed at. A rename rewrites this. */
  session: string;
  /**
   * The workspace-qualified session identity — the join key, the shells-registry
   * key, and the key every pane match reads. Minted from the row at upsert; a
   * rename rewrites it together with {@link session}.
   */
  identity: string;
}

/**
 * Mount a pane for [fresh] unless one is already mounted for its identity.
 *
 * The dedupe is the whole rule: the arrival watcher runs on every selection,
 * and a second mount of the same session would mean two TerminalViews
 * subscribed to one PTY. Identity, not name — the name-only version is what
 * let one workspace's pane answer for another's.
 *
 * Pure: returns the given array untouched when there is nothing to add, so a
 * caller can detect the no-op by reference and skip writing reactive state.
 */
export function upsertPane(
  panes: readonly SessionPaneRecord[],
  fresh: { session: string; identity: string },
  mintId: () => string,
): SessionPaneRecord[] {
  if (panes.some((pane) => pane.identity === fresh.identity)) return panes as SessionPaneRecord[];
  return [...panes, { id: mintId(), session: fresh.session, identity: fresh.identity }];
}

/**
 * Drop every pane whose identity is no longer on the workspace's bar.
 *
 * A pane lives while its session is on the bar, and the bar is the authority
 * on that for the same reason `pruneTabIds` is driven by the tabs rather than
 * by close handlers: a session can leave the bar without anything here closing
 * it — killed on the host, stopped from the phone, or the folder the user just
 * navigated away from, whose panes are not the new folder's however
 * same-named they look. Retiring the record unmounts the TerminalView and
 * closes its SSH shell, which for a dead or left-behind session is the honest
 * teardown — and what stops a re-created same-named session from inheriting a
 * pane still pointed at a dead PTY.
 */
export function prunePanes(
  panes: readonly SessionPaneRecord[],
  liveIdentities: ReadonlySet<string>,
): SessionPaneRecord[] {
  return panes.filter((pane) => liveIdentities.has(pane.identity));
}
