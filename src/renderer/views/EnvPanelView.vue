<script setup lang="ts">
// EnvPanelView: the server-side env editor (FEATURES.md F16). Lists the env
// keys the helper sees for a folder (`pocketshell env list`), reveals values
// on demand (`env get --key`), and writes edits (`env set`, values on the
// command's stdin — never argv).
//
// Two design constraints shape everything below:
//
//   - **Values are secrets until asked for.** The helper's write-only default
//     keeps values off the wire, and the panel honours that: names load
//     immediately, a value appears only when its row is revealed, and a
//     revealed-but-unedited row displays through a password field until the
//     eye icon is pressed. Nothing here re-serves a value that was never
//     fetched.
//
//   - **A write that failed must not look like one that succeeded.** `envSet`
//     rejects with the host's own message; per-row save state turns that into
//     a sentence next to the row rather than a silent no-op.
import { onMounted, ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId, EnvVarRow } from '@pocketshell/core';
import { errorMessage } from '../../shared/errors';

const props = defineProps<{
  connectionId: ConnectionId;
  /** The folder whose env is being edited (the Files tab's current directory). */
  dir: string;
}>();

/** One editable row on screen. */
interface EnvRow {
  key: string;
  /** The env file the key was read from; '' when a new key not yet written. */
  file: string;
  hasValue: boolean;
  /** The value has been fetched from the host (`env get`). */
  revealed: boolean;
  /** The field's current text — the fetched value, or the user's edit. */
  value: string;
  /** True when `value` differs from what the host last confirmed. */
  dirty: boolean;
  saving: boolean;
}

const rows = ref<EnvRow[]>([]);
const loading = ref(true);
/** A load/list failure — the panel's own error channel. */
const error = ref<string | null>(null);
/** A failed write, named next to the row (or the new-key form) that failed. */
const saveError = ref<string | null>(null);

/** The new-key form. */
const newKey = ref('');
const newValue = ref('');
const adding = ref(false);

function toRow(r: EnvVarRow): EnvRow {
  return { key: r.key, file: r.file, hasValue: r.hasValue, revealed: false, value: '', dirty: false, saving: false };
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    const list = await api.agent.envList(props.connectionId, props.dir);
    rows.value = list.map(toRow);
  } catch (e) {
    error.value = errorMessage(e);
  } finally {
    loading.value = false;
  }
}

/**
 * Fetch one row's value and put it in the field.
 *
 * Revealing and editing are the same gesture from here on: a secret that has
 * been fetched may as well be correctable, and a separate "edit" action would
 * just be a second click on the way to the same `env set`.
 */
async function onReveal(row: EnvRow): Promise<void> {
  if (row.revealed) return;
  try {
    const values = await api.agent.envGet(props.connectionId, props.dir, [row.key]);
    row.value = values[row.key] ?? '';
    row.revealed = true;
  } catch (e) {
    error.value = errorMessage(e);
  }
}

/** Fetch every row's value in one round trip (the helper's whole-env read). */
async function onRevealAll(): Promise<void> {
  try {
    const values = await api.agent.envGet(props.connectionId, props.dir);
    for (const row of rows.value) {
      if (row.key in values) {
        row.value = values[row.key]!;
        row.revealed = true;
      }
    }
  } catch (e) {
    error.value = errorMessage(e);
  }
}

/**
 * A cheap key check before the host sees it. The helper has opinions about
 * names too, but `=` or whitespace in a key mangles the dotenv file silently
 * worse than it fails loudly — refuse the obvious nonsense locally.
 */
function keyIsSane(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
}

/** Write one row's value back to the file it came from. */
async function onSave(row: EnvRow): Promise<void> {
  row.saving = true;
  saveError.value = null;
  try {
    await api.agent.envSet(props.connectionId, props.dir, { [row.key]: row.value }, row.file || undefined);
    row.hasValue = true;
    row.dirty = false;
    row.file = row.file || '.env';
  } catch (e) {
    saveError.value = `${row.key}: ${errorMessage(e)}`;
  } finally {
    row.saving = false;
  }
}

async function onAdd(): Promise<void> {
  const key = newKey.value.trim();
  if (!keyIsSane(key)) return;
  adding.value = true;
  saveError.value = null;
  try {
    await api.agent.envSet(props.connectionId, props.dir, { [key]: newValue.value });
    // Re-list rather than hand-appending: the helper decides where the key
    // landed, and the authoritative row is one cheap call away.
    newKey.value = '';
    newValue.value = '';
    await load();
  } catch (e) {
    saveError.value = `${key}: ${errorMessage(e)}`;
  } finally {
    adding.value = false;
  }
}

onMounted(load);
</script>

<template>
  <div class="env-panel">
    <p class="env-dir muted">{{ props.dir }}</p>

    <p v-if="loading" class="muted">listing env keys…</p>
    <p v-else-if="error" class="error">{{ error }}</p>

    <template v-else>
      <p v-if="!rows.length" class="muted empty-line">
        No env keys in this folder yet. Add one below — it lands in <code>.env</code>.
      </p>

      <ul v-else class="env-rows">
        <li v-for="row in rows" :key="row.key" class="env-row">
          <div class="row-head">
            <code class="key">{{ row.key }}</code>
            <span class="file-badge" :class="{ envrc: row.file === '.envrc' }">{{
              row.file || 'new'
            }}</span>
            <span v-if="!row.hasValue" class="unset">not set</span>
          </div>

          <div v-if="row.revealed" class="row-edit">
            <!-- Password-dots while the field holds a fetched value the user
                 has not touched — the value is already in memory, but it need
                 not be on the screen of everyone looking at this window.
                 Editing turns it into text, because there is no editing a
                 secret you cannot see. -->
            <input
              v-model="row.value"
              class="value-input"
              :type="row.dirty ? 'text' : 'password'"
              :aria-label="`Value of ${row.key}`"
              spellcheck="false"
              @input="row.dirty = true"
            />
            <button
              class="save-btn"
              :disabled="!row.dirty || row.saving"
              :title="row.dirty ? 'Write to the host' : 'Unchanged'"
              @click="onSave(row)"
            >
              {{ row.saving ? 'Saving…' : 'Save' }}
            </button>
          </div>
          <div v-else class="row-edit">
            <button class="reveal-btn" @click="onReveal(row)">
              {{ row.hasValue ? 'Reveal value' : 'Set a value' }}
            </button>
          </div>
        </li>
      </ul>

      <div class="panel-actions">
        <button v-if="rows.length" class="reveal-btn" @click="onRevealAll">
          Reveal all values
        </button>
      </div>

      <p v-if="saveError" class="error">{{ saveError }}</p>

      <form class="add-row" @submit.prevent="onAdd">
        <input
          v-model="newKey"
          class="key-input"
          placeholder="NEW_KEY"
          aria-label="New key name"
          spellcheck="false"
          autocomplete="off"
        />
        <input
          v-model="newValue"
          class="value-input"
          placeholder="value"
          aria-label="New key value"
          spellcheck="false"
          autocomplete="off"
        />
        <button class="save-btn" type="submit" :disabled="!keyIsSane(newKey.trim()) || adding">
          {{ adding ? 'Adding…' : 'Add key' }}
        </button>
      </form>
      <p v-if="newKey.trim() && !keyIsSane(newKey.trim())" class="muted hint">
        Keys are UPPER_SNAKE — letters, digits and underscores, starting with a letter.
      </p>
    </template>
  </div>
</template>

<style scoped>
.env-panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  min-width: 0;
}
.env-dir {
  margin: 0;
  font-size: var(--fs-300);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.muted {
  color: var(--fg-muted);
}
.error {
  margin: 0;
  color: var(--error);
}
.empty-line {
  margin: 0;
}
.env-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.env-row {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  padding: var(--sp-2) 0;
  border-bottom: 1px solid var(--border);
}
.row-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.key {
  font-family: var(--font-mono);
  font-size: var(--fs-300);
  overflow-wrap: anywhere;
}
.file-badge {
  font-size: var(--fs-200);
  padding: 0 var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  color: var(--fg-muted);
}
.file-badge.envrc {
  color: var(--accent);
}
.unset {
  font-size: var(--fs-200);
  color: var(--fg-muted);
  font-style: italic;
}
.row-edit {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.value-input,
.key-input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: var(--fs-300);
  padding: var(--sp-1) var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: inherit;
}
.save-btn,
.reveal-btn {
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: inherit;
  padding: var(--sp-1) var(--sp-2);
  cursor: pointer;
}
.save-btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}
.panel-actions {
  display: flex;
  justify-content: flex-end;
}
.add-row {
  display: flex;
  gap: var(--sp-2);
  border-top: 1px solid var(--border);
  padding-top: var(--sp-3);
}
.hint {
  margin: 0;
  font-size: var(--fs-200);
}
</style>
