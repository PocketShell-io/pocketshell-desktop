<script setup lang="ts">
/**
 * RemoteImagePicker: choose an image that already lives on the host, so it can
 * be annotated without a round trip through the local filesystem.
 *
 * This deliberately does NOT reuse FileTree or the files store. That store is
 * a singleton backing the Files tab: driving it from a modal would move the
 * user's open directory and open document out from under them, and its
 * `clear()` on unmount would wipe the tab's state when this closed. The
 * listing call underneath (`api.sftp.list`) is the same one the store uses, so
 * nothing is duplicated except a few lines of navigation.
 *
 * It also filters where FileTree does not: everything here ends up as pixels
 * on a canvas, so a file the browser cannot decode is not a choice, it is a
 * dead end that only reports itself after the read.
 */
import { computed, onMounted, ref } from 'vue';
import { api } from '../ipc';
import AppIcon from '@ui/components/AppIcon.vue';
import type { DirEntry } from '../../main/sftp/SftpService';

const props = defineProps<{
  connectionId: string;
  /** Directory to open first — normally the session's working directory. */
  startPath?: string | null;
}>();

const emit = defineEmits<{ pick: [{ path: string; name: string }]; close: [] }>();

/**
 * Extensions a browser can decode into an <img>. SVG is excluded on purpose:
 * it is a document that can carry script and external references, and the only
 * thing done with the result here is drawImage, which would rasterise it
 * anyway. BMP and TIFF are absent because Chromium does not decode them.
 */
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'ico'];

const cwd = ref('.');
const entries = ref<DirEntry[]>([]);
const loading = ref(false);
const error = ref<string | null>(null);

function isImage(entry: DirEntry): boolean {
  if (entry.type === 'dir') return false;
  const dot = entry.name.lastIndexOf('.');
  if (dot < 0) return false;
  return IMAGE_EXTENSIONS.includes(entry.name.slice(dot + 1).toLowerCase());
}

/** Directories first, then images; both alphabetical. Nothing else is listed. */
const visible = computed(() => {
  const dirs = entries.value.filter((e) => e.type === 'dir');
  const images = entries.value.filter(isImage);
  const byName = (a: DirEntry, b: DirEntry): number => a.name.localeCompare(b.name);
  return [...dirs.sort(byName), ...images.sort(byName)];
});

const crumbs = computed(() => {
  const parts = cwd.value.split('/').filter(Boolean);
  const out: { name: string; path: string }[] = [{ name: '/', path: '/' }];
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    out.push({ name: part, path: acc });
  }
  return out;
});

const atRoot = computed(() => cwd.value === '/');

async function load(path: string): Promise<void> {
  loading.value = true;
  error.value = null;
  try {
    // realPath first so `.`, `~` and any symlink on the way resolve once, here,
    // rather than leaving a relative path in the breadcrumb that later joins
    // wrongly.
    const resolved = await api.sftp.realPath(props.connectionId, path);
    entries.value = await api.sftp.list(props.connectionId, resolved);
    cwd.value = resolved;
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not list that directory.';
    entries.value = [];
  } finally {
    loading.value = false;
  }
}

function childOf(name: string): string {
  return cwd.value === '/' ? `/${name}` : `${cwd.value}/${name}`;
}

async function onEntry(entry: DirEntry): Promise<void> {
  if (entry.type === 'dir') {
    await load(childOf(entry.name));
    return;
  }
  emit('pick', { path: childOf(entry.name), name: entry.name });
}

async function up(): Promise<void> {
  if (atRoot.value) return;
  const parent = cwd.value.slice(0, cwd.value.lastIndexOf('/'));
  await load(parent === '' ? '/' : parent);
}

/** Bytes, rounded the way the port panel rounds them: no false precision. */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

onMounted(() => void load(props.startPath || '.'));
</script>

<template>
  <div class="picker">
    <div class="bar">
      <button class="icon-btn" :disabled="atRoot || loading" title="Up one level" @click="up">
        <AppIcon name="arrow-up" :size="14" />
      </button>
      <nav class="crumbs" aria-label="Path">
        <button
          v-for="crumb in crumbs"
          :key="crumb.path"
          class="crumb"
          :disabled="loading"
          @click="load(crumb.path)"
        >
          {{ crumb.name }}
        </button>
      </nav>
      <button class="icon-btn" :disabled="loading" title="Refresh" @click="load(cwd)">
        <AppIcon name="refresh" :size="14" />
      </button>
    </div>

    <div class="list" role="listbox" aria-label="Images on the host">
      <p v-if="error" class="note error">{{ error }}</p>
      <p v-else-if="loading" class="note">Listing…</p>
      <p v-else-if="visible.length === 0" class="note">No folders or images here.</p>
      <!-- v-for lives on a <template> under the v-else rather than on the row
           itself: v-if and v-for on one element is ambiguous about which runs
           first, and eslint-plugin-vue rejects it. -->
      <template v-else>
        <button
          v-for="entry in visible"
          :key="entry.name"
          class="row"
          role="option"
          @click="onEntry(entry)"
        >
          <AppIcon :name="entry.type === 'dir' ? 'folder' : 'image'" :size="14" />
          <span class="name">{{ entry.name }}</span>
          <span v-if="entry.type !== 'dir'" class="size">{{ humanSize(entry.size) }}</span>
        </button>
      </template>
    </div>

    <footer class="actions">
      <button class="btn" @click="emit('close')">Cancel</button>
    </footer>
  </div>
</template>

<style scoped>
.picker {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  min-width: 0;
}

.bar {
  display: flex;
  align-items: center;
  gap: var(--sp-1);
  min-width: 0;
}
.crumbs {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: 1 1 auto;
  min-width: 0;
  overflow-x: auto;
  white-space: nowrap;
}
.crumb {
  padding: 0 var(--sp-1);
  height: var(--control-h-sm);
  background: transparent;
  border: none;
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  font-family: var(--font-mono);
  font-size: var(--fs-100);
  cursor: pointer;
}
.crumb:hover:not(:disabled) {
  background: var(--state-hover);
  color: var(--fg);
}
/* The trailing crumb is where you are, not somewhere to go. */
.crumb:last-child {
  color: var(--fg);
}

.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--control-h-sm);
  height: var(--control-h-sm);
  flex: 0 0 auto;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--r-sm);
  color: var(--fg-secondary);
  cursor: pointer;
}
.icon-btn:hover:not(:disabled) {
  background: var(--state-hover);
  color: var(--fg);
}
.icon-btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: default;
}

.list {
  display: flex;
  flex-direction: column;
  min-height: 220px;
  max-height: 44vh;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
}
.row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  height: var(--row-h);
  padding: 0 var(--row-pad-x);
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border-soft);
  color: var(--fg);
  text-align: left;
  cursor: pointer;
}
.row:last-child {
  border-bottom: none;
}
.row:hover {
  background: var(--state-hover);
}
.row:focus-visible {
  outline: var(--focus-ring-width) solid var(--focus-ring);
  outline-offset: calc(var(--focus-ring-offset) * -1);
}
.name {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: var(--fs-300);
}
.size {
  flex: 0 0 auto;
  font-size: var(--fs-100);
  color: var(--fg-secondary);
  font-variant-numeric: tabular-nums;
}

.note {
  margin: 0;
  padding: var(--sp-3);
  font-size: var(--fs-200);
  color: var(--fg-secondary);
}
.note.error {
  color: var(--error);
}

.actions {
  display: flex;
  justify-content: flex-end;
}
.btn {
  height: var(--control-h);
  padding: 0 var(--sp-3);
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  color: var(--fg);
  font-size: var(--fs-200);
  cursor: pointer;
}
.btn:hover {
  background: var(--state-hover);
}
</style>
