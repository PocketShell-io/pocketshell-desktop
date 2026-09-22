import { defineStore } from 'pinia';
import { ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId } from '@pocketshell/core';
import type { UsageRow } from '../../main/helper/usageParsers';
import { parseProfileRows, type AgentProfile } from '@pocketshell/core';
import { errorMessage } from '../../shared/errors';

/**
 * Agents store: the provider-usage dashboard rows, and nothing else.
 *
 * It used to also hold the CONVERSATION of the selected session — messages,
 * the transcript the messages came from, and a stale-reply guard keyed on the
 * session name. That whole half is gone, with the feature: the user asked for
 * conversations to be dropped completely, so the tab,
 * the transcript resolver, the `agent-log` client and the IPC behind them were
 * removed rather than left as an unused path.
 *
 * `loading` survived that cut and is worth a note, because it is the one thing
 * the removal could have broken silently. It was written ONLY by the
 * conversation loader, but it is READ by the usage refresh button in
 * UsageView.vue and HostWorkspaceView.vue — so deleting the writer would have
 * left a spinner that never spins and a button that is never disabled, with
 * nothing to say why. `loadUsage` owns it now.
 */
export const useAgentsStore = defineStore('agents', () => {
  const usage = ref<UsageRow[]>([]);
  /** True while `loadUsage` is in flight — drives the refresh spinner. */
  const loading = ref(false);
  /**
   * Set when the usage fetch itself failed, distinguishing "this host reports
   * no usage" from "we could not ask" — the same split `profilesError` below
   * exists for, and for the same reason: an empty table is a normal state the
   * panel explains in a line, whereas a failed fetch (no helper on the host, a
   * dropped link) deserves to be said out loud so the user knows the numbers
   * are missing rather than zero. Before this ref existed, `loadUsage` had a
   * try/finally with no catch, so the rejection escaped to whichever button
   * handler called it and the panel silently kept whatever it had.
   */
  const usageError = ref<string | null>(null);

  /**
   * Never rejects. A failure lands in `usageError` and deliberately does NOT
   * blank `usage`: a refresh that fails mid-session leaves the previous rows in
   * place, because a table that is a few minutes old with a reason attached
   * beats an empty one — the same call the sessions store makes for its poll.
   */
  async function loadUsage(connectionId: ConnectionId): Promise<void> {
    loading.value = true;
    usageError.value = null;
    try {
      usage.value = await api.helper.usage(connectionId);
    } catch (e) {
      usageError.value = errorMessage(e) || 'Could not read this host’s provider usage.';
    } finally {
      loading.value = false;
    }
  }

  /**
   * The host's agent profiles, for the launch dialog's profile picker.
   *
   * Profiles are defined ONCE on the host (the helper auto-discovers `~/.claude`,
   * `~/.zlaude`, `~/.codex` and reads an optional `profiles.yaml`), which is why
   * the client fetches them instead of storing them per-host — the same reason
   * the phone's `ProfilesGateway` exists. `agent:profiles` has been wired end to
   * end since 88cc932 fixed the `{"profiles": […]}` envelope, but nothing in the
   * renderer called it until the launch dialog did.
   */
  const profiles = ref<AgentProfile[]>([]);
  /** True while `loadProfiles` is in flight. */
  const profilesLoading = ref(false);
  /**
   * Set when the fetch itself failed, distinguishing "this host has no profiles"
   * from "we could not ask".
   *
   * The phone collapses both to an empty list and shows nothing — a host with no
   * CLI, a failing probe and a host with one profile all look identical there.
   * The desktop keeps them apart because it has the room to: an empty list is a
   * normal state the dialog explains in a line, whereas a failed fetch is worth
   * saying out loud so the user knows the picker is missing options rather than
   * that the host has none. Neither blocks the launch — a profile is optional,
   * and the engine default is exactly what omitting `--profile` selects.
   */
  const profilesError = ref<string | null>(null);
  /**
   * Which connection `profiles` describes, so a stale response from the host we
   * just left cannot overwrite the one we are on (the phone guards the same race
   * with a generation counter plus an `isCurrentHost` check).
   */
  let profilesFor: ConnectionId | null = null;

  async function loadProfiles(connectionId: ConnectionId): Promise<void> {
    profilesLoading.value = true;
    profilesError.value = null;
    profilesFor = connectionId;
    try {
      const rows = await api.agent.profiles(connectionId);
      if (profilesFor !== connectionId) return;
      profiles.value = parseProfileRows(rows);
    } catch (e) {
      if (profilesFor !== connectionId) return;
      profiles.value = [];
      profilesError.value = errorMessage(e) || 'Could not list this host’s agent profiles.';
    } finally {
      if (profilesFor === connectionId) profilesLoading.value = false;
    }
  }

  /**
   * The engines this host's `pocketshell agent` actually lists, or null when
   * we have not been able to ask.
   *
   * Null is the initial value AND the failure value, and that is deliberate:
   * both mean "unknown", and `kindUnavailableReason` in shared/agentLaunch.ts
   * already knows what to do with unknown — offer the engines the pinned 0.4.44
   * helper guarantees, refuse the ones it does not. Distinguishing "never
   * asked" from "asked and failed" would buy a different WORDING at best, and
   * `agentKindsProbing` already covers the only case where the wording matters
   * (the answer is still coming).
   *
   * Not merged into `profiles`: a host can list profiles and lack an engine,
   * or the reverse, and the launch dialog needs both answers separately.
   */
  const agentKinds = ref<readonly string[] | null>(null);
  /** True while `loadAgentKinds` is in flight — lets "no" be said as "not yet". */
  const agentKindsProbing = ref(false);
  /** @see profilesFor — same stale-response guard, same reason. */
  let agentKindsFor: ConnectionId | null = null;

  /**
   * Ask the host which engines it can launch.
   *
   * Re-asked on every open of the launch dialog rather than cached per host,
   * because the helper is installed and upgraded out from under this app: a
   * user who runs `uv tool upgrade pocketshell` in one tab should find Grok
   * offered in the next dialog they open, not after a reconnect. The call is
   * one `--help` exec, which does no work host-side.
   *
   * Never rejects. A failure leaves `agentKinds` null, which the dialog reads
   * as "unknown" and handles by falling back to the pinned baseline — see
   * shared/agentLaunch.ts. Nothing here needs an error string, because the
   * sentence the user sees is composed from the kind they picked, not from the
   * exec's complaint.
   */
  async function loadAgentKinds(connectionId: ConnectionId): Promise<void> {
    agentKindsProbing.value = true;
    agentKindsFor = connectionId;
    try {
      const kinds = await api.agent.kinds(connectionId);
      if (agentKindsFor !== connectionId) return;
      // Anything that is not a list is "unknown", which is what null means
      // here. The main process already answers `string[] | null`, so this is
      // the belt to that braces — but the value crosses an IPC boundary and a
      // shape that slipped through would otherwise become an empty list, i.e.
      // a host that claims it can launch nothing.
      agentKinds.value = Array.isArray(kinds) ? kinds : null;
    } catch {
      if (agentKindsFor !== connectionId) return;
      agentKinds.value = null;
    } finally {
      if (agentKindsFor === connectionId) agentKindsProbing.value = false;
    }
  }

  return {
    usage,
    loading,
    usageError,
    loadUsage,
    profiles,
    profilesLoading,
    profilesError,
    loadProfiles,
    agentKinds,
    agentKindsProbing,
    loadAgentKinds,
  };
});
