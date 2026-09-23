import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { agentMark } from '../../src/shared/agentBadge';
import type { SessionAgentKind } from '@pocketshell/core';

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
    expect(icons).toEqual(['hexagon', 'code', 'terminal', 'zap']);
    // Distinct, which is the only property the marks actually have to have:
    // they are arbitrary, and the tooltip is what names them.
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
