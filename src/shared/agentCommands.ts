/**
 * Agent slash-command catalog — a port of the Android client's
 * `AgentCommandCatalog.kt` (:83-256, filter at :268-277 / :343-352).
 *
 * This is an APP-SHIPPED, PER-AGENT CURATED LIST, deliberately not user CRUD:
 * a command that an engine does not have is simply absent from its list, so an
 * unavailable command is never offered. Do not build editing UI for it, and do
 * not invent a desktop-only fallback catalog for "no agent detected" — the
 * dropdown stays closed instead.
 *
 * Each agent's list is ordered curated-first (new/clear, compact, goal where it
 * exists, plus one agent-appropriate extra) followed by the searchable long
 * tail.
 */
import type { ComposerAgentKind } from './composerSend';

interface AgentCommandArgument {
  placeholder: string;
  required: boolean;
}

export interface AgentCommand {
  /** Literal text typed into the agent REPL, leading `/` included. */
  command: string;
  /** Row title. */
  label: string;
  /** One-line explanation under the label. */
  description: string;
  /** Clears or rolls back conversation context. Carried for completeness. */
  destructive?: boolean;
  /** Present when the command takes an inline argument. */
  argument?: AgentCommandArgument;
}

const goalArgument: AgentCommandArgument = {
  placeholder: 'Goal for this session',
  required: true,
};

const compactArgument: AgentCommandArgument = {
  placeholder: 'Optional compaction instructions',
  required: false,
};

/**
 * Claude Code. `/clear` is the single underlying command for both "new" and
 * "reset", so it is ONE row. Claude has both `/goal` and the new-clear row.
 */
const claudeCode: AgentCommand[] = [
  {
    command: '/clear',
    label: 'New / clear conversation',
    description: 'Start a fresh conversation (clears current context).',
    destructive: true,
  },
  {
    command: '/compact',
    label: 'Compact context',
    description: 'Summarise the conversation to free up context.',
    argument: compactArgument,
  },
  {
    command: '/goal',
    label: 'Goal',
    description: 'Set a persistent objective for the session.',
    argument: goalArgument,
  },
  {
    command: '/rewind',
    label: 'Rewind',
    description: 'Roll back to an earlier point in the conversation.',
    destructive: true,
  },
  // Long tail (searchable).
  { command: '/resume', label: 'Resume', description: 'Resume a previous conversation.' },
  { command: '/context', label: 'Context', description: 'Show the current context usage.' },
  { command: '/model', label: 'Model', description: 'Switch the active model.' },
  { command: '/cost', label: 'Cost', description: 'Show token cost for the session.' },
  { command: '/review', label: 'Review', description: 'Request a code review.' },
  { command: '/init', label: 'Init', description: 'Initialise project memory (CLAUDE.md).' },
];

/**
 * Codex. `/new` (fresh conversation) is the curated row; `/clear` — which also
 * wipes terminal scrollback — lives in the long tail.
 */
const codex: AgentCommand[] = [
  {
    command: '/new',
    label: 'New conversation',
    description: 'Start a fresh conversation in this CLI session.',
    destructive: true,
  },
  {
    command: '/compact',
    label: 'Compact context',
    description: 'Summarise the conversation to free up context.',
    argument: compactArgument,
  },
  {
    command: '/goal',
    label: 'Goal',
    description: 'Set a persistent objective for the session.',
    argument: goalArgument,
  },
  { command: '/diff', label: 'Diff', description: 'Show the working-tree diff.' },
  // Long tail (searchable).
  {
    command: '/clear',
    label: 'Clear',
    description: 'Clear the terminal and start a fresh chat.',
    destructive: true,
  },
  { command: '/resume', label: 'Resume', description: 'Resume a previous conversation.' },
  { command: '/review', label: 'Review', description: 'Request a code review.' },
  { command: '/status', label: 'Status', description: 'Show the current session status.' },
  { command: '/model', label: 'Model', description: 'Switch the active model.' },
  { command: '/init', label: 'Init', description: 'Initialise project memory.' },
];

/**
 * OpenCode. `/new` and `/clear` are aliases, so they collapse to one row.
 * OpenCode is the one agent WITHOUT `/goal` — it is omitted, not stubbed.
 */
const openCode: AgentCommand[] = [
  {
    command: '/new',
    label: 'New / clear conversation',
    description: 'Start a fresh conversation (clears current context).',
    destructive: true,
  },
  {
    command: '/compact',
    label: 'Compact context',
    description: 'Summarise the conversation to free up context.',
    argument: compactArgument,
  },
  { command: '/sessions', label: 'Sessions', description: 'Browse and resume previous sessions.' },
  { command: '/undo', label: 'Undo', description: 'Undo the last change.', destructive: true },
  // Long tail (searchable).
  { command: '/redo', label: 'Redo', description: 'Redo the last undone change.' },
  { command: '/share', label: 'Share', description: 'Create a shareable link for the session.' },
  { command: '/export', label: 'Export', description: 'Export the conversation.' },
  { command: '/models', label: 'Models', description: 'Switch the active model.' },
  { command: '/init', label: 'Init', description: 'Initialise project memory.' },
];

/**
 * Grok. The one list here with NO Android original — `AgentCommandCatalog.kt`
 * covers three engines (30 entries) and grok is not among them, so this is
 * assembled from the Grok CLI's own command set rather than ported.
 *
 * That makes it the one list whose provenance is weaker than the rule at the
 * top of this file would like, and it is deliberately kept to commands that
 * are core to the CLI rather than padded to match the others' length. Grok is
 * already the engine this repo cannot get a receipt for — `agentLaunch.ts`
 * keeps its launch line minimal for exactly the same reason, no
 * `pocketshell agent grok --help` having been captured. When one is, check
 * this list against it; a command that turns out not to exist should be
 * DELETED, not left in with a caveat, because offering an unavailable command
 * is the failure mode the catalog exists to avoid.
 *
 * No `/goal`, following the opencode precedent: an engine that does not have
 * it gets it omitted, never stubbed.
 */
const grokBuild: AgentCommand[] = [
  {
    command: '/new',
    label: 'New conversation',
    description: 'Start a fresh conversation in this CLI session.',
    destructive: true,
  },
  {
    command: '/compact',
    label: 'Compact context',
    description: 'Summarise the conversation to free up context.',
    argument: compactArgument,
  },
  { command: '/context', label: 'Context', description: 'Show the current context usage.' },
  { command: '/export', label: 'Export', description: 'Export the current session.' },
  // Long tail (searchable).
  {
    command: '/clear',
    label: 'Clear',
    description: 'Clear the conversation history.',
    destructive: true,
  },
  { command: '/models', label: 'Models', description: 'Switch the active model.' },
  { command: '/usage', label: 'Usage', description: 'Show token usage for the session.' },
  { command: '/mcp', label: 'MCP servers', description: 'Manage connected MCP servers.' },
  { command: '/init', label: 'Init', description: 'Initialise project memory.' },
  { command: '/help', label: 'Help', description: "List the CLI's own commands." },
];

/** The full ordered list for one engine, curated-first then long tail. */
export function commandsFor(agent: ComposerAgentKind): AgentCommand[] {
  switch (agent) {
    case 'claude':
      return claudeCode;
    case 'codex':
      return codex;
    case 'opencode':
      return openCode;
    case 'grok':
      return grokBuild;
    default:
      return [];
  }
}

/** Case-insensitive substring match over command + label + description (:343). */
export function filterCommands(agent: ComposerAgentKind, query: string): AgentCommand[] {
  const all = commandsFor(agent);
  const needle = query.trim().toLowerCase();
  if (needle === '') return all;
  return all.filter(
    (c) =>
      c.command.toLowerCase().includes(needle) ||
      c.label.toLowerCase().includes(needle) ||
      c.description.toLowerCase().includes(needle),
  );
}

/**
 * Android: `SlashCommandAutocomplete.filteredCommands` (:68-71). Empty list
 * when there is no agent — a shell pane never gets a dropdown.
 */
export function filteredCommands(agent: ComposerAgentKind | null, query: string): AgentCommand[] {
  if (agent === null) return [];
  return filterCommands(agent, query);
}

/**
 * The text an accepted row inserts: the command, plus ONE trailing space when
 * it takes an argument so the caret lands ready to type it (:81-88).
 */
export function insertionTextFor(command: AgentCommand): string {
  return command.argument ? command.command + ' ' : command.command;
}
