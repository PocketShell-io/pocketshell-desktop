import { describe, expect, it } from 'vitest';
import {
  BP_END,
  BP_START,
  SUBMIT_KEY,
  deliverPayload,
  frameForPaste,
  needsBracketedPaste,
  composerAgentKind,
  sendRoute,
  withTimeout,
} from '../../src/shared/composerSend';
import { appendAttachmentPaths } from '../../src/shared/composerText';

/**
 * The bracketed-paste proof.
 *
 * The desktop writes into a plain PTY running `tmux attach` — there is no tmux
 * control-mode client to frame multi-line input for us the way there is on
 * Android. Because `appendAttachmentPaths` always introduces newlines when
 * attachments are staged, an unframed attachment send makes an agent REPL treat
 * every `- <path>` line as its own prompt. 
 */

/** Records every write in order, exactly as the PTY would receive them. */
function recorder(result = true): { writes: string[]; write: (d: string) => Promise<boolean> } {
  const writes: string[] = [];
  return {
    writes,
    write: async (d: string) => {
      writes.push(d);
      return result;
    },
  };
}

const noSleep = async (): Promise<void> => {};

describe('needsBracketedPaste', () => {
  it('is false for a single-line payload', () => {
    expect(needsBracketedPaste('hello world')).toBe(false);
  });

  it('is true for anything containing a line break', () => {
    expect(needsBracketedPaste('a\nb')).toBe(true);
    expect(needsBracketedPaste('a\rb')).toBe(true);
  });

  it('is ALWAYS true for a payload carrying an attachment block', () => {
    const payload = appendAttachmentPaths('look at this', ['~/.pocketshell/attachments/main/a.png']);
    expect(needsBracketedPaste(payload)).toBe(true);
  });
});

describe('frameForPaste', () => {
  it('leaves a single-line payload alone', () => {
    expect(frameForPaste('echo hi')).toBe('echo hi');
  });

  it('wraps a multi-line payload in ESC[200~ / ESC[201~', () => {
    expect(frameForPaste('a\nb')).toBe(`${BP_START}a\nb${BP_END}`);
    expect(frameForPaste('a\nb')).toBe('\x1b[200~a\nb\x1b[201~');
  });

  it('puts no submit key inside the block', () => {
    const framed = frameForPaste('a\nb');
    expect(framed.endsWith(BP_END)).toBe(true);
    expect(framed).not.toContain('\r');
  });
});

describe('deliverPayload — the wire sequence', () => {
  it('sends a framed body and THEN a separate carriage return', async () => {
    const r = recorder();
    const payload = appendAttachmentPaths('what is wrong here', [
      '~/.pocketshell/attachments/main/shot.png',
      '~/.pocketshell/attachments/main/log.txt',
    ]);

    const ok = await deliverPayload(payload, { write: r.write, submitDelayMs: 0, sleep: noSleep });

    expect(ok).toBe(true);
    expect(r.writes).toHaveLength(2);
    expect(r.writes[0]).toBe(
      '\x1b[200~what is wrong here\n\nAttached files:\n' +
        '- ~/.pocketshell/attachments/main/shot.png\n' +
        '- ~/.pocketshell/attachments/main/log.txt\x1b[201~',
    );
    expect(r.writes[1]).toBe(SUBMIT_KEY);
  });

  it('still sends Enter separately for a single-line payload', async () => {
    const r = recorder();
    await deliverPayload('hello', { write: r.write, submitDelayMs: 0, sleep: noSleep });
    expect(r.writes).toEqual(['hello', '\r']);
  });

  it('waits between the body and Enter so the TUI can ingest the paste', async () => {
    const r = recorder();
    const slept: number[] = [];
    await deliverPayload('a\nb', {
      write: r.write,
      submitDelayMs: 250,
      sleep: async (ms) => {
        // Enter must not have been written yet when the delay starts.
        expect(r.writes).toHaveLength(1);
        slept.push(ms);
      },
    });
    expect(slept).toEqual([250]);
    expect(r.writes).toHaveLength(2);
  });

  it('never presses Enter when the body write failed', async () => {
    const r = recorder(false);
    const ok = await deliverPayload('a\nb', { write: r.write, submitDelayMs: 0, sleep: noSleep });
    expect(ok).toBe(false);
    expect(r.writes).toEqual([`${BP_START}a\nb${BP_END}`]);
  });

  it('produces ONE submission for a multi-line prompt, not one per line', async () => {
    const r = recorder();
    await deliverPayload('line one\nline two\nline three', {
      write: r.write,
      submitDelayMs: 0,
      sleep: noSleep,
    });
    // Exactly one carriage return crosses the wire, and it is the last write.
    expect(r.writes.filter((w) => w.includes('\r'))).toEqual(['\r']);
    expect(r.writes.at(-1)).toBe('\r');
  });
});

describe('sendRoute (TmuxSessionScreen.kt:3163)', () => {
  const base = { liveAgent: null, presumedAgent: null, withEnter: true };

  // The `'agent-conversation'` arm is gone with the Conversation tab
  //. Its removal is observable in exactly one place —
  // a codex pane now reaches the codex arm instead of being short-circuited
  // past it, which is what gives it the longer submit delay it needs.
  it('routes Codex through the agent payload path', () => {
    expect(sendRoute({ ...base, liveAgent: 'codex' })).toBe('agent-payload');
  });

  it('routes any other live agent as raw bytes', () => {
    expect(sendRoute({ ...base, liveAgent: 'claude' })).toBe('raw');
  });

  it('routes a merely presumed agent through the agent payload path', () => {
    expect(sendRoute({ ...base, presumedAgent: 'claude' })).toBe('agent-payload');
  });

  it('falls back to raw when nothing is known — which is every desktop send today', () => {
    expect(sendRoute(base)).toBe('raw');
  });
});

describe('composerAgentKind', () => {
  it('passes the four real engines through', () => {
    expect(composerAgentKind('claude')).toBe('claude');
    expect(composerAgentKind('codex')).toBe('codex');
    expect(composerAgentKind('opencode')).toBe('opencode');
    expect(composerAgentKind('grok')).toBe('grok');
  });

  it('yields null for a shell, an unclassified pane, or no data at all', () => {
    expect(composerAgentKind('shell')).toBeNull();
    expect(composerAgentKind('unknown')).toBeNull();
    expect(composerAgentKind(null)).toBeNull();
    expect(composerAgentKind(undefined)).toBeNull();
  });

  it('yields null for the transient detector states — no engine to talk to yet', () => {
    expect(composerAgentKind('probing')).toBeNull();
    expect(composerAgentKind('exited')).toBeNull();
  });
});

describe('withTimeout', () => {
  it('passes a value through', async () => {
    await expect(withTimeout(Promise.resolve(7), 1000)).resolves.toBe(7);
  });

  it('resolves null when nothing settles in time', async () => {
    await expect(withTimeout(new Promise<number>(() => {}), 5)).resolves.toBeNull();
  });
});
