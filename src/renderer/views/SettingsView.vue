<script setup lang="ts">
// Settings: the renderer preferences screen, with host-scoped project roots.
// Account & sync is intentionally a separate window (views/AccountView.vue),
// so this overlay stays focused on local application preferences.
//
// WHERE THIS LIVES, AND WHY IT IS AN OVERLAY
//
// Ports and Usage are overlays because they are HOST-level and belong to the
// workspace header. Settings are mostly app-level, so on the face of it they belong
// somewhere else entirely — a route. They are still an overlay, for two
// reasons that both come out of this app's structure rather than out of taste:
//
//   - A route would unmount the workspace. `/settings` as a top-level route
//     replaces HostWorkspaceView, which owns the terminal; leaving the screen
//     to flip a switch would tear down xterm and take the user's scrollback
//     with it. That is a real cost the Ports overlay was already avoiding.
//   - It has to be reachable with no connection. `defaultHost` is a decision
//     about STARTUP, so the host picker is precisely where a user goes looking
//     for it. An overlay is the only host-agnostic surface this app has. The
//     same component, opened from the picker's header and from the workspace's;
//     over whatever is behind it.
//     The project-root section is the host-scoped exception: from the picker
//     it asks for an explicit host, while a workspace supplies its connected
//     host automatically.
//
// So: one view, mounted inside `OverlayPanel` by two callers. It renders no
// heading of its own — the overlay chrome owns the title (see UsageView's
// `embedded` prop and the duplicated-heading note in OverlayPanel).
import { computed, onMounted, ref } from 'vue';
import { useConnectionStore } from '../stores/connection';
import { useProjectsStore } from '../stores/projects';
import { useSessionsStore } from '../stores/sessions';
import { useSettingsStore } from '../stores/settings';
import { useUpdateStore } from '../stores/update';
import { defaultHostStatus } from '../autoConnect';
import { canonicalisePath } from '../sessionGrouping';
import {
  inferHome,
  normaliseRootPath,
  OTHER_ROOT,
  rootForPath,
  SESSION_ROOTS_MAX,
} from '../sessionRoots';
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  MONOSPACE_FAMILIES,
  parseFontSize,
  resolveMonoStack,
  sanitiseFontFamily,
} from '../fonts';
import {
  formatZoomPercent,
  ZOOM_PERCENT_DEFAULT,
  ZOOM_PERCENT_MAX,
  ZOOM_PERCENT_MIN,
} from '../zoom';
import { THEME_CHOICE_SYSTEM, THEMES } from '../themes';
import ShortcutSettings from '../components/ShortcutSettings.vue';

const connection = useConnectionStore();
const projects = useProjectsStore();
const sessions = useSessionsStore();
const settings = useSettingsStore();
const updates = useUpdateStore();

/**
 * The host whose project roots this section edits.
 *
 * A connected workspace supplies its active alias, so opening Settings there
 * cannot accidentally edit another instance. When Settings is opened from
 * the disconnected host picker, the user chooses an alias explicitly before
 * the root controls become active.
 */
const selectedRootHost = ref('');
const rootHost = computed(() => connection.activeHost?.name ?? selectedRootHost.value);
const scopedSessionRoots = computed(() => settings.sessionRootsFor(rootHost.value));

onMounted(async () => {
  // The picker loads hosts on its own mount, but the workspace does not
  // re-read the config, and this panel opens over both. `listConfigHosts()` is
  // the single source for the default-host choices, so ask for it when the
  // list is empty rather than rendering an empty select.
  if (!connection.hosts.length) await connection.loadHosts();
  if (
    !connection.activeHost &&
    settings.defaultHost &&
    connection.hosts.some((host) => host.name === settings.defaultHost)
  ) {
    selectedRootHost.value = settings.defaultHost;
  }
});

/**
 * A stored default naming a host that is no longer in ~/.ssh/config. The value
 * is deliberately still shown as selected and still stored — the user set it,
 * and silently dropping it would hide the fact that their config changed.
 */
const defaultMissing = computed(
  () => defaultHostStatus(settings.defaultHost, connection.hosts) === 'missing',
);

function onDefaultHostChange(event: Event): void {
  const value = (event.target as HTMLSelectElement).value;
  // '' is the "no default" option; the store's parser normalises it to null.
  settings.set('defaultHost', value === '' ? null : value);
}

/* --- Session roots -------------------------------------------------------
 * The session panel's top level for the selected host. An empty host entry
 * means "derive roots from $HOME", which is what the panel did before this
 * control existed, so this section is additive: a user who never opens it
 * sees no change.
 * ---------------------------------------------------------------------- */

const rootDraft = ref('');
const rootError = ref<string | null>(null);

/**
 * Roots offered as suggestions: the ones the CURRENT host's sessions are
 * actually running under, minus what is already registered.
 *
 * This exists because a text field alone asks the user to remember paths on a
 * machine they are not looking at. Their real roots are, by definition, where
 * their sessions already are — so the app can just read them off the session
 * list it already has when that host is connected. There is no remote
 * directory scan behind this: the panel can open with no connection at all
 * from the host picker, and a suggestion list that is sometimes empty is
 * better than one that sometimes blocks on SSH. The phone solves it the other
 * way, with a remote directory scan over three guessed parents
 * (WatchedFoldersViewModel.kt:397).
 */
const rootSuggestions = computed<string[]>(() => {
  // Sessions are only associated with an alias while that host is connected.
  // Do not offer stale rows from a previous connection for a host selected in
  // the disconnected picker.
  if (!rootHost.value || rootHost.value !== connection.activeHost?.name) return [];
  const paths = sessions.sessions.map((session) => session.path);
  const home = projects.home ?? inferHome(paths);
  const out: string[] = [];
  for (const path of paths) {
    const { key } = rootForPath(canonicalisePath(path), home);
    if (key === OTHER_ROOT) continue;
    if (scopedSessionRoots.value.includes(key)) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out.sort();
});

const rootsFull = computed(() => scopedSessionRoots.value.length >= SESSION_ROOTS_MAX);

/**
 * Add whatever is in the field. The store owns normalisation and dedupe, so
 * the only work here is turning its `false` into a sentence — and the two
 * reasons it can refuse a *well-formed* path need telling apart, because
 * "already registered" and "list is full" call for different next actions.
 */
function onAddRoot(): void {
  const value = rootDraft.value;
  if (!rootHost.value || !value.trim()) return;
  if (normaliseRootPath(value) === null) {
    rootError.value = 'Use an absolute path, or one under ~ — for example ~/git.';
    return;
  }
  if (!settings.addSessionRoot(rootHost.value, value)) {
    rootError.value = rootsFull.value
      ? `That is the limit of ${SESSION_ROOTS_MAX} roots. Remove one first.`
      : 'That root is registered already.';
    return;
  }
  rootDraft.value = '';
  rootError.value = null;
}

function onRemoveRoot(path: string): void {
  if (!rootHost.value) return;
  settings.removeSessionRoot(rootHost.value, path);
  rootError.value = null;
}

/* --- Theme ---------------------------------------------------------------
 * The options are read off the THEMES registry, so this control never needs
 * touching when a theme is added: one record in themes.ts and it is listed.
 * `system` is not a theme and is offered separately, first, because it is a
 * different KIND of answer — a rule, not a palette.
 * ---------------------------------------------------------------------- */

function onThemeChange(event: Event): void {
  settings.set('theme', (event.target as HTMLSelectElement).value);
}

/* --- Zoom ----------------------------------------------------------------
 * The stepper writes through the SAME store actions the Ctrl+= / Ctrl+- /
 * Ctrl+0 chords land on (App.vue subscribes; main forwards the intent). There
 * is no local number here on purpose: a copy would be a second source of truth
 * and would go stale the first time the user used the keyboard instead of the
 * mouse, which is precisely the failure this control exists to avoid.
 * ---------------------------------------------------------------------- */

const zoomLabel = computed(() => formatZoomPercent(settings.zoomPercent));
const atMinZoom = computed(() => settings.zoomPercent <= ZOOM_PERCENT_MIN);
const atMaxZoom = computed(() => settings.zoomPercent >= ZOOM_PERCENT_MAX);
const atDefaultZoom = computed(() => settings.zoomPercent === ZOOM_PERCENT_DEFAULT);

/**
 * The stack the chosen family actually resolves to, used to render the two
 * samples below.
 *
 * The samples are not decoration. There is no way to ask the renderer whether
 * a family is installed, so a sample IS the answer: type a name, and if it
 * does not change, the font is not on this machine and the stack fell through
 * to Consolas. That is a better report than any check this app could make.
 *
 * There are two of them, one per size control, because a single shared sample
 * is what made the size controls confusable in the first place — see the
 * comment above the Monospace text section in the template.
 */
const monoSample = computed(() => resolveMonoStack(settings.monospaceFontFamily));

/**
 * Committed on `change` (blur, Enter, or picking a datalist suggestion) rather
 * than on `input`. A family name is only meaningful once it is finished — the
 * partial "Fira Cod" would resolve to the fallback and flicker the whole app's
 * mono chrome on the way to "Fira Code".
 */
function onFamilyChange(event: Event): void {
  const el = event.target as HTMLInputElement;
  const clean = sanitiseFontFamily(el.value) ?? null;
  settings.set('monospaceFontFamily', clean);
  // Write the cleaned value back so the field shows what was actually stored;
  // otherwise a name that lost characters to the sanitiser would look accepted
  // verbatim until the panel was reopened.
  el.value = clean ?? '';
}

/** Both size fields. The clamp lives in `fonts.ts` so it cannot drift. */
function onSizeChange(key: 'terminalFontSize' | 'editorFontSize', event: Event): void {
  const el = event.target as HTMLInputElement;
  // `min`/`max` on a number input are advisory — they gate the stepper, not a
  // typed value — so the clamp is applied here regardless of what the DOM says.
  const size = parseFontSize(el.value) ?? settings[key];
  settings.set(key, size);
  el.value = String(size);
}

/* --- Keyboard ------------------------------------------------------------
 * The whole group — the list, the capture editor, and the refused-keys
 * ledger — is components/ShortcutSettings.vue, with its reasoning. The parent
 * keeps the group chrome, like every other section here.
 * ---------------------------------------------------------------------- */
</script>

<template>
  <div class="settings">
    <section class="group">
      <h3 class="group-title">Startup</h3>
      <div class="row">
        <div class="row-text">
          <label class="row-label" for="default-host">Default host</label>
          <p class="row-hint">
            Connect to this host as soon as PocketShell starts and go straight to its
            sessions. Choose <em>Always show the host list</em> to keep the picker.
          </p>
        </div>
        <select
          id="default-host"
          class="control"
          :value="settings.defaultHost ?? ''"
          @change="onDefaultHostChange"
        >
          <option value="">Always show the host list</option>
          <!-- The stale value keeps its own option so the select can still
               display it; without this the control would silently snap to
               "always show", which is not what is stored. -->
          <option v-if="defaultMissing" :value="settings.defaultHost ?? ''">
            {{ settings.defaultHost }} (not in ~/.ssh/config)
          </option>
          <option v-for="host in connection.hosts" :key="host.name" :value="host.name">
            {{ host.name }}
          </option>
        </select>
      </div>
      <p v-if="defaultMissing" class="notice">
        <AppIcon name="alert-triangle" :size="14" />
        <span>
          <strong>{{ settings.defaultHost }}</strong> is not in <code>~/.ssh/config</code> any
          more, so PocketShell starts on the host list until you pick a new default.
        </span>
      </p>
    </section>

    <section class="group">
      <h3 class="group-title">Session panel</h3>

      <div class="row stacked">
        <div class="row-text">
          <span class="row-label">Project roots</span>
          <p class="row-hint">
            The top level of the session tree: <code>~/git</code>, <code>~/tmp</code>, or
            any folder you keep projects in. Every session below a root is grouped under
            it, by the folder it runs in. Sessions under no root collect in
            <em>other</em>, at the bottom. Roots are stored separately for each SSH host;
            <template v-if="rootHost">
              this list belongs to <code>{{ rootHost }}</code>.
            </template>
            <template v-else>choose an instance below to edit its list.</template>
          </p>
        </div>

        <div v-if="!rootHost && connection.hosts.length" class="root-host-picker">
          <label for="root-host">Instance</label>
          <select id="root-host" v-model="selectedRootHost" class="control">
            <option disabled value="">Choose an SSH host</option>
            <option v-for="host in connection.hosts" :key="host.name" :value="host.name">
              {{ host.name }}
            </option>
          </select>
        </div>

        <template v-if="rootHost">
          <ul v-if="scopedSessionRoots.length" class="roots">
            <li v-for="root in scopedSessionRoots" :key="root" class="root">
              <span class="root-path">{{ root }}</span>
              <button class="icon-btn" :title="`Remove ${root}`" @click="onRemoveRoot(root)">
                <AppIcon name="trash-2" :size="14" />
              </button>
            </li>
          </ul>

          <div class="add-root">
            <input
              v-model="rootDraft"
              class="control grow"
              type="text"
              list="root-suggestions"
              placeholder="~/git"
              :disabled="rootsFull"
              :aria-label="`Add a project root for ${rootHost}`"
              @keydown.enter.prevent="onAddRoot"
            />
            <!-- Where the user's roots actually are, read off the running
                 sessions. Typing is still allowed: a root you have not started a
                 session in yet cannot be suggested, and registering one ahead of
                 time is a legitimate thing to want. -->
            <datalist id="root-suggestions">
              <option v-for="path in rootSuggestions" :key="path" :value="path" />
            </datalist>
            <button class="add-btn" :disabled="rootsFull" @click="onAddRoot">
              <AppIcon name="plus" :size="14" />
              Add
            </button>
          </div>

          <p v-if="rootError" class="notice">
            <AppIcon name="alert-triangle" :size="14" />
            <span>{{ rootError }}</span>
          </p>
        </template>
        <p v-else class="root-notice">
          <AppIcon name="alert-triangle" :size="14" />
          <span v-if="connection.hosts.length">
            Connect to an instance, or choose an SSH host above, to configure its roots.
          </span>
          <span v-else>Connect to an instance to configure its roots.</span>
        </p>
      </div>
    </section>

    <section class="group">
      <h3 class="group-title">Display</h3>

      <div class="row">
        <div class="row-text">
          <label class="row-label" for="theme-choice">Theme</label>
          <p class="row-hint">
            Colours for the whole app — panels, terminal and file editor together, so
            they always read as one surface. <em>Follow Windows</em> switches between
            Dark and Light with the system's own light and dark mode, live.
          </p>
        </div>
        <select
          id="theme-choice"
          class="control"
          :value="settings.theme"
          @change="onThemeChange"
        >
          <option :value="THEME_CHOICE_SYSTEM">Follow Windows</option>
          <option v-for="theme in THEMES" :key="theme.id" :value="theme.id">
            {{ theme.label }}
          </option>
        </select>
      </div>

      <div class="row">
        <div class="row-text">
          <span id="zoom-label" class="row-label">App zoom</span>
          <p class="row-hint">
            Scales the whole window at once — panels, tabs, the composer and the terminal
            together — the way a browser's zoom does. <kbd>Ctrl</kbd> with
            <kbd>+</kbd>, <kbd>-</kbd> or <kbd>0</kbd> moves this same setting, so the
            number here is always what the window is actually at. To change only the
            terminal's text, leave this at 100% and use <em>Terminal text size</em> below.
          </p>
        </div>
        <!-- A stepper, not a number field: zoom moves along a fixed ladder
             (see zoom.ts) so that in-then-out returns to exactly where you
             started, and a free-text percentage would invite values that are
             not on it. The reset sits in the same group as the thing it
             undoes, and is disabled at 100% so it also reads as a state. -->
        <div class="stepper" role="group" aria-labelledby="zoom-label">
          <button
            class="icon-btn"
            :disabled="atMinZoom"
            aria-label="Zoom out"
            title="Zoom out (Ctrl+-)"
            @click="settings.zoomOut()"
          >
            <AppIcon name="minus" :size="14" />
          </button>
          <span class="stepper-value" aria-live="polite">{{ zoomLabel }}</span>
          <button
            class="icon-btn"
            :disabled="atMaxZoom"
            aria-label="Zoom in"
            title="Zoom in (Ctrl+=)"
            @click="settings.zoomIn()"
          >
            <AppIcon name="plus" :size="14" />
          </button>
          <button
            class="icon-btn"
            :disabled="atDefaultZoom"
            aria-label="Reset zoom to 100%"
            title="Reset to 100% (Ctrl+0)"
            @click="settings.resetZoom()"
          >
            <AppIcon name="rotate-ccw" :size="14" />
          </button>
        </div>
      </div>
    </section>

    <!--
      Monospace text.

      TWO SIZE CONTROLS, AND WHY EACH ONE CARRIES ITS OWN PREVIEW.

      These shipped as "Terminal size" and "File editor size" under one
      heading, with a single shared sample between them, and a user reported
      twice that "font size has no effect" — because they were moving the
      editor's control while watching the terminal. The wiring was correct
      both times. That is a labelling defect, not a user error: two adjacent
      numeric fields whose only distinguishing mark was a word in a hint
      nobody reads.

      Both settings are kept. They are genuinely two decisions — the terminal's
      size changes the cell, so it changes the rows and columns pushed to the
      PTY and tmux reflows on the far end, which the editor's size cannot do —
      and merging them would jump every existing user's editor from 13px to
      16px on upgrade, breaking the rule the whole typography feature was built
      on. What changes instead is that each control now names its surface in
      the LABEL rather than in prose, and each is followed by a captioned live
      sample rendered in that surface's own face, size and ground. A preview
      that visibly moves when you touch the control is self-explanatory in a
      way no label is; if this is still confused after that, the answer is to
      merge them and accept the editor jump.
    -->
    <section class="group">
      <h3 class="group-title">Monospace text</h3>

      <div class="row">
        <div class="row-text">
          <label class="row-label" for="mono-family">Font</label>
          <p class="row-hint">
            Used by the terminal, the file editor and every path, port and session name
            in the app — they are one surface, so they share one face. Pick a suggestion
            or type any family installed on this machine; leave it empty for the default.
            A font you do not have falls back to Consolas, never to a proportional face.
          </p>
        </div>
        <input
          id="mono-family"
          class="control"
          type="text"
          list="mono-families"
          placeholder="Consolas (default)"
          :value="settings.monospaceFontFamily ?? ''"
          @change="onFamilyChange"
        />
        <datalist id="mono-families">
          <option v-for="family in MONOSPACE_FAMILIES" :key="family" :value="family" />
        </datalist>
      </div>

      <div class="row previewed">
        <div class="row-main">
          <div class="row-text">
            <label class="row-label" for="terminal-size">Terminal text size</label>
            <p class="row-hint">
              Pixels, for the terminal only — this is the one the shell and tmux are in.
              Changing it changes the cell size, so the terminal reports a new row and
              column count to the remote and tmux redraws to fit. Above about 22px an
              80-column pane no longer fits a default window with the session panel open.
            </p>
          </div>
          <input
            id="terminal-size"
            class="control size"
            type="number"
            :min="FONT_SIZE_MIN"
            :max="FONT_SIZE_MAX"
            step="1"
            :value="settings.terminalFontSize"
            @change="onSizeChange('terminalFontSize', $event)"
          />
        </div>
        <!-- On the terminal's own ground, in the resolved stack, at exactly
             the size above: the sample answers both "is this font installed"
             and "which of the two controls am I holding". -->
        <figure class="preview">
          <figcaption class="preview-tag">Terminal at {{ settings.terminalFontSize }}px</figcaption>
          <p class="sample terminal" :style="{ fontFamily: monoSample }">
            ABCdef 0123 il1 O0 {}[]() -&gt;= !== &amp;&amp; ~/.ssh/config
          </p>
        </figure>
      </div>

      <div class="row previewed">
        <div class="row-main">
          <div class="row-text">
            <label class="row-label" for="editor-size">File editor text size</label>
            <p class="row-hint">
              Pixels, for the text of a file open in the Files tab — nothing else. It has
              its own setting because the two surfaces ship at different sizes, and
              because only the terminal's size is visible to the program on the other end.
            </p>
          </div>
          <input
            id="editor-size"
            class="control size"
            type="number"
            :min="FONT_SIZE_MIN"
            :max="FONT_SIZE_MAX"
            step="1"
            :value="settings.editorFontSize"
            @change="onSizeChange('editorFontSize', $event)"
          />
        </div>
        <figure class="preview">
          <figcaption class="preview-tag">File editor at {{ settings.editorFontSize }}px</figcaption>
          <p class="sample editor" :style="{ fontFamily: monoSample }">
            ABCdef 0123 il1 O0 {}[]() -&gt;= !== &amp;&amp; ~/.ssh/config
          </p>
        </figure>
      </div>
    </section>

    <section class="group">
      <h3 class="group-title">Prompt composer</h3>

      <div class="row">
        <div class="row-text">
          <span class="row-label">Typing opens the composer</span>
          <p class="row-hint">
            Typing in the terminal opens the prompt composer and the keystrokes go into
            it, instead of straight to the shell.
          </p>
        </div>
        <button
          class="switch"
          role="switch"
          :aria-checked="settings.typingOpensComposer"
          :class="{ on: settings.typingOpensComposer }"
          @click="settings.set('typingOpensComposer', !settings.typingOpensComposer)"
        >
          <AppIcon :name="settings.typingOpensComposer ? 'toggle-right' : 'toggle-left'" />
          <span>{{ settings.typingOpensComposer ? 'On' : 'Off' }}</span>
        </button>
      </div>

      <div class="row">
        <div class="row-text">
          <span class="row-label">Close the composer after sending</span>
          <p class="row-hint">
            The composer closes itself once a message is sent, and reopens the next time
            you type.
          </p>
        </div>
        <button
          class="switch"
          role="switch"
          :aria-checked="settings.closeComposerOnSend"
          :class="{ on: settings.closeComposerOnSend }"
          @click="settings.set('closeComposerOnSend', !settings.closeComposerOnSend)"
        >
          <AppIcon :name="settings.closeComposerOnSend ? 'toggle-right' : 'toggle-left'" />
          <span>{{ settings.closeComposerOnSend ? 'On' : 'Off' }}</span>
        </button>
      </div>
    </section>

    <!--
      Keyboard. The whole group — list, capture, refused keys — is
      components/ShortcutSettings.vue; the reasoning lives there.
    -->
    <section class="group">
      <h3 class="group-title">Keyboard</h3>
      <ShortcutSettings />
    </section>


    <section class="group">
      <h3 class="group-title">Updates</h3>

      <div class="row">
        <div class="row-text">
          <label class="row-label">Updates</label>
          <p class="row-hint">
            The app checks this project's GitHub releases once per launch. Nothing
            installs itself: when a newer version exists you get a banner with a
            download link, and updating means replacing this copy the way you first
            put it here. The check runs at launch; this button runs it again now.
          </p>
        </div>
        <div class="control">
          <button class="btn-ghost" :disabled="updates.status === 'checking'" @click="updates.check()">
            {{ updates.status === 'checking' ? 'Checking…' : 'Check now' }}
          </button>
          <p class="row-hint">
            <template v-if="updates.status === 'up-to-date'">
              Up to date ({{ updates.currentVersion }}).
            </template>
            <template v-else-if="updates.status === 'available'">
              {{ updates.tagName }} is available.
            </template>
            <template v-else-if="updates.status === 'failed'">
              Check failed: {{ updates.reason }}
            </template>
            <template v-else-if="updates.status === 'idle'">
              {{ updates.currentVersion ?? '…' }}
            </template>
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  padding: var(--sp-4);
}
.group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
/* The section header metric from the session panel: small, uppercase, tracked.
   It is the app's existing "this is a group of things" mark. */
.group-title {
  margin: 0;
  font-size: var(--fs-100);
  line-height: var(--lh-100);
  font-weight: var(--fw-semibold);
  color: var(--fg-muted);
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
/* Label left, control right, hairline between rows — the shape every settings
   list in every desktop app has, so nothing here needs to be learned. */
.row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--border-soft);
}
.row:last-child {
  border-bottom: none;
}
/* A list plus an editor cannot sit in the label-left/control-right shape the
   other rows use — it needs the full width — so this row stacks instead. */
.row.stacked {
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-2);
}
/* A row whose preview belongs to IT and not to the section. The label/control
   pair keeps the normal shape in `.row-main`; the sample goes full width
   underneath, inside the same row, so the hairline still separates settings
   rather than separating a control from its own preview. */
.row.previewed {
  flex-direction: column;
  align-items: stretch;
  gap: var(--sp-2);
}
.row-main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
}
.preview {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
/* Names the surface the sample IS. Same metric as the group title, one step
   quieter — it labels a picture, it is not a heading. */
.preview-tag {
  font-size: var(--fs-100);
  line-height: var(--lh-100);
  font-weight: var(--fw-medium);
  color: var(--fg-secondary);
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
/* The zoom stepper: minus / value / plus / reset, in one bordered group so the
   four controls read as one instrument rather than four loose buttons. */
.stepper {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: 0 var(--sp-1);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
}
/* Tabular figures and a fixed width so stepping 90% -> 100% -> 110% does not
   shuffle the buttons either side of it. */
.stepper-value {
  min-width: 4.5ch;
  text-align: center;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  font-variant-numeric: tabular-nums;
  color: var(--fg);
}
/* The keyboard group's styles — keycaps, the chord list, the capture field —
   moved to components/ShortcutSettings.vue with the group. */
.root-host-picker {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.root-host-picker label {
  flex: none;
  font-size: var(--fs-200);
  color: var(--fg-secondary);
}
.root-host-picker .control {
  flex: 1;
  max-width: none;
}
.roots {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  overflow: hidden;
}
.root {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--row-h);
  padding: 0 var(--sp-1) 0 var(--sp-3);
  border-bottom: 1px solid var(--border-soft);
}
.root:last-child {
  border-bottom: none;
}
/* The stored spelling, verbatim and in mono: this is the string the panel
   matches against, so showing it in anything else would be a paraphrase. */
.root-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--fs-200);
}
.add-root {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.control.grow {
  flex: 1;
  max-width: none;
  font-family: var(--font-mono);
}
/* Bordered, matching the session panel's `New session` button: it is the one
   primary action in this section and a ghost control beside a text field
   reads as a hint rather than a button. */
.add-btn {
  flex: none;
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  cursor: pointer;
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
}
.add-btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent-dim);
  background: var(--accent-soft);
}
.add-btn:disabled,
.control:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.row-text {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}
.row-label {
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  color: var(--fg);
}
/* --fg-secondary, not --fg-muted: this is real information at 12px, and
   --fg-muted is 4.12:1; restrict it to >=15px. */
.row-hint {
  margin: 0;
  max-width: 46ch;
  font-size: var(--fs-200);
  line-height: var(--lh-200);
  color: var(--fg-secondary);
}
.control {
  flex: none;
  height: var(--control-h);
  background: var(--surface-2);
  /* WCAG 1.4.11: a control's boundary needs >=3:1; --border is 1.49:1. */
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg);
  padding: 0 var(--sp-2);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  max-width: 16rem;
}
/* A labelled two-state control, not a bordered box: the mark itself changes
   shape (toggle-left/toggle-right), so on and off differ without relying on
   the tint. Ghost at rest like the rest of the app's chrome. */
.switch {
  flex: none;
  height: var(--control-h);
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 0 var(--sp-2);
  background: transparent;
  border: none;
  border-radius: var(--r-md);
  color: var(--fg-secondary);
  font-family: var(--font-ui);
  font-size: var(--fs-300);
  font-weight: var(--fw-medium);
  line-height: 1;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease),
    color var(--dur-fast) var(--ease);
}
.switch.on {
  color: var(--accent);
}
.switch:hover {
  background: var(--state-hover);
}
.control.size {
  width: 5rem;
  font-variant-numeric: tabular-nums;
}
/* The sync rows' outcome line. Same hint metric; an error tints the text so
   "decryption failed — wrong passphrase" is a colour apart from a count. */
/* The sync selection list: a scroller rather than an ever-growing stack —
   a config with thirty hosts must not stretch the settings panel. Two
   columns while there is room (aliases are short), one on a narrow panel. */
/* Each sample sits on its surface's own ground at its surface's own size, so
   it answers the question the user is actually asking — "what will THIS look
   like" — rather than "what does this font look like on a settings panel".
   The two differ only in the size token they read, which is the whole point:
   move one control and exactly one sample changes. */
.sample {
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--term-bg);
  line-height: 1.3;
  white-space: nowrap;
  overflow-x: auto;
}
.sample.terminal {
  color: var(--term-fg);
  font-size: var(--term-font-size);
}
/* The editor sits on the terminal's ground too (see FilesView: an open file
   and the shell it came from are one surface), in the editor's own body
   colour and at the editor's own size. */
.sample.editor {
  color: var(--code-variable);
  font-size: var(--code-font-size);
}
/* The refusal sheet's other half: the roots editor's notice. The keyboard
   group's own notice moved to ShortcutSettings.vue with the group. */
.root-notice {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  color: var(--warning);
  background: var(--warning-soft);
  font-size: var(--fs-200);
  line-height: var(--lh-200);
}
code {
  font-family: var(--font-mono);
  font-size: 0.9em;
}
</style>
