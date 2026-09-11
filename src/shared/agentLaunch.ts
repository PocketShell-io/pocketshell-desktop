/**
 * The `pocketshell agent …` launch line, built from the helper's REAL option
 * list rather than a remembered one.
 *
 * ## What the helper actually accepts
 *
 * Captured from the pinned 0.4.44 fixture image, not from docs — the
 * `--help` output is committed verbatim at
 * `tests/unit/fixtures/v0.4.44-agent-help.txt` and
 * `…-agent-claude-help.txt`, and `tests/unit/agentLaunch.test.ts` asserts
 * this module against those files so a helper bump that moves a flag fails a
 * test instead of a user's terminal:
 *
 *     Usage: pocketshell agent claude [OPTIONS]
 *
 *     Options:
 *       --dir TEXT                      Folder to launch the agent in (its cwd).
 *                                       [required]
 *       --skip-permissions / --no-skip-permissions
 *                                       … [default: skip-permissions]
 *       --config-dir TEXT               … Mutually exclusive with --profile.
 *       --profile TEXT                  Named host profile … Mutually
 *                                       exclusive with --config-dir.
 *
 * Three facts drive every branch below.
 *
 * 1. **`--dir` is REQUIRED.** The desktop used to type a bare
 *    `pocketshell agent claude`, which exits 2 with `Error: Missing option
 *    '--dir'.` — so the session was created, the agent never started, and the
 *    user was left in a plain shell staring at a usage message. That is the
 *    bug this module exists to make unrepeatable.
 * 2. **Skip-permissions defaults to ON host-side.** So the affirmative
 *    `--skip-permissions` is never worth emitting; the only flag that carries
 *    information is the negative `--no-skip-permissions`. This matches the
 *    phone (`SessionTypePickerSheet.kt::buildAgentCommand`), and it means a
 *    host that later changes its default changes ours with it.
 * 3. **`--profile` and `--config-dir` are mutually exclusive** (exit 2). We
 *    only ever emit `--profile`, so the pair can never both appear.
 *
 * ## Grok, and the version boundary
 *
 * `pocketshell agent` on the pinned 0.4.44 image has exactly three
 * subcommands — `claude`, `codex`, `opencode`. There is **no `grok`** there:
 * `pocketshell agent grok` exits 2 with `Error: No such command 'grok'.`
 * (captured at `v0.4.44-agent-no-such-command.stderr.txt`, and still asserted
 * in `agentLaunch.test.ts` so the boundary cannot quietly move). The helper's
 * own repo has since grown a `grok` subcommand, but that work is
 * **unreleased**: no host is known to run it, and this repo therefore has no
 * `pocketshell agent grok --help` capture to pin flag spellings against.
 *
 * This module used to answer that by leaving `grok` out of
 * {@link LAUNCHABLE_KINDS} altogether, and the header used to say flatly that
 * this desktop cannot start one. That is no longer the whole story. Grok IS a
 * launchable kind now and the picker does offer it — but conditionally, per
 * host, and never on the strength of a version number we merely remember:
 *
 * - {@link kindUnavailableReason} is the gate. It is answered from a real
 *   probe of the real host — `pocketshell agent --help`, read by
 *   `PocketshellClient.agentSubcommands` and parsed by
 *   `parsers.ts::parseAgentSubcommands` — for the same reason every flag above
 *   is pinned to a capture: on this repo's record a captured contract has been
 *   right every time a remembered one was wrong.
 * - The direction of the "we don't know" answer differs per kind, on purpose.
 *   Unknown means **yes** for claude/codex/opencode, because those three are
 *   guaranteed by the helper version this app targets
 *   ({@link HELPER_BASELINE_KINDS}) and a probe that merely failed must not
 *   take away three agents that certainly work. Unknown means **no** for grok,
 *   because grok is guaranteed by nothing: launching it on a host that lacks
 *   the subcommand creates the session, exits 2, and leaves the user in a
 *   plain shell reading a usage message. That is precisely the failure the
 *   missing `--dir` produced and precisely what this module exists to make
 *   unrepeatable, so the unknown case has to fall on the refusing side.
 * - The refusal is a *message*, not an absence. It names the version boundary
 *   ({@link HELPER_VERSION_WITHOUT_GROK}) so "why is Grok greyed out" has an
 *   answer the user can act on, rather than a control that silently is not
 *   there.
 *
 * Two things stay conservative until a grok `--help` can actually be captured:
 * {@link supportsSkipPermissions} and {@link supportsProfiles} both say no for
 * grok, so the only line this module will ever build for it is the required
 * `--dir` and nothing else. Emitting a flag we have not seen the subcommand
 * accept is the same mistake as trusting a remembered flag name, and it fails
 * the same way — exit 2, plain shell. See those two functions for the detail.
 *
 * {@link SessionAgentKind} remains wider than {@link LAUNCHABLE_KINDS}, but
 * for a different reason than it used to be: what it carries beyond the four
 * engines — `shell`, `probing`, `exited`, `unknown` — are classifications of a
 * session, not things anyone can ask to start.
 */
import { shellQuote, shellQuoteRemotePath } from './shellQuote.js';
import type { SessionAgentKind } from './types.js';

/**
 * The agent kinds this desktop knows how to build a `pocketshell agent` line
 * for, in the order the picker offers them.
 *
 * The first three are the phone's order (claude, codex, opencode) and are the
 * ones the pinned helper certainly has. `grok` comes last because it is the
 * newest and the only one whose availability has to be asked about — see
 * {@link HELPER_BASELINE_KINDS} and {@link kindUnavailableReason}. Membership
 * here means "we can spell the command", NOT "this host will accept it".
 */
export const LAUNCHABLE_KINDS = ['claude', 'codex', 'opencode', 'grok'] as const;

export type LaunchableKind = (typeof LAUNCHABLE_KINDS)[number];

/**
 * The subcommands `pocketshell agent` has on the helper version this app
 * targets, pinned to the captured `--help` (`v0.4.44-agent-help.txt`).
 *
 * This is the floor, and it is what makes a FAILED capability probe survivable
 * rather than crippling: these three exist on every host that can run this app
 * at all, so when the probe cannot answer we still offer them. Anything not in
 * this list — today that is `grok` alone — has to be proven present on the
 * host before it is offered.
 */
export const HELPER_BASELINE_KINDS = ['claude', 'codex', 'opencode'] as const;

/**
 * The helper version that is known NOT to have `pocketshell agent grok`.
 *
 * Deliberately phrased as the version *without* the subcommand rather than as
 * the first version *with* it. 0.4.44 is a fact this repo can prove — it is
 * the pinned fixture image, and `v0.4.44-agent-no-such-command.stderr.txt` is
 * the receipt. The release number that will FIRST carry grok is not a fact
 * this repo has: the helper is a separately released Python project and the
 * grok work is still unreleased there, so naming "0.4.45" here would be
 * inventing exactly the kind of remembered contract the rest of this file
 * refuses to trust. Messages therefore say "newer than 0.4.44", which stays
 * true whatever number the helper actually ships under.
 */
export const HELPER_VERSION_WITHOUT_GROK = '0.4.44';

/** Display names for the picker. Title-case; the phone uses lowercase CLI names. */
export const KIND_LABELS: Record<LaunchableKind, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  grok: 'Grok',
};

/** Narrow a badge-level {@link SessionAgentKind} to something we can launch. */
export function isLaunchableKind(kind: SessionAgentKind | null): kind is LaunchableKind {
  return kind !== null && (LAUNCHABLE_KINDS as readonly string[]).includes(kind);
}

/**
 * Whether the kind needs a helper newer than the one this app pins.
 *
 * The inverse of {@link HELPER_BASELINE_KINDS} membership, given a name
 * because it is the thing every caller actually wants to ask: a kind that
 * needs a newer helper is one whose absence from a host is EXPECTED and worth
 * explaining, rather than a sign that something is broken.
 */
export function kindNeedsNewerHelper(kind: LaunchableKind): boolean {
  return !(HELPER_BASELINE_KINDS as readonly string[]).includes(kind);
}

/**
 * Whether the kind's per-action approval prompts can be turned off.
 *
 * - **opencode: no.** The helper's own help says the flag is a "No-op for
 *   opencode", so offering the toggle there would be a control that does
 *   nothing. The phone hides the row outright and never emits the flag.
 * - **grok: no, for now, and for a different reason.** `--skip-permissions` is
 *   a per-SUBCOMMAND option — it is documented on `agent claude --help`, not
 *   on the group — and no `agent grok --help` has been captured, because no
 *   released helper has that subcommand to capture from. An unrecognised
 *   option makes click exit 2, which would create the session, fail to start
 *   the agent, and drop the user into a plain shell: the exact failure the
 *   header describes. So grok gets the minimal line — `--dir` and nothing
 *   else — until a capture says more is safe. If that capture shows the flag,
 *   deleting `kind !== 'grok'` here is the whole change.
 */
export function supportsSkipPermissions(kind: LaunchableKind): boolean {
  return kind !== 'opencode' && kind !== 'grok';
}

/**
 * Whether a profile can be chosen for the kind.
 *
 * `pocketshell profiles list --engine` accepts only `claude|codex`, and
 * `agent --profile` is documented "Ignored for opencode" — opencode has no
 * config-dir env var at all (helper `profiles.py`: "opencode has no profile
 * env var, so it is out of scope").
 *
 * grok is excluded on the same evidence: `profiles list` on 0.4.44 knows two
 * engines and grok is not one of them, so {@link profilesFor} would filter to
 * an empty list for it regardless of what this function said. Saying no
 * explicitly makes the picker hide a control it could never fill, and keeps
 * `--profile` — an option we have never seen `agent grok` accept — out of the
 * launch line. Revisit when a grok `--help` and a `profiles list` that names
 * grok can both be captured.
 */
export function supportsProfiles(kind: LaunchableKind): boolean {
  return kind !== 'opencode' && kind !== 'grok';
}

/**
 * What one host's `pocketshell agent` can start, as far as we were able to
 * ask.
 *
 * `subcommands` is the `Commands:` block of `pocketshell agent --help`, or
 * **null** when we could not read it — the helper is missing, the exec failed,
 * the output did not parse. Null is a genuinely different answer from `[]` and
 * the two must not be collapsed: an empty list would mean a helper that admits
 * to having no agents at all, which no real host produces, while null means we
 * never got to ask. {@link kindUnavailableReason} treats them differently.
 */
export interface HostAgentSupport {
  subcommands: readonly string[] | null;
  /**
   * `pocketshell --version`'s first line, if bootstrap got one. Used only to
   * make the refusal concrete ("this host has …"); never to decide anything,
   * because the decision comes from the probe.
   */
  helperVersion?: string | null;
  /** True while the probe is still in flight, so "no" can be said as "not yet". */
  probing?: boolean;
}

/**
 * Why this host cannot start [kind] right now, or null when it can.
 *
 * The whole point is that every branch produces a SENTENCE. A kind the host
 * cannot launch used to be handled by not existing — the `+` menu simply did
 * not list Grok — and the cost of that was a user who could not tell "this app
 * dropped the feature" from "my host is old". So the picker shows the option
 * and this function explains it, in terms the user can act on: which host,
 * which helper version, what to do.
 *
 * Baseline kinds get null unless the probe positively contradicts them. That
 * asymmetry is argued in the header: three agents that certainly work must not
 * disappear because an SSH exec hiccuped, while grok must not be offered on a
 * guess.
 */
export function kindUnavailableReason(
  kind: LaunchableKind,
  support: HostAgentSupport,
): string | null {
  const label = KIND_LABELS[kind];
  // Array.isArray rather than `!== null`: the list arrives over IPC from a
  // parser that returns `string[] | null`, and anything else that reaches here
  // — an undefined from a half-built stub, a shape a future helper changes —
  // is "we did not get an answer", which is the case the branch below already
  // handles correctly. Treating it as an empty list instead would refuse every
  // engine on the host.
  const listed = Array.isArray(support.subcommands) ? support.subcommands : null;
  if (listed !== null) {
    if (listed.includes(kind)) return null;
    // The probe answered, and the answer was no. This is the 0.4.44 case for
    // grok, and it is the only branch that can name the host's own version.
    const has = support.helperVersion?.trim();
    const running = has ? ` This host runs ${has}.` : '';
    if (kindNeedsNewerHelper(kind)) {
      return (
        `This host’s pocketshell helper is too old to start ${label} — its ` +
        `\`pocketshell agent\` has no \`${kind}\` subcommand. ${label} needs a helper ` +
        `newer than ${HELPER_VERSION_WITHOUT_GROK}.${running}`
      );
    }
    return (
      `This host’s \`pocketshell agent\` does not list a \`${kind}\` subcommand, so ` +
      `${label} cannot be started here.${running}`
    );
  }
  // The probe could not answer. Baseline kinds are pinned and go ahead anyway;
  // grok does not, because being wrong here costs the user a session that
  // comes up as a plain shell.
  if (!kindNeedsNewerHelper(kind)) return null;
  if (support.probing) {
    return `Checking whether this host’s pocketshell can start ${label}…`;
  }
  return (
    `Could not ask this host which agents its pocketshell can start, and ${label} ` +
    `needs a helper newer than ${HELPER_VERSION_WITHOUT_GROK} — so it is not offered here. ` +
    `Pick another agent, or reconnect and try again.`
  );
}

/** One row of `pocketshell profiles list --json`'s `{"profiles": [...]}`. */
export interface AgentProfile {
  name: string;
  engine: string;
  /** `null` for the engine's built-in default location. */
  configDir: string | null;
  /** The engine's default profile; the picker pre-selects it. */
  default: boolean;
}

/**
 * Parse the `{"profiles": [...]}` envelope 0.4.44 emits.
 *
 * The rows arrive over IPC as `unknown[]` ({@link
 * PocketshellClient.listProfiles} unwraps the envelope but does not type the
 * rows), so this is where they become data. A row with no usable `name` or
 * `engine` is DROPPED rather than defaulted: a nameless profile cannot be
 * passed to `--profile`, and inventing a name for it would produce a launch
 * line the host rejects with `unknown claude profile`.
 */
export function parseProfileRows(rows: readonly unknown[]): AgentProfile[] {
  const out: AgentProfile[] = [];
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    const name = typeof r['name'] === 'string' ? r['name'].trim() : '';
    const engine = typeof r['engine'] === 'string' ? r['engine'].trim() : '';
    if (name === '' || engine === '') continue;
    const rawDir = r['config_dir'];
    out.push({
      name,
      engine,
      configDir: typeof rawDir === 'string' && rawDir.trim() !== '' ? rawDir.trim() : null,
      default: r['default'] === true,
    });
  }
  return out;
}

/** The profiles that apply to one kind, host order preserved (default first). */
export function profilesFor(
  kind: LaunchableKind,
  profiles: readonly AgentProfile[],
): AgentProfile[] {
  if (!supportsProfiles(kind)) return [];
  return profiles.filter((p) => p.engine === kind);
}

/**
 * The name to put in `--profile` for a picked profile, or null for none.
 *
 * Null for the engine's DEFAULT profile, matching the phone
 * (`launchCommand`'s `.takeUnless { it.default }`): the default is what the
 * agent uses when `--profile` is absent, so naming it adds a flag that can
 * fail — `unknown claude profile` if the host renames it — in exchange for no
 * change in behaviour. Null too for a remembered name the host no longer
 * lists, which is how a profile deleted on the host stops haunting the
 * dialog.
 */
export function profileFlagName(
  picked: string | null,
  available: readonly AgentProfile[],
): string | null {
  if (!picked) return null;
  const match = available.find((p) => p.name === picked);
  if (!match || match.default) return null;
  return match.name;
}

/** Everything the picker collects. */
export interface LaunchChoice {
  kind: LaunchableKind;
  /** Folder the agent starts in. May be a literal `~/…`. */
  dir: string;
  /** Per-action approval prompts disabled. Host default is `true`. */
  skipPermissions: boolean;
  /** Profile NAME as the host reports it, or null for the engine default. */
  profile: string | null;
}

/**
 * The literal line typed into the session's PTY (no trailing `\r`).
 *
 * Quoting, which is the whole reason this is not a template string at the
 * call site:
 *
 * - **`--dir` uses {@link shellQuoteRemotePath}**, not a plain quote. This is
 *   the one deliberate divergence from the phone, which single-quotes the
 *   directory flat. A desktop folder key can be a literal, unexpanded `~/git/x`
 *   — tmux reports cwds that way and `stripTilde` in renderer/remotePaths.ts
 *   exists because of it — and `'~/git/x'` inside single quotes is four literal
 *   characters the shell will not expand, so the helper would look for a
 *   directory named `~`. `shellQuoteRemotePath` emits `$HOME/'git/x'`: the
 *   prefix expands, the rest is inert data, and a folder called
 *   `wei'rd $(touch /tmp/PWNED)` still travels as text.
 * - **`--profile` uses a plain {@link shellQuote}.** A profile name is data,
 *   never a path — the host's own discovery produces names like
 *   `Claude (Z.AI)`, with a space and parentheses, which unquoted would split
 *   into three words and fail as `unknown claude profile: 'Claude'`.
 *
 * Flags are emitted only when they carry information (see the header): the
 * host defaults skip-permissions ON, so only the negative is spoken, and
 * never for opencode where it is a no-op.
 *
 * The engine's DEFAULT profile is passed as `profile: null` by the caller,
 * not stripped here — see {@link profileFlagName}. Naming it and omitting it
 * are the same launch, and this function stays a dumb renderer of the choice
 * it is handed so that what you read here is what the host receives.
 */
export function buildLaunchCommand(choice: LaunchChoice): string {
  const parts = ['pocketshell', 'agent', choice.kind, '--dir', shellQuoteRemotePath(choice.dir)];
  if (supportsSkipPermissions(choice.kind) && !choice.skipPermissions) {
    parts.push('--no-skip-permissions');
  }
  const profile = choice.profile?.trim();
  if (supportsProfiles(choice.kind) && profile) {
    parts.push('--profile', shellQuote(profile));
  }
  return parts.join(' ');
}

/**
 * Why {@link buildLaunchCommand} would produce a line the host rejects, or
 * null when it would not.
 *
 * Called BEFORE the session is created, which is the point: the old flow
 * created a session and only then discovered the command was malformed,
 * leaving a shell plus a usage message in the terminal. A launch that cannot
 * work should cost the user nothing.
 *
 * `support` is the host capability probe, and it is OPTIONAL on purpose. The
 * picker (`LaunchSessionDialog`) passes it, because the picker is the one
 * place a user chooses a kind and therefore the one place the choice can still
 * be steered. The callers downstream of it — `FolderWorkspaceView.createSession`
 * and `NewSessionDialog.commit` — re-run this check on a choice the picker has
 * already vetted, and they run it on a code path where the answer can only be
 * "too late". Omitting the argument there means the host check is skipped
 * rather than re-decided from a store those components would have to grow a
 * dependency on. The shape check — is this a kind at all, is there a
 * directory — still runs for everyone, which is what those callers are
 * actually guarding against.
 */
export function launchBlocker(
  choice: Partial<LaunchChoice>,
  support?: HostAgentSupport,
): string | null {
  if (!choice.kind || !isLaunchableKind(choice.kind)) {
    return 'Pick an agent to launch.';
  }
  if (support) {
    const unavailable = kindUnavailableReason(choice.kind, support);
    if (unavailable) return unavailable;
  }
  // `--dir` is required and the helper resolves it host-side; a blank one
  // would make `shellQuoteRemotePath` fall back to `$HOME`, silently starting
  // the agent in the home directory instead of the folder the user is in.
  if (!choice.dir || choice.dir.trim() === '') {
    return 'This folder has no known directory on the host, so an agent cannot be launched in it.';
  }
  return null;
}
