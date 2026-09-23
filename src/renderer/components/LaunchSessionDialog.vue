<script setup lang="ts">
// LaunchSessionDialog: the folder workspace's `+` -> "New session…".
//
// ## Why this is not NewSessionDialog, and why it does not drift from it
//
// NewSessionDialog answers ONE question — *which folder* — by browsing,
// creating or cloning one. Inside a folder workspace that question is already
// answered, and the question left is
// *which agent*. Merging the two would mean the `+` flow re-asks a question it
// already knows the answer to, which is exactly the friction the `+` menu
// existed to avoid.
//
// The drift the merge would have prevented is prevented a different way: both
// dialogs end at the SAME command builder, `src/shared/agentLaunch.ts`, which
// is the only place that knows how to spell a flag, and which is pinned
// against the captured `--help` output. A second dialog cannot invent a
// second command.
//
// ## Why it emits a choice instead of creating the session
//
// The old `+` menu created a session and only THEN discovered the command it
// meant to type was malformed (`pocketshell agent claude` with no `--dir`,
// exit 2), leaving the user with a plain shell and a usage message to read.
// So this dialog owns validation and owns nothing else: `launchBlocker` runs
// on every keystroke, the confirm button is dead while it returns a reason,
// and the parent only starts creating once a launch is known to be
// well-formed. Cancel costs nothing because nothing was created.
//
// ## Shape, versus the phone's `SessionTypePickerSheet`
//
// Ported: the Shell|Agent segmented control, the agent segmented control, the
// skip-permissions row (default ON, hidden for opencode), and the profile
// picker (shown only when the host lists a real choice). Diverged:
//   - no name / start-folder fields — the workspace already fixes both, and
//     the name is derived host-side;
//   - Grok is offered, but PER HOST. The phone lists it unconditionally; the
//     pinned 0.4.44 helper has no `grok` subcommand at all, and typing one at
//     a host that lacks it exits 2 and leaves a plain shell behind. So this
//     dialog asks the host what it can launch (`agents.loadAgentKinds`) and
//     turns a "no" into a sentence rather than into a missing button — see
//     `hostSupport` below and the header of shared/agentLaunch.ts;
//   - the answers PERSIST (the phone resets every open) — see
//     `AppSettings.agentLaunchDefaults`;
//   - an empty or failed profile fetch says so in a line, where the phone
//     shows nothing at all.
import { computed, onMounted, ref, watch } from 'vue';
import AppIcon from '@ui/components/AppIcon.vue';
import OverlayPanel from './OverlayPanel.vue';
import { useAgentsStore } from '../stores/agents';
import { useConnectionStore } from '../stores/connection';
import { useSettingsStore } from '../stores/settings';
import { displayPath, useProjectsStore } from '../stores/projects';
import {
  KIND_LABELS,
  LAUNCHABLE_KINDS,
  buildLaunchCommand,
  kindUnavailableReason,
  launchBlocker,
  profileFlagName,
  profilesFor,
  supportsProfiles,
  supportsSkipPermissions,
  type HostAgentSupport,
  type LaunchChoice,
  type LaunchableKind,
} from '@pocketshell/core';

const props = defineProps<{
  /** The folder the session starts in. Null when the folder has no host path. */
  folderPath: string | null;
  /** What to call it in the header. */
  folderLabel: string;
}>();

const emit = defineEmits<{
  /**
   * Create a session here and launch this. `choice` is null for a plain shell,
   * which creates a session and types nothing into it.
   */
  confirm: [choice: LaunchChoice | null];
  close: [];
}>();

const agents = useAgentsStore();
const connection = useConnectionStore();
const projects = useProjectsStore();
const settings = useSettingsStore();

/** Shell or agent — the phone's first control, and its default (Agent). */
const wantsAgent = ref(true);
const kind = ref<LaunchableKind>(settings.agentLaunchDefaults.kind);
const skipPermissions = ref(settings.agentLaunchDefaults.skipPermissions);
/**
 * The picked profile NAME, per engine, seeded from last time.
 *
 * Per engine rather than one value because switching claude -> codex -> claude
 * must not silently carry a claude profile into codex, where the host would
 * reject it. A copy, not the stored object: nothing is written back until the
 * user confirms.
 */
const pickedProfile = ref<Record<string, string>>({ ...settings.agentLaunchDefaults.profiles });

/** Profiles for the selected engine, in host order (its default first). */
const engineProfiles = computed(() => profilesFor(kind.value, agents.profiles));

/**
 * The profile row currently selected, falling back to the host's default.
 *
 * The fallback is what makes a remembered name that the host dropped harmless:
 * it simply stops matching and the default takes over.
 */
const activeProfile = computed(() => {
  const remembered = pickedProfile.value[kind.value];
  const match = engineProfiles.value.find((p) => p.name === remembered);
  return match ?? engineProfiles.value.find((p) => p.default) ?? engineProfiles.value[0] ?? null;
});

/** Only worth showing a picker when there is something to pick BETWEEN. */
const showProfiles = computed(
  () => wantsAgent.value && supportsProfiles(kind.value) && engineProfiles.value.length > 1,
);

const choice = computed<LaunchChoice | null>(() => {
  if (!wantsAgent.value) return null;
  return {
    kind: kind.value,
    dir: props.folderPath ?? '',
    skipPermissions: skipPermissions.value,
    profile: profileFlagName(activeProfile.value?.name ?? null, engineProfiles.value),
  };
});

/**
 * What this host's `pocketshell agent` said it can launch, plus the helper
 * version bootstrap already read.
 *
 * The version is passed for the MESSAGE only — the decision comes from the
 * probed subcommand list, never from comparing numbers (agentLaunch.ts says
 * why). It costs nothing to include and turns "your helper is too old" into
 * "your helper is 0.4.44, which is too old", which is the difference between a
 * complaint and an instruction.
 */
const hostSupport = computed<HostAgentSupport>(() => ({
  subcommands: agents.agentKinds,
  helperVersion: connection.bootstrap?.pocketshell.version ?? null,
  probing: agents.agentKindsProbing,
}));

/** Why this host cannot start [k], for the dimming and the tooltip on its segment. */
function unavailable(k: LaunchableKind): string | null {
  return kindUnavailableReason(k, hostSupport.value);
}

/**
 * Why confirming would not work, or null. A plain shell needs a folder too —
 * the session is created with `-c <folder>` either way — so the folder check
 * runs for both, which is why the shell branch borrows an agent kind purely to
 * satisfy the shape.
 *
 * `hostSupport` is passed only on the AGENT branch: a plain shell needs no
 * `pocketshell agent` subcommand at all, and a host whose probe failed must
 * not lose the ability to open a terminal over it.
 */
const blocker = computed(() =>
  choice.value
    ? launchBlocker(choice.value, hostSupport.value)
    : launchBlocker({ kind: 'claude', dir: props.folderPath ?? '' }),
);

/** The literal line that will be typed, shown so it is never a mystery. */
const preview = computed(() => (choice.value ? buildLaunchCommand(choice.value) : null));

onMounted(() => {
  if (!connection.connectionId) return;
  void agents.loadProfiles(connection.connectionId);
  // Re-asked on every open rather than cached: the helper is upgraded out from
  // under this app, and a user who just installed a newer one should see the
  // engine it added in the very next dialog.
  void agents.loadAgentKinds(connection.connectionId);
});

// Switching to an engine that cannot take one drops a stale profile from the
// preview immediately, rather than at confirm time.
watch(kind, () => {
  if (!supportsProfiles(kind.value)) delete pickedProfile.value[kind.value];
});

function pickProfile(name: string): void {
  pickedProfile.value = { ...pickedProfile.value, [kind.value]: name };
}

/**
 * Remember the answers, then hand the choice up.
 *
 * Written on CONFIRM and not on every change: a dialog the user opened, poked
 * at and cancelled should leave the defaults where they were.
 */
function onConfirm(): void {
  if (blocker.value) return;
  settings.agentLaunchDefaults = {
    kind: kind.value,
    skipPermissions: skipPermissions.value,
    profiles: { ...pickedProfile.value },
  };
  emit('confirm', choice.value);
}
</script>

<template>
  <OverlayPanel title="New session" size="sm" @close="emit('close')">
    <div class="launch">
      <p class="where muted">
        in
        <code :title="folderPath ?? ''">{{
          folderPath ? displayPath(folderPath, projects.home) : folderLabel
        }}</code>
      </p>

      <!-- ---- shell or agent ---- -->
      <section class="field">
        <span class="field-label">Session type</span>
        <div class="segmented" role="tablist">
          <button
            v-for="opt in [
              { on: false, label: 'Shell' },
              { on: true, label: 'Agent' },
            ]"
            :key="opt.label"
            class="segment"
            :class="{ on: wantsAgent === opt.on }"
            role="tab"
            :aria-selected="wantsAgent === opt.on"
            @click="wantsAgent = opt.on"
          >
            {{ opt.label }}
          </button>
        </div>
      </section>

      <template v-if="wantsAgent">
        <!-- ---- which harness ----
             An engine this host cannot launch is DIMMED but still clickable,
             which is the deliberate part. Removing it would leave the user
             unable to tell "this app dropped Grok" from "my host's helper is
             old"; disabling it would show that something is wrong without
             saying what. Clicking it selects it, `blocker` names the reason in
             full, and Create stays dead — so the explanation is one click away
             and the broken launch is still impossible. -->
        <section class="field">
          <span class="field-label">Agent</span>
          <div class="segmented" role="tablist">
            <button
              v-for="k in LAUNCHABLE_KINDS"
              :key="k"
              class="segment"
              :class="{ on: kind === k, unavailable: unavailable(k) !== null }"
              role="tab"
              :aria-selected="kind === k"
              :title="unavailable(k) ?? ''"
              @click="kind = k"
            >
              {{ KIND_LABELS[k] }}
            </button>
          </div>
        </section>

        <!-- ---- skip permissions ----
             Absent, not disabled, for opencode: the helper's own help calls
             the flag a "No-op for opencode", and a control that cannot do
             anything is worse than no control. -->
        <section v-if="supportsSkipPermissions(kind)" class="field toggle-field">
          <span class="field-label">Permissions</span>
          <button
            class="toggle"
            :class="{ on: skipPermissions }"
            role="switch"
            :aria-checked="skipPermissions"
            @click="skipPermissions = !skipPermissions"
          >
            <AppIcon :name="skipPermissions ? 'toggle-right' : 'toggle-left'" :size="16" />
            <span>{{ skipPermissions ? 'Skip permission prompts' : 'Ask before each action' }}</span>
          </button>
        </section>

        <!-- ---- which profile ---- -->
        <section v-if="showProfiles" class="field profile-field">
          <span class="field-label">Profile</span>
          <div class="chips">
            <button
              v-for="p in engineProfiles"
              :key="p.name"
              class="chip"
              :class="{ on: activeProfile?.name === p.name }"
              :title="p.configDir ?? 'the agent’s own default config directory'"
              @click="pickProfile(p.name)"
            >
              {{ p.name }}
            </button>
          </div>
        </section>

        <!-- An empty or failed profile list is a NORMAL state: a profile is
             optional and its absence means the engine default, which is what
             omitting `--profile` selects anyway. Said in a line so the user
             knows the picker is not simply missing. -->
        <p v-else-if="agents.profilesError" class="hint muted">
          <AppIcon name="alert-triangle" :size="12" />
          Could not list this host’s agent profiles, so {{ KIND_LABELS[kind] }} will start
          on its default configuration.
        </p>
        <p
          v-else-if="supportsProfiles(kind) && !agents.profilesLoading && !engineProfiles.length"
          class="hint muted"
        >
          This host has no {{ KIND_LABELS[kind] }} profiles configured, so it will start on
          its default configuration.
        </p>

        <p v-if="preview" class="preview">
          <code>{{ preview }}</code>
        </p>
      </template>
      <p v-else class="hint muted">A plain shell in this folder. No agent is started.</p>

      <p v-if="blocker" class="error">{{ blocker }}</p>

      <footer class="actions">
        <button class="btn-secondary" @click="emit('close')">Cancel</button>
        <button class="btn-primary" :disabled="blocker !== null" @click="onConfirm">
          Create session
        </button>
      </footer>
    </div>
  </OverlayPanel>
</template>

<style scoped>
.launch {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-4);
}
.where {
  margin: 0;
  font-size: var(--fs-200);
}
.where code,
.preview code {
  font-family: var(--font-mono);
}

.field {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  font-size: var(--fs-200);
}
.profile-field {
  align-items: flex-start;
}
.field-label {
  flex: 0 0 auto;
  min-width: 6.5rem;
  color: var(--fg-secondary);
}

/* Same segmented register as NewSessionDialog's route selector. */
.segmented {
  display: flex;
  flex: 1;
  gap: var(--sp-1);
  padding: var(--sp-1);
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}
.segment {
  flex: 1;
  height: var(--control-h);
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.segment:hover:not(.on) {
  background: var(--state-hover);
  color: var(--fg);
}
.segment.on {
  background: var(--accent-soft);
  color: var(--accent);
}
/* Reads as unavailable at a glance, stays clickable so the reason is
   reachable. Selecting one keeps the `on` background, because the user did
   select it and the segmented control must not lie about which tab is
   current — the red blocker line below is what says it cannot be created. */
.segment.unavailable:not(.on) {
  opacity: var(--disabled-opacity);
}

.toggle-field .toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--control-h);
  padding: 0 var(--sp-2);
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
}
.toggle:hover {
  background: var(--state-hover);
  color: var(--fg);
}
.toggle.on {
  color: var(--accent);
}

.chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
  flex: 1;
  min-width: 0;
}
.chip {
  height: var(--control-h);
  padding: 0 var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-200);
}
.chip:hover:not(.on) {
  color: var(--fg);
  background: var(--state-hover);
}
.chip.on {
  background: var(--accent-soft);
  border-color: transparent;
  color: var(--accent);
}

.hint {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0;
  font-size: var(--fs-200);
}
.hint .app-icon {
  margin-top: 3px;
  color: var(--warning);
}

/* The exact line that gets typed. A launch the user cannot read is a launch
   they cannot report when it goes wrong. */
.preview {
  margin: 0;
  padding: var(--sp-2);
  border-radius: var(--r-md);
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--fg-secondary);
  font-size: var(--fs-200);
  overflow-x: auto;
  white-space: nowrap;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  padding-top: var(--sp-3);
  border-top: 1px solid var(--border);
}
.btn-primary,
.btn-secondary {
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-4);
  border-radius: var(--r-md);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-semibold);
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.btn-primary {
  background: var(--accent);
  color: var(--on-accent);
  border: 1px solid var(--accent);
}
.btn-primary:hover:not(:disabled) {
  background: var(--accent-dim);
  color: var(--fg);
}
.btn-primary:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.btn-secondary {
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  color: var(--fg-secondary);
  font-weight: var(--fw-medium);
}
.btn-secondary:hover {
  color: var(--fg);
}
.error {
  margin: 0;
  color: var(--error);
  font-size: var(--fs-200);
}
</style>
