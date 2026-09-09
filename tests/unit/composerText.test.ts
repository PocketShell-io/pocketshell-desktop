import { describe, expect, it } from 'vitest';
import {
  appendAttachmentPaths,
  appendSeededPrompt,
  attachmentDisplayName,
  canFlushDraftToTerminal,
  insertAtCaret,
  insertCommandText,
  isTypingKey,
  railToggle,
  slashQueryFor,
} from '../../src/shared/composerText';
import { commandsFor, filteredCommands, insertionTextFor } from '../../src/shared/agentCommands';
import { composerAgentKind } from '../../src/shared/composerSend';

/**
 * Ports of the Android client's own contracts for the composer's pure logic.
 * The case lists come from the Android tests (which in turn came from
 * PromptComposerViewModelTest / SlashCommandAutocompleteTest).
 */

describe('appendAttachmentPaths — the composition rule (PromptComposerViewModel.kt:2645)', () => {
  const A = '~/.pocketshell/attachments/main/20260824-101500-01-shot.png';
  const B = '~/.pocketshell/attachments/main/20260824-101500-02-log.txt';

  it('returns the draft untouched when there are no paths', () => {
    expect(appendAttachmentPaths('hello', [])).toBe('hello');
    expect(appendAttachmentPaths('', [])).toBe('');
  });

  it('REPLACES an empty draft, so an attachment-only send is legal', () => {
    expect(appendAttachmentPaths('', [A])).toBe(`Attached files:\n- ${A}`);
  });

  it('replaces a whitespace-only draft too (Kotlin isBlank(), not isEmpty())', () => {
    expect(appendAttachmentPaths('   \n\t ', [A])).toBe(`Attached files:\n- ${A}`);
  });

  it('separates a normal draft by exactly one blank line', () => {
    expect(appendAttachmentPaths('what is wrong here', [A])).toBe(
      `what is wrong here\n\nAttached files:\n- ${A}`,
    );
  });

  it('adds only the missing newline when the draft already ends in one', () => {
    expect(appendAttachmentPaths('line\n', [A])).toBe(`line\n\nAttached files:\n- ${A}`);
  });

  it('adds nothing when the draft already ends in a blank line', () => {
    expect(appendAttachmentPaths('line\n\n', [A])).toBe(`line\n\nAttached files:\n- ${A}`);
  });

  it('appends at the END, one bullet per path, in order', () => {
    expect(appendAttachmentPaths('why?', [A, B])).toBe(
      `why?\n\nAttached files:\n- ${A}\n- ${B}`,
    );
  });

  it('never prepends — the user text always comes first', () => {
    const out = appendAttachmentPaths('user text', [A]);
    expect(out.indexOf('user text')).toBeLessThan(out.indexOf('Attached files:'));
  });
});

describe('slashQueryFor (SlashCommandAutocomplete.kt:47)', () => {
  it('opens on a bare slash with an empty query (full catalog)', () => {
    expect(slashQueryFor('/', 1)).toBe('');
  });

  it('returns the token after the slash', () => {
    expect(slashQueryFor('/comp', 5)).toBe('comp');
  });

  it('closes once the caret moves past the leading token', () => {
    expect(slashQueryFor('/comp arg', 9)).toBeNull();
  });

  it('stays open while the caret is still inside the token', () => {
    expect(slashQueryFor('/comp arg', 5)).toBe('comp');
    expect(slashQueryFor('/comp arg', 0)).toBe('comp');
  });

  it('is closed when the text does not start with a slash', () => {
    expect(slashQueryFor('hello /comp', 11)).toBeNull();
    expect(slashQueryFor('', 0)).toBeNull();
  });

  it('treats any whitespace as the token terminator', () => {
    expect(slashQueryFor('/comp\nmore', 5)).toBe('comp');
    expect(slashQueryFor('/comp\nmore', 7)).toBeNull();
  });
});

describe('insertCommandText (SlashCommandAutocomplete.kt:94)', () => {
  it('replaces an existing leading token and preserves the trailing text', () => {
    expect(insertCommandText('/cle rest of it', '/clear')).toEqual(['/clear rest of it', 6]);
  });

  it('prepends when there is no leading slash token', () => {
    expect(insertCommandText('hello', '/clear')).toEqual(['/clearhello', 6]);
  });

  it('replaces the whole text when the token is the whole text', () => {
    expect(insertCommandText('/comp', '/compact ')).toEqual(['/compact ', 9]);
  });

  it('puts the caret at the end of the inserted command', () => {
    const [, caret] = insertCommandText('/x', '/rewind');
    expect(caret).toBe('/rewind'.length);
  });
});

describe('attachmentDisplayName (PromptComposerViewModel.kt:2675)', () => {
  it('shows the last path segment, never the full remote path', () => {
    expect(attachmentDisplayName('~/.pocketshell/attachments/main/shot.png')).toBe('shot.png');
  });

  it('tolerates trailing slashes and degenerate input', () => {
    expect(attachmentDisplayName('~/a/b/')).toBe('b');
    expect(attachmentDisplayName('shot.png')).toBe('shot.png');
    expect(attachmentDisplayName('/')).toBe('/');
  });
});

describe('appendSeededPrompt (PromptComposerViewModel.kt:482)', () => {
  it('replaces a blank draft', () => {
    expect(appendSeededPrompt('  ', 'review this')).toBe('review this');
  });

  it('adds a newline separator only when one is missing', () => {
    expect(appendSeededPrompt('hi', 'review this')).toBe('hi\nreview this');
    expect(appendSeededPrompt('hi\n', 'review this')).toBe('hi\nreview this');
  });
});

describe('agent command catalog (AgentCommandCatalog.kt)', () => {
  it('offers nothing when no agent is detected — a shell pane has no commands', () => {
    expect(filteredCommands(null, '')).toEqual([]);
    expect(filteredCommands(null, 'comp')).toEqual([]);
  });

  it('returns the full catalog for a blank query', () => {
    expect(filteredCommands('claude', '')).toEqual(commandsFor('claude'));
    expect(commandsFor('claude').length).toBeGreaterThan(0);
  });

  it('filters by substring over command, label and description', () => {
    const hits = filteredCommands('claude', 'comp').map((c) => c.command);
    expect(hits).toContain('/compact');
    expect(hits).not.toContain('/clear');
  });

  it('omits commands an engine does not have (OpenCode has no /goal)', () => {
    expect(commandsFor('opencode').map((c) => c.command)).not.toContain('/goal');
    expect(commandsFor('claude').map((c) => c.command)).toContain('/goal');
  });

  it('adds one trailing space only for argument-taking commands', () => {
    const compact = commandsFor('claude').find((c) => c.command === '/compact');
    const clear = commandsFor('claude').find((c) => c.command === '/clear');
    expect(insertionTextFor(compact!)).toBe('/compact ');
    expect(insertionTextFor(clear!)).toBe('/clear');
  });

  /**
   * Grok is the engine everything else in this repo has to hedge about — it
   * cannot be launched by the pinned helper and no `--help` has been captured
   * for it — so it is the one most likely to be quietly left as a stub. It is
   * a real `SessionAgentKind` and `composerAgentKind` passes it straight
   * through, which means a grok pane reaches the dropdown like any other and
   * must not arrive to a near-empty list.
   */
  describe('grok', () => {
    it('offers a catalog comparable to the ported engines, not a stub', () => {
      const grok = commandsFor('grok');
      expect(grok.length).toBeGreaterThanOrEqual(commandsFor('opencode').length);
    });

    it('is reachable from a host-recorded kind, so the dropdown really opens', () => {
      expect(composerAgentKind('grok')).toBe('grok');
      expect(filteredCommands(composerAgentKind('grok'), '')).toEqual(commandsFor('grok'));
    });

    it('carries the conversation basics the composer is built around', () => {
      const commands = commandsFor('grok').map((c) => c.command);
      expect(commands).toContain('/new');
      expect(commands).toContain('/compact');
      expect(commands).toContain('/clear');
    });

    it('omits /goal rather than stubbing it, the way OpenCode does', () => {
      expect(commandsFor('grok').map((c) => c.command)).not.toContain('/goal');
    });

    it('takes a compaction argument, so accepting it leaves room to type one', () => {
      const compact = commandsFor('grok').find((c) => c.command === '/compact');
      expect(insertionTextFor(compact!)).toBe('/compact ');
    });

    it('is searchable by description, not only by command token', () => {
      expect(filteredCommands('grok', 'model').map((c) => c.command)).toContain('/models');
    });
  });

  /**
   * Structural rules that hold for EVERY engine. A duplicate row is the defect
   * these catch in practice: two entries for one command give the dropdown two
   * identical-looking rows and make the highlight index ambiguous.
   */
  describe('every engine', () => {
    const engines = ['claude', 'codex', 'opencode', 'grok'] as const;

    it('offers a non-empty list', () => {
      for (const engine of engines) expect(commandsFor(engine).length).toBeGreaterThan(0);
    });

    it('lists each command exactly once', () => {
      for (const engine of engines) {
        const commands = commandsFor(engine).map((c) => c.command);
        expect(new Set(commands).size).toBe(commands.length);
      }
    });

    it('writes every command with its leading slash and no whitespace', () => {
      for (const engine of engines) {
        for (const c of commandsFor(engine)) {
          expect(c.command).toMatch(/^\/[a-z][a-z-]*$/);
          expect(c.label).not.toBe('');
          expect(c.description).not.toBe('');
        }
      }
    });

    it('starts with a way to begin a fresh conversation', () => {
      for (const engine of engines) {
        const first = commandsFor(engine)[0]!;
        expect(first.destructive).toBe(true);
        expect(['/new', '/clear']).toContain(first.command);
      }
    });
  });
});

describe('railToggle — one control, two states', () => {
  it('points DOWN when the panel is open, because that is where it goes', () => {
    expect(railToggle(true).icon).toBe('chevron-down');
  });

  it('points UP when the panel is closed, because that is where it comes from', () => {
    expect(railToggle(false).icon).toBe('chevron-up');
  });

  it('names the action it will perform, not the state it is in', () => {
    expect(railToggle(true).label).toBe('Hide the prompt panel');
    expect(railToggle(false).label).toBe('Open the prompt panel');
  });

  it('advertises the same keyboard chord in both states', () => {
    expect(railToggle(true).title).toContain('Ctrl+`');
    expect(railToggle(false).title).toContain('Ctrl+`');
  });

  it('is a true alternation: flipping twice returns the original', () => {
    let open = false;
    const first = railToggle(open);
    open = !open;
    expect(railToggle(open)).not.toEqual(first);
    open = !open;
    expect(railToggle(open)).toEqual(first);
  });

  it('says a draft is waiting when the panel is closed over one', () => {
    const waiting = railToggle(false, true);
    expect(waiting.unsent).toBe(true);
    expect(waiting.title).toContain('unsent draft');
    expect(waiting.label).toContain('unsent draft');
  });

  it('stays quiet when the closed panel holds nothing', () => {
    expect(railToggle(false, false).unsent).toBe(false);
    expect(railToggle(false).title).not.toContain('unsent');
  });

  it('never claims unsent work while the panel is OPEN, where the draft shows', () => {
    expect(railToggle(true, true).unsent).toBe(false);
    expect(railToggle(true, true).title).not.toContain('unsent');
  });
});

/**
 * The typing intercept's whole contract. Everything this rejects reaches the
 * shell untouched, so the false cases matter more than the true ones.
 */
describe('isTypingKey — what opens the composer, and what must not', () => {
  const press = (key: string, mods: Partial<Record<string, boolean>> = {}) =>
    isTypingKey({ key, ...mods });

  it('accepts letters, digits and punctuation', () => {
    for (const k of ['a', 'Z', '7', '/', '-', '?', 'é', '\u4f60']) {
      expect(press(k)).toBe(true);
    }
  });

  it('accepts Shift, because Shift-A is a capital letter', () => {
    expect(press('A', { shiftKey: true })).toBe(true);
  });

  it('never steals a control chord — Ctrl-C must reach the shell', () => {
    for (const k of ['c', 'd', 'z', 'r', 'l', 'a', 'b']) {
      expect(press(k, { ctrlKey: true })).toBe(false);
      expect(press(k, { metaKey: true })).toBe(false);
      expect(press(k, { altKey: true })).toBe(false);
    }
  });

  it('never steals a named key', () => {
    for (const k of [
      'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown',
      'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'F5',
      'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Insert',
    ]) {
      expect(press(k)).toBe(false);
    }
  });

  it('leaves a bare space to the pager it pages', () => {
    // Only the TRIGGER: once the composer is open, the draft has focus and a
    // space is an ordinary character again.
    expect(press(' ')).toBe(false);
  });

  it('leaves an in-flight IME composition where it already is', () => {
    expect(press('a', { isComposing: true })).toBe(false);
  });
});

describe('insertAtCaret — the keystroke that opened the composer is not lost', () => {
  it('plants the character at the caret', () => {
    expect(insertAtCaret('hello world', 5, 'X')).toEqual(['helloX world', 6]);
  });

  it('starts a draft from empty', () => {
    expect(insertAtCaret('', 0, 'h')).toEqual(['h', 1]);
  });

  it('continues a remembered draft where the caret was left', () => {
    expect(insertAtCaret('fix the ', 8, 'p')).toEqual(['fix the p', 9]);
  });

  it('survives a caret past the end of the text', () => {
    expect(insertAtCaret('abc', 99, 'd')).toEqual(['abcd', 4]);
  });

  it('survives a negative caret', () => {
    expect(insertAtCaret('abc', -5, 'z')).toEqual(['zabc', 1]);
  });
});

describe('canFlushDraftToTerminal — a short draft goes back to the shell', () => {
  const flushable = (draft: string, extra: Partial<Parameters<typeof canFlushDraftToTerminal>[0]> = {}) =>
    canFlushDraftToTerminal({
      draft,
      attachments: 0,
      error: null,
      sendInFlight: false,
      uploadingCount: 0,
      ...extra,
    });

  it('hands a two-character command back', () => {
    expect(flushable('ls')).toBe(true);
  });

  it('hands a four-character draft back — "less than 5 characters"', () => {
    expect(flushable('htop')).toBe(true);
  });

  it('keeps a five-character draft — the rule itself', () => {
    expect(flushable('hello')).toBe(false);
  });

  it('counts by code point, like isTypingKey', () => {
    expect(flushable('👍👍👍👍')).toBe(true);
    expect(flushable('👍👍👍👍👍')).toBe(false);
  });

  it('keeps nothing: an empty or whitespace-only draft is not handed over', () => {
    expect(flushable('')).toBe(false);
    expect(flushable('  ')).toBe(false);
  });

  it('refuses a line break, which would submit whatever precedes it', () => {
    expect(flushable('ls\n')).toBe(false);
    expect(flushable('a\nb')).toBe(false);
  });

  it('refuses when an attachment is staged — the pane needs the tile, not the text', () => {
    expect(flushable('ls', { attachments: 1 })).toBe(false);
  });

  it('refuses mid-send, mid-upload, and behind a failure banner', () => {
    expect(flushable('ls', { sendInFlight: true })).toBe(false);
    expect(flushable('ls', { uploadingCount: 2 })).toBe(false);
    expect(flushable('ls', { error: 'Not sent.' })).toBe(false);
  });
});
