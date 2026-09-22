import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  HELPER_BASELINE_KINDS,
  HELPER_VERSION_WITHOUT_GROK,
  KIND_LABELS,
  LAUNCHABLE_KINDS,
  buildLaunchCommand,
  isLaunchableKind,
  kindNeedsNewerHelper,
  kindUnavailableReason,
  launchBlocker,
  parseProfileRows,
  profileFlagName,
  profilesFor,
  supportsProfiles,
  supportsSkipPermissions,
  type AgentProfile,
} from '@pocketshell/core';

/**
 * Two suites with different jobs.
 *
 * The FIRST reads the committed `--help` capture and asserts that every flag
 * this module emits is spelled the way the helper the user actually runs
 * spells it. That is the guard this repo needs: it has been
 * burned four times by trusting a documented contract over a captured one, and
 * the `--dir` bug was a fifth. If a helper bump renames `--skip-permissions`,
 * re-capturing the fixture fails these tests rather than shipping a session
 * that starts a shell and prints a usage message.
 *
 * The SECOND is the command construction as pure logic — the matrix of
 * profile / no profile, skip / no skip, and a directory with a space in it.
 */
const V44 = resolve(__dirname, 'fixtures');
const readV44 = (name: string): string => readFileSync(resolve(V44, name), 'utf8');

describe('the 0.4.44 `pocketshell agent` contract, as captured', () => {
  const groupHelp = readV44('v0.4.44-agent-help.txt');
  const claudeHelp = readV44('v0.4.44-agent-claude-help.txt');
  const opencodeHelp = readV44('v0.4.44-agent-opencode-help.txt');

  it('lists exactly the three subcommands this app treats as its baseline', () => {
    // The `Commands:` block of `pocketshell agent --help`.
    const listed = [...groupHelp.matchAll(/^ {2}(\w+) {2,}Launch/gm)].map((m) => m[1]);
    expect(listed).toEqual(['claude', 'codex', 'opencode']);
    // The baseline is the pinned version's list, verbatim. LAUNCHABLE_KINDS is
    // WIDER — it is what the app can spell, not what this helper accepts — and
    // the gap between the two is exactly the set that has to be probed for.
    expect([...HELPER_BASELINE_KINDS]).toEqual(listed);
    expect([...LAUNCHABLE_KINDS]).toEqual([...listed, 'grok']);
    for (const kind of HELPER_BASELINE_KINDS) expect(kindNeedsNewerHelper(kind)).toBe(false);
    expect(kindNeedsNewerHelper('grok')).toBe(true);
  });

  it('has no `grok` subcommand, which is what the picker refuses on', () => {
    expect(groupHelp).not.toMatch(/^ {2}grok\b/m);
    expect(readV44('v0.4.44-agent-no-such-command.stderr.txt')).toContain(
      "Error: No such command 'grok'.",
    );
    // Launchable in the sense that this app knows the line…
    expect(isLaunchableKind('grok')).toBe(true);
    // …but refused on a host whose captured help is the fixture above. This is
    // the whole guard: the exit-2 plain-shell failure never reaches the user.
    const onPinnedHost = { subcommands: [...HELPER_BASELINE_KINDS] };
    expect(kindUnavailableReason('grok', onPinnedHost)).toMatch(/too old to start Grok/);
    expect(kindUnavailableReason('grok', onPinnedHost)).toContain('`grok` subcommand');
    expect(kindUnavailableReason('grok', onPinnedHost)).toContain(
      `newer than ${HELPER_VERSION_WITHOUT_GROK}`,
    );
    expect(launchBlocker({ kind: 'grok', dir: '/srv/app' }, onPinnedHost)).toBe(
      kindUnavailableReason('grok', onPinnedHost),
    );
  });

  it('marks --dir required, which is the bug this module fixes', () => {
    expect(claudeHelp).toMatch(/--dir TEXT[\s\S]*?\[required\]/);
    // And the exact failure the old bare command produced.
    expect(readV44('v0.4.44-agent-missing-dir.stderr.txt')).toContain(
      "Error: Missing option '--dir'.",
    );
  });

  it('spells the permission flag as a --x/--no-x pair defaulting to ON', () => {
    expect(claudeHelp).toContain('--skip-permissions / --no-skip-permissions');
    expect(claudeHelp).toContain('[default: skip-permissions]');
    // Because the host default is ON, only the negative carries information.
    const on = buildLaunchCommand({ kind: 'claude', dir: '/srv/app', skipPermissions: true, profile: null });
    expect(on).not.toContain('--skip-permissions');
    expect(on).not.toContain('--no-skip-permissions');
  });

  it('says the permission flag is a no-op for opencode', () => {
    expect(opencodeHelp).toContain('No-op\n                                  for opencode');
    expect(supportsSkipPermissions('opencode')).toBe(false);
  });

  it('says --profile is ignored for opencode and excludes --config-dir', () => {
    expect(claudeHelp).toContain('Ignored for');
    expect(claudeHelp).toContain('opencode. Mutually exclusive with --profile.');
    expect(claudeHelp).toMatch(/--profile TEXT[\s\S]*?Mutually\s+exclusive with --config-dir/);
    expect(supportsProfiles('opencode')).toBe(false);
    // We never emit --config-dir, so the exclusive pair cannot both appear.
    const cmd = buildLaunchCommand({
      kind: 'claude',
      dir: '/srv/app',
      skipPermissions: true,
      profile: 'Claude (Z.AI)',
    });
    expect(cmd).not.toContain('--config-dir');
  });
});

describe('buildLaunchCommand', () => {
  const base = { kind: 'claude', dir: '/srv/app', skipPermissions: true, profile: null } as const;

  it('always passes --dir, quoted', () => {
    expect(buildLaunchCommand(base)).toBe("pocketshell agent claude --dir '/srv/app'");
  });

  it('emits --no-skip-permissions only when the user turned it off', () => {
    expect(buildLaunchCommand({ ...base, skipPermissions: false })).toBe(
      "pocketshell agent claude --dir '/srv/app' --no-skip-permissions",
    );
  });

  it('never emits a permission flag for opencode, either way', () => {
    const on = buildLaunchCommand({ ...base, kind: 'opencode', skipPermissions: true });
    const off = buildLaunchCommand({ ...base, kind: 'opencode', skipPermissions: false });
    expect(on).toBe("pocketshell agent opencode --dir '/srv/app'");
    expect(off).toBe(on);
  });

  it('emits --profile, quoted, for a named profile', () => {
    expect(buildLaunchCommand({ ...base, profile: 'Claude (Z.AI)' })).toBe(
      "pocketshell agent claude --dir '/srv/app' --profile 'Claude (Z.AI)'",
    );
  });

  it('drops a blank or whitespace-only profile rather than emitting an empty flag', () => {
    expect(buildLaunchCommand({ ...base, profile: '   ' })).toBe(
      "pocketshell agent claude --dir '/srv/app'",
    );
    expect(buildLaunchCommand({ ...base, profile: null })).toBe(
      "pocketshell agent claude --dir '/srv/app'",
    );
  });

  it('ignores a profile for opencode, which has no config dir', () => {
    expect(buildLaunchCommand({ ...base, kind: 'opencode', profile: 'Claude (Z.AI)' })).toBe(
      "pocketshell agent opencode --dir '/srv/app'",
    );
  });

  /**
   * Grok gets the MINIMAL line, and this pins it.
   *
   * `--dir` is required on the whole `pocketshell agent` group, so it is the
   * one flag we know a `grok` subcommand must accept. Everything else —
   * `--skip-permissions`, `--profile` — is documented per subcommand, and no
   * `agent grok --help` exists to capture, so emitting either would be
   * guessing at a contract. A wrong guess is exit 2, which is a created
   * session, no agent, and a usage message: the failure this file exists to
   * stop. If a capture later shows the flags, this test is what says so.
   */
  it('builds grok as --dir and nothing else, whatever else was chosen', () => {
    expect(buildLaunchCommand({ ...base, kind: 'grok' })).toBe(
      "pocketshell agent grok --dir '/srv/app'",
    );
    expect(
      buildLaunchCommand({
        kind: 'grok',
        dir: '/srv/app',
        skipPermissions: false,
        profile: 'Claude (Z.AI)',
      }),
    ).toBe("pocketshell agent grok --dir '/srv/app'");
  });

  it('combines both flags in the helper documented order', () => {
    expect(
      buildLaunchCommand({ kind: 'codex', dir: '/srv/app', skipPermissions: false, profile: 'work' }),
    ).toBe("pocketshell agent codex --dir '/srv/app' --no-skip-permissions --profile 'work'");
  });

  // --- quoting ------------------------------------------------------------

  it('survives a directory containing a space', () => {
    expect(buildLaunchCommand({ ...base, dir: '/srv/my app' })).toBe(
      "pocketshell agent claude --dir '/srv/my app'",
    );
  });

  it('expands a literal `~/` cwd instead of quoting it into a dead path', () => {
    // tmux reports unexpanded cwds; `'~/git/x'` would make the helper look for
    // a directory literally named `~`.
    expect(buildLaunchCommand({ ...base, dir: '~/git/my app' })).toBe(
      "pocketshell agent claude --dir $HOME/'git/my app'",
    );
    expect(buildLaunchCommand({ ...base, dir: '~' })).toBe(
      'pocketshell agent claude --dir $HOME',
    );
  });

  it('passes a hostile folder name through as data', () => {
    expect(buildLaunchCommand({ ...base, dir: "/srv/wei'rd $(touch /tmp/PWNED)" })).toBe(
      "pocketshell agent claude --dir '/srv/wei'\\''rd $(touch /tmp/PWNED)'",
    );
  });

  it('quotes a profile name containing a quote', () => {
    expect(buildLaunchCommand({ ...base, profile: "o'brien" })).toBe(
      "pocketshell agent claude --dir '/srv/app' --profile 'o'\\''brien'",
    );
  });
});

describe('launchBlocker', () => {
  it('passes a complete choice', () => {
    expect(launchBlocker({ kind: 'claude', dir: '/srv/app', skipPermissions: true, profile: null })).toBeNull();
  });

  it('blocks a kind that is not an agent at all', () => {
    expect(launchBlocker({ kind: 'shell' as never, dir: '/srv/app' })).toBe(
      'Pick an agent to launch.',
    );
  });

  it('does NOT second-guess the host when no support is passed', () => {
    // The two callers downstream of the picker (FolderWorkspaceView,
    // NewSessionDialog) re-check a choice the picker already vetted, on a path
    // where "the host cannot do this" is no longer actionable. Omitting the
    // argument has to mean "skip that question", not "answer it no", or a grok
    // launch the picker allowed would die one step later for no stated reason.
    expect(launchBlocker({ kind: 'grok', dir: '/srv/app' })).toBeNull();
  });
});

/**
 * The host capability gate — the reason Grok can be offered at all.
 *
 * `grok` is a real `pocketshell agent` subcommand in the helper's own repo but
 * is NOT in any released helper, so no host in `tests/unit/fixtures` has it and
 * none can be captured yet. What is pinned here is therefore the DECISION
 * table, not a second fixture: given what a host said, what does the picker do.
 * The 0.4.44 row is the one that must never regress, because getting it wrong
 * is the exit-2 plain-shell bug this whole module exists to prevent.
 */
describe('kindUnavailableReason', () => {
  const PINNED = [...HELPER_BASELINE_KINDS];
  const UPGRADED = [...HELPER_BASELINE_KINDS, 'grok'];

  it('allows every baseline kind on the pinned helper', () => {
    for (const kind of HELPER_BASELINE_KINDS) {
      expect(kindUnavailableReason(kind, { subcommands: PINNED })).toBeNull();
    }
  });

  it('allows grok once the host lists it', () => {
    expect(kindUnavailableReason('grok', { subcommands: UPGRADED })).toBeNull();
    expect(launchBlocker({ kind: 'grok', dir: '/srv/app' }, { subcommands: UPGRADED })).toBeNull();
  });

  it('names the host’s own version in the too-old message when bootstrap has one', () => {
    const reason = kindUnavailableReason('grok', {
      subcommands: PINNED,
      helperVersion: 'pocketshell 0.4.44',
    });
    expect(reason).toContain('This host runs pocketshell 0.4.44.');
  });

  it('says nothing about a version bootstrap never read', () => {
    expect(kindUnavailableReason('grok', { subcommands: PINNED, helperVersion: null })).not.toContain(
      'This host runs',
    );
    expect(kindUnavailableReason('grok', { subcommands: PINNED, helperVersion: '  ' })).not.toContain(
      'This host runs',
    );
  });

  // --- the unknown host: the direction of the default -----------------------

  it('lets the baseline through when the probe could not answer', () => {
    // A failed exec must not cost the user three agents that certainly work.
    for (const kind of HELPER_BASELINE_KINDS) {
      expect(kindUnavailableReason(kind, { subcommands: null })).toBeNull();
      expect(kindUnavailableReason(kind, { subcommands: null, probing: true })).toBeNull();
    }
  });

  it('refuses grok when the probe could not answer', () => {
    const reason = kindUnavailableReason('grok', { subcommands: null });
    expect(reason).toMatch(/Could not ask this host/);
    expect(reason).toContain(`newer than ${HELPER_VERSION_WITHOUT_GROK}`);
  });

  it('says "not yet" rather than "no" while the probe is still in flight', () => {
    expect(kindUnavailableReason('grok', { subcommands: null, probing: true })).toBe(
      'Checking whether this host’s pocketshell can start Grok…',
    );
  });

  it('refuses a baseline kind the host positively did not list', () => {
    // Not the expected case, but the probe answering "no claude here" is a real
    // answer and deserves its own sentence rather than the version one.
    const reason = kindUnavailableReason('claude', { subcommands: ['codex', 'opencode'] });
    expect(reason).toContain('`claude` subcommand');
    expect(reason).not.toContain('too old');
  });

  it('blocks a folder with no host directory, BEFORE anything is created', () => {
    expect(launchBlocker({ kind: 'claude', dir: '' })).toMatch(/no known directory/);
    expect(launchBlocker({ kind: 'claude', dir: '   ' })).toMatch(/no known directory/);
  });
});

describe('profile rows', () => {
  const envelope = JSON.parse(readV44('v0.4.44-profiles-list.json')) as { profiles: unknown[] };

  it('parses the real 0.4.44 envelope rows', () => {
    const rows = parseProfileRows(envelope.profiles);
    expect(rows).toEqual<AgentProfile[]>([
      { name: 'Claude', engine: 'claude', configDir: null, default: true },
      { name: 'Claude (Z.AI)', engine: 'claude', configDir: '/home/testuser/.zlaude', default: false },
      { name: 'Codex', engine: 'codex', configDir: null, default: true },
    ]);
  });

  it('treats a host with no profiles as empty, not an error', () => {
    const empty = JSON.parse(readV44('v0.4.44-profiles-list-empty.json')) as { profiles: unknown[] };
    expect(empty.profiles).toEqual([]);
    expect(parseProfileRows(empty.profiles)).toEqual([]);
  });

  it('drops rows that could not be passed to --profile', () => {
    expect(
      parseProfileRows([
        null,
        'nope',
        { engine: 'claude' },
        { name: '  ', engine: 'claude' },
        { name: 'ok', engine: '' },
        { name: 'ok', engine: 'claude', config_dir: '', default: 'yes' },
      ]),
    ).toEqual<AgentProfile[]>([{ name: 'ok', engine: 'claude', configDir: null, default: false }]);
  });

  it('filters to the engine, and gives opencode none', () => {
    const rows = parseProfileRows(envelope.profiles);
    expect(profilesFor('claude', rows).map((p) => p.name)).toEqual(['Claude', 'Claude (Z.AI)']);
    expect(profilesFor('codex', rows).map((p) => p.name)).toEqual(['Codex']);
    expect(profilesFor('opencode', rows)).toEqual([]);
  });

  describe('profileFlagName', () => {
    const rows = parseProfileRows(envelope.profiles);

    it('is null for the engine default — naming it is the same launch', () => {
      expect(profileFlagName('Claude', rows)).toBeNull();
    });

    it('is the name for a non-default profile', () => {
      expect(profileFlagName('Claude (Z.AI)', rows)).toBe('Claude (Z.AI)');
    });

    it('is null for a remembered profile the host no longer lists', () => {
      expect(profileFlagName('Claude (deleted)', rows)).toBeNull();
    });

    it('is null when nothing is picked', () => {
      expect(profileFlagName(null, rows)).toBeNull();
      expect(profileFlagName('', rows)).toBeNull();
    });
  });
});

describe('the picker surface', () => {
  it('labels every launchable kind', () => {
    for (const kind of LAUNCHABLE_KINDS) expect(KIND_LABELS[kind]).toBeTruthy();
    expect(Object.keys(KIND_LABELS).sort()).toEqual([...LAUNCHABLE_KINDS].sort());
  });

  it('labels grok in the same title case as the rest', () => {
    expect(KIND_LABELS).toEqual({
      claude: 'Claude Code',
      codex: 'Codex',
      opencode: 'OpenCode',
      grok: 'Grok',
    });
  });

  /**
   * Both predicates answer for grok deliberately, and both answer NO. See
   * `supportsSkipPermissions` for the argument: an option nobody has captured
   * the subcommand accepting is an option we do not send.
   */
  it('offers grok neither a permissions toggle nor a profile picker', () => {
    expect(supportsSkipPermissions('grok')).toBe(false);
    expect(supportsProfiles('grok')).toBe(false);
    // And so the profile filter is empty for it even on a host with profiles.
    const envelope = JSON.parse(readV44('v0.4.44-profiles-list.json')) as { profiles: unknown[] };
    const rows = parseProfileRows(envelope.profiles);
    expect(profilesFor('grok', rows)).toEqual([]);
  });
});
