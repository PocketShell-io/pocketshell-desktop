# Prompt Composer — Desktop Implementation Spec

Status: **built.** `src/renderer/components/PromptComposer.vue` +
`src/renderer/stores/composer.ts` implement Part II. Where the code and this
document have diverged, the code won.

**Citation convention.** Paths starting `app/` or `core/` are in the Android
repo at `C:\Users\alexey\git\pocketshell`. Paths starting `src/` or `docs/` are
in this repo, `C:\Users\alexey\git\pocketshell-electron`. Every behavioural
claim in Part I carries a `file:line`.

Part I documents the phone app as built, so the desktop can be implemented
without re-reading Kotlin. Part II is the desktop spec.

---

# Part I — The Android composer, as built

## 1. Where it lives, who owns it, how it opens

The composer is a **Material 3 modal bottom sheet** hosted by the *session*
screen, not by a tab.

- Entry point composable: `PromptComposerSheet` — `app/src/main/java/com/pocketshell/app/composer/PromptComposerSheet.kt:179`.
- Body renderer (pure, previewable, and what every instrumented test drives):
  `SheetContent` — `PromptComposerSheet.kt:516`.
- State owner: `PromptComposerViewModel` — `app/src/main/java/com/pocketshell/app/composer/PromptComposerViewModel.kt`.
- Host wiring: `app/src/main/java/com/pocketshell/app/tmux/TmuxSessionScreen.kt:2194-2281`.

**Scope of the ViewModel: activity-scoped, shared across every session on a
host.** This is stated at `PromptComposerViewModel.kt:813-820` and is the direct
cause of issue #746 (drafts bleeding between sessions), which the app then works
around with an owner stamp (§4.4). The composer is *not* per-tab: the Terminal /
Conversation tab choice only selects the **send route**
(`TmuxSessionScreen.kt:2184-2186`, `:3163-3179`), never a different composer.
The draft is scoped by session, via `composerTargetKey = "$hostId/$sessionName"`
(`TmuxSessionScreen.kt:2207`).

Open triggers (all set the host's `showMicSheet` flag):

| Trigger | Site |
| --- | --- |
| Composer launcher chip in the bottom control row (unconditional — needs no live pane) | `TmuxSessionScreen.kt:1873` |
| Tapping a rendered engine command in the terminal (`/clear` etc.) — pre-fills the draft, then opens | `TmuxSessionScreen.kt:722-727` |
| Share-into-session intent — seeds attachment tiles, then opens | `TmuxSessionScreen.kt:616-620` |
| File viewer's "Attach to current session" — seeds a review prompt into the draft, then opens | `TmuxSessionScreen.kt:629-633` |

Close triggers: header `×` (`PromptComposerSheet.kt:820-836`), scrim tap,
swipe-down, system Back (`TmuxSessionScreen.kt:5559` routes Back to
`onDismissMicSheet` before any other handler), and a **successful** send
(`PromptComposerSheet.kt:322-323`). All of them run `dismissComposer`
(`PromptComposerSheet.kt:361-364`), which releases the mic and calls the host's
`onDismiss` — **and deliberately preserves the draft** (stated at
`PromptComposerViewModel.kt:779-782`).

## 2. Anatomy

`SheetContent` renders, top to bottom (`PromptComposerSheet.kt:770-1280`):

1. **Slash-command dropdown** — floats at the *top* of the column, above the
   field, so the IME can never occlude it. Only when the leading token is a `/`
   and the filtered catalog is non-empty.
2. **Header** — "Prompt Composer" title + a circular `×` chip. Hidden entirely
   when the soft keyboard is up (§3).
3. **Scroll region** (`weight(1f, fill = false)` + `verticalScroll`) containing,
   in order: the **draft field** (multi-line, placeholder `"Compose prompt…"`,
   self-scrolling to keep the caret visible; the IME size dance is §3.3); an
   **error / status banner** with an inline **Discard** button whenever there is
   something to clear; attachment upload progress; the **staged attachment
   tiles** — compact square tiles, image thumbnail or file-type tile, each with
   an `×` remove control.
4. **Connection-lost row** — deliberately *outside* the scroll region so it is
   sticky above the Send row. Copy:
   `"Connection lost — Send will retry once reconnected."`
5. **Control row** (sticky): left, one rounded pill grouping **📎 attach**,
   **`{}` snippets**, **`/` slash** — all three disable while transcribing or
   while an attachment batch is uploading; `/` additionally disables when no
   agent is detected. Right: a single primary **Send** button, then the mic disc.

There is **no** separate "Insert" button and **no** keyboard-raise button — both
were removed. Every region above has a direct counterpart in
`PromptComposer.vue` (the mic and its states excepted, §22).

## 3. Visibility / expand state machine — the important part

`ComposerPartialExpandE2eTest` is where the current truth is written, and it is
*not* what its own name suggests. Read
`app/src/androidTest/java/com/pocketshell/app/composer/ComposerPartialExpandE2eTest.kt:146-179`:
the test **no longer asserts the `PartiallyExpanded` enum**. It asserts two
user-facing invariants instead, because forcing the partial anchor by
over-sizing the content is exactly what shipped the #615 regression.

The as-built machine has **three sheet values × two IME states**, and the app
treats the IME dimension as chrome, not as a state:

### 3.1 Sheet values (Material 3 `SheetValue`)

| Value | How reached | Notes |
| --- | --- | --- |
| `Hidden` | Not composed (`showMicSheet == false`), or dismissed | Draft survives (§4) |
| `PartiallyExpanded` | Default landing state — `rememberModalBottomSheetState(skipPartiallyExpanded = false)` (`PromptComposerSheet.kt:216`) | The compact resting state |
| `Expanded` | User drags the sheet upward | **Unreachable while the keyboard is up** — the `Expanded` anchor *is* the IME-resized `maxHeight`, so `expand()` is a no-op (`PromptComposerSheet.kt:721-724`) |

The sheet is **content-height (wrap-content)**, not a height fraction
(`PromptComposerSheet.kt:370-392`). #615 made it a fully-expanded sheet plus a
manual IME inset and produced a keyboard-height void, a jump-to-top and a
cut-off; #682 reverted to wrap-content.

### 3.2 The invariant that actually matters

From `ComposerPartialExpandE2eTest.kt:154-179`, asserted with real geometry:

1. The sheet is **open** (non-`Hidden`).
2. The **terminal text above it stays readable** — the marker text is
   `assertIsDisplayed()` *while* the composer is composed.
3. The draft field's `boundsInRoot.top > rootHeight * 0.25` — the composer is
   confined to the lower portion of the screen.

That is the whole "modal inversion" goal (#191/#234): never occlude the agent
output you are composing against.

### 3.3 The keyboard-up chrome variant (#801)

When `WindowInsets.ime` is non-zero (`PromptComposerSheet.kt:735-741`):

- The body is capped to `maxHeight - (ime - navBars)` — measured at ~175dp on a
  Pixel 7 (`:702-733`).
- The **header is dropped entirely** (`:802`), reclaiming ~58dp.
- Draft `minHeight` drops 96dp → 56dp (`:932`).
- Keyboard-down only, the scroll region additionally caps at 360dp
  (`:868-876`, constant at `:2910`).

Everything in this subsection is a soft-keyboard artifact. **None of it ports.**

### 3.4 What persists across visibility transitions

Everything the user authored. Dismissal (`×`, scrim, Back, swipe) calls only
`cancelRecording()` + `onDismiss()` (`PromptComposerSheet.kt:361-364`); it never
touches the draft, the attachment tiles, or the error banner. Only three things
clear state: a confirmed delivery, an explicit Discard, and a session switch
(§4).

## 4. Draft lifecycle

### 4.1 Every edit is mirrored and persisted

`onDraftChange` (`PromptComposerViewModel.kt:286-300`) writes the text to
`SavedStateHandle[KEY_DRAFT]`, stamps `KEY_DRAFT_OWNER` with the current target
(null when the text is empty), updates `uiState.draft`, and **clears
`uiState.error`**. Keys at `:2544` and `:2558`. Restored on construction at
`:117`.

### 4.2 Send does not clear optimistically (#745)

`dispatchSendNow` (`:661-712`) flips `sendInFlight = true`, clears the error,
emits a `SendRequest` on a buffered `Channel` — and **leaves the draft and the
tiles on screen**. `PromptComposerSendDismissE2eTest.kt:48-55` states the bug
this fixed: "first the message disappears from the Composer and then sometimes
the Composer stays on the screen."

- **Delivered** → `markSendDelivered()` (`:725-737`) clears attachments, resets
  upload state, `onDraftChange("")`, then the host dismisses the sheet
  (`PromptComposerSheet.kt:322-323`).
- **Failed or timed out** → `restoreFailedSend()` (`:746-774`). The composer
  **stays open**. It puts the *composed* payload (text **with** the attachment
  paths already folded in) back in the draft, sets
  `"Not sent. Reconnect, then send again or discard the draft."`, and **drops
  the attachment tiles** — explicitly so the resend does not double-append the
  paths (`:768-770`). Proven end-to-end at
  `PromptComposerSendDismissE2eTest.kt:271-298`: the restored draft still
  contains both the attachment path and the typed text, and a later successful
  resend still carries the path.
- Timeout: the host `onSend` is wrapped in
  `withTimeoutOrNull(SEND_TIMEOUT_MS)` where `SEND_TIMEOUT_MS = 12_000`
  (`PromptComposerSheet.kt:314`, constant at `PromptComposerViewModel.kt:2535`).
  A timeout is treated exactly like a `false`.

### 4.3 Discard is the only user control that throws work away

`discardDraft()` (`:783-800`): cancels any in-flight attachment upload, clears
the draft, the tiles, the error, and both `SavedStateHandle` keys. Surfaced
*only* as the `Discard` button inside the error banner
(`PromptComposerSheet.kt:970-985`, tag `prompt-composer-discard`).
`PromptComposerDiscardE2eTest.kt:160-226` pins it: after Discard the draft is
`""`, `error` is `null`, the banner is gone, and **the composer is still open**.

The header `×` explicitly does **not** discard (`PromptComposerViewModel.kt:781`).

### 4.4 Session switch discards a foreign draft

`onComposerTargetChanged(targetKey)` (`:813-840`), called from
`LaunchedEffect(composerTargetKey)` (`PromptComposerSheet.kt:343-345`):

- no draft and no attachments → no-op;
- `draftOwner == null` (restored from process death before a target was known) →
  **adopt** the new target;
- `draftOwner != targetKey` → `discardDraft()`.

`PromptComposerDiscardE2eTest.kt:231-276` proves a "Not sent" draft authored in
session A is gone (draft `""`, error `null`, banner absent) after retargeting to
session B.

**This whole mechanism only exists because the ViewModel is a single
activity-scoped instance.** See §12.4 for why the desktop must not port it.

### 4.5 Summary table

| Event | Draft | Attachment tiles | Error banner | Composer open? |
| --- | --- | --- | --- | --- |
| Dismiss (`×`, scrim, Back, swipe) | kept | kept | kept | closed |
| Send tapped (in flight) | kept, visible | kept, visible | cleared | open, Send disabled + spinner |
| Send delivered | cleared | cleared | cleared | **closed** |
| Send failed / 12s timeout | replaced by composed payload | **dropped** (folded into text) | "Not sent…" + Discard | **open** |
| Discard tapped | cleared | cleared | cleared | open |
| Switch to another session | discarded if owned elsewhere | discarded with it | cleared | — |
| Process death / rotation | restored from `SavedStateHandle` | **lost** (not persisted) | lost | — |
| Any keystroke | — | — | **cleared** (`:299`) | — |

## 5. Send — composition, routing, delivery

### 5.1 The composition rule (load-bearing)

`appendAttachmentPaths` (`PromptComposerViewModel.kt:2645-2660`): the staged
remote paths are **appended at the end**, never prepended, as an
`Attached files:` header followed by one `- <remote path>` line per attachment,
separated from the user's text by **exactly one blank line**. A blank draft
(whitespace-only counts) is *replaced* by the block, so an attachment-only send
is legal. Example:

```
what is wrong here

Attached files:
- ~/.pocketshell/attachments/main/20260824-101500-01-shot.png
- ~/.pocketshell/attachments/main/20260824-101500-02-log.txt
```

Called once, at send time only, from `dispatchSendNow` (`:670`). The draft text
is **never** mutated by attaching — stated at `:301-309`, `:2176-2179`,
`:407-410`. The TypeScript port is §14.

### 5.2 Send gating

- Button enabled predicate (`PromptComposerSheet.kt:1202-1207`):
  `(liveEditorText.isNotEmpty() || attachments.isNotEmpty()) && !sendInFlight`.
  It reads the **live editor value**, not the ViewModel draft — issue #491, so
  an uncommitted IME composing region still enables Send.
- ViewModel guards (`:662`, `:672`): no-op if a send is already in flight; no-op
  if the *composed* text is empty.
- Sending while an attachment batch is still uploading **waits for it**, then
  sends with the image included. §16.0 is the desktop rule and its rationale.

### 5.3 "Send" vs "Send + Enter"

`SendRequest` carries `withEnter` (`PromptComposerViewModel.kt:2298-2301`) — but
**inside the composer it is always `true`**. Every send affordance calls
`onSend(true)`: `commitAndSend` (`PromptComposerSheet.kt:678`), the recording
`StopSendButton` (`:1250`), the transcribing `StopSendButton` (`:1270`). Issue
#453 collapsed the old Insert/Send pair into one button whose tag is still
`prompt-composer-send-enter` (`:2761-2769`).

The `withEnter = false` half survives **only outside the composer**, in the
snippet picker's explicit `Send` / `Send + ↵` chips
(`app/src/main/java/com/pocketshell/app/snippets/SnippetPickerSheet.kt:414-440`).
That is issue #187: the fix was to replace a smart-default tap surface with two
explicitly-labelled actions, and per **D22** (hard-cuts-only) the legacy
row-body smart-default was deleted rather than kept behind a flag
(`TmuxSessionScreen.kt:2286-2291`).

**Desktop consequence:** the composer has exactly one Send verb, and it submits.
Do not build an Insert/Send pair.

### 5.4 Routing

`TmuxComposerSendRoute` — `TmuxSessionScreen.kt:3159`, decision function at
`:3163-3179`:

```kotlin
when {
    viewingConversation                    -> AgentConversation
    withEnter && liveAgent == Codex        -> AgentPayload
    liveAgent != null                      -> RawBytes
    presumedAgentKind != null              -> AgentPayload
    else                                   -> RawBytes
}
```

where `viewingConversation = detection != null && selectedTab == Conversation`
(`:2184-2186`).

| Route | Transport | Extra |
| --- | --- | --- |
| `AgentConversation` | `sendToAgentPaneResult(paneId, text)` | Also echoes an optimistic user turn into the transcript |
| `AgentPayload` | `sendAgentPayloadToPaneResult(paneId, text, agentKind)` | Bracketed paste + a submit-delay before Enter |
| `RawBytes` | `writeInputToPaneResult(paneId, (withEnter ? text + "\r" : text).toByteArray())` (`:2258-2262`) | — |

### 5.5 Multi-line delivery — bracketed paste (#209)

Because §5.1 *always* introduces newlines when attachments are staged, and
because the user can type newlines, the payload is routinely multi-line. Naïve
delivery would make an agent REPL submit each line as a separate prompt — the
bug found in daily use on 2026-05-27
(`app/src/main/java/com/pocketshell/app/tmux/TmuxSessionViewModel.kt:9775-9795`).
The phone solves it inside `sendInputBytesToPane` (`:9758`) with bracketed-paste
markers and a delayed submit; the desktop equivalent, which must implement the
framing itself, is **§16.2 — the single home for this mechanism**.

## 6. Attachments in the composer

Staged attachments are **structured state, never folded into the draft while
composing** — `StagedAttachment(remotePath, displayName, previewUri, mimeType)`
at `PromptComposerViewModel.kt:2183-2189`, list at `:2245`.

- **Staging**: `attachFiles(count, previews, stage)` (`:311-390`). Single-flight
  — a second call while a batch is in flight is a no-op (`:315`). Bounded by
  `ATTACHMENT_UPLOAD_TIMEOUT_MS = 90_000` (`:326`, `:2521`).
- **Merge**: `mergeStagedPaths` (`:403-427`) de-duplicates by `remotePath` and
  appends in order.
- **Partial failure (#570)**: paths that *did* upload are attached **and** the
  error is shown — never discard survivors (§17 has the desktop contract).
- **Display name**: last path segment only, never the full remote path —
  `attachmentDisplayName` (`:2675-2679`).
- **Removal**: `removeAttachment(remotePath)` (`:528-546`) — identity is the
  remote path; the draft is untouched.
- **Seeding**: `seedAttachment(remotePath)` (`:443-473`) attaches an
  already-uploaded path without re-uploading (the share-into-session flow),
  de-duplicating.
- **Remote location**: `~/.pocketshell/attachments/<scope>/`
  (`app/src/main/java/com/pocketshell/app/composer/PromptAttachmentStager.kt:212`).
- **Failure copy**: `"Attachment upload failed: <detail>. Your draft was kept;
  reconnect or choose a smaller/readable file."` (`:2681-2689`).

Behavioural proof that attach and typing coexist:
`PromptComposerSendDismissE2eTest.kt:227-268` — attach first, then type; both the
tile and the typed text must be visible, and the draft must still be `""`
immediately after attaching.

## 7. Slash commands

Per issue #787 the standalone `AgentCommandSheet` palette and the bottom
`/ commands` chip were **deleted**; slash entry now lives *only* in the composer
(`TmuxSessionScreen.kt:2324-2330`).

Pure logic in `app/src/main/java/com/pocketshell/app/composer/SlashCommandAutocomplete.kt`:

- **`slashQueryFor(value)`** (`:47-61`) — dropdown open iff the text starts with
  `/` **and** the caret (selection start) is within the leading token (token =
  up to the first whitespace). Returns the substring after `/` up to that
  whitespace. A bare `/` yields `""` → the full catalog. Typing a space and
  moving on to the argument **closes** the dropdown.
- **`filteredCommands(agent, query)`** (`:68-71`) — empty list when `agent` is
  null. A shell pane never gets a dropdown.
- **`insertCommand`/`insertCommandText`** (`:81-105`) — replaces the leading
  slash token if one exists, otherwise prepends; preserves any trailing text;
  adds one trailing space for argument-taking commands; caret lands at the end
  of the inserted command.

Catalog source: `app/src/main/java/com/pocketshell/app/agentcommands/AgentCommandCatalog.kt:83`
— an **app-shipped, per-agent curated list** (30 `AgentCommand` entries across
Claude Code / Codex / OpenCode), deliberately *not* user CRUD.

The `/` **button** is not a second picker: it seeds a leading `/` into the field
and focuses it, which makes `slashQueryFor` non-null with a blank query — the
same dropdown. Desktop deltas (the ported catalog, keyboard navigation,
agent-kind gating) are §18.

## 8. Snippets

The `{}` button opens `SnippetPickerSheet` over the composer with
`kindFilter = Prompt` (`PromptComposerSheet.kt:455-481`).

**Composer-specific invariant** (`:456-472`): a pick **appends to the draft and
never sends**. The picker's `withEnter` signal is deliberately ignored — inside
the composer the compose-then-send safety rule wins. Separator: `""` if the draft
is empty or already ends with `\n` or a space, else `" "`.

Outside the composer the same picker *does* send directly, gated on liveness
(`TmuxSessionScreen.kt:2295-2320`).

## 9. Liveness guards

`sessionLive = status is ConnectionStatus.Connected` (`TmuxSessionScreen.kt:399`)
is the single source of truth.

- **Send is not gated.** Issue #548: send is *connect-on-action* — if the control
  channel dropped while the composer was open, the ViewModel kicks/reuses a
  reconnect and awaits the live client before returning failure
  (`TmuxSessionScreen.kt:2214-2218`). The 12s timeout (§4.2) converts a truly
  dead link into the "Not sent" banner.
- **Attach is not gated.** Issue #451: the file picker backgrounds the app, so on
  return the session may be briefly absent; `stagePromptAttachments` lazily
  reconnects and awaits (`TmuxSessionScreen.kt:2273-2280`).
- **Advisory indicator, not a block.** `connectionLost = !sessionLive` is pushed
  in (`:2212`) → `setConnectionDegraded` (`PromptComposerViewModel.kt:850-853`,
  documented as advisory at `:841-849`) → the sticky "Connection lost" row.
- **The snippet picker outside the composer *is* hard-gated** on `sessionLive`
  (issue #249, `TmuxSessionScreen.kt:2302-2308`), as are terminal hotkeys. The
  asymmetry is intentional: a composed prompt is worth reconnecting for; a
  keystroke is not.

## 10. Voice (documented for completeness — not ported)

Roughly two thirds of `PromptComposerViewModel.kt` is dictation — a three-state
FSM, Whisper and Android-speech providers, a mic lock, a pending-transcription
retry queue, an API-key vault — and none of it has a desktop analogue. The full
inventory of what is deliberately not ported is §22.

---

# Part II — Desktop specification

## 11. Where the composer lives in the new navigation

**Position: the composer is per-session, owned by the folder workspace shell,
and follows the active session tab. It is not rendered on a Files tab.**

`FolderWorkspaceView` — a workspace whose tab bar carries one tab per tmux
session and then Files tabs; there is no Conversation tab — mounts
`<PromptComposer/>` **once**, outside the tab body, and keeps it alive across
tab switches (`v-show`, never `v-if`) so the draft, caret and scroll position
survive a tab change; it is shown only while the active tab is a session tab
(`src/renderer/views/FolderWorkspaceView.vue:1981-1998`). Which session the
composer holds is the active SESSION TAB, not a route param. The dock floats
*over* the tab content rather than docking below it (§21.1).

```
FolderWorkspaceView                (src/renderer/views/FolderWorkspaceView.vue)
├── tab bar    one tab per tmux session, then Files tabs
├── tab body   TerminalView per session (v-show) / FilesView
└── .composer-dock   <PromptComposer/>, v-show on session tabs only
```

Route: `/host/:name/folder/:folder` with the active tab as the `?tab=` query
parameter (`src/renderer/router.ts:41-44`). vue-router reuses the
`FolderWorkspaceView` instance, so the component is **not** remounted; a `watch`
on `sessionName` swaps which per-session record it reads and restores that
record's caret and focus (`PromptComposer.vue:258-264`).

## 12. Visibility state machine (desktop)

Three states, **app-level** (not per session), persisted.

```ts
type ComposerMode = 'hidden' | 'docked' | 'expanded';
```

| State | Rendering | Geometry |
| --- | --- | --- |
| `hidden` | The card is gone; the **fixed toggle** (§21.4) remains — a 24px icon button wearing a pip when a draft or attachment is waiting | pinned to the pane's bottom-right corner, floating over the terminal |
| `docked` (default) | Full card | the remembered geometry: position and size, both dragged by the user, default 720—240 in the resting corner |
| `expanded` | Same card, maximized | fills the dock: full width, height capped at 80% of the body. Ignores the remembered geometry, which `docked` returns to |

The `hidden` rail is a **desktop addition** and is deliberate: the phone loses
the composer entirely when closed, so a preserved "Not sent" draft becomes
invisible (issue #695's complaint class). A persistent rail costs 32px and
guarantees a stale draft is always discoverable.

**The mode is not per session.** Open/closed/maximized is a **preference about
the tool**; the draft, its attachments, the caret and the dragged height are
**facts about a session**. Only the second group is keyed by `targetKey` (§15).
A dismissal remembers the mode, so re-opening restores docked-vs-maximized —
once for the app rather than once per session.

### 12.1 Transitions

| From | Trigger | To |
| --- | --- | --- |
| `hidden` | click the fixed toggle / `Ctrl+\`` / `Ctrl+Shift+K` | the last open mode, draft focused |
| `hidden` | `Ctrl+Shift+↑` | `docked` (grow) |
| `hidden` | a seed action (slash command tapped in the terminal, "send to composer" from Files, paste-to-attach) | the last open mode, draft focused |
| `docked` | click the **same** fixed toggle / `Ctrl+\`` / `Ctrl+Shift+K` / `Ctrl+Shift+↓` | `hidden` |
| `docked` | `Ctrl+Shift+↑` / the header's maximize button / double-click the header | `expanded` |
| `expanded` | `Ctrl+Shift+↓` / the header's restore button | `docked` |
| any non-hidden | `Escape` (§12.2) | `hidden`, focus to the terminal; draft kept — unless short enough for the hand-off (§12.2) |
| any | **successful** send | unchanged — the card stays open and focused (§12.3); with `closeComposerOnSend` (§26.2), `hidden`, from which typing re-opens the last open mode |
| any | failed send | unchanged, banner shown |
| any | session switch | **unchanged.** The panel does not open or close because you changed session; only which draft it shows changes |

### 12.2 Escape closes it

**Escape closes the composer.** The user asked for the plain meaning of the key:
*"esc should close the prompt composer."* Two rungs, first match wins:

1. **Slash dropdown open** — close the dropdown only. It is the one thing more
   local than the panel; Escape closes what you opened last, and picking a
   command is not a reason to lose the whole composer.
2. **Otherwise** — close it, and hand focus back to the terminal.

**Escape never destroys work.** Discard is the only control that throws work
away (§4.3), and a close keeps the draft — with one deliberate exception that
MOVES work rather than destroying it:

**The short-draft hand-off.** A user close — Escape, `Ctrl+\``, the toggle, the
card's close, shrink past `docked` — with a draft of fewer than five
characters hands that text to the pane: written raw into the PTY, no Enter,
the draft cleared, and the typing intercept (§26.1) stood down until the
composer is next summoned. The user's rule, in as many words: start typing,
press Esc, and what was typed should be at the prompt to continue typing
there — but only while it is under five characters. Two or three characters
are keystrokes the intercept borrowed on their way to the pane — a shell
command put back where it was heading; five or more are a prompt, and a
dismissal never moves one. The rest of the gate lives with the pure helpers
(`canFlushDraftToTerminal`, §14): single-line only, because a written line
break would SUBMIT whatever precedes it, and never with attachments, a
failure banner, or a send/upload in flight. No registered shell, or the
connection down, means no hand-off either — moving text to nowhere is losing
it, so the close is an ordinary one and the draft stays. The mechanism's home
is the store's `flushToTerminal(key, write)`, the same injected-transport
shape as `send`; the stood-down state is the store's `terminalOwnsTyping`,
cleared the moment the panel is summoned again.

**Clicking outside closes it — but only when it is empty.** Implemented with
three guards, each of which is the whole safety of the feature:

- **Empty only.** Empty means no draft text, no staged attachments, no failure
  banner, nothing in flight. **Whitespace-only counts as empty** — the store
  already refuses to send `payload.trim() === ''`, so three spaces are not work
  by any definition the app already uses. With anything else present the click
  does nothing: dismissing unsent work because the user clicked the terminal to
  read something would be invisible until they went looking for it.
- **Gated on the press, not the click.** The card is movable and resizable, and
  both routinely travel outside its own bounds before the button comes up.
  Keying on `mousedown` and on where it LANDED means an interaction that started
  inside the composer can never dismiss it, however far it travels.
- **Inside means inside `.composer-root`** — the card, its grips, its header,
  the pinned toggle and the doodle overlay are all descendants. The toggle in
  particular sits outside the CARD but inside the composer, so a naive handler
  would close on its press and let its own click re-open, which reads as
  nothing happening.

It does **not** suppress the typing intercept — the hand-off above is the only
close that does, and a click-outside can never be one: it fires on an EMPTY
composer only (§26.1). A click elsewhere is incidental — the user reached for
the terminal, not against the composer — and the composer was empty, so
nothing was lost; typing afterwards almost certainly means they want it back.
The rule that falls out, and the one to keep in mind when adding any future
dismissal:

> **A dismissal puts the view away. It speaks for the next keystroke only when
> it has somewhere to put the user's text — the hand-off's text sitting at the
> prompt. Silence without that visible fact is the hatch that was removed, and
> it stays removed.**

It does not move focus either: the click already decided where focus goes. One
press, one meaning — and the only meaning is close.

| Closed by | Means | Next keystroke |
|---|---|---|
| **the user**, empty or long draft — Escape, `Ctrl+\``, `Ctrl+Shift+K`, `Ctrl+Shift+↓`, the toggle, the card's close | "put it away" | **re-opens** the composer, carrying that character |
| **the user**, short draft — the same keys | "put this back where I was typing" | **the shell keeps them**: the text is at the prompt and the intercept stands down until the composer is summoned again |
| **a delivered send** (`closeComposerOnSend`, §26.2) | "that one's away, next?" | **re-opens** the composer, carrying that character |

All four user-close routes behave identically, which is the point: a user who
dismisses three different ways must not get three different results.

**The two paths stay distinct in the model even though they agree.**
`dismiss()` still exists as its own action — it is where the user-close path can
be given behaviour again without hunting down four call sites, and the two
closes are different facts about the world even when they produce the same
state. Collapsing them into one boolean is precisely what would make them cancel
each other out the next time one of them needs to differ.

### 12.3 A successful send does not hide the composer

The phone dismisses the sheet on delivery (`PromptComposerSheet.kt:322-323`)
because the sheet occludes the terminal on a phone screen. On desktop the
composer is a non-modal floating card — no scrim, nothing to dismiss — and the
user asked to interact *primarily* through it. So: on delivery, clear the draft
and the tiles, keep the card open and focused, ready for the next prompt. This is a deliberate,
justified divergence — record it in the component's header comment.

### 12.4 What persists — and the one mechanism NOT to port

Per session key, everything persists across every mode transition and every tab
switch: draft text, caret/selection, staged attachments, error banner and scroll
position. The **mode and the card's geometry are not among them** — both are
app-level, stored under their own key (§12, §15). The height moved to that side
with the rest of the geometry: a box split across two scopes would have to be
assembled from two places on every render.

**Do not port the #746 owner-stamp discard-on-switch mechanism.** It exists
solely because the Android ViewModel is a single activity-scoped instance shared
by all sessions (`PromptComposerViewModel.kt:813-820`). A Pinia store can hold a
`Map<targetKey, ComposerSessionState>`, so the desktop keeps a **per-session
draft** — which satisfies the same user-visible invariant the Android hack
enforces ("a draft never appears in a session it was not authored in") while
being strictly better: switching away and back restores your prompt instead of
destroying it. Persist the map via `electron-store` so drafts survive an app
restart, replacing `SavedStateHandle` (`:2544`, `:2558`) — and, unlike Android,
persist the attachment list too (Android loses it on process death because only
`KEY_DRAFT` is saved).

The connection id is a transport handle, not the identity of the session. When
the SSH link reconnects, the renderer keeps the composer mounted and moves every
`<oldConnectionId>/<sessionName>` record to the replacement id before exposing
it. Terminal re-attachment also leaves focus alone when the composer (or another
control) already owns it, so a reconnect cannot send the next typed character
to the terminal.

## 13. Files and component tree

```
src/shared/
  composerText.ts          appendAttachmentPaths, slashQueryFor, insertCommandText,
                           attachmentDisplayName, isTypingKey, insertAtCaret, railToggle
  composerSend.ts          ComposerSendRoute, sendRoute, the bracketed-paste framing,
                           deliverPayload, composerTiming
  composerAttachments.ts   staging list helpers: dedupe, replaceStagedAttachment
  composerGeometry.ts      the geometry arithmetic (§21.1)
  doodleGeometry.ts        the doodle arithmetic (§27.5)
  agentCommands.ts         per-agent command catalog (data + filter)

src/renderer/stores/
  composer.ts              the Pinia store, keyed by session target;
                           ComposerMode and StagedAttachment live here
  shells.ts                sessionKey -> ShellId registry (§25.2)

src/renderer/components/
  PromptComposer.vue       the whole composer; owns layout + shortcuts
  ComposerAttachmentTiles.vue
  SlashCommandDropdown.vue
  DoodleCanvas.vue         the annotate surface (§27)

src/renderer/views/
  FolderWorkspaceView.vue  mounts <PromptComposer/> once, outside the tab body (§11)
```

All components `<script setup lang="ts">`, with a top-of-file block comment
explaining the component's job, as every existing file does.

## 14. Pure helpers (`src/shared/composerText.ts`)

Port these verbatim in behaviour; they are the only parts of the Kotlin with
unit-test-grade contracts.

```ts
/** Android: PromptComposerViewModel.kt:2645. Appends the staged remote paths
 *  at the END of the draft, one blank line apart, as a bullet list. */
export function appendAttachmentPaths(draft: string, paths: string[]): string {
  if (paths.length === 0) return draft;
  const block = 'Attached files:' + paths.map((p) => `\n- ${p}`).join('');
  if (draft.trim() === '') return block;          // Kotlin isBlank()
  if (draft.endsWith('\n\n')) return draft + block;
  if (draft.endsWith('\n')) return draft + '\n' + block;
  return draft + '\n\n' + block;
}

/** Android: SlashCommandAutocomplete.kt:47. Null = dropdown closed. */
export function slashQueryFor(text: string, caret: number): string | null {
  if (!text.startsWith('/')) return null;
  const ws = text.search(/\s/);
  const tokenEnd = ws < 0 ? text.length : ws;
  if (caret < 0 || caret > tokenEnd) return null;
  return text.slice(1, tokenEnd);
}

/** Android: SlashCommandAutocomplete.kt:94. Returns [newText, newCaret]. */
export function insertCommandText(text: string, commandText: string): [string, number] {
  let tokenEnd = 0;
  if (text.startsWith('/')) {
    const ws = text.search(/\s/);
    tokenEnd = ws < 0 ? text.length : ws;
  }
  return [commandText + text.slice(tokenEnd), commandText.length];
}

/** Android: PromptComposerViewModel.kt:2675. Last path segment, never the full path. */
export function attachmentDisplayName(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/, '');
  const seg = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return seg.trim() === '' ? remotePath : seg;
}
```

Note the Kotlin `isBlank()` vs `isEmpty()` distinction in the first function — a
whitespace-only draft is *replaced* by the attachment block, not appended to.

## 15. Pinia store (`src/renderer/stores/composer.ts`)

Follow the `defineStore(id, setup)` style used by
`src/renderer/stores/connection.ts:15` and `stores/agents.ts:16`.

```ts
export interface StagedAttachment {
  remotePath: string;      // stable identity, e.g. ~/.pocketshell/attachments/main/…png
  displayName: string;
  mimeType?: string;
  previewDataUrl?: string; // images only, for the tile thumbnail
}

export interface ComposerSessionState {
  draft: string;
  attachments: StagedAttachment[];
  error: string | null;
  sendInFlight: boolean;
  uploadingCount: number;      // 0 = idle;  Android AttachmentUploadState
  connectionDegraded: boolean;
  height: number | null;       // user-dragged px, null = the default 240
  caret: number;
}
```

Keyed by `targetKey = `${connectionId}/${sessionName}``, mirroring the phone's
`"$hostId/$sessionName"` (`TmuxSessionScreen.kt:2207`).

**Not keyed** (§12): `mode`, `lastOpenMode` and `geometry` are plain refs
on the store, persisted under `pocketshell.composer.visibility.v1` — a second key
rather than a version bump of `pocketshell.composer.v1`, so the drafts already on
disk survive the change and an old blob's per-session `mode`/`height` are simply
ignored. That key keeps its `visibility` name even though the payload has since
grown `geometry`: renaming it would orphan the blob and silently reopen every
user's composer, and a stale name is cheaper than a lost preference. A record
with no draft and no attachments is not written at all: `ensure()` touches a key
for every session merely visited, and without that filter the blob grows one
empty entry per session forever.

`geometry` is stored RAW and never re-clamped to the current pane. A window that
is briefly made small would otherwise permanently rewrite the user's layout to
whatever fitted it; the component clamps for display instead (§21.1).

Actions, one-for-one with the Kotlin so the mapping stays auditable:

| Store action | Android counterpart |
| --- | --- |
| `setDraft(key, text)` — also clears `error` | `onDraftChange` `:286` |
| `stage(key, sources)` — single-flight, 90s timeout, dedupe, keeps partial survivors | `attachFiles` `:311` + `mergeStagedPaths` `:403` |
| `seedAttachment(key, remotePath)` | `seedAttachment` `:443` |
| `seedPrompt(key, prompt)` — appends on its own line if a draft exists | `seedDraftPrompt` `:482` |
| `prefillCommand(key, command)` | `prefillEngineCommand` `:508` |
| `removeAttachment(key, remotePath)` | `removeAttachment` `:528` |
| `send(key)` | `requestSend`/`dispatchSendNow` `:605`/`:661` |
| `markDelivered(key)` | `markSendDelivered` `:725` |
| `restoreFailedSend(key, payload, message?)` | `restoreFailedSend` `:746` |
| `discard(key)` — cancels an in-flight upload first | `discardDraft` `:783` |
| `setConnectionDegraded(key, boolean)` | `setConnectionDegraded` `:850` |
| `setMode(mode)` / `toggleHidden()` / `grow()` / `shrink()` — **no key**, §12 | *(desktop only)* |
| `setGeometry(box)` / `resetGeometry()` — **no key**, §21.1 | *(desktop only)* |

Copy the strings exactly:

- `'Not sent. Reconnect, then send again or discard the draft.'` (`:747`)
- `'Connection lost — Send will retry once reconnected.'` (`PromptComposerSheet.kt:1102`)
- `'Attachment upload failed: <detail>. Your draft was kept; reconnect or choose a smaller/readable file.'` (`:2687`)
- `'Uploading N attachment(s)...'` (`PromptComposerSheet.kt:1010`)
- placeholder `'Compose prompt…'` (`PromptComposerSheet.kt:2829`)

## 16. Send path

### 16.0 An upload in flight is waited for, not abandoned

Sending while an attachment batch is still uploading waits for it, then sends
with the image included. The user attaches an image and then writes a prompt
ABOUT that image, so cancelling the batch would deliver a question with its
subject missing. Four things make the wait safe rather than a hang:

- **`sendInFlight` goes up BEFORE the wait.** The Send button reads it, so it
  disables; the single-flight guard reads it, so a second Enter is a no-op
  rather than a second prompt queued behind the same upload; `isEmpty` reads it,
  so a click-outside cannot dismiss a prompt parked on its own picture. #745's
  rule — draft and tiles stay on screen — simply holds through a longer wait.
- **The batch always settles.** `Batch.done` resolves on every exit including a
  throw, and the upload's own `uploadTimeoutMs` bounds the wait.
- **The payload is composed AFTER the wait.** Reading it first is precisely how
  a prompt about an image gets sent with the image missing.
- **A failed upload does not send.** The banner and the intact draft are what
  every other refusal in this store leaves behind, and the user can retry
  without retyping.

### 16.1 Sequence

1. Compose: `payload = appendAttachmentPaths(draft, attachments.map(a => a.remotePath))`.
2. Guard: return if `payload === ''` or `sendInFlight` (`:662`, `:672`).
3. If an upload is in flight, **wait for it** and compose the payload
   afterwards (§16.0).
4. `sendInFlight = true`, `error = null`. **Leave the draft and the tiles on
   screen** — this is #745 and it is the single most user-visible send rule.
5. Deliver (§16.2) with a 12 000 ms timeout (`SEND_TIMEOUT_MS`, `:2535`).
6. Delivered → `markDelivered` (clear draft + tiles, keep the composer open and
   focused, §12.3). Not delivered or timed out → `restoreFailedSend(payload)`:
   put the **composed** payload back in the draft, drop the tiles, show the
   banner with a Discard button.

### 16.2 Transport, and the bracketed-paste requirement

The desktop writes into a PTY running `tmux attach` via
`api.shell.input(shellId, data)`
(`src/preload/index.ts:198`, channel `shell:input` at `src/shared/channels.ts:58`).
There is no tmux control-mode client here, so **the renderer must apply the
bracketed-paste framing itself** — the Android side gets it for free inside
`sendInputBytesToPane` (`TmuxSessionViewModel.kt:9758-9800`, `:9860-9870`).

```ts
export async function deliverPayload(payload: string, opts: DeliverOptions): Promise<boolean> {
  const delay = opts.submitDelayMs ?? composerTiming.submitDelayMs;
  const wrote = await opts.write(frameForPaste(payload)); // BP_START…BP_END when multi-line
  if (!wrote) return false;                               // a dead channel never leaves a half-typed prompt
  if (delay > 0) await sleep(delay);                      // #526
  return opts.write(SUBMIT_KEY);                          // '\r', separately, after
}
```

Rules, each from the Kotlin:

- Wrap in `\e[200~`/`\e[201~` whenever the payload contains a line break
  (`TmuxSessionViewModel.kt:9781-9795`). Since §5.1 always adds newlines when
  attachments are staged, **any attachment send is a paste send**. Getting this
  wrong makes each line of an attachment block a separate agent prompt.
- Send the submit `\r` **separately, after** the paste block, never inside it
  (`:8777-8780`).
- Wait between the body and the Enter: the desktop takes 250 ms for **every**
  send (`composerTiming.submitDelayMs`, `src/shared/composerSend.ts:47`) — the
  safe end of the Android range (default 150 ms, `SettingsModels.kt:271`; 250 ms
  floor for Codex, `TmuxSessionViewModel.kt:12135`). It is imperceptible, and
  Enter must never race the TUI's paste ingestion.
- Programs that do not enable bracketed paste render the markers literally; the
  Kotlin accepts that degradation explicitly (`:9793-9795`). Do the same.

### 16.3 Routing

```ts
export type ComposerSendRoute = 'agent-payload' | 'raw';
```

Decision function, `sendRoute` (`src/shared/composerSend.ts:155`), mirroring the
phone's `tmuxComposerSendRoute` (`TmuxSessionScreen.kt:3163`): `withEnter &&
liveAgent === 'codex' → 'agent-payload'`; `liveAgent → 'raw'`; `presumedAgent →
'agent-payload'`; else `'raw'`.

**The Codex arm is live.** `liveAgent` is fed from the host-recorded
`@ps_agent_kind` tmux option via `agentKindFromTmuxOption`
(`src/main/helper/parsers.ts:216`) narrowed by `composerAgentKind`
(`src/shared/composerSend.ts:110`), arriving as the composer's `agentKind` prop.
`presumedAgent` has no desktop source yet — nothing infers an engine from
history.

The phone's third arm, `'agent-conversation'`, is gone rather than merely
unreachable: it existed for the Conversation tab, which is deleted, and it never
did anything the `'raw'` arm did not — it only short-circuited ahead of the
Codex arm, giving codex panes the short submit delay. Keep `sendRoute` pure and
unit-test it against the four cases (`tests/unit/composerSend.test.ts`).

### 16.4 Only one Send verb

Per §5.3 the composer submits, always. Do not build Insert/Send. If a "stage
without submitting" affordance is ever wanted, it belongs in a snippet-style
surface outside the composer, per #187.

## 17. Attachments (composer side)

The upload backend lives in `src/main/attachments/AttachmentStager.ts`; the IPC
is `attachments:stage` / `attachments:pickFiles`
(`src/shared/channels.ts:195-196`), typed in `src/preload/index.ts:695-728`.
The composer only consumes it.

- Call `api.attachments.stage({ connectionId, scopeKey, sources })` where
  `scopeKey` is the session name (the phone scopes per session —
  `PromptAttachmentStager.kt:47-49`).
- `StageAttachmentsResult` (`src/shared/types.ts:214`) already encodes the #570
  partial-failure contract: **when `ok === false` but `paths` is non-empty,
  attach those paths anyway and show `error`.** Do not throw the survivors away.
- Build tiles with `attachmentDisplayName(path)` — the file name, never the full
  remote path (`PromptComposerViewModel.kt:2675`).
- De-duplicate by `remotePath` (`:409-412`).
- Single-flight: ignore a second stage call while one is in flight (`:315`);
  disable the attach button meanwhile, but leave typing and text-only Send live
  (`PromptComposerSheet.kt:1150-1156`).
- 90 s timeout (`:2521`).
- Removing a tile never touches the draft (`:520-527`).
- After a failed send the tiles are gone and their paths live in the draft text
  (§4.2) — the resend must not re-append them.

Sources: `{ kind: 'file', path }` for the picker and drag-and-drop;
`{ kind: 'bytes', data, name, mimeType }` for clipboard paste
(`src/shared/types.ts:188-201`).

## 18. Slash commands

- Port `AgentCommandCatalog` to `src/shared/agentCommands.ts` as plain data
  (30 entries, `AgentCommandCatalog.kt:83-256`) plus the substring filter over
  command + label + description (`:268-277`). It is an app-shipped curated
  catalog, not user CRUD — do not build editing UI for it.
- **Grok is the one list with no Android original.** The Kotlin catalog covers
  claude/codex/opencode only, but `grok` is a real `SessionAgentKind` that
  `composerAgentKind` passes through, so a grok pane reaches the dropdown and
  needs a list of its own. It is assembled from the Grok CLI's own commands
  rather than ported, which makes it the one entry without a receipt — the
  same gap `agentLaunch.ts` documents for `pocketshell agent grok`. When a
  `grok --help` is finally captured, check the list against it and DELETE
  anything that turns out not to exist rather than annotating it.
- Dropdown opens when `slashQueryFor(text, caret) !== null` **and** the filtered
  list is non-empty (`PromptComposerSheet.kt:631`).
- Position it **above** the draft field (`:780-786`).
- Cap at ~196px with internal scroll (`:2915`).
- Row: mono accent command token, inline `<arg>` hint for argument-taking
  commands, ≤2-line wrapping description, one command per row.
- Keyboard: `↑`/`↓` move the highlight, `Enter` or `Tab` accepts, `Escape`
  closes the dropdown only. This is a desktop addition — the phone is tap-only.
- The `/` toolbar button seeds a leading `/` and focuses the field; it is not a
  separate palette (`:650-656`).
- **Agent-kind gating.** The `/` button is disabled and the dropdown never opens
  when no agent kind is known (`:1170-1174`,
  `SlashCommandAutocomplete.kt:68-70`). Desktop detection exists: the host
  records `@ps_agent_kind` per session, `agentKindFromTmuxOption`
  (`src/main/helper/parsers.ts:216`) maps it, `composerAgentKind` narrows it to
  the four engines, and the workspace hands the result to the composer as its
  `agentKind` prop — the same prop that gates the button and feeds `liveAgent`
  in §16.3. A shell pane (or `probing`/`exited`) gets `null`. Do not invent a
  desktop-only fallback catalog; that would violate the "never offer an
  unavailable command" rule.

## 19. Snippets — deferred

The desktop has no snippet storage at all (`grep -ri snippet src/` returns
nothing). Ship the composer without the `{}` button. When snippets
land, the rule to implement is §8: a pick **appends to the draft, never sends**,
with the `""`/`" "` separator rule from `PromptComposerSheet.kt:466-472`.

## 20. Keyboard shortcuts (recommended)

Register global chords on `window` with `{ capture: true }` in the workspace
shell and `preventDefault()` + `stopPropagation()` on match, so xterm's textarea
never sees them. `TerminalView.vue` has already claimed the
`Ctrl/Cmd+Shift+…` namespace for app chords (both paste chords, Ctrl/Cmd+V and
Ctrl/Cmd+Shift+V, now land in THIS composer — see `onCustomKey` and
docs/SHORTCUTS.md §1.1), which is why every global here is a
Shift-chord: bare `Ctrl+K`, `Ctrl+L`, `Ctrl+A`, `Ctrl+E`, `Ctrl+R` are all real
terminal keys and must keep reaching the pane.

**Global (workspace scope)**

| Chord | Action |
| --- | --- |
| `Ctrl/Cmd+Shift+K` | Toggle `hidden` ⇄ last non-hidden mode; focus the draft when opening |
| `Ctrl/Cmd+Shift+↑` | Grow: `hidden → docked → expanded` |
| `Ctrl/Cmd+Shift+↓` | Shrink: `expanded → docked → hidden` |
| `Ctrl/Cmd+Shift+A` | Attach files (open the native picker) |

**Draft-focused scope**

| Key | Action |
| --- | --- |
| `Enter` | Send (submits — §5.3) |
| `Shift+Enter` | Newline |
| `Ctrl/Cmd+Enter` | Send (alias, so muscle memory from other tools works) |
| `Escape` | The ladder in §12.2 — never destroys the draft |
| `/` as the first character | Opens the slash dropdown (via `slashQueryFor`, not a keybinding) |
| `↑`/`↓`, `Enter`/`Tab` | Navigate / accept in the slash dropdown when open |
| `Ctrl/Cmd+↑` / `Ctrl/Cmd+↓` | Sent-prompt history: older / newer (§28); plain `↑`/`↓` stay caret keys |
| `Ctrl/Cmd+V` | Paste; non-text clipboard items become attachments (§23) |
| `Ctrl/Cmd+Shift+Backspace` | Discard draft (the Discard button remains the primary affordance) |

`Enter`-sends is the correct default here because the phone's single Send always
submits (§5.3) and the composer's whole purpose is submitting prompts. Do **not**
add a settings toggle for "Enter inserts a newline" — D22 forbids settings flags
for alternate behaviours; `Shift+Enter` is the escape hatch.

## 21. Styling and geometry

Colour is the token set in `docs/DESIGN.md` §4.3 — panel chrome
`var(--surface)`, draft fill `var(--bg)`, draft border `var(--border-strong)`
(WCAG 1.4.11 — an input's boundary must be ≥3:1), accent `var(--accent)`, muted
text `var(--fg-secondary)` — enforced by `tests/unit/designGates.test.ts`,
which fails any raw hex outside `App.vue`.

### 21.1 The composer FLOATS, and the user places it

The composer is not a docked row, not a full-bleed strip, and not fixed to a
corner. It is a card the user can drag anywhere in the session body and resize
from any edge.

```
 .session-body            position: relative
 └── .composer-dock       position: absolute; inset: var(--composer-inset)
                          pointer-events: none      ← the terminal stays clickable
     └── .composer-root   the card's world, and what the geometry measures
         ├── .composer    position: absolute; right/bottom/width/height inline
         └── .rail        the fixed toggle (§21.4), pinned to the corner
```

`.composer-root` is the WHOLE dock. The only thing the card must clear is the
toggle's own box — expressed as `PaneBox.keepOut` rather than as a wall, so a
card parked to the LEFT of the toggle may sit on the pane's floor.

**The dock is INSET, not padded.** An absolutely positioned child resolves its
offsets against its containing block's *padding* box, so padding on the dock
would not have held the card off the pane's edges. Insetting the dock itself
does, and it buys something better: `right: 0; bottom: 0` now *means* the
resting corner, so `src/shared/composerGeometry.ts` never has to know what the
inset is. The dock has already subtracted it.

**Geometry** is four numbers, in dock coordinates, measured from the corner the
card rests in:

```ts
interface ComposerGeometry { right: number; bottom: number; width: number; height: number }
```

`right`/`bottom` rather than `left`/`top` because the card's home is the
bottom-right: the resting state is two zeroes instead of arithmetic over the
pane size, and a pane that gets *shorter* carries the card up with its bottom
edge instead of pushing it out of sight. The left and top edges are derived when
a resize needs them.

| | |
|---|---|
| Move handle | the **header strip** — the card's title bar, `cursor: move`, `user-select: none`. Presses that land on its one button (maximize/restore) are excluded; double-clicking it maximizes, as a title bar does everywhere |
| Resize | **all four edges and all four corners**, 6px strips and 14px corner boxes overlaid on the card's own padding, so none of them covers the textarea. The top one keeps the old sash's look and its double-click. Corners are declared after edges so they win the hit test where both would answer |
| Floors | 360—190. 360 leaves ~40 mono columns beside the tools pill and Send; 190 is the height at which the toolbar, two draft lines, the tiles and the Send row all still fit |
| Cap | 80% of the pane's height, and never wider or taller than the pane |
| Containment | clamped **fully inside** the pane, always. The strongest form of "never draggable off-screen": there is no partially-lost state to recover from, so no rescue affordance is needed |
| Keep-out | the fixed toggle's measured corner box. A card spanning it is lifted to sit above it, and shortened if it would not otherwise fit — so the control that closes the card can never end up underneath it |
| Snapping | on mouse-**up** after a MOVE only, 12px, each axis independently, to that axis's two flush positions. Never during a drag (DESIGN.md §5.9 wants pointer-1:1) and never after a resize, which would silently change the size just chosen |
| Maximize | fills the dock — full width, capped height. Deliberately unlike the resting card: "maximize" is a request for all the room there is, a different question from how wide a prompt wants to be |
| Corners / elevation | `--r-xl` and `0 8px 32px rgba(0,0,0,.5)` — §5.5's `OverlayPanel` treatment with the Y offset pulled in from 16px, because a card that can sit flush against the bottom of its dock would throw that shadow off the pane and leave its *top* edge, the one with terminal text behind it, unseparated |

Every rule above is pure arithmetic in `src/shared/composerGeometry.ts` and is
unit-tested in `tests/unit/composerGeometry.test.ts`. The component's only job
is to measure the dock (one `ResizeObserver`) and feed deltas in.

Dragging a **maximized** card leaves the maximized state and keeps the box it
had, exactly like dragging a maximized OS window restores it under the cursor.

### 21.2 The terminal-never-resizes guarantee

**The composer reserves nothing.** An earlier design gave the tab body a
permanent padding strip for the toggle; the user asked for those rows back: the
composer is an overlay and must not take space from the terminal.

The guarantee never depended on the padding, only on its being a **constant**:
the terminal is sized by the pane, and no composer state can change it. Zero is
a constant. Opening, closing, moving and resizing the card cause no SSH
window-change and no remote tmux reflow — the dock is absolutely positioned and
takes no part in the tab body's layout in any state. What the overlay costs is
stated in §21.4: the toggle floats over the bottom-right of the terminal, where
tmux paints the right end of its status line.

`--composer-inset` is declared on the workspace in `FolderWorkspaceView.vue`
rather than in `App.vue`'s `:root`: it describes that pane's relationship with
the composer, and custom properties inherit, so PromptComposer reads it without
being handed it.

### 21.3 Inside the card

Ported from the phone: draft box `var(--r-lg)` radius, 1px border, `min-height`
46px (two lines — below that the caret line is clipped in half), internal scroll
past that; the tools pill 22px radius (`PromptComposerSheet.kt:1146-1150`); slash
dropdown `max-height` 196px (`:2915`), rendered **above** the card's top edge.
That last one is why the card is *not* `overflow: hidden`, which in turn is why
`.sash` closes the card's top corners itself.

`<style scoped>` per component, matching every existing view.

### 21.4 One toggle, one position — the control that never moves

**There is exactly one open/close control, and it is anchored to the PANE**, not
to the card: pinned `right: 0; bottom: 0` of the dock, identical in every state
— open, closed, card dragged elsewhere, card maximized. The card itself moves
(§21.1), so a control riding on it has no fixed position to offer.

```
 .composer-dock          the session body, inset on all sides
 ├── .composer-root      the card's world: the whole dock
 │   └── .composer       the card: dragged, resized, maximized, or absent
 └── .rail               the fixed toggle, pinned to the bottom-right corner
```

| | |
|---|---|
| Both states | open — chevron **down**, the direction the panel will travel. Closed — chevron **up** |
| Size / surface | a 28px (`--control-h`) round button around a **16px** mark; opaque `--surface-2`, a `--border-strong` edge and the card's elevation shadow. DESIGN.md §4.2 requires the strong border (4.12:1) wherever a boundary is the only thing identifying a control, and here it is the only thing separating the chip from the terminal behind it |
| Inset | a further `--sp-3` inside the dock's own corner, so it visibly floats ON the terminal rather than hugging the pane's edge — and clears almost the whole tmux status row |
| Never covered | `PaneBox.keepOut` (§21.1) is the toggle's measured box; `clampGeometry` lifts any card that would span it. A **corner hole in the card's placement**, not a band carved out of the pane |
| Waiting draft | a 6px accent **pip** on the button's corner — a CSS circle, not a glyph, ringed in the panel surface so it reads against any terminal output — plus `— unsent draft` in the tooltip. `railToggle(open, unsent)` owns that copy |

The chevron mapping and the unsent copy are a pure function (`railToggle` in
`src/shared/composerText.ts`), tested in `tests/unit/composerText.test.ts`.

**The card has a close button too.** The header is
`[ PROMPT ——— maximize/restore ] [ close ]` — the conventional window order,
dismissal last so it is not what the cursor lands on by accident. Opening and
closing are not symmetric acts: closing is something you do to a surface you are
already looking at, at the point of attention, which needs no fixed address;
opening is a summons issued from somewhere else entirely, and *that* is what
needs one unmoving pixel. Maximize keeps its button rather than retreating into
the header's double-click — that gesture still works, and so do
`Ctrl+Shift+↑`/`↓`, but a primary affordance should not live only behind an
undiscoverable one.

**Closing always hands the keyboard back to the terminal.** Every path — the
pinned toggle, the card's close, Escape, the chords, close-on-send — routes
through one `hideComposer()` that focuses the pane. That is not a nicety: the
typing intercept of §26 lives on the terminal's own textarea, so a close that
left focus on a button would leave the next keystroke going nowhere and the
whole feature looking broken. `lastOpenMode` carries docked-vs-maximized across
the round trip whichever closer is used; the pinned toggle is an ADDITIONAL way
to close, not a replacement. The coordinate invariance is asserted end-to-end in
`tests/e2e/composer.spec.ts`.

## 22. Deliberately NOT ported

| Dropped | Why |
| --- | --- |
| **Voice / Whisper dictation** — the mic button, the `Idle/Recording/Transcribing` FSM (`PromptComposerViewModel.kt:2150`), the amplitude waveform (`PromptComposerSheet.kt:2231`), the mm:ss timer, the silence watchdog (`:1062-1130`), the swipe-up mic lock (`:621-639`), `Insert`/`Send` stop actions (`:1225-1275`), keep-screen-on (`:585-590`) | The desktop has no audio-capture dependency, no OpenAI key vault, and no permission flow. This is ~60% of the Kotlin ViewModel and ~40% of the sheet. Dropping it removes the *entire reason* `requestSend` has a queue-until-transcription branch (`:605-618`) — desktop `send()` is a straight-line call. |
| **Pending-transcription queue** — banner, per-item retry/discard/save-as-audio, foreground-resume auto-retry (`:1780-1960`, `PromptComposerSheet.kt:2386-2600`) | Exists only to salvage failed Whisper round-trips. |
| **API-key entry dialog** (`PromptComposerSheet.kt:2684`) | Whisper-only. |
| **Everything IME** — the `keyboardUp` chrome variant (§3.3), the header-drop at `:802`, the 96↔56dp draft floor swap at `:932`, the `maxHeight - (ime - navBars)` room formula at `:735-741`, the `weight(1f, fill = false)` squish arithmetic at `:869`, `contentWindowInsets` at `:392-397`, and the six IME regression tests | A desktop window has no soft keyboard, so there is no dead space, no squish, and no IME-resized window. The composer is a flex child of a fixed-height column. **Do not port any reserve constant, any height cap keyed on an inset, or any "hide the header when …" rule.** The one durable lesson to keep is the invariant those tests were protecting: the Send row must always be reachable and a long draft must scroll *within* the composer instead of pushing the controls out of view — which on desktop is `overflow-y: auto` on the draft plus `flex: none` on the control row. |
| **`TextFieldValue` composing-region handling** (#491, `UnifiedComposer.kt:42-60`, `PromptComposerSheet.kt:597-613`) | A DOM `<textarea>`'s `.value` is always the visible text; there is no uncommitted composing region to miss. Read `.value` directly. (IME composition for CJK still exists in the DOM — guard Enter-to-send with `event.isComposing` and that is the whole of it.) |
| **`SavedStateHandle` mirroring + the #746 owner stamp** (`:2544`, `:2558`, `:813-840`) | Replaced by a per-session map in Pinia persisted through `electron-store` — see §12.4. |
| **Modal bottom sheet, scrim, drag anchors, swipe-to-dismiss, `BackHandler`** (`PromptComposerSheet.kt:366`, `TmuxSessionScreen.kt:5543-5564`) | The desktop composer floats but is never modal: no scrim, the terminal behind it stays live and clickable. Escape replaces Back; the chevron and the shortcuts replace the swipe. |
| **Mic-release-on-dismiss** (`:361-364`) | No mic. |

## 23. What desktop should ADD

1. **The `hidden` rail** (§12) — the phone has no equivalent; it just vanishes.
2. **Real keyboard shortcuts** (§20) — the phone is tap-only and its only
   "keyboard" concerns are IME dead space.
3. **Keyboard navigation of the slash dropdown** (§18) — the phone requires a tap
   on a row.
4. **Paste-to-attach.** On the draft's `paste` event, inspect
   `event.clipboardData.files` and `.items`. If any item is not `text/plain`,
   `preventDefault()` and stage them as
   `{ kind: 'bytes', data, name, mimeType }` (`src/shared/types.ts:108-116`);
   plain text pastes normally. The phone can only attach through the SAF picker
   (`PromptComposerSheet.kt:279-292`). Screenshot → paste → attached tile is the
   single biggest desktop ergonomics win here, and the IPC already supports it.
5. **Drag-and-drop.** The card accepts a file drop directly (`onDragOver`/
   `onDrop`, staging via `stageFiles`). The terminal pane is a target too:
   TerminalView cancels the drop and emits the File objects to
   `PromptComposer.acceptDroppedFiles` — the routing the paste chords use, so
   there is still one staging path and it lives here. The files must ride the
   event (a DataTransfer is dead once the drop returns; the composer cannot
   re-read them the way it re-reads a clipboard), and the panel opens before
   the upload runs — a drop is a summons, like Ctrl+V. Only drags advertising
   `Files` are claimed on either surface, so the tab strip's drags fall
   through.
6. **Draft persistence across app restarts** — Android persists only the draft
   text and only until the process is recreated; desktop should persist draft +
   attachments + mode per session to `electron-store`.
7. **Drag/resize everywhere** — realised as the fully draggable, edge-resizable
   card of §21.1 with app-level geometry (§12), not the per-session top-edge
   drag handle first specced here.

## 24. Test plan

The contracts live in `tests/unit/`: `composerText.test.ts` (the pure helpers,
with the case lists of §14 — blank/whitespace/`\n`/`\n\n` drafts, caret-in-token,
token replacement), `composerSend.test.ts` (routing and framing, §16.2–16.3),
`composerAttachments.test.ts` (dedupe, replace-in-place), `composerGeometry.test.ts`
(§21.1), `composerStore.test.ts` (draft/tiles/error state rules, per-session
isolation, `closeComposerOnSend`), `composerOutsideClick.test.ts` (the §12.2
guards), `composerClipboardPaste.test.ts`, `composerAttachmentTiles.test.ts`,
`composerHistoryRecall.test.ts` (§28), `DoodleCanvas.test.ts` and
`doodleGeometry.test.ts` (§27); `designGates.test.ts` fences the tokens (§21).
`tests/e2e/composer.spec.ts` drives the composed surface.

Integration invariant (Docker `tmux`/`helper` fixtures, per `docs/TESTING.md`):
compose a two-line prompt with one staged attachment, send it, and assert with
`tmux capture-pane` that the pane received **one** submission containing both
lines and the `Attached files:` block — the bracketed-paste proof (§16.2).

## 25. Conflicts and dependencies with in-flight work

1. **Resolved — session identity.** The restructure landed; the composer follows
   the active session tab of `FolderWorkspaceView` (§11).
2. **Resolved — `shellId` reachability.** The one hard dependency is closed:
   `src/renderer/stores/shells.ts:74-98` keeps a `register` / `unregister` /
   `shellIdFor` registry keyed by session, so the composer writes to the same
   shell the terminal shows.
3. **Stale.** The `ConversationView.vue` session-id input this item asked to
   remove left with the Conversation tab itself.
4. **Ports and Usage are host-scoped** and must not become siblings of the
   composer — the composer belongs to the session workspace only (§11).
5. **Stale.** An earlier revision declared desktop agent detection nonexistent;
   it exists — see §16.3 and §18.
6. **The attachments backend contract is settled** — `attachments:stage` /
   `attachments:pickFiles` (`src/shared/channels.ts:195-196`),
   `StageAttachmentsResult` (`src/shared/types.ts:214`). Its partial-failure
   semantics already match Android #570; consume as-is, do not re-litigate.
7. **No decision here changes `docs/DESIGN.md`.** If the composer's placement
   (§11) contradicts what that document says about tab ownership, reconcile
   there — flagged, not edited.

## 26. Two behaviours the user drives from Settings

Both are switches in `stores/settings.ts` (`typingOpensComposer`,
`closeComposerOnSend`), both default **on**, and both are read through the store
on every use rather than copied at mount — flipping either one takes effect on
the next keystroke.

They exist for one reason, stated by the user: on the phone the composer is the
primary way you talk to the agent, and they want the same reflex on the desktop
with typing as the trigger. Together they make the rhythm: type anywhere, the
card appears with what you typed; send, it gets out of the way; type again, it
is back.

### 26.1 `typingOpensComposer`

A printable keystroke at a CLOSED composer opens it and lands in the draft
instead of reaching the shell. **The character that triggered it is not lost** —
having to retype the first letter of every prompt would defeat the point.

Where it is decided:

| | |
|---|---|
| Predicate | `isTypingKey` in `src/shared/composerText.ts`, unit-tested. Pure, so the line it draws is checkable rather than buried in an event handler |
| Intercept | `TerminalView.vue`'s existing `attachCustomKeyEventHandler`, which already owns the clipboard chords. Returning `false` stops xterm turning the key into input bytes |
| Condition | `FolderWorkspaceView.vue` computes `settings.typingOpensComposer && composer.mode === 'hidden' && the active tab is a session tab` and hands TerminalView the answer as `interceptTyping`. The terminal knows nothing about the composer or the settings; the composer knows nothing about the terminal's key handling |
| Delivery | TerminalView emits `typed`; the workspace calls the composer's `typeInto(char)`, which opens on `lastOpenMode` and splices the character in at the remembered caret (`insertAtCaret`) |

**Where the line is drawn, exactly.** `isTypingKey` returns false — so the key
goes straight to the shell — for:

- **anything with Ctrl, Meta or Alt.** One rule covers Ctrl-C, Ctrl-D, Ctrl-Z,
  Ctrl-R, tmux's prefix and every app chord. A terminal that swallows Ctrl-C is
  broken. Shift is deliberately not in that list: Shift-A is a capital letter.
- **any key whose `key` is not exactly one code point.** The DOM spells named
  keys out (`Enter`, `Tab`, `Escape`, `ArrowUp`, `F5`, `Backspace`, `Home`…), so
  one rule covers the whole control keyboard without enumerating it.
- **a bare space.** It is the near-universal "next page" in pagers and tmux copy
  mode, and nobody begins a prompt with it. Only the TRIGGER is affected: once
  the composer is open the draft has focus and space types normally.
- **a key mid-IME-composition.** The composing text belongs to whatever already
  has focus; stealing it half-written would drop it.

**One decision per keystroke.** TerminalView handles the keydown and
`preventDefault()`s it — that is the feature, not a precaution: cancelling the
native path is what stops xterm *and* suppresses the DOM keypress event, so the
character cannot reach the draft a second time on top of the copy `typeInto`
planted.

**How to get a plain terminal**, which is the question this feature has to have
an answer to:

1. **Open the composer, then click into the terminal and type.** The intercept
   only runs while the composer is CLOSED — that is one of its two conditions —
   so with the card on screen the pane behaves like any terminal. The card stays
   out of the way as a floating panel; type into it whenever you want it back.
2. **The setting**, for turning the behaviour off entirely.

**What suppresses the intercept, and the one thing that may.** Earlier designs
armed a suppression from a dismissal and then from a press in the terminal; the
user hit both as ordinary static — in a terminal-centric app, clicking into the
terminal is how you focus the window, scroll output and select a path, not a
declaration of shell intent — and reported typing opening the composer "sometimes"
with nothing on screen saying why. So the hatch was removed outright: the
intercept's conditions stay visible on screen — the setting, the composer being
closed, the active tab being a session. The ONE exception is
`terminalOwnsTyping`, armed only by §12.2's short-draft hand-off: that close
PUT the user's text at the prompt, so re-catching the next keystroke would
fight the words it just delivered — a fact on screen, not a silent hatch. It
clears the moment the composer is summoned again. The cost is real and
accepted: with the setting on and the panel closed, every printable keystroke
opens the composer, so a shell command always starts with a summons (`Ctrl+\``,
or the toggle) or with opening the card first — option 1 above. The user types
prompts for a living here and chose that trade in as many words.

### 26.2 `closeComposerOnSend`

After a delivered send the composer closes itself, and the next keystroke brings
it back (§26.1). This is the phone's rhythm, asked for explicitly.

- **Only a confirmed delivery closes it.** A failure — including a timeout,
  which §4.2 treats as a failure — leaves the card open: the composed payload
  is back in the draft and the "Not sent" banner is showing, and closing over
  the top of that would hide both, leaving an invisible unsent prompt and no
  explanation.
- A **partial attachment failure** (#570) happens at STAGE time, not send time;
  it has no say in whether the panel closes (§17).
- The rule lives in the store's `send(key, deliver, { closeOnDelivery })` rather
  than in the component, so the failure case is testable without a settings
  fixture. The component passes the setting in and, on a delivered-and-closed
  send, hands focus to the terminal — which is what arms §26.1 for the next
  keystroke.
- It composes with `lastOpenMode`: a maximized composer that closes on send
  re-opens maximized.

## 27. The doodle / annotate surface

`DoodleCanvas.vue`, reached two ways: from the composer's attach row through a
source chooser (blank sheet, clipboard, a local file, a file on the host), and
from the pencil on an image tile that is **already staged** (§27.7). Whatever
the source, the image arrives as a URL an `<img>` can load and leaves as PNG
bytes that go straight into the `{kind:'bytes'}` staging path the clipboard
already uses — no new upload, remote-path, tile or send code (§17, §23.4).

### 27.1 The document, and what "attached" means

The sheet is a list of ITEMS — strokes, and text annotations — repainted onto
one canvas on every change. There is exactly one canvas and one painter, and
`commit()` encodes that same canvas, so **anything visible on the sheet is in
the attached PNG by construction**. There is no preview layer for the exporter
to reproduce, which is the failure this design exists to make impossible.

The one thing that is NOT an item is the text tool's caret: it is a real
`<textarea>` floating over the canvas, and `toBlob` cannot see it. So the commit
path flushes the open editor into the document *before* it encodes. Attaching
mid-sentence attaches the sentence. `tests/unit/DoodleCanvas.test.ts` asserts
this against a recording 2D context rather than trusting it.

### 27.2 Tools

| Tool | Gesture | Notes |
| --- | --- | --- |
| Draw | drag | freehand, smoothed through the sample midpoints |
| Line / Arrow | drag, tail to head | **Shift constrains to 45° steps** |
| Rectangle / Ellipse | drag two corners | Shift does nothing here — see below |
| Text | click to place, click existing text to edit | |

- **The arrowhead scales with the mark weight**, at 4x the stroke, capped at 60%
  of the arrow's length so a short arrow is not all head. The shaft stops at the
  barb baseline, not at the tip, so a fat round cap cannot poke out of the point.
- **A click with no drag commits nothing.** A zero-length arrow is invisible but
  would still consume an Undo, and an Undo that appears to do nothing is how
  users conclude undo is broken. Only the pen means anything by a single point
  (it is a dot).
- **Shift is deliberately not wired to rectangle/ellipse.** On those the same key
  conventionally means "square"/"circle", which is a different constraint under
  the same keycap; implementing one and leaving the other inert is worse than
  doing neither.
- **One colour row and one weight row serve every tool**, text included. Weight
  drives stroke thickness and, through it, text size — they are the same idea
  (how heavy a mark), which is why it is one control.

### 27.3 Text: the keys, and the Escape collision

| Key | In the annotation editor |
| --- | --- |
| `Enter` | **newline** — annotations wrap and are routinely two lines |
| `Ctrl/Cmd+Enter` | commit |
| `Escape` | commit, and **stop propagating** |
| `Ctrl/Cmd+Z` | the textarea's own undo, not the sheet's |

Enter is the opposite of the draft's Enter-sends (§20), and that is fine: the
draft is a message being finished, this is a caption being laid out.

**The Escape rung is the load-bearing part.** This canvas sits inside an
`OverlayPanel` (Escape closes the overlay) inside `.composer-root` (Escape runs
the §12.2 ladder and hides the whole composer), and both listen for a bubbling
Escape. Without `stopPropagation` on the editor's own handler, one Escape while
typing a caption would throw away the caption, the drawing and the composer, in
that order. Handling it on the focused element makes the open editor the
innermost rung of the same ladder — *Escape closes what you opened last* —
without either outer handler needing to know this tool exists. Neither §12.2 nor
`OverlayPanel` was changed.

It **commits** rather than cancels, because Escape in this app never destroys
work (§12.2). Ctrl+Z is how you take an annotation back.

Committed text stays editable: click it again with the text tool and the caret
returns, at the end of the text. Emptying an annotation deletes it — there is no
separate delete control, and adding one would mean a selection model this
surface does not otherwise have. Clicking a swatch while the caret is open
retargets the annotation being typed; re-opening an old one keeps its own colour
rather than adopting the toolbar's.

### 27.4 Undo

`history` is a stack of previous versions of the item ARRAY — references, tens of
them, which is a different proposition from the per-stroke pixel snapshots the
original design rejected. It is what lets one Ctrl+Z (or the toolbar button)
cover every mutation the surface has:

- a stroke, a shape or an arrow;
- placing a text annotation;
- **retyping an existing one** — a mutation in the middle of the document, which
  a pop-the-last-item stack cannot express;
- **Clear**, which is otherwise one misclick from losing the whole markup.

Nothing that changes the document bypasses it: every mutation goes through one
function, so "does undo cover this tool?" stays answerable by reading one place.

### 27.5 Geometry lives outside the component

`src/shared/doodleGeometry.ts` holds the arithmetic — arrowhead barbs and shaft
stop, 45° snapping, greedy line breaking with hard breaks and character-level
breaking for an unbreakable URL, block layout and hit testing. It is pure: it
takes numbers and a `measure` callback and knows nothing of the DOM, tokens or a
canvas context. That is what makes the parts most likely to be subtly wrong
testable in `tests/unit/doodleGeometry.test.ts` without a canvas at all.

### 27.6 Typography, and the one token deviation

Family (`--font-ui`), weight (`--fw-semibold`) and leading (`--lh-300`) are
resolved from computed style at paint time, exactly as the pens resolve their
colour tokens — no literal enters the `.vue` file.

**Size is not from `--fs-*`, and this is deliberate.** That ladder is a chrome
density system (28px rows, 40px bars) that tops out at 20px — `fonts.ts` says so
in as many words — while this canvas is a bitmap up to 2048px wide whose logical
pixels are not CSS pixels. `--fs-300` text on a phone screenshot would be
13/2048 of the image width and about four screen pixels tall on the sheet. Size
follows the selected mark weight instead — 8x, with a 36px floor so the lightest
weight stays legible once the sheet is shrunk to about a third — so a caption
and the arrow pointing at it read as one hand. (The ratio was 4x, borrowed from
the arrowhead, and that borrowing was a reported bug: an arrowhead is a shape
and survives shrinking, type does not.) The ratio and the floor are named
constants in the pure module, and the test asserts what REACHES THE EYE
(`textFontSize(w) * (700/2048) >= 11`) rather than asserting the constants
against themselves.

### 27.7 Annotating an image that is already attached

**The affordance.** A pencil appears on image tiles only — sitting *before* the
`×`, so the destructive control keeps the corner muscle memory expects — decided
by `classifyByName(remotePath)`, the same classifier the Files tab uses. Not by
"does the tile have a thumbnail": a tile only carries a preview when it came
from a paste or a drop, so that rule would offer annotation on a dropped
screenshot and refuse it on the identical file attached through the paperclip
(which stages by path and never mints one), or on either after a restart
(previews are deliberately not persisted). The remote name always survives.

**Where the pixels come from.** Staging is EAGER — the bytes are uploaded when
the file is attached, not when the prompt is sent (§17) — so the host always
has an authoritative copy, and `sftp:readBinary` under
`absoluteAttachmentPath()` is a correct fallback for any tile, including one
restored from a previous run. But it is a round trip, and for the case people
actually hit (a screenshot pasted five seconds ago) the same bytes are already
in the renderer behind the tile's object URL. So the local preview is tried
first: instant, and it works with the connection down. Only tiles with no
preview pay for the read, behind a `loading` step that also gives a failed read
somewhere to be reported.

**Replace, not keep alongside — and the ordering rule is load-bearing.**
"Annotate it" is a sentence about one image; keeping both would double every
attachment anyone marks up and hand the agent a clean copy and a scribbled copy
of the same screenshot with nothing to say which to believe. The swap is **in
place**, and that is the load-bearing detail: paths are folded into the prompt
in tile order at send time (§5.1), so a draft that says "compare the first
screenshot with the second" is a statement about the list's ordering, and
remove-then-reattach — the only thing the store's existing actions can express
— would silently move the image to the end. `replaceStagedAttachment()` in
`src/shared/composerAttachments.ts` is the ordering rule, pure and unit-tested;
it reports `null` rather than appending when the target is gone, because
re-adding an attachment the user has since removed is worse than losing the
drawing.

The original on the host is left where it is: nothing references it, and
`AttachmentRetentionPolicy` already owns the lifetime of everything under
`~/.pocketshell/attachments`. Deleting eagerly would mean a new privileged IPC
channel that removes remote files, to reclaim one screenshot from a directory
that prunes itself.

**Re-annotating works, and starts from the flattened result** — the second pass
draws on the PNG the first pass produced, not on its vector items, which are not
persisted anywhere. The visible cost is the filename; `doodleAttachmentName()`
strips the previous decoration before adding one of each, so the name is stable
under any number of passes instead of growing one per pass.

### 27.8 Cancelling no longer destroys the drawing

`DoodleCanvas` owns the close decision, and the parent routes every dismissal
through `requestClose()`, exposed for exactly that. An empty sheet still closes
on one Escape — a doodle opened by mistake must not argue. A sheet with work on
it raises a confirmation in its own footer, replacing the action row rather than
stacking above it, so the buttons that answer the question are the only buttons
there are. An open caption is flushed into the document first, so it counts as
work.

Escape keeps its meaning from §12.2 — *it never destroys work*. It arms the
confirmation, and a second Escape **dismisses the confirmation** rather than
confirming it: the safe direction on the key people press without reading.
Discarding takes a deliberate click on a button labelled Discard.

This is fixed for every doodle source, not just the new one. `OverlayPanel` was
not changed; it still emits `close` for Escape and for a backdrop click, and the
composer decides what that means.

---

## 28. Sent-prompt history — repeat what you already sent

Added 2026-08-29, from the user's report: prompts go into a tmux pane that may
not be the one on screen, so what a prompt did is not always visible and
re-running it means retyping it from memory. A shell answers the same problem
with `history` and the up arrow; the composer now has both, per session.

### 28.1 What is recorded

Every CONFIRMED delivery lands in the session's `history`
(`ComposerSessionState.history`), as the COMPOSED payload — attachment paths
already folded in — because that is the text that entered the pane, and a
repeat should resend exactly what was sent. Failed and timed-out sends are
never recorded: a prompt that did not land is not one the user can repeat, and
"up arrow" must not re-offer something that already failed once.

A prompt sent again has ONE place in the list — the top (zsh's `erasedups`,
not bash's narrower ignoredups). Keeping a stale copy mid-list would make the
arrow walk step over the same text twice. The list is capped at
`COMPOSER_HISTORY_LIMIT` (100), oldest falling off.

It is keyed like every other per-session fact (`"$connectionId/$name"`), so
`rekey` carries it across a rename and `forget` drops it with the session.

### 28.2 The arrow walk

Ctrl/Cmd+↑ steps older into the draft, Ctrl/Cmd+↓ steps newer, and one ↓ past
the newest hands back the draft the walk started from — held in `recallSaved`
for exactly that, so browsing never destroys work. Enter on a recalled entry
resends it; the resend is the dedupe above keeping the list honest. Any manual
edit ends the browse (the text on screen is the user's from then on), as do
Discard, a delivered send and a failed send's restore.

The chord, not the bare arrows: plain ↑/↓ must stay caret keys for editing a
draft — a multi-line compose is unreadable if ↑ yanks the draft out from under
the cursor — so the old caret-position gates (first line to recall older, last
line to recall newer, no selection) went with the chord. The keystrokes are
intercepted in `PromptComposer.onDraftKeydown`:

- the slash dropdown owns the arrows while it is open (§18) — chord or not;
- not while an IME composition is in flight.

Recalling a prompt that happens to start with `/` dismisses the command
dropdown rather than opening it: the text was not typed, so it is not a query.

### 28.3 Persistence

`history` and `recallSaved` join the per-session blob under
`pocketshell.composer.v1` (§15, §12.4). The browse cursor itself does not
survive a restart — it is a gesture, like the slash dropdown's dismissal — so a
draft parked in `recallSaved` when the app went away is restored as THE draft:
the saved text is the only one that can come back.

Tests: `tests/unit/composerStore.test.ts` (the state rules) and
`tests/unit/composerHistoryRecall.test.ts` (the keystrokes, mounted).
