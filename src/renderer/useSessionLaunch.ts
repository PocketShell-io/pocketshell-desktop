import { onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue';
import { useRoute } from 'vue-router';
import type { Box } from '../shared/popupPlacement';
import {
  buildLaunchCommand,
  KIND_LABELS,
  launchBlocker,
  type LaunchChoice,
} from '../shared/agentLaunch';
import { errorMessage } from '../shared/errors';
import { sessionIdentityKey } from './sessionIdentity';
import { parkedAgentLaunch, takeAgentLaunch } from './pendingAgentLaunch';
import { api } from './ipc';
import type { WorkspaceTab } from '../shared/workspaceTabs';
import type { useConnectionStore } from './stores/connection';
import type { useProjectsStore } from './stores/projects';
import type { useSessionsStore } from './stores/sessions';
import type { useShellsStore } from './stores/shells';

/** How the pool addresses one of this folder's sessions, by name. */
export interface SessionMetaValue {
  backend: 'tmux' | 'aplexer';
  workspace: string | null;
  aplexerId: string | null;
}

export interface SessionLaunchDeps {
  connection: ReturnType<typeof useConnectionStore>;
  projects: ReturnType<typeof useProjectsStore>;
  sessions: ReturnType<typeof useSessionsStore>;
  shells: ReturnType<typeof useShellsStore>;
  /** The bar, as it stands right now. */
  tabs: ComputedRef<WorkspaceTab[]>;
  /** The resolved active tab — read only inside the query watcher's callback. */
  getActiveTab: () => WorkspaceTab | null;
  sessionMeta: ComputedRef<Map<string, SessionMetaValue>>;
  /** The folder's real path, or null for an untracked session's pseudo-folder. */
  folderPath: ComputedRef<string | null>;
  selected: Ref<string | null>;
  persist: () => void;
  /** The one selection path, so a created tab arrives like a click. */
  goToTab: (id: string) => void;
  focusActiveTab: () => void | Promise<void>;
  /** The `+` menu's anchor, closed by opening the dialog and by a create. */
  addAnchor: Ref<Box | null>;
}

/**
 * Creating a session in this folder, and launching an agent in it once its
 * PTY exists.
 *
 * Three pieces move as one: the `+`-menu create (`createSession`, with every
 * refusal spelled out), the launch pipeline (`pendingLaunch` — the wait for
 * the new session's PTY, the write through the wrapper, and the deadline that
 * turns a silent never into a sentence), and the session panel's parked
 * hand-off. Extracted from the folder workspace; the view keeps the `+`
 * menu's anchor and the error strip the refusals render in.
 */
export function useSessionLaunch(deps: SessionLaunchDeps): {
  launching: Ref<boolean>;
  createError: Ref<string | null>;
  openLaunchDialog: () => void;
  cancelPendingLaunch: () => void;
  createSession: (choice: LaunchChoice | null) => Promise<void>;
} {
  const route = useRoute();

  /**
   * True while the launch dialog is up.
   *
   * The `+` menu used to list the engines itself and start one on a single
   * click. It no longer can: a launch needs a directory, and it may want a
   * profile and a permissions answer, none of which fit in a menu row. So the
   * menu collapsed to "New session…" — the ellipsis is the usual promise that a
   * dialog follows — and "New Files tab", which STAYS a direct action because it
   * creates nothing on the host and has nothing to configure. Putting a free
   * action behind a dialog would make it feel expensive.
   *
   * The menu also used to offer Grok, which at the time could not have worked:
   * 0.4.44's `pocketshell agent` has no `grok` subcommand. That fact still
   * holds, but it is no longer a reason to leave Grok out — the dialog now asks
   * the HOST which subcommands its helper actually has and offers Grok only
   * where the answer says yes, explaining itself where it says no (see
   * `kindUnavailableReason` in shared/agentLaunch.ts). Which is the deeper
   * reason the engines belong behind the dialog rather than in this menu: the
   * answer is per-host and has to be fetched, and a menu row cannot wait for a
   * round trip or carry the sentence that comes back when it is no.
   */
  const launching = ref(false);

  function openLaunchDialog(): void {
    deps.addAnchor.value = null;
    createError.value = null;
    launching.value = true;
  }

  const createError = ref<string | null>(null);

  /**
   * A launch waiting for its session's PTY to exist.
   *
   * The desktop cannot set `@ps_agent_kind` — the helper's `pocketshell agent`
   * wrapper writes it in the process that BECOMES the agent.
   * So choosing an engine means starting a session and then running the wrapper
   * inside it, which cannot happen until the terminal has actually attached. The
   * watch below is that wait; it is one-shot, and a session whose PTY never comes
   * up simply gets a shell, which is what it would have been anyway.
   */
  const pendingLaunch = ref<{
    session: string;
    backend: 'tmux' | 'aplexer';
    workspace: string | null;
    choice: LaunchChoice;
  } | null>(null);
  /** Cleared when the launch lands; fires if it never does. See below. */
  let launchTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * How long to wait for the new session's PTY before giving up on the launch.
   *
   * Generous, because this is a fresh SSH channel plus a login shell plus
   * `tmuxctl` (a Python program — ~250 ms of interpreter startup before it execs
   * `tmux attach`, per the measurements in src/shared/attachCommand.ts), and on a
   * real link the whole sequence has been observed at 1.5-2 s. Twelve seconds is
   * far beyond that, so expiring means something is actually wrong rather than
   * merely slow.
   */
  const LAUNCH_TIMEOUT_MS = 12_000;

  function clearLaunchTimer(): void {
    if (launchTimer !== null) clearTimeout(launchTimer);
    launchTimer = null;
  }

  watch(
    () =>
      pendingLaunch.value
        ? deps.shells.shellIdFor(
            sessionIdentityKey(pendingLaunch.value.session, {
              backend: pendingLaunch.value.backend,
              workspace: pendingLaunch.value.workspace ?? undefined,
            }),
          )
        : null,
    (shellId) => {
      const pending = pendingLaunch.value;
      if (!pending || !shellId) return;
      // The write is answered, never assumed. False means main tracks no live
      // channel for the id the registry answered with — a lookup and a write
      // straddling the shell's death. Consuming the launch here is how the line
      // once vanished into a corpse with no message and no retry: the launch
      // stays armed, the next registration re-points this watcher, and the
      // deadline below stays the backstop for the case where nothing ever does.
      //
      // Through the wrapper, never the bare `claude`/`codex` binary: the wrapper
      // is what records the kind, and a session started around it shows up as
      // `unknown` forever.
      //
      // The line itself is built in shared/agentLaunch.ts against the captured
      // `--help`, never assembled here. It used to be a template string, and it
      // was WRONG — a bare `pocketshell agent claude` with no `--dir`, which the
      // helper rejects with exit 2 and a usage message, so the session came up as
      // a plain shell every single time.
      void api.shell
        .input(shellId, `${buildLaunchCommand(pending.choice)}\r`)
        .then((delivered) => {
          if (!delivered) return;
          pendingLaunch.value = null;
          clearLaunchTimer();
        });
    },
  );

  /**
   * Arm the launch, and arm a deadline with it.
   *
   * The deadline is the whole point of this function existing rather than one
   * assignment. Before it, a launch whose PTY never came up did NOTHING, silently
   * and forever: the session existed, the tab appeared, and the engine the user
   * picked simply never started — with no message, because the only failure path
   * was a watcher that never fired. "I asked for Claude and got a shell" is not a
   * bug anyone can report usefully.
   *
   * The session itself is real either way, which is why this is a message and not
   * a rollback: the user has a working shell in the right folder and can start
   * the agent by hand. Telling them that is the entire remedy.
   */
  function armLaunch(session: string, choice: LaunchChoice): void {
    clearLaunchTimer();
    const meta = deps.sessionMeta.value.get(session);
    pendingLaunch.value = {
      session,
      backend: meta?.backend ?? 'tmux',
      workspace: meta?.workspace ?? null,
      choice,
    };
    launchTimer = setTimeout(() => {
      if (pendingLaunch.value?.session !== session) return;
      pendingLaunch.value = null;
      launchTimer = null;
      // The remedy is the EXACT line we would have typed, so the user can paste
      // it rather than reconstruct which flags their choices implied.
      createError.value =
        `Started "${session}", but its terminal did not come up in time, so ` +
        `${KIND_LABELS[choice.kind]} was not launched. The session is a plain shell - run ` +
        `\`${buildLaunchCommand(choice)}\` in it to start the agent.`;
    }, LAUNCH_TIMEOUT_MS);
  }

  onBeforeUnmount(clearLaunchTimer);

  /**
   * Collect a launch the SESSION PANEL parked, and run it here.
   *
   * The panel can create a session but has no terminal to type into, so
   * NewSessionDialog parks the agent choice and the navigation it was already
   * making delivers it. This is the other end. The
   * launch machinery below is NOT duplicated — the slot hands over a
   * `LaunchChoice` and `armLaunch` does exactly what it does for the `+`.
   *
   * Watching the SLOT rather than hooking a lifecycle, because two arrivals have
   * to be covered and only one of them is a mount: creating a session in the
   * folder that is already open re-uses this component instance and changes only
   * the route query, so neither `onMounted` nor the folder-key watch fires. A
   * reactive slot covers both with one watcher.
   *
   * Watching `tabs` with it is the guard that keeps the launch off the wrong
   * terminal: the session must actually be on this bar before the slot is taken.
   * A workspace the user merely passes through leaves the slot alone —
   * `takeAgentLaunch` only clears on a match — so the launch survives the trip.
   *
   * `immediate` because the panel files the created session as a pending row
   * BEFORE navigating, so the tab is usually already present at mount and
   * `tabs` may never change.
   */
  watch(
    [parkedAgentLaunch, deps.tabs],
    () => {
      const parked = parkedAgentLaunch.value;
      if (!parked) return;
      if (
        !deps.tabs.value.some((tab) => tab.kind === 'session' && tab.session === parked.session)
      ) {
        return;
      }
      // The workspace proves the launch is this folder's: a same-named tag in
      // another folder matches the tab above but must not steal the slot. Read
      // from this folder's own rows; unknown (a row that lost its backend info)
      // matches leniently rather than stranding the launch.
      const workspace = deps.sessionMeta.value.get(parked.session)?.workspace ?? null;
      const choice = takeAgentLaunch(deps.connection.connectionId, parked.session, Date.now(), workspace);
      if (!choice) return;
      // Through the one selection path, so arriving on a launched session leaves
      // the keyboard where a click would have — and the PTY the launch is
      // waiting for is the pane this mounts.
      deps.goToTab(parked.session);
      armLaunch(parked.session, choice);
    },
    { immediate: true },
  );

  /**
   * A create in the folder that is ALREADY open changes only the route query.
   *
   * `onMounted` and the folder-key watch do not fire — the same route-reuse fact
   * the parked-launch watcher above works around — so the panel's hand-off,
   * `?tab=<session>`, selected nothing: the agent case has its own watcher, and
   * this is the plain shell's. HostWorkspaceView's `onSelectFolder` states the
   * intent this completes — a navigation that names a session exists to move to
   * the new tab — and `goToTab` brings the keyboard with the selection, the
   * way a click would. A tab already in front declines (a folder change selected
   * it while loading state, and `loadFolderState` owns that arrival's
   * focus), and a name that is not on the bar yet is ignored rather than raced:
   * the panel refreshes the session list before navigating, so a miss means the
   * session is gone, not slow.
   */
  watch(
    () => route.query['tab'],
    (routed) => {
      if (typeof routed !== 'string' || routed === deps.getActiveTab()?.id) return;
      if (!deps.tabs.value.some((tab) => tab.kind === 'session' && tab.session === routed)) return;
      deps.goToTab(routed);
    },
  );

  /**
   * Create a session here, and launch [choice] in it once its PTY exists.
   *
   * [choice] is null for a plain shell. It arrives already validated — the
   * dialog will not let a broken one be confirmed — but it is re-checked here
   * anyway, because this is the last point at which nothing has been created
   * yet. That ordering is the fix for the old flow's worst property: it created
   * a session and only then found out the command was malformed, so a failed
   * launch still cost the user a stray session and an error to read in a
   * terminal.
   *
   * ## Every exit from here is either a new tab or a sentence
   *
   * There used to be a third kind, and it was the whole of the reported bug. The
   * host can answer a `unique` start with the name of a session this bar is
   * ALREADY showing — see ProjectsService.startSession for the socket-blindness
   * that made it do so — and this function trusted the name it was handed. Both
   * symptoms fell out of that one line:
   *
   *  - a shell create assigned `selected` the tab that was already selected, so
   *    the dialog closed and nothing else visibly happened at all;
   *  - an agent create armed the launch against a session whose PTY was already
   *    up and registered, so the watcher below fired on the spot and typed
   *    `pocketshell agent …` into the terminal the user was working in.
   *
   * The second is the serious one: it is this app writing a command into a live
   * session nobody pointed it at. So the name is checked against the bar BEFORE
   * anything is armed or selected, and the launch is armed LAST — after the
   * refresh, after the tab is known to exist, and with no `await` between the
   * selection and the arming, so no PTY can register in the gap and fire the
   * watcher against a session this function has not vouched for.
   *
   * A refusal is always a sentence in `createError`, which renders directly under
   * the tab strip. "Nothing happened" is not an outcome this function is allowed
   * to have.
   */
  async function createSession(choice: LaunchChoice | null): Promise<void> {
    deps.addAnchor.value = null;
    launching.value = false;
    createError.value = null;
    const connectionId = deps.connection.connectionId;
    const path = deps.folderPath.value;
    if (!connectionId || !path) {
      createError.value =
        'This folder has no known directory on the host, so a session cannot be started in it.';
      return;
    }
    // Fail BEFORE creating anything, never after.
    const blocker = choice ? launchBlocker(choice) : null;
    if (blocker) {
      createError.value = blocker;
      return;
    }
    // `unique` and not `reuse`: the folder's default session already has a tab,
    // so "new session" here can only mean a genuinely new one. The host walks
    // `<base>-2`, `<base>-3`, which is what makes the new tab read `Terminal 2`.
    //
    // Wrapped, even though `projects.start` resolves a result object rather than
    // throwing: the IPC call underneath it CAN reject (a closed window, a
    // serialisation failure), and an unhandled rejection here would leave the
    // user exactly where they started — a menu that closed and nothing else —
    // which is the same "nothing happens" symptom this whole change is fixing.
    //
    // The bar is read BEFORE the await, because `tabs` is derived from the session
    // store and the refresh below moves it. What is wanted is the set of sessions
    // that were already here when the user asked for another one.
    const before = new Set(
      deps.tabs.value.filter((tab) => tab.kind === 'session').map((tab) => tab.session),
    );
    let result;
    try {
      result = await deps.projects.start(connectionId, path, undefined, 'unique');
    } catch (e) {
      createError.value = `Could not start a session here: ${errorMessage(e)}`;
      return;
    }
    if (!result.ok || !result.sessionName) {
      createError.value = result.error ?? 'Could not start a session here.';
      return;
    }
    const created = result.sessionName;
    // The host answered with something that is already on this bar. Main refuses
    // the cases it can see (ProjectsService.startSession), and this is the same
    // refusal made from the only place that knows what is on screen — which is a
    // fact main does not have and cannot be given. Nothing is armed and nothing is
    // re-selected: the user asked for another session and did not get one, and the
    // one thing worse than saying so is typing an agent into the session they were
    // using.
    if (result.reused || before.has(created)) {
      createError.value =
        `The host answered with "${created}", which is already open in this folder, so no ` +
        `new session was started` +
        (choice ? ` and ${KIND_LABELS[choice.kind]} was not launched.` : '.');
      return;
    }
    // The row is filed as a pending session (`sessions.addPending`) rather than
    // confirmed by a listing first: the refresh used to be awaited right here,
    // and it is the slowest call in the app — a full `pocketshell sessions
    // list` under a login shell — sitting between the click and the terminal
    // the launch is waiting for. The result carries the row's backend, workspace
    // and aplexer id, so the tab bar and the join have everything they need
    // without a snapshot; the panel's poll reconciles the optimistic row with
    // the authoritative one a few seconds later.
    const pendingRow = deps.sessions.summaryFromStartResult(result, path);
    if (pendingRow) deps.sessions.addPending(pendingRow);
    if (!deps.tabs.value.some((tab) => tab.kind === 'session' && tab.session === created)) {
      // The session exists on the host — main confirmed the create — but it is not
      // filed under this folder, so there is no tab to select and no pane for a
      // launch to wait on. Grouping is by the directory tmux reports, so the usual
      // cause is a session whose working directory is not the one this workspace
      // is keyed on. Saying which name to look for is the whole remedy.
      createError.value =
        `Started "${created}" on the host, but it did not appear in this folder, so there ` +
        `is no tab for it here` +
        (choice ? ` and ${KIND_LABELS[choice.kind]} was not launched.` : '.');
      return;
    }
    deps.selected.value = created;
    deps.persist();
    // Armed last, and deliberately after the selection rather than before it: the
    // pane this mounts is the PTY the launch waits for, and there is no `await`
    // between the two, so the watcher cannot fire against anything else.
    if (choice) armLaunch(created, choice);
    // The dialog's OverlayPanel hands focus back to the `+` that opened it as it
    // unmounts, so without this the user's first keystrokes go to that button. A
    // create that ends in a new tab ends the way a tab click does: keyboard in
    // the pane. `focusActiveTab` resolves after `nextTick`, so it lands after the
    // panel's restore — the terminal wins the hand-off, not the button.
    void deps.focusActiveTab();
  }

  /**
   * Tear down an armed launch without its sentence — the folder switch uses it:
   * a launch armed for the folder being left must not fire a message into the
   * folder being arrived at.
   */
  function cancelPendingLaunch(): void {
    pendingLaunch.value = null;
    clearLaunchTimer();
  }

  return { launching, createError, openLaunchDialog, cancelPendingLaunch, createSession };
}
