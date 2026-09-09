/**
 * Composer delivery: send routing and the bracketed-paste framing.
 *
 * WHY THE FRAMING LIVES HERE AND IS NOT OPTIONAL
 * ----------------------------------------------
 * The Android client talks to tmux through a `tmux -CC` control-mode client,
 * so `sendInputBytesToPane` (TmuxSessionViewModel.kt:9758-9800, :9860-9870)
 * gets to wrap multi-line input in bracketed-paste markers before the submit
 * key. This app writes into a PLAIN PTY running `tmux attach`, so nothing does
 * that for us — the renderer must do it itself.
 *
 * It matters because `appendAttachmentPaths` ALWAYS introduces newlines when
 * attachments are staged. Without the framing an agent
 * REPL treats every line of the `Attached files:` block as a separate prompt —
 * a bug that actually shipped on the phone (found in daily use 2026-05-27).
 *
 * Programs that do not enable bracketed paste render the markers literally.
 * The Kotlin accepts that degradation explicitly (:9793-9795); so do we.
 *
 * 
 */

/** `ESC [ 2 0 0 ~` — "a paste starts here". */
export const BP_START = '\x1b[200~';
/** `ESC [ 2 0 1 ~` — "the paste ends here". */
export const BP_END = '\x1b[201~';

/**
 * The submit key, sent SEPARATELY and AFTER the paste block — never inside it
 * (Android `sendAgentPayloadToPaneResult`, :8777-8780).
 */
export const SUBMIT_KEY = '\r';

/**
 * Tunables, grouped so tests can shorten them without fake timers.
 *
 * `submitDelayMs`: issue #526. The Android default is 150ms
 * (SettingsModels.kt:271) with a 250ms floor for Codex
 * (TmuxSessionViewModel.kt:12135). We take the safe end of that range for every
 * send rather than only the Codex one: 250ms is imperceptible to a human and
 * Enter must never race the TUI's ingestion of the paste.
 *
 * `sendTimeoutMs`: SEND_TIMEOUT_MS (PromptComposerViewModel.kt:2535).
 * `uploadTimeoutMs`: ATTACHMENT_UPLOAD_TIMEOUT_MS (:2521).
 */
export const composerTiming = {
  submitDelayMs: 250,
  sendTimeoutMs: 12_000,
  uploadTimeoutMs: 90_000,
};

/** True when the payload must be bracketed — i.e. it contains a line break. */
export function needsBracketedPaste(payload: string): boolean {
  return payload.includes('\n') || payload.includes('\r');
}

/**
 * The exact body written to the PTY before the submit key: bracketed when the
 * payload is multi-line, verbatim otherwise.
 */
export function frameForPaste(payload: string): string {
  return needsBracketedPaste(payload) ? BP_START + payload + BP_END : payload;
}

export interface DeliverOptions {
  /** Writes bytes to the PTY. Resolves false when the write did not land. */
  write: (data: string) => Promise<boolean>;
  /** Overrides `composerTiming.submitDelayMs`. */
  submitDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Write one composed prompt to a PTY: framed body, pause, submit key.
 *
 * Returns false without pressing Enter when the body write failed, so a dead
 * channel can never leave a half-typed prompt sitting in the pane.
 */
export async function deliverPayload(payload: string, opts: DeliverOptions): Promise<boolean> {
  const delay = opts.submitDelayMs ?? composerTiming.submitDelayMs;
  const sleep = opts.sleep ?? defaultSleep;
  const wrote = await opts.write(frameForPaste(payload));
  if (!wrote) return false;
  if (delay > 0) await sleep(delay);
  return opts.write(SUBMIT_KEY);
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Agent engines the composer can route to. Mirrors Android's `AgentKind`. */
export type ComposerAgentKind = 'claude' | 'codex' | 'opencode' | 'grok';

/**
 * Narrow a host-recorded `SessionAgentKind` (types.ts:103) to the engines the
 * composer can actually route to and offer commands for.
 *
 * `shell` and `unknown` are the phone's "not an agent" — a shell pane must never
 * get a slash dropdown. `probing` / `exited` are transient detector states with
 * no engine to talk to yet, so they map to null too: the catalog must never
 * offer a command we cannot name an engine for.
 */
export function composerAgentKind(
  kind: 'claude' | 'codex' | 'opencode' | 'grok' | 'shell' | 'probing' | 'exited' | 'unknown' | null | undefined,
): ComposerAgentKind | null {
  switch (kind) {
    case 'claude':
    case 'codex':
    case 'opencode':
    case 'grok':
      return kind;
    default:
      return null;
  }
}

/**
 * Android: `TmuxComposerSendRoute` (TmuxSessionScreen.kt:3159).
 *
 * The phone's third arm, `'agent-conversation'`, is GONE rather than merely
 * unreachable. It existed for the Conversation tab, which has been deleted
 *, and it never did anything the `'raw'` arm did not:
 * both wrote to the pane's PTY, because there was no live transcript to echo
 * an optimistic turn into. What it DID do, unhelpfully, was short-circuit
 * ahead of the codex arm below — so a codex pane viewed from the Conversation
 * tab got the SHORT submit delay and could drop its Enter. Removing the arm
 * fixes that as a side effect.
 */
export type ComposerSendRoute = 'agent-payload' | 'raw';

export interface SendRouteInput {
  /** The engine currently running in the pane, when detection knows. */
  liveAgent: ComposerAgentKind | null;
  /** The engine we believe the pane runs, from history rather than detection. */
  presumedAgent: ComposerAgentKind | null;
  /** Always true inside the composer — there is exactly one Send verb. */
  withEnter: boolean;
}

/**
 * Android: the `when` block at `TmuxSessionScreen.kt:3163-3179`, ported shape
 * for shape.
 *
 * `liveAgent` is fed from the host-recorded `@ps_agent_kind` tmux option via
 * `composerAgentKind`, so the Codex arm is live. `presumedAgent` has no desktop
 * source yet — nothing infers an engine from history.
 */
export function sendRoute(input: SendRouteInput): ComposerSendRoute {
  if (input.withEnter && input.liveAgent === 'codex') return 'agent-payload';
  if (input.liveAgent !== null) return 'raw';
  if (input.presumedAgent !== null) return 'agent-payload';
  return 'raw';
}

/** Resolve a promise to `null` if it has not settled within `ms`. */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
