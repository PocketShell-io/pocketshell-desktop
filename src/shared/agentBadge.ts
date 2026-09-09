/**
 * Which mark a session tab wears for the agent running in it
 *
 *
 * The classification itself is not decided here and is not decided anywhere in
 * this app: `@ps_agent_kind` is a per-session tmux user option written by the
 * helper's `pocketshell agent` wrapper in the process that becomes the agent,
 * and it reaches the renderer as `SessionSummary.agentKind`. This module is
 * presentation and nothing else — it answers "what does that kind look like on
 * a 12px tab".
 *
 * ## What the phone does, and why none of it is ported
 *
 * Checked before designing, because a difference from the phone should be a
 * decision rather than an accident. The Android app renders a **two-letter
 * monogram in a tinted pill** — `CL`, `CX`, `OC`, `GK`, `SH`, `?` —
 * (`sessionBadgeMonogram` in `app/.../projects/FolderListTreeChrome.kt`, drawn
 * by `shared/ui-kit/.../components/AgentKindBadge.kt`). Its tint is BINARY, not
 * per-kind: agent means one purple (`#A78BFA`), non-agent means grey, so
 * Claude, Codex, OpenCode and Grok are told apart by their letters alone. It
 * ships no per-agent drawable at all — `res/drawable/` holds only the launcher,
 * the quick-settings tile and the two notification marks.
 *
 * So there was nothing to port, and the one mechanism it does have cannot come
 * across: a letter standing in for a graphic affordance is exactly what
 * `tests/unit/designGates.test.ts` enforces.
 * A monogram would also inherit the UI font at the tab's own size rather than
 * the stroke weight the rest of the bar shares — the same reason `type` is a
 * drawn "T" in AppIcon.vue and not a typed one.
 *
 * ## The marks are arbitrary, and say so
 *
 * Vendor logos at 12-14px are a licensing and fidelity trap — half of them are
 * trademarks, all of them are drawn for a different stroke weight, and none of
 * them survives being flattened to one `currentColor` outline. So these are
 * four ordinary Feather marks whose only job is to be TOLD APART: a closed
 * angular outline, a symmetric pair of chevrons, an asymmetric chevron-plus-rule,
 * and a jagged bolt. Nothing here claims a mark means Claude in the world; it
 * means Claude on this bar, the tooltip says so on first hover, and that is the
 * same contract a colour swatch has.
 *
 * They are named by SHAPE in AppIcon.vue (`hexagon`, `code`, `terminal`, `zap`)
 * and mapped to kinds here, so the icon registry stays a registry of marks and
 * this file is the only place that knows which product wears which.
 *
 * ## Nothing at all for unknown, and that is the point
 *
 * The unknown case is common and legitimate. A session started outside the
 * `pocketshell agent` wrapper — by hand, by `tmuxctl`, by the user's own
 * terminal — reads as `unknown` forever, because the wrapper is what records
 * the option; and a plain shell tab is not a failure of detection, it is a
 * shell. Marking either would put a glyph on most of the bar that means "we do
 * not know", which is worse than silence: it costs the same 12px, it trains the
 * eye to ignore the slot, and it takes away the only useful property a sparse
 * badge has — that its PRESENCE is information.
 *
 * `probing` and `exited` are the phone's transient detector states. The desktop
 * runs no detector so nothing emits them, and they are listed in the switch
 * anyway so this stays exhaustive against the same enum the phone renders.
 */

import type { SessionAgentKind } from './types.js';

/**
 * The AppIcon marks this module may name.
 *
 * A narrow union rather than an import of `AppIconName`, because that type
 * lives inside a `.vue` SFC and this module is plain shared code that the main
 * process's `tsconfig` also compiles. The link between the two is checked where
 * it matters anyway: the template binds this string to `<AppIcon :name>`, so a
 * mark renamed in the registry fails `vue-tsc` at the call site rather than
 * rendering an empty `<svg>`.
 */
type AgentMarkName = 'hexagon' | 'code' | 'terminal' | 'zap';

/** What a session tab shows for one agent kind. */
export interface AgentMark {
  icon: AgentMarkName;
  /** Tooltip text. The mark is arbitrary; this is what makes it legible. */
  label: string;
}

/**
 * The mark for [kind], or null when the tab should show nothing.
 *
 * Null is the answer for every kind that is not one of the four engines — see
 * the header for why `unknown` and `shell` deliberately get no glyph rather
 * than a "we don't know" one.
 *
 * `grok` is badged unconditionally, and that is independent of whether this
 * app could have started the session. Launching one now depends on the HOST —
 * 0.4.44's `pocketshell agent` has no `grok` subcommand, newer helpers do, and
 * `agentLaunch.ts` probes for it — while a session can be a grok session
 * regardless: the phone launches it through its own engine registry and the
 * tmux option is on the session either way. Reading our own capability, or a
 * particular host's, out of the record we are merely displaying would badge
 * the same session differently depending on which machine it came from.
 */
export function agentMark(kind: SessionAgentKind | null | undefined): AgentMark | null {
  switch (kind) {
    case 'claude':
      return { icon: 'hexagon', label: 'Claude Code' };
    case 'codex':
      return { icon: 'code', label: 'Codex' };
    case 'opencode':
      return { icon: 'terminal', label: 'OpenCode' };
    case 'grok':
      return { icon: 'zap', label: 'Grok' };
    case 'shell':
    case 'unknown':
    case 'probing':
    case 'exited':
    case null:
    case undefined:
      return null;
    default:
      // An enum member added host-side that this build does not know about.
      // Silence is the safe answer for the same reason `unknown` gets it.
      return null;
  }
}
