import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agentMark, usageProviderMark } from '../../src/shared/agentBadge';
import { agentBadges } from '@ui/app/sessionTreeText';
import { groupSessionsIntoRoots } from '@ui/app/sessionTree';
import type { SessionAgentKind, SessionSummary } from '@pocketshell/core';

/**
 * Which mark a session tab wears.
 *
 * Presentation only — the classification is the host's, written by the
 * `pocketshell agent` wrapper into `@ps_agent_kind`. What is worth pinning is
 * the half a later edit could quietly get wrong: WHICH kinds get a mark at all,
 * and that the marks the mapping names actually exist in the icon registry.
 */

describe('agentMark', () => {
  it('gives each of the four engines its own mark', () => {
    const kinds = ['claude', 'codex', 'opencode', 'grok'] as const;
    const icons = kinds.map((k) => agentMark(k)?.icon);
    expect(icons).toEqual(['brand-claude', 'brand-codex', 'brand-opencode', 'brand-grok']);
    // Distinct, which is the only property the marks actually have to have:
    // they are the vendors' own, and the tooltip is what names them in words.
    expect(new Set(icons).size).toBe(kinds.length);
  });

  it('names the agent, for the tooltip', () => {
    expect(agentMark('claude')?.label).toBe('Claude Code');
    expect(agentMark('grok')?.label).toBe('Grok');
  });

  it('badges GROK whether or not the host it came from could launch one', () => {
    // Whether this app can START a grok session is a per-host question
    // (`agentLaunch.ts` probes `pocketshell agent --help` for the subcommand,
    // which 0.4.44 does not have). Whether a session IS one is not: the phone
    // starts them through its own engine registry and the tmux option is on
    // the session either way. Badging must follow the record, or the same
    // session would look different depending on which machine listed it.
    expect(agentMark('grok')).not.toBeNull();
  });

  it('shows NOTHING for unknown, for a shell, or for no answer at all', () => {
    // The whole reason a sparse badge is worth having: its PRESENCE means
    // something. `unknown` is common and legitimate — any session started
    // outside the wrapper reads that way forever — and a plain shell is not a
    // failed detection.
    for (const kind of ['unknown', 'shell', 'probing', 'exited'] as const) {
      expect(agentMark(kind)).toBeNull();
    }
    expect(agentMark(null)).toBeNull();
    expect(agentMark(undefined)).toBeNull();
  });

  it('is exhaustive over SessionAgentKind', () => {
    // Every member of the shared enum is answered — with a mark or with null —
    // so a kind added host-side cannot fall through to an undefined lookup.
    const all: SessionAgentKind[] = [
      'claude',
      'codex',
      'opencode',
      'grok',
      'shell',
      'probing',
      'exited',
      'unknown',
    ];
    for (const kind of all) expect(agentMark(kind)).not.toBeUndefined();
  });

  it('names marks that AppIcon actually carries', () => {
    // The one seam this mapping has: it declares its own narrow union rather
    // than importing `AppIconName` out of a `.vue`, so nothing but the template
    // checks the two agree. Read the registry and check it here as well, since
    // the failure mode — an empty `<svg>` on the tab — is silent.
    const source = readFileSync(
      resolve(__dirname, '..', '..', '..', 'pocketshell-core', 'packages', 'ui', 'src', 'components', 'AppIcon.vue'),
      'utf8',
    );
    for (const kind of ['claude', 'codex', 'opencode', 'grok'] as const) {
      const icon = agentMark(kind)!.icon;
      expect(source).toMatch(new RegExp(`^\\s*'?${icon}'?:\\s*\\{`, 'm'));
    }
  });
});

/**
 * The mark a PROVIDER USAGE row wears — the same vendor register, read by the
 * helper's provider key instead of a session's agent kind. The overlap is
 * deliberate but not total: `go` is OpenCode (the helper's own gloss), while
 * copilot and zai are providers no session kind ever names, and an
 * unfamiliar provider wears nothing, the tab rule.
 */
describe('usageProviderMark', () => {
  it('maps every provider the helper reports today', () => {
    const providers = ['claude', 'codex', 'copilot', 'go', 'grok', 'zai'];
    const icons = providers.map((p) => usageProviderMark(p)?.icon);
    expect(icons).toEqual([
      'brand-claude',
      'brand-codex',
      'brand-copilot',
      'brand-opencode',
      'brand-grok',
      'brand-zai',
    ]);
    // Distinct — the shape is the only thing telling the rows apart.
    expect(new Set(icons).size).toBe(providers.length);
  });

  it('reads the provider key case-insensitively and spells the aliases', () => {
    expect(usageProviderMark('Claude')?.icon).toBe('brand-claude');
    expect(usageProviderMark('github_copilot')?.icon).toBe('brand-copilot');
    expect(usageProviderMark('open-code')?.icon).toBe('brand-opencode');
    expect(usageProviderMark('grok-build')?.icon).toBe('brand-grok');
  });

  it('shows NOTHING for a provider the register does not know', () => {
    // Same rule as the tabs: a mark whose only content is "we do not know"
    // is noise. The row still renders its (capitalised) name; only the mark
    // is absent.
    expect(usageProviderMark('new_vendor')).toBeNull();
    expect(usageProviderMark('')).toBeNull();
  });

  it('names marks that AppIcon actually carries', () => {
    // The same seam the tab mapping has, checked the same way: the registry
    // entry must exist or the row renders an empty `<svg>`.
    const source = readFileSync(
      resolve(__dirname, '..', '..', '..', 'pocketshell-core', 'packages', 'ui', 'src', 'components', 'AppIcon.vue'),
      'utf8',
    );
    for (const provider of ['claude', 'codex', 'copilot', 'go', 'grok', 'zai']) {
      const icon = usageProviderMark(provider)!.icon;
      expect(source).toMatch(new RegExp(`^\\s*'?${icon}'?:\\s*\\{`, 'm'));
    }
  });
});

/**
 * The badges a FOLDER row wears — one per session that runs a named agent, in
 * the folder's tab-bar order: the derived row order, with the user's dragged
 * arrangement (`applyTabOrder`'s stored ranking) applied on top, so the row
 * keeps reading as its tab bar folded flat after a drag. Each badge carries
 * its session's NAME beside the kind — the mark's silhouette already says the
 * product, so the row's mark tooltip wears the name instead. This replaced a
 * session count beside a deduped kind list: the user asked for the tabs'
 * notation outright, so the row reads as its tab bar folded flat. Built on
 * real trees from `groupSessionsIntoRoots` (folderSort.test.ts's reasoning)
 * because the thing being read is a real `SessionDirectory`.
 */
describe('agentBadges', () => {
  const HOME = '/home/alexey';

  function folder(sessions: SessionSummary[]) {
    const roots = groupSessionsIntoRoots(sessions, HOME);
    const dir = roots[0]?.directories[0];
    if (!dir) throw new Error('fixture grouped into no folder');
    return dir;
  }

  function session(name: string, agentKind?: SessionAgentKind): SessionSummary {
    return { name, created: 100, activity: 100, attached: false, path: `${HOME}/git/app`, agentKind };
  }

  it('wears one badge per session, duplicates kept, in row order', () => {
    // Three claudes and a codex are FOUR badges — the deduped list this
    // replaced could only have said `claude, codex`, and the count said the
    // rest in a second notation. Row order is tab order.
    const dir = folder([
      session('a', 'claude'),
      session('b', 'claude'),
      session('c', 'codex'),
      session('d', 'claude'),
    ]);
    expect(agentBadges(dir)).toEqual([
      { kind: 'claude', session: 'a' },
      { kind: 'claude', session: 'b' },
      { kind: 'codex', session: 'c' },
      { kind: 'claude', session: 'd' },
    ]);
  });

  it('names the session each badge stands for — the mark tooltip text', () => {
    // The mark's silhouette already says the product, so the row tooltip
    // spends its hover on what the eye cannot: which session of the folder's
    // run this mark is. The badge therefore carries the name beside the kind.
    const dir = folder([session('api', 'codex')]);
    expect(agentBadges(dir)).toEqual([{ kind: 'codex', session: 'api' }]);
  });

  it('leaves shells and unknowns out of the run', () => {
    // agentBadge's silence rule, applied per session: a shell wears no mark,
    // so the run can be shorter than the folder's session list.
    const dir = folder([
      session('a'),
      session('b', 'claude'),
      session('c', 'shell'),
      session('d', 'unknown'),
      session('e', 'codex'),
    ]);
    expect(agentBadges(dir)).toEqual([
      { kind: 'claude', session: 'b' },
      { kind: 'codex', session: 'e' },
    ]);
  });

  it('wears six marks — the tooltip name limit — once six sessions run agents', () => {
    // Six used to be where the run CAPPED, back when the row priced every
    // mark at the row gap's 20px; the stacked run (`.agent-run`) lies each
    // mark 4px deep on its neighbor and costs 8px, so six fit and the cap
    // rose to meet the tooltip — a folder's row stops disagreeing with its
    // own tab strip (dapier's six tabs wore four marks).
    const dir = folder([1, 2, 3, 4, 5, 6].map((n) => session(`s${n}`, 'claude')));
    expect(agentBadges(dir)).toEqual(
      [1, 2, 3, 4, 5, 6].map((n) => ({ kind: 'claude', session: `s${n}` })),
    );
  });

  it('still caps, so a dozen-agent folder cannot push the timestamp off the row', () => {
    const dir = folder([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => session(`s${n}`, 'claude')));
    expect(agentBadges(dir)).toHaveLength(6);
  });

  // The stored manual tab order. The run is the tab bar folded flat, and the
  // bar applies the user's dragged arrangement (`applyTabOrder`) — so the run
  // must apply the same ranking (`tabRank`'s contract), or a drag would leave
  // the row reading the old order while the bar reads the new one.
  describe('with the stored tab ranking', () => {
    const trio = () => folder([session('a', 'claude'), session('b', 'codex'), session('c', 'claude')]);

    it('follows the arrangement the tabs were dragged into, over the row order', () => {
      // Row order says claude, codex, claude; the bar says c, a, b — the run
      // must read the bar.
      expect(agentBadges(trio(), ['c', 'a', 'b'])).toEqual([
        { kind: 'claude', session: 'c' },
        { kind: 'claude', session: 'a' },
        { kind: 'codex', session: 'b' },
      ]);
    });

    it('keeps unranked sessions in row order behind the ranked ones', () => {
      // A session created after the last drag has no rank; the bar puts it at
      // the end of its group, and the run answers the same way.
      expect(agentBadges(trio(), ['b'])).toEqual([
        { kind: 'codex', session: 'b' },
        { kind: 'claude', session: 'a' },
        { kind: 'claude', session: 'c' },
      ]);
    });

    it('treats ids that name no session as inert', () => {
      // The stored order is the whole bar's ids — Files tab ids among them —
      // and ids that name nothing alive rank nothing, exactly as
      // applyTabOrder treats them.
      expect(agentBadges(trio(), ['~/git/app::files:7', 'b', 'a-killed-session'])).toEqual([
        { kind: 'codex', session: 'b' },
        { kind: 'claude', session: 'a' },
        { kind: 'claude', session: 'c' },
      ]);
    });

    it('reads an empty order as un-arranged and walks the rows', () => {
      expect(agentBadges(trio(), [])).toEqual([
        { kind: 'claude', session: 'a' },
        { kind: 'codex', session: 'b' },
        { kind: 'claude', session: 'c' },
      ]);
    });
  });
});
