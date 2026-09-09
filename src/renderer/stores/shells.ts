import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { ShellId } from '../../shared/types';

/**
 * Shell registry: which live PTY belongs to which session.
 *
 * WHY THIS EXISTS
 * ---------------
 * `shellId` used to be a module-local `let` inside TerminalView.vue — never
 * returned, never exposed — so nothing outside that component could write to
 * the pane. The prompt composer has to, and so will
 * any future surface that pushes text at a session.
 *
 * WHY A REGISTRY AND NOT FULL SHELL OWNERSHIP
 * -------------------------------------------
 * The spec offers two fixes: `defineExpose({ shellId })`, or moving shell
 * ownership into a store. This takes the store, because the composer, the
 * terminal and the workspace all need to address the same shell and a template
 * ref only solves it for whoever holds the ref. But it deliberately stops at a
 * REGISTRY: TerminalView still opens, re-opens and closes its own PTY.
 *
 * Moving `open`/`close` out of the component would mean re-sequencing the code
 * that binds xterm's `onData`/`onResize` — and that sequencing is exactly what
 * the just-landed listener-leak fix pins (handlers bound once per terminal
 * lifetime, reading `shellId` from the closure; the e2e regression test in
 * tests/e2e/session-nav.spec.ts asserts no duplicated `0;276;0c` device-attribute
 * replies after repeated session switches). A registry gets the composer what
 * it needs while leaving that code path untouched.
 *
 * The map is keyed by the same session key TerminalView takes as a prop, and is
 * reactive, because TerminalView re-points its pane whenever that key changes
 * — a consumer that captured the id once would end up writing to a
 * closed channel.
 *
 * WHAT A CLIENT PER SESSION TAB CHANGES
 * -------------------------------------
 * Nothing in this file, but a great deal in how to read it — and the change is
 * a relaxation, which is worth saying because the previous note here described
 * the opposite.
 *
 * Main briefly held ONE attached tmux client per connection and moved it
 * between sessions with `switch-client`. Under that design several session keys
 * could name the same ShellId over time, and writing to that shell put bytes
 * into whichever session the client was displaying RIGHT NOW — not the session
 * whose key you looked the id up under. This map therefore had to carry a
 * stricter invariant than it looks like it carries: at most one key registered
 * against a shared shell at a time, maintained by TerminalView unregistering
 * the outgoing key BEFORE asking main for the new one.
 *
 * Main now keeps a client per session tab and holds it for the life of the tab
 * (src/main/ssh/TmuxClientPool.ts), so a ShellId is bound to ONE session for as
 * long as it exists. The map means exactly what it appears to mean again: a key
 * is a session, its value is that session's own PTY, and several keys may be
 * registered at once because several tabs really are live at once. A composer
 * that resolves a shell for its session cannot be handed a stranger's pane,
 * because there is no operation left that repoints a shell at another session.
 *
 * An entry can still go stale — the pool evicts the least recently used client
 * when a connection runs out of SSH channels, which closes that PTY — so a
 * consumer must still tolerate a write failing, and `shell:input` still fences
 * on the session name. What it no longer has to tolerate is a write SUCCEEDING
 * against the wrong session.
 *
 * A registry is still the right shape. Ownership of the PTY was already split
 * between the component and main; what lives on the main side is the decision
 * of whether a new PTY is needed at all, which belongs where the host is
 * visible.
 */
export const useShellsStore = defineStore('shells', () => {
  /** sessionKey -> the ShellId currently attached to it. */
  const byKey = ref<Record<string, ShellId>>({});

  function register(key: string, shellId: ShellId): void {
    if (!key) return;
    byKey.value = { ...byKey.value, [key]: shellId };
  }

  /** Drop a key's shell. A no-op when `shellId` is no longer the current one. */
  function unregister(key: string, shellId?: ShellId): void {
    if (!key) return;
    const current = byKey.value[key];
    if (current === undefined) return;
    if (shellId !== undefined && current !== shellId) return;
    const next = { ...byKey.value };
    delete next[key];
    byKey.value = next;
  }

  function shellIdFor(key: string): ShellId | null {
    return byKey.value[key] ?? null;
  }

  function clear(): void {
    byKey.value = {};
  }

  return { byKey, register, unregister, shellIdFor, clear };
});
