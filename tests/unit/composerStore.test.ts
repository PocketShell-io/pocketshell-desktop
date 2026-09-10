import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { StageAttachmentsResult } from '../../src/shared/types';

/**
 * The composer's behaviour tests — the desktop equivalents of the Android
 * instrumented suites the spec cites (PromptComposerSendDismissE2eTest,
 * PromptComposerDiscardE2eTest, ComposerPartialExpandE2eTest), driven through
 * the store rather than a rendered tree because the rules being pinned are
 * state rules, not layout ones. 
 */

const stage = vi.fn<(payload: unknown) => Promise<StageAttachmentsResult>>();
const pickFiles = vi.fn<(payload: unknown) => Promise<string[]>>();

vi.mock('../../src/renderer/ipc', () => ({
  api: {
    attachments: {
      stage: (payload: unknown) => stage(payload),
      pickFiles: (payload: unknown) => pickFiles(payload),
    },
  },
}));

const { useComposerStore, COMPOSER_HISTORY_LIMIT } = await import('../../src/renderer/stores/composer');
const { sessionIdentityKey } = await import('../../src/renderer/sessionIdentity');
const { defaultGeometry } = await import('../../src/shared/composerGeometry');
const { COMPOSER_STRINGS } = await import('../../src/shared/composerText');
const { composerTiming } = await import('../../src/shared/composerSend');

const A = '~/.pocketshell/attachments/main/shot.png';
const B = '~/.pocketshell/attachments/main/log.txt';
const KEY = 'conn-1/main';
const OTHER = 'conn-1/build';

const CONN = 'conn-1' as never;

function okResult(paths: string[]): StageAttachmentsResult {
  return { ok: true, paths, failedCount: 0 };
}

type Store = ReturnType<typeof useComposerStore>;

let composer: Store;

beforeEach(() => {
  setActivePinia(createPinia());
  composer = useComposerStore();
  stage.mockReset();
  pickFiles.mockReset();
});

afterEach(() => {
  composerTiming.sendTimeoutMs = 12_000;
});

async function attach(key: string, paths: string[], result?: StageAttachmentsResult): Promise<void> {
  stage.mockResolvedValueOnce(result ?? okResult(paths));
  await composer.stage(key, {
    connectionId: CONN,
    scopeKey: 'main',
    sources: paths.map(() => ({ kind: 'file', path: 'local' })),
  });
}

describe('draft lifecycle', () => {
  it('mirrors every edit and clears the error on any keystroke (:299)', () => {
    composer.restoreFailedSend(KEY, 'old payload');
    expect(composer.states[KEY]?.error).toBe(COMPOSER_STRINGS.notSent);
    composer.setDraft(KEY, 'typing again');
    expect(composer.states[KEY]?.error).toBeNull();
    expect(composer.states[KEY]?.draft).toBe('typing again');
  });

  it('keeps a per-session draft — switching away and back restores it', () => {
    composer.setDraft(KEY, 'draft for main');
    composer.setDraft(OTHER, 'draft for build');
    // The Android owner-stamp would have DISCARDED the first one here.
    expect(composer.states[KEY]?.draft).toBe('draft for main');
    expect(composer.states[OTHER]?.draft).toBe('draft for build');
  });

  it('moves all session records when reconnect replaces the connection id', () => {
    composer.setDraft(KEY, 'half-written prompt');
    composer.recordSent(OTHER, 'previous prompt');

    composer.rekeyConnection('conn-1', 'conn-2');

    expect(composer.states[KEY]).toBeUndefined();
    expect(composer.states[OTHER]).toBeUndefined();
    expect(composer.states['conn-2/main']?.draft).toBe('half-written prompt');
    expect(composer.states['conn-2/build']?.history).toEqual(['previous prompt']);
  });

  it('a session that was never touched has an empty draft', () => {
    composer.setDraft(KEY, 'only in main');
    expect(composer.ensure(OTHER).draft).toBe('');
  });

  it('prefillCommand replaces a leading slash token (:508)', () => {
    composer.setDraft(KEY, '/cle and some args');
    composer.prefillCommand(KEY, '/clear');
    expect(composer.states[KEY]?.draft).toBe('/clear and some args');
  });

  it('seedPrompt appends on its own line (:482)', () => {
    composer.setDraft(KEY, 'context');
    composer.seedPrompt(KEY, 'review ~/a.ts');
    expect(composer.states[KEY]?.draft).toBe('context\nreview ~/a.ts');
  });
});

describe('attachments', () => {
  it('stages paths as tiles WITHOUT touching the draft (:301-309)', async () => {
    composer.setDraft(KEY, 'typed first');
    await attach(KEY, [A]);
    expect(composer.states[KEY]?.draft).toBe('typed first');
    expect(composer.states[KEY]?.attachments.map((a) => a.remotePath)).toEqual([A]);
    expect(composer.states[KEY]?.attachments[0]?.displayName).toBe('shot.png');
  });

  it('attach-then-type leaves the draft empty right after attaching', async () => {
    await attach(KEY, [A]);
    expect(composer.states[KEY]?.draft).toBe('');
    composer.setDraft(KEY, 'now some text');
    expect(composer.states[KEY]?.attachments).toHaveLength(1);
    expect(composer.states[KEY]?.draft).toBe('now some text');
  });

  it('KEEPS the survivors of a partial failure and shows the error (#570)', async () => {
    await attach(KEY, [A], { ok: false, paths: [A], failedCount: 1, error: 'huge.bin too large' });
    expect(composer.states[KEY]?.attachments.map((a) => a.remotePath)).toEqual([A]);
    expect(composer.states[KEY]?.error).toBe(
      COMPOSER_STRINGS.attachmentFailed('huge.bin too large'),
    );
  });

  it('reports an error and stages nothing when nothing landed', async () => {
    stage.mockResolvedValueOnce({ ok: false, paths: [], failedCount: 2, error: 'connection lost' });
    await composer.stage(KEY, {
      connectionId: CONN,
      scopeKey: 'main',
      sources: [
        { kind: 'file', path: 'a' },
        { kind: 'file', path: 'b' },
      ],
    });
    expect(composer.states[KEY]?.attachments).toEqual([]);
    expect(composer.states[KEY]?.error).toContain('connection lost');
  });

  it('de-duplicates by remote path (:409-412)', async () => {
    await attach(KEY, [A, B]);
    await attach(KEY, [B]);
    expect(composer.states[KEY]?.attachments.map((a) => a.remotePath)).toEqual([A, B]);
  });

  it('is single-flight: a second batch while one is uploading is a no-op (:315)', async () => {
    let release!: (r: StageAttachmentsResult) => void;
    stage.mockReturnValueOnce(
      new Promise<StageAttachmentsResult>((resolve) => {
        release = resolve;
      }),
    );
    const first = composer.stage(KEY, {
      connectionId: CONN,
      scopeKey: 'main',
      sources: [{ kind: 'file', path: 'a' }],
    });
    expect(composer.states[KEY]?.uploadingCount).toBe(1);
    await composer.stage(KEY, {
      connectionId: CONN,
      scopeKey: 'main',
      sources: [{ kind: 'file', path: 'b' }],
    });
    expect(stage).toHaveBeenCalledTimes(1);
    release(okResult([A]));
    await first;
    expect(composer.states[KEY]?.uploadingCount).toBe(0);
  });

  it('WAITS for an upload in flight, then sends the prompt WITH the image', async () => {
    // The user's report, in their words: "If I'm uploading an image and hit
    // enter, I wait till image is uploaded and then send the prompt" — and, on
    // being told the old rule cited the phone for abandoning the batch: "that's
    // not how the phone app works. it waits".
    //
    // What the old rule did was drop the in-flight batch and send what was
    // already staged, so a prompt written ABOUT an image went out without it,
    // to an agent that answered anyway having never seen the picture.
    let release!: (r: StageAttachmentsResult) => void;
    stage.mockReturnValueOnce(
      new Promise<StageAttachmentsResult>((resolve) => {
        release = resolve;
      }),
    );
    composer.setDraft(KEY, 'what is wrong in this screenshot?');
    const staging = composer.stage(KEY, {
      connectionId: CONN,
      scopeKey: 'main',
      sources: [{ kind: 'file', path: 'shot.png' }],
    });
    expect(composer.states[KEY]?.uploadingCount).toBe(1);

    // Enter, mid-upload. Nothing may be delivered yet.
    //
    // Typed argument list, not `vi.fn(async () => true)`: an inferred zero-arg
    // spy makes `mock.calls` a tuple of length 0, and the assertions below are
    // entirely about WHAT was delivered.
    const deliver = vi.fn(async (_payload: string) => true);
    const sending = composer.send(KEY, deliver);
    await Promise.resolve();
    expect(deliver).not.toHaveBeenCalled();
    // And the composer must not look idle while it waits, or a click-outside
    // could dismiss a prompt that is parked on its own upload.
    expect(composer.states[KEY]?.sendInFlight).toBe(true);

    release(okResult([A]));
    await staging;
    expect(await sending).toBe(true);

    // ONE delivery, carrying the path that landed while the send waited.
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0]![0]).toContain(A);
    expect(deliver.mock.calls[0]![0]).toContain('what is wrong in this screenshot?');
  });

  it('does NOT send when the upload it waited for failed', async () => {
    // The prompt was written about the attachment, so delivering it without one
    // is the failure this whole rule exists to remove. The draft and the banner
    // stay, which is what every other refusal in this store leaves behind.
    let release!: (r: StageAttachmentsResult) => void;
    stage.mockReturnValueOnce(
      new Promise<StageAttachmentsResult>((resolve) => {
        release = resolve;
      }),
    );
    composer.setDraft(KEY, 'look at this');
    const staging = composer.stage(KEY, {
      connectionId: CONN,
      scopeKey: 'main',
      sources: [{ kind: 'file', path: 'shot.png' }],
    });

    const deliver = vi.fn(async () => true);
    const sending = composer.send(KEY, deliver);
    release({ ok: false, paths: [], failedCount: 1, error: 'connection lost' });
    await staging;

    expect(await sending).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
    expect(composer.states[KEY]?.draft).toBe('look at this');
    expect(composer.states[KEY]?.error).toContain('connection lost');
    // The wait must not leave the flag stuck on, or the composer is bricked:
    // every later send would return at the single-flight guard.
    expect(composer.states[KEY]?.sendInFlight).toBe(false);
  });

  it('takes one send while waiting, not two', async () => {
    // Enter pressed twice during a slow upload. The second must be the ordinary
    // single-flight no-op rather than a second prompt queued behind the same
    // picture.
    let release!: (r: StageAttachmentsResult) => void;
    stage.mockReturnValueOnce(
      new Promise<StageAttachmentsResult>((resolve) => {
        release = resolve;
      }),
    );
    composer.setDraft(KEY, 'twice');
    const staging = composer.stage(KEY, {
      connectionId: CONN,
      scopeKey: 'main',
      sources: [{ kind: 'file', path: 'shot.png' }],
    });

    const deliver = vi.fn(async () => true);
    const first = composer.send(KEY, deliver);
    await Promise.resolve();
    const second = await composer.send(KEY, deliver);
    expect(second).toBe(false);

    release(okResult([A]));
    await staging;
    expect(await first).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('still sends immediately when nothing is uploading', async () => {
    // The wait is only for a batch in flight. A prompt with no upload behind it
    // must not pay a tick for the feature.
    composer.setDraft(KEY, 'plain');
    const deliver = vi.fn(async () => true);
    expect(await composer.send(KEY, deliver)).toBe(true);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('removing a tile never touches the draft (:520-527)', async () => {
    composer.setDraft(KEY, 'keep me');
    await attach(KEY, [A, B]);
    composer.removeAttachment(KEY, A);
    expect(composer.states[KEY]?.attachments.map((a) => a.remotePath)).toEqual([B]);
    expect(composer.states[KEY]?.draft).toBe('keep me');
  });

  it('seedAttachment attaches an already-uploaded path once (:443)', () => {
    composer.seedAttachment(KEY, A);
    composer.seedAttachment(KEY, A);
    expect(composer.states[KEY]?.attachments).toHaveLength(1);
  });
});

describe('send', () => {
  it('composes text + attachment paths at SEND time', async () => {
    composer.setDraft(KEY, 'what is wrong here');
    await attach(KEY, [A, B]);
    const seen: string[] = [];
    await composer.send(KEY, async (p) => {
      seen.push(p);
      return true;
    });
    expect(seen).toEqual([`what is wrong here\n\nAttached files:\n- ${A}\n- ${B}`]);
  });

  it('allows an attachment-only send', async () => {
    await attach(KEY, [A]);
    const seen: string[] = [];
    await composer.send(KEY, async (p) => {
      seen.push(p);
      return true;
    });
    expect(seen).toEqual([`Attached files:\n- ${A}`]);
  });

  it('does NOT clear the draft or the tiles while in flight (#745)', async () => {
    composer.setDraft(KEY, 'hello');
    await attach(KEY, [A]);
    let release!: (v: boolean) => void;
    const pending = composer.send(
      KEY,
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    expect(composer.states[KEY]?.sendInFlight).toBe(true);
    expect(composer.states[KEY]?.draft).toBe('hello');
    expect(composer.states[KEY]?.attachments).toHaveLength(1);
    release(true);
    await pending;
  });

  it('clears the draft and the tiles on delivery, and STAYS OPEN', async () => {
    composer.setDraft(KEY, 'hello');
    await attach(KEY, [A]);
    await composer.send(KEY, async () => true);
    expect(composer.states[KEY]?.draft).toBe('');
    expect(composer.states[KEY]?.attachments).toEqual([]);
    expect(composer.states[KEY]?.error).toBeNull();
    // The phone dismisses the sheet here; the desktop deliberately does not.
    expect(composer.mode).toBe('docked');
  });

  it('restores the COMPOSED payload and drops the tiles on failure (:768-770)', async () => {
    composer.setDraft(KEY, 'typed text');
    await attach(KEY, [A]);
    await composer.send(KEY, async () => false);
    const s = composer.states[KEY]!;
    expect(s.draft).toBe(`typed text\n\nAttached files:\n- ${A}`);
    expect(s.draft).toContain(A);
    expect(s.attachments).toEqual([]);
    expect(s.error).toBe(COMPOSER_STRINGS.notSent);
    expect(s.sendInFlight).toBe(false);
  });

  it('a resend after a failure still carries the path and does not double it', async () => {
    composer.setDraft(KEY, 'typed text');
    await attach(KEY, [A]);
    await composer.send(KEY, async () => false);
    const seen: string[] = [];
    await composer.send(KEY, async (p) => {
      seen.push(p);
      return true;
    });
    expect(seen[0]).toContain(A);
    expect(seen[0]!.match(/Attached files:/g)).toHaveLength(1);
    expect(seen[0]!.match(/- ~\/\.pocketshell/g)).toHaveLength(1);
  });

  it('treats a timeout exactly like a failure', async () => {
    composerTiming.sendTimeoutMs = 10;
    composer.setDraft(KEY, 'slow one');
    const ok = await composer.send(KEY, () => new Promise<boolean>(() => {}));
    expect(ok).toBe(false);
    expect(composer.states[KEY]?.error).toBe(COMPOSER_STRINGS.notSent);
    expect(composer.states[KEY]?.draft).toBe('slow one');
  });

  it('is a no-op when the composed payload is empty (:672)', async () => {
    composer.setDraft(KEY, '   ');
    const deliver = vi.fn(async () => true);
    expect(await composer.send(KEY, deliver)).toBe(false);
    expect(deliver).not.toHaveBeenCalled();
  });

  it('is a no-op while a send is already in flight (:662)', async () => {
    composer.setDraft(KEY, 'hello');
    let release!: (v: boolean) => void;
    const first = composer.send(
      KEY,
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    const second = vi.fn(async () => true);
    expect(await composer.send(KEY, second)).toBe(false);
    expect(second).not.toHaveBeenCalled();
    release(true);
    await first;
  });

  it('canSend mirrors the button predicate (PromptComposerSheet.kt:1202)', async () => {
    expect(composer.canSend(KEY)).toBe(false);
    composer.setDraft(KEY, 'x');
    expect(composer.canSend(KEY)).toBe(true);
    composer.setDraft(KEY, '');
    expect(composer.canSend(KEY)).toBe(false);
    await attach(KEY, [A]);
    expect(composer.canSend(KEY)).toBe(true);
  });
});

describe('discard (PromptComposerDiscardE2eTest.kt:160-226)', () => {
  it('clears draft, tiles and banner, and leaves the composer OPEN', async () => {
    composer.setDraft(KEY, 'typed text');
    await attach(KEY, [A]);
    await composer.send(KEY, async () => false);
    expect(composer.states[KEY]?.error).not.toBeNull();

    composer.discard(KEY);
    const s = composer.states[KEY]!;
    expect(s.draft).toBe('');
    expect(s.attachments).toEqual([]);
    expect(s.error).toBeNull();
    expect(composer.mode).not.toBe('hidden');
  });

  it('does not touch any other session', () => {
    composer.setDraft(KEY, 'mine');
    composer.setDraft(OTHER, 'theirs');
    composer.discard(KEY);
    expect(composer.states[OTHER]?.draft).toBe('theirs');
  });
});

describe('dismissError (the banner ×)', () => {
  /**
   * The reported trap: Discard used to BE the banner's button, and a user who
   * read it as "remove the failed attachment" lost the whole draft. The × is
   * the scoped replacement — an attachment failure leaves nothing behind to
   * clean up (a refused file never staged), so dismissal may only ever clear
   * the message.
   */
  it('clears the error and keeps the draft and tiles', async () => {
    composer.setDraft(KEY, 'dictated prompt');
    await attach(KEY, [A]);
    stage.mockResolvedValueOnce({ ok: false, paths: [], failedCount: 1, error: 'too big' });
    await composer.stage(KEY, {
      connectionId: CONN,
      scopeKey: 'main',
      sources: [{ kind: 'file', path: 'oversize.bin' }],
    });
    expect(composer.states[KEY]?.error).not.toBeNull();

    composer.dismissError(KEY);

    const s = composer.states[KEY]!;
    expect(s.error).toBeNull();
    expect(s.draft).toBe('dictated prompt');
    expect(s.attachments).toEqual([expect.objectContaining({ remotePath: A })]);
  });

  it('leaves a failed send recoverable — draft and notSent banner intact', () => {
    composer.restoreFailedSend(KEY, 'the payload');
    composer.dismissError(KEY);
    expect(composer.states[KEY]?.draft).toBe('the payload');
  });

  it('is safe on a session with no error', () => {
    composer.setDraft(KEY, 'untouched');
    expect(() => composer.dismissError(KEY)).not.toThrow();
    expect(composer.states[KEY]?.draft).toBe('untouched');
  });
});

describe('visibility state machine', () => {
  it('defaults to docked', () => {
    expect(composer.mode).toBe('docked');
  });

  it('grows hidden -> docked -> expanded and stops there', () => {
    composer.setMode('hidden');
    composer.grow();
    expect(composer.mode).toBe('docked');
    composer.grow();
    expect(composer.mode).toBe('expanded');
    composer.grow();
    expect(composer.mode).toBe('expanded');
  });

  it('shrinks expanded -> docked -> hidden and stops there', () => {
    composer.setMode('expanded');
    composer.shrink();
    expect(composer.mode).toBe('docked');
    composer.shrink();
    expect(composer.mode).toBe('hidden');
    composer.shrink();
    expect(composer.mode).toBe('hidden');
  });

  it('toggleHidden restores the last non-hidden mode, not always docked', () => {
    composer.setMode('expanded');
    composer.toggleHidden();
    expect(composer.mode).toBe('hidden');
    composer.toggleHidden();
    expect(composer.mode).toBe('expanded');
  });

  it('never destroys the draft across any transition', () => {
    composer.setDraft(KEY, 'survivor');
    for (const m of ['hidden', 'docked', 'expanded', 'hidden'] as const) {
      composer.setMode(m);
      expect(composer.states[KEY]?.draft).toBe('survivor');
    }
  });

  /**
   * The reported bug: close the panel, open another session, and it is back.
   * Open/closed is a preference about the tool, so it does not live in the
   * per-session record that a never-visited session starts blank.
   */
  it('stays closed when the user switches to another session', () => {
    composer.setDraft(KEY, 'draft for main');
    composer.setMode('hidden');

    composer.ensure(OTHER); // selecting a session the composer has never seen
    expect(composer.mode).toBe('hidden');

    // ...and the per-session halves are still per session.
    expect(composer.states[OTHER]?.draft).toBe('');
    expect(composer.states[KEY]?.draft).toBe('draft for main');
  });

  it('re-opens into the mode it was closed from, whichever session is current', () => {
    composer.setMode('expanded');
    composer.setMode('hidden');
    composer.ensure(OTHER);
    composer.toggleHidden();
    expect(composer.mode).toBe('expanded');
  });


  /**
   * The card's box is a preference about the tool, exactly like open/closed:
   * where the composer sits describes the window layout, not any conversation.
   * A per-session position would make the card jump as you switch sessions,
   * which is the bug this file already pins for the mode.
   */
  it('shares one card geometry across sessions', () => {
    composer.setGeometry({ right: 120, bottom: 40, width: 640, height: 300 });
    composer.ensure(OTHER);
    expect(composer.geometry).toEqual({ right: 120, bottom: 40, width: 640, height: 300 });
  });

  it('starts in the resting corner at the default size', () => {
    expect(composer.geometry).toEqual(defaultGeometry());
  });

  it('resetGeometry puts a card the user has lost back in its corner', () => {
    composer.setGeometry({ right: 900, bottom: 400, width: 380, height: 200 });
    composer.resetGeometry();
    expect(composer.geometry).toEqual(defaultGeometry());
  });

  it('keeps the geometry across every mode transition', () => {
    const g = { right: 60, bottom: 80, width: 500, height: 260 };
    composer.setGeometry(g);
    for (const m of ['hidden', 'docked', 'expanded', 'docked'] as const) {
      composer.setMode(m);
      expect(composer.geometry).toEqual(g);
    }
  });

  it('a delivered send re-opens a hidden composer rather than leaving it hidden', async () => {
    composer.setDraft(KEY, 'hi');
    composer.setMode('hidden');
    await composer.send(KEY, async () => true);
    expect(composer.mode).toBe('docked');
  });
});

describe('connection degradation is advisory', () => {
  it('does not gate send', async () => {
    composer.setConnectionDegraded(KEY, true);
    composer.setDraft(KEY, 'send me anyway');
    expect(composer.canSend(KEY)).toBe(true);
    expect(await composer.send(KEY, async () => true)).toBe(true);
  });
});

/**
 * `closeComposerOnSend`: the phone's rhythm — send, the
 * card gets out of the way, the next keystroke brings it back.
 */
describe('close on send', () => {
  it('closes the composer after a confirmed delivery', async () => {
    composer.setDraft(KEY, 'ship it');
    await composer.send(KEY, async () => true, { closeOnDelivery: true });
    expect(composer.mode).toBe('hidden');
  });

  it('leaves it OPEN when the send failed, where the banner and draft are', async () => {
    composer.setDraft(KEY, 'ship it');
    await composer.send(KEY, async () => false, { closeOnDelivery: true });
    expect(composer.mode).not.toBe('hidden');
    expect(composer.states[KEY]?.error).toBe(COMPOSER_STRINGS.notSent);
    expect(composer.states[KEY]?.draft).toBe('ship it');
  });

  it('leaves it open when a send times out, which is a failure like any other', async () => {
    composerTiming.sendTimeoutMs = 10;
    composer.setDraft(KEY, 'slow one');
    await composer.send(KEY, () => new Promise<boolean>(() => {}), { closeOnDelivery: true });
    expect(composer.mode).not.toBe('hidden');
  });

  it('keeps the composer open on delivery when the setting is off', async () => {
    composer.setDraft(KEY, 'ship it');
    await composer.send(KEY, async () => true);
    expect(composer.mode).toBe('docked');
  });

  it('remembers docked-vs-maximized across a close-on-send round trip', async () => {
    composer.setMode('expanded');
    composer.setDraft(KEY, 'ship it');
    await composer.send(KEY, async () => true, { closeOnDelivery: true });
    expect(composer.mode).toBe('hidden');
    composer.toggleHidden();
    expect(composer.mode).toBe('expanded');
  });

  it('still clears the draft and the tiles on the way out', async () => {
    composer.setDraft(KEY, 'ship it');
    await attach(KEY, [A]);
    await composer.send(KEY, async () => true, { closeOnDelivery: true });
    expect(composer.states[KEY]?.draft).toBe('');
    expect(composer.states[KEY]?.attachments).toEqual([]);
  });

  it('a partially-staged batch does not turn a delivery into a failure', async () => {
    // #570 partial failure happens at STAGE time: the survivors are attached
    // and an error is shown. If the user sends anyway, the send either lands or
    // it does not — the earlier attachment error has no say in whether the
    // panel closes.
    await attach(KEY, [A], { ok: false, paths: [A], failedCount: 1, error: 'huge.bin too large' });
    expect(composer.states[KEY]?.error).not.toBeNull();
    await composer.send(KEY, async () => true, { closeOnDelivery: true });
    expect(composer.mode).toBe('hidden');
    expect(composer.states[KEY]?.error).toBeNull();
  });
});

/**
 * Closing the composer does NOT decide what the next keystroke does
 *.
 *
 * The user reported the old behaviour as a bug — "I start typing, prompt
 * composer opens, I click esc, continue typing and now the input goes to the
 * terminal" — and it was the design working as written: `dismiss()` suppressed
 * the typing intercept, so Escape carried a second, durable instruction beyond
 * "put the panel away".
 *
 * Every closing route now behaves the same, and typing brings the panel back
 * from all of them. Nothing else suppresses the intercept either: the
 * plain-terminal hatch that later lived on a press in the terminal went the
 * same way, reported as "when I start typing it stopped showing the prompt
 * composer" — with the hatch armed, which is any click into the terminal, the
 * composer simply never came.
 */
describe('closing, and what the next keystroke does', () => {
  it('a dismissal does NOT speak for the next keystroke — this is the reported bug', () => {
    composer.dismiss();
    // The regression. Escape closes; it does not also decide what typing does,
    // so continuing to type re-opens the composer carrying the character,
    // exactly as it does from any other closed state. The intercept's own
    // gating (the setting, mode === 'hidden') is FolderWorkspaceView's
    // `interceptTyping`, and there is no third condition left in the store.
    expect(composer.mode).toBe('hidden');
  });

  it('a delivered send closes the same way, so typing brings it back', async () => {
    composer.setDraft(KEY, 'ship it');
    await composer.send(KEY, async () => true, { closeOnDelivery: true });
    expect(composer.mode).toBe('hidden');
  });

  it('the two close paths agree, and are still two paths', async () => {
    // They produce the same state, which is the point — and they stay distinct
    // actions, which is the point of NOT collapsing them into one call.
    // `dismiss` records the mode to come back to; the send path goes through
    // `setMode` and does not.
    composer.setMode('expanded');
    composer.dismiss();

    composer.setMode('expanded');
    composer.setDraft(KEY, 'ship it');
    await composer.send(KEY, async () => true, { closeOnDelivery: true });

    expect(composer.mode).toBe('hidden');
    expect(composer.lastOpenMode).toBe('expanded');
  });

  it('the toggle and the size ladder close the same way Escape does', () => {
    // A user who dismisses three different ways must not get three different
    // results. All of these route through `dismiss`.
    composer.toggleHidden();
    expect(composer.mode).toBe('hidden');

    composer.setMode('expanded');
    composer.shrink();
    expect(composer.mode).toBe('docked');
    composer.shrink();
    expect(composer.mode).toBe('hidden');
  });

  it('a dismissal still remembers docked-vs-maximized for the next summons', () => {
    composer.setMode('expanded');
    composer.dismiss();
    composer.toggleHidden();
    expect(composer.mode).toBe('expanded');
  });

  it('never destroys the draft', () => {
    composer.setDraft(KEY, 'survivor');
    composer.dismiss();
    expect(composer.states[KEY]?.draft).toBe('survivor');
  });
});

/**
 * `forget` — the kill's counterpart to a rename's `rekey`
 *
 *
 * A rename moves a record to the name its session now has; a kill leaves a
 * record no session will ever claim again. They must not be the same call, and
 * neither of them is `discard`, which is the user throwing away a draft in a
 * session that still exists.
 */
describe('forget', () => {
  it('removes the record entirely, not just its contents', () => {
    composer.setDraft(KEY, 'half a prompt');
    composer.forget(KEY);
    // `discard` would leave a blank record behind. That is right when the
    // session is still there and the composer has to go on rendering it, and
    // wrong here: the entry would persist to localStorage forever.
    expect(composer.states[KEY]).toBeUndefined();
  });

  it('leaves every other session alone', () => {
    composer.setDraft(KEY, 'mine');
    composer.setDraft(OTHER, 'theirs');
    composer.forget(KEY);
    expect(composer.states[OTHER]?.draft).toBe('theirs');
  });

  it('does not hand a killed session’s draft to the next one of that name', () => {
    // Not hypothetical: `sessions create` derives the name from the folder, so
    // a folder's session comes back under the same name routinely.
    composer.setDraft(KEY, 'from the dead session');
    composer.forget(KEY);
    expect(composer.ensure(KEY).draft).toBe('');
  });

  it('is a no-op for a key that was never touched', () => {
    expect(() => composer.forget('conn-1/never-existed')).not.toThrow();
    expect(composer.states['conn-1/never-existed']).toBeUndefined();
  });
});

/**
 * Sent-prompt history and the arrow-key walk through it. The user's report: prompts go into a tmux pane that may not be the one
 * on screen, so a prompt that has already scrolled away can only be repeated
 * from memory. A shell answers that with `history` and the up arrow; these
 * tests pin the store half of the same answer, per session.
 */
describe('sent-prompt history', () => {
  it('records a CONFIRMED delivery, with the attachment paths already folded in', async () => {
    composer.setDraft(KEY, 'run the tests');
    await attach(KEY, [A]);
    await composer.send(KEY, async () => true);
    expect(composer.states[KEY]?.history).toEqual([`run the tests\n\nAttached files:\n- ${A}`]);
  });

  it('does not record a send that failed or timed out', async () => {
    composer.setDraft(KEY, 'never landed');
    await composer.send(KEY, async () => false);
    composer.setDraft(KEY, 'took too long');
    composerTiming.sendTimeoutMs = 10;
    await composer.send(KEY, () => new Promise<boolean>(() => {}));
    expect(composer.states[KEY]?.history).toEqual([]);
  });

  it('skips a consecutive duplicate, but an older prompt resent rises to the top', async () => {
    composer.setDraft(KEY, 'first');
    await composer.send(KEY, async () => true);
    composer.setDraft(KEY, 'second');
    await composer.send(KEY, async () => true);
    // Resending the newest entry is the feature working, not a second fact.
    composer.setDraft(KEY, 'second');
    await composer.send(KEY, async () => true);
    expect(composer.states[KEY]?.history).toEqual(['first', 'second']);
    // Resending an OLD entry erases the stale copy and puts the prompt on top,
    // so the arrow walk never steps over the same text twice.
    composer.setDraft(KEY, 'first');
    await composer.send(KEY, async () => true);
    expect(composer.states[KEY]?.history).toEqual(['second', 'first']);
  });

  it('is per session', async () => {
    composer.setDraft(KEY, 'for main');
    await composer.send(KEY, async () => true);
    composer.setDraft(OTHER, 'for build');
    await composer.send(OTHER, async () => true);
    expect(composer.states[KEY]?.history).toEqual(['for main']);
    expect(composer.states[OTHER]?.history).toEqual(['for build']);
  });

  it('caps the list, oldest falling off first', async () => {
    for (let i = 0; i < COMPOSER_HISTORY_LIMIT + 10; i += 1) {
      composer.recordSent(KEY, `prompt ${i}`);
    }
    const history = composer.states[KEY]?.history ?? [];
    expect(history).toHaveLength(COMPOSER_HISTORY_LIMIT);
    expect(history[0]).toBe(`prompt 10`);
    expect(history.at(-1)).toBe(`prompt ${COMPOSER_HISTORY_LIMIT + 9}`);
  });

  it('a rename carries the history; a kill drops it', async () => {
    composer.recordSent(KEY, 'mine');
    composer.rekey(KEY, OTHER);
    expect(composer.states[OTHER]?.history).toEqual(['mine']);
    composer.forget(OTHER);
    expect(composer.ensure(OTHER).history).toEqual([]);
  });
});

describe('history recall', () => {
  it('is a no-op with nothing sent yet', () => {
    composer.setDraft(KEY, 'typed');
    expect(composer.recallOlder(KEY)).toBeNull();
    expect(composer.recallNewer(KEY)).toBeNull();
    expect(composer.states[KEY]?.draft).toBe('typed');
  });

  it('↑ recalls the newest payload and stashes the live draft underneath', async () => {
    composer.recordSent(KEY, 'last thing sent');
    composer.setDraft(KEY, 'half-typed');
    expect(composer.recallOlder(KEY)).toBe('last thing sent');
    expect(composer.states[KEY]?.draft).toBe('last thing sent');
    expect(composer.states[KEY]?.caret).toBe('last thing sent'.length);
  });

  it('repeated ↑ walks older entries', () => {
    composer.recordSent(KEY, 'older');
    composer.recordSent(KEY, 'newer');
    expect(composer.recallOlder(KEY)).toBe('newer');
    expect(composer.recallOlder(KEY)).toBe('older');
    expect(composer.states[KEY]?.draft).toBe('older');
  });

  it('↑ at the oldest entry does nothing, so the keystroke stays with the textarea', () => {
    composer.recordSent(KEY, 'only');
    expect(composer.recallOlder(KEY)).toBe('only');
    expect(composer.recallOlder(KEY)).toBeNull();
    expect(composer.states[KEY]?.draft).toBe('only');
  });

  it('↓ mid-stack steps newer; ↓ past the newest hands the stashed draft back', () => {
    composer.recordSent(KEY, 'older');
    composer.recordSent(KEY, 'newer');
    composer.setDraft(KEY, 'half-typed');

    expect(composer.recallOlder(KEY)).toBe('newer');
    expect(composer.recallOlder(KEY)).toBe('older');
    // One ↓ reaches the newest entry…
    expect(composer.recallNewer(KEY)).toBe('newer');
    // …and one more ends the browse with the draft the walk started from.
    expect(composer.recallNewer(KEY)).toBe('half-typed');
    expect(composer.states[KEY]?.draft).toBe('half-typed');
    // Not browsing any more: ↓ is an ordinary arrow again.
    expect(composer.recallNewer(KEY)).toBeNull();
  });

  it('editing during a browse ends it, so ↓ no longer replaces the text', () => {
    composer.recordSent(KEY, 'sent once');
    composer.recallOlder(KEY);
    composer.setDraft(KEY, 'sent once but edited');
    expect(composer.recallNewer(KEY)).toBeNull();
    expect(composer.states[KEY]?.draft).toBe('sent once but edited');
  });

  it('a delivered send ends the browse', async () => {
    composer.recordSent(KEY, 'sent once');
    // Browse back to it — an Enter here resends it — and let it deliver.
    composer.recallOlder(KEY);
    await composer.send(KEY, async () => true);
    expect(composer.states[KEY]?.draft).toBe('');
    // The browse is over: ↓ must not reach for a stashed draft that no longer
    // describes anything.
    expect(composer.recallNewer(KEY)).toBeNull();
  });

  it('discard and a failed send both end the browse', async () => {
    composer.recordSent(KEY, 'sent once');
    composer.recallOlder(KEY);
    composer.discard(KEY);
    expect(composer.recallNewer(KEY)).toBeNull();

    composer.setDraft(KEY, 'try again');
    await composer.send(KEY, async () => false);
    expect(composer.recallNewer(KEY)).toBeNull();
    expect(composer.states[KEY]?.draft).toBe('try again');
  });

  it('a recalled payload can be sent again, and does not double on the stack', async () => {
    composer.recordSent(KEY, 'newer still');
    composer.recordSent(KEY, 'repeat me');
    composer.recallOlder(KEY); // -> the newest, 'repeat me'
    const seen: string[] = [];
    await composer.send(KEY, async (p) => {
      seen.push(p);
      return true;
    });
    expect(seen).toEqual(['repeat me']);
    // Resending the top entry changes nothing — one entry per prompt.
    expect(composer.states[KEY]?.history).toEqual(['newer still', 'repeat me']);
    // …and the next ↑ recalls exactly what was just sent.
    expect(composer.recallOlder(KEY)).toBe('repeat me');
  });
});

describe('flushToTerminal — a short draft goes back to the shell on a close', () => {
  it('hands the draft to the write, clears it, and stands the intercept down', () => {
    composer.setDraft(KEY, 'ls');
    const written: string[] = [];
    expect(composer.flushToTerminal(KEY, (text) => written.push(text))).toBe(true);
    expect(written).toEqual(['ls']);
    expect(composer.states[KEY]?.draft).toBe('');
    expect(composer.terminalOwnsTyping).toBe(true);
  });

  it('keeps the draft when there is nowhere to put it', () => {
    composer.setDraft(KEY, 'ls');
    expect(composer.flushToTerminal(KEY, null)).toBe(false);
    expect(composer.states[KEY]?.draft).toBe('ls');
    expect(composer.terminalOwnsTyping).toBe(false);
  });

  it('keeps a prompt-sized draft — a dismissal never moves real work', () => {
    composer.setDraft(KEY, 'explain this build failure');
    const written: string[] = [];
    expect(composer.flushToTerminal(KEY, (text) => written.push(text))).toBe(false);
    expect(written).toEqual([]);
    expect(composer.states[KEY]?.draft).toBe('explain this build failure');
  });

  it('summoning the composer again re-arms the intercept', () => {
    composer.setDraft(KEY, 'ls');
    composer.flushToTerminal(KEY, () => {});
    expect(composer.terminalOwnsTyping).toBe(true);
    composer.setMode('docked');
    expect(composer.terminalOwnsTyping).toBe(false);
  });
});

describe('targetKey identity', () => {
  it('keys tmux rows by bare name, exactly as before', () => {
    expect(composer.targetKey('conn-1', 'main')).toBe('conn-1/main');
  });

  it('keys aplexer rows by their workspace-qualified identity', () => {
    const identity = sessionIdentityKey('review', {
      backend: 'aplexer',
      workspace: '/home/alexey/git/a',
    });
    composer.setDraft(composer.targetKey('conn-1', 'review', identity), 'draft for A');
    const other = sessionIdentityKey('review', {
      backend: 'aplexer',
      workspace: '/home/alexey/git/b',
    });
    // Same tag, other folder: a different record, untouched draft.
    expect(composer.targetKey('conn-1', 'review', other)).not.toBe(
      composer.targetKey('conn-1', 'review', identity),
    );
    expect(composer.states[composer.targetKey('conn-1', 'review', other)]?.draft ?? '').toBe('');
    expect(
      composer.states[composer.targetKey('conn-1', 'review', identity)]?.draft,
    ).toBe('draft for A');
  });
});
