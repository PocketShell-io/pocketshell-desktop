# Prompt Composer — decision record

Status: **built.** `src/renderer/components/PromptComposer.vue` +
`src/renderer/stores/composer.ts` (+ the pure modules in
`src/shared/composer*.ts`) implement everything below; where code and this
document ever diverged, the code won. What remains here is the contract, the
divergences from the Android original, and the reasoning.

**Citation convention.** Part I documents the phone app as built — paths
like `PromptComposerViewModel.kt:2645` are in the Android repo at
`C:\Users\alexey\git\pocketshell`. It is the parity reference: the behaviour
the desktop ported, and the baseline every deliberate divergence is measured
against.

---

# Part I — The Android composer, as built

## 1. Where it lives, who owns it, how it opens

A Material 3 modal bottom sheet hosted by the *session* screen. State owner:
`PromptComposerViewModel` — **activity-scoped, shared across every session on
a host** (`PromptComposerViewModel.kt:813-820`). That single fact is the
direct cause of #746 (drafts bleeding between sessions), worked around with
an owner stamp (§4.4), and the reason the desktop must NOT port that
mechanism (§12.4). The composer is not per-tab: the Terminal/Conversation
tab choice only selects the send route (§5.4). The draft is scoped by
session via `composerTargetKey = "$hostId/$sessionName"`.

Open triggers: the launcher chip, tapping a rendered engine command in the
terminal (pre-fills, then opens), share-into-session, the file viewer's
"attach". Close triggers: header `×`, scrim, swipe-down, system Back, and a
**successful** send. All closes run `dismissComposer`, which **deliberately
preserves the draft** — only a confirmed delivery, an explicit Discard, or a
session switch clears state (§4).

## 2. Anatomy

Top to bottom: slash-command dropdown floating ABOVE the field (so the IME
can never occlude it); header with `×` (hidden while the keyboard is up); a
scroll region holding the draft field, the error/status banner with an
inline Discard button, upload progress, and the staged attachment tiles; a
connection-lost row sticky OUTSIDE the scroll region; a sticky control row —
attach / snippets / slash pill on the left, one Send button on the right.
No separate Insert button, no keyboard-raise button — both were removed.

## 3. Visibility / expand state machine

Three sheet values (`Hidden` / `PartiallyExpanded` — the default landing /
`Expanded` — unreachable while the keyboard is up, because the expanded
anchor IS the IME-resized height). The sheet is content-height, not a height
fraction — making it fully-expanded plus a manual IME inset shipped a
keyboard-height void and was reverted.

The invariant that actually matters (asserted with real geometry in the
E2E test): the sheet is open, the terminal text above it stays readable, and
the draft field sits in the lower quarter of the screen. That is the whole
"modal inversion" goal: **never occlude the agent output you are composing
against.**

### 3.3 The keyboard-up chrome variant

With the IME up: body capped to the leftover height, header dropped
entirely, draft floor drops, scroll region capped. **All of it is a
soft-keyboard artifact. None of it ports** (§22).

### 3.4 What persists across visibility transitions

Everything the user authored. Only three things clear state: a confirmed
delivery, an explicit Discard, and a session switch (§4).

## 4. Draft lifecycle

Every edit is mirrored into `SavedStateHandle` and clears the error; drafts
survive process death (attachments do not — only the draft text is saved).

### 4.2 Send does not clear optimistically (#745)

`dispatchSendNow` flips `sendInFlight`, clears the error, emits the send —
and **leaves the draft and the tiles on screen**. The bug this fixed: "first
the message disappears from the Composer and then sometimes the Composer
stays on the screen."

- **Delivered** → attachments cleared, draft cleared, sheet dismissed.
- **Failed or timed out (12s)** → `restoreFailedSend`: the composer **stays
  open**, the *composed* payload (text WITH the attachment paths folded in)
  goes back in the draft, and the tiles are **dropped** — explicitly so the
  resend does not double-append the paths. The banner reads `"Not sent.
  Reconnect, then send again or discard the draft."`

### 4.3 Discard is the only user control that throws work away

`discardDraft` cancels any in-flight upload and clears draft, tiles, error.
Surfaced only as the Discard button inside the error banner. The header `×`
explicitly does NOT discard.

### 4.4 Session switch discards a foreign draft

`onComposerTargetChanged`: no draft → no-op; owner unknown (process death)
→ adopt; owner ≠ target → discard. **This mechanism exists only because the
ViewModel is a single shared instance** — see §12.4 for why the desktop
must not port it.

### 4.5 Summary table

| Event | Draft | Attachment tiles | Error banner | Composer open? |
| --- | --- | --- | --- | --- |
| Dismiss (`×`, scrim, Back, swipe) | kept | kept | kept | closed |
| Send tapped (in flight) | kept, visible | kept, visible | cleared | open, Send disabled + spinner |
| Send delivered | cleared | cleared | cleared | **closed** |
| Send failed / 12s timeout | replaced by composed payload | **dropped** (folded into text) | "Not sent…" + Discard | **open** |
| Discard tapped | cleared | cleared | cleared | open |
| Switch to another session | discarded if owned elsewhere | discarded with it | cleared | — |
| Process death / rotation | restored | **lost** | lost | — |
| Any keystroke | — | — | **cleared** | — |

## 5. Send — composition, routing, delivery

### 5.1 The composition rule (load-bearing)

`appendAttachmentPaths` (`PromptComposerViewModel.kt:2645`): the staged
remote paths are **appended at the end**, never prepended, as an
`Attached files:` header followed by one `- <remote path>` line per
attachment, separated from the user's text by **exactly one blank line**. A
blank draft (**whitespace-only counts — Kotlin `isBlank()`, not
`isEmpty()`**) is *replaced* by the block, so an attachment-only send is
legal:

```
what is wrong here

Attached files:
- ~/.pocketshell/attachments/dtc-site/main/20260824-101500-01-shot.png
```

Called once, at send time only. **The draft text is never mutated by
attaching** — attaching stages; only sending composes.

### 5.2 Send gating

Enabled iff `(liveEditorText.isNotEmpty() || attachments.nonEmpty()) &&
!sendInFlight` — reading the **live editor value**, not the ViewModel draft
(#491: an uncommitted IME composing region still enables Send). Guards:
no-op if a send is in flight; no-op if the *composed* text is empty.

### 5.3 "Send" vs "Send + Enter"

`SendRequest` carries `withEnter`, but **inside the composer it is always
true**. The old Insert/Send pair was collapsed into one button (#453); the
`withEnter = false` half survives only in the snippet picker's explicit
chips. **Desktop consequence: the composer has exactly one Send verb, and it
submits. Do not build an Insert/Send pair.**

### 5.4 Routing

`viewingConversation → AgentConversation; withEnter && liveAgent == Codex →
AgentPayload; liveAgent != null → RawBytes; presumedAgent != null →
AgentPayload; else RawBytes.` AgentConversation also echoes an optimistic
user turn into the transcript; AgentPayload is bracketed paste + a
submit-delay before Enter; RawBytes writes the bytes (plus `\r` when
`withEnter`).

### 5.5 Multi-line delivery — bracketed paste (#209)

Because §5.1 *always* introduces newlines when attachments are staged, the
payload is routinely multi-line, and naïve delivery would make an agent REPL
submit each line as a separate prompt — the bug found in daily use. The
phone solves it inside `sendInputBytesToPane` with bracketed-paste markers
and a delayed submit; the desktop, with no tmux control-mode client, must
implement the framing itself — **§16.2 is the single home for this
mechanism.**

## 6. Attachments in the composer

Staged attachments are **structured state, never folded into the draft while
composing** — `StagedAttachment(remotePath, displayName, previewUri,
mimeType)`. Staging is single-flight (a second call while a batch is in
flight is a no-op) and bounded by a 90s timeout; batches merge deduplicated
by `remotePath`, in order. **Partial failure (#570): the paths that DID
upload are attached AND the error is shown — never discard survivors.**
Display name is the last path segment only. Removing a tile never touches
the draft. Seeding attaches an already-uploaded path without re-uploading.
Remote location: `~/.pocketshell/attachments/<scope>/`, one directory per
project, shared by a workspace's tags.

## 7. Slash commands

The standalone palette was deleted; slash entry lives only in the composer.
Pure logic: `slashQueryFor` — dropdown open iff the text starts with `/` AND
the caret is within the leading token (up to first whitespace); typing a
space and moving to the argument closes it. `filteredCommands` — empty when
no agent; a shell pane never gets a dropdown. `insertCommandText` — replaces
the leading token, preserves trailing text, one trailing space for
argument-taking commands. Catalog: an **app-shipped, per-agent curated list**
(30 entries across Claude Code / Codex / OpenCode), deliberately not user
CRUD. The `/` button is not a second picker: it seeds a leading `/` and
focuses the field.

## 8. Snippets

A pick **appends to the draft and never sends** — the picker's `withEnter`
signal is deliberately ignored inside the composer; the compose-then-send
safety rule wins. Separator: `""` if the draft is empty or already ends with
a newline or space, else `" "`. Outside the composer the same picker DOES
send directly, gated on liveness.

## 9. Liveness guards

`sessionLive` is the single source of truth, and the asymmetry is
intentional: **send is not gated** (connect-on-action — the ViewModel kicks
a reconnect and awaits the live client; the 12s timeout converts a truly
dead link into the "Not sent" banner); **attach is not gated** (the file
picker backgrounds the app, so staging lazily reconnects); the
connection-lost row is an **advisory indicator, not a block**. But the
snippet picker outside the composer IS hard-gated, as are terminal hotkeys.
A composed prompt is worth reconnecting for; a keystroke is not.

## 10. Voice

Two thirds of the Kotlin ViewModel is dictation — FSM, Whisper, mic lock,
retry queue, key vault. No desktop analogue; see §22.

---

# Part II — The desktop, as built

## 11. Where the composer lives

Per-session, owned by the folder workspace shell, following the active
session tab — **not rendered on a Files tab**. `FolderWorkspaceView` mounts
`<PromptComposer/>` **once**, outside the tab body, kept alive across tab
switches (`v-show`, never `v-if`) so draft, caret and scroll position
survive a tab change; it is shown only while the active tab is a session
tab. Which session it holds is the active SESSION TAB, not a route param;
vue-router reuses the view instance, and a watch swaps which per-session
record it reads. Ports and Usage are host-scoped and must not become
siblings of the composer.

## 12. Visibility state machine (desktop)

Three states, **app-level** (not per session), persisted:
`'hidden' | 'docked' | 'expanded'`. `docked` is the remembered geometry,
user-dragged; `expanded` fills the dock and ignores it; `hidden` leaves the
**fixed toggle** (§21.4) — a small icon button wearing a pip when a draft or
attachment is waiting. The hidden rail is a **desktop addition** and
deliberate: the phone loses the composer entirely when closed, so a
preserved "Not sent" draft becomes invisible (#695's complaint class). A
persistent rail guarantees a stale draft is always discoverable.

**The mode is not per session.** Open/closed/maximized is a *preference
about the tool*; the draft, attachments, caret and height are *facts about a
session*. Only the second group is keyed by `targetKey` (§15).

### 12.1 Transitions

| From | Trigger | To |
| --- | --- | --- |
| `hidden` | toggle / `Ctrl+\`` / `Ctrl+Shift+K` / a seed action | the last open mode, draft focused |
| `hidden` | `Ctrl+Shift+↑` | `docked` |
| `docked` | same toggle / chords / `Ctrl+Shift+↓` | `hidden` |
| `docked` | `Ctrl+Shift+↑` / maximize button / header double-click | `expanded` |
| `expanded` | `Ctrl+Shift+↓` / restore button | `docked` |
| any non-hidden | `Escape` (§12.2) | `hidden`, focus to the terminal; draft kept — unless the short-draft hand-off applies |
| any | **successful** send | unchanged — stays open and focused (§12.3); with `closeComposerOnSend` (§26.2), `hidden` |
| any | failed send | unchanged, banner shown |
| any | session switch | **unchanged** — only which draft it shows changes |

### 12.2 Escape closes it — and never destroys work

Two rungs, first match wins: slash dropdown open → close the dropdown only
(Escape closes what you opened last); otherwise close the composer and hand
focus back to the terminal. Discard is the only control that throws work
away (§15.1) — with one deliberate exception that MOVES work rather than
destroying it:

**The short-draft hand-off.** A user close with a draft of fewer than five
characters hands that text to the pane: written raw into the PTY, no Enter,
the draft cleared, and the typing intercept (§26.1) stood down until the
composer is next summoned. Two or three characters are keystrokes the
intercept borrowed on their way to the pane — a shell command put back
where it was heading; five or more are a prompt, and a dismissal never
moves one. The rest of the gate (`canFlushDraftToTerminal`, §14):
single-line only — a written line break would SUBMIT whatever precedes it —
and never with attachments, a failure banner, or a send/upload in flight;
no registered shell or a down connection means no hand-off either, since
moving text to nowhere is losing it. Home: the store's `flushToTerminal`;
the stood-down state is `terminalOwnsTyping`, cleared the moment the panel
is summoned again.

**Clicking outside closes it — but only when it is empty** (no draft text,
no staged attachments, no banner, nothing in flight; whitespace-only counts
as empty, by the store's own send rule). Three guards are the whole safety:
keyed on `mousedown` and where it LANDED (the card is draggable and a drag
routinely travels outside its own bounds); "inside" means inside
`.composer-root` — the card, grips, header, pinned toggle and doodle
overlay — so pressing the toggle can never close-then-reopen. The rule for
any future dismissal:

> **A dismissal puts the view away. It speaks for the next keystroke only
> when it has somewhere to put the user's text — the hand-off's text sitting
> at the prompt. Silence without that visible fact is the hatch that was
> removed, and it stays removed.**

All four user-close routes behave identically, which is the point.
`dismiss()` still exists as its own action — the user-close path can be
given behaviour again in one place, and the two closes (user vs
click-outside) are different facts about the world even when they produce
the same state.

### 12.3 A successful send does not hide the composer

The phone dismisses on delivery because the sheet occludes the terminal on
a phone screen. On desktop the composer is a non-modal floating card and
the user works *primarily* through it — so on delivery, clear draft and
tiles and **keep the card open and focused**, ready for the next prompt. A
deliberate, recorded divergence from Part I.

### 12.4 What persists — and the one mechanism NOT to port

Per session key, everything persists across every mode transition and tab
switch: draft, caret, staged attachments, error, scroll. Mode and geometry
are app-level (§15). **Do not port the #746 owner-stamp
discard-on-switch mechanism**: it exists solely because the Android
ViewModel is one shared instance. A Pinia store holds a
`Map<targetKey, ComposerSessionState>` — the desktop keeps a **per-session
draft**, satisfying the same invariant ("a draft never appears in a session
it was not authored in") while being strictly better: switching away and
back RESTORES your prompt. The map persists via electron-store (draft AND
attachments, unlike Android), and the connection id is a transport handle,
not an identity: on reconnect every record rekeys to the new id before it
is published. Terminal re-attachment leaves focus alone when the composer
owns it, so a reconnect cannot redirect the next keystroke into xterm.

## 13. Files

The tree is its own documentation: `src/shared/composerText.ts`,
`composerSend.ts`, `composerAttachments.ts`, `composerGeometry.ts`,
`doodleGeometry.ts`, `agentCommands.ts`; `stores/composer.ts`;
`components/PromptComposer.vue`, `ComposerAttachmentTiles.vue`,
`SlashCommandDropdown.vue`, `DoodleCanvas.vue`; mounted by
`views/FolderWorkspaceView.vue`.

## 14. Pure helpers (`src/shared/composerText.ts`)

`appendAttachmentPaths`, `slashQueryFor`, `insertCommandText`,
`attachmentDisplayName`, `isTypingKey`, `insertAtCaret`, `railToggle` —
ported one-for-one from the Kotlin (§5.1, §7), unit-test-grade contracts in
`tests/unit/composerText.test.ts`. The one subtlety worth keeping in prose:
the blank-draft check is Kotlin `isBlank()`, not `isEmpty()` — a
whitespace-only draft is *replaced* by the attachment block, not appended
to.

## 15. The store (`src/renderer/stores/composer.ts`)

Per-session records keyed by `` `${connectionId}/${sessionName}` ``
(draft, attachments, error, send/upload state, caret, history). **Not
keyed**: `mode`, `lastOpenMode` and `geometry`, persisted under
`pocketshell.composer.visibility.v1` — a second key rather than a version
bump of `pocketshell.composer.v1`, so drafts already on disk survive, and
**the key keeps its `visibility` name even though the payload has since
grown `geometry`**: renaming it would orphan the blob and silently reopen
every user's composer, and a stale name is cheaper than a lost preference.
A record with no draft and no attachments is not written at all — `ensure()`
touches a key for every session merely visited, and without that filter the
blob grows one empty entry per session forever. `geometry` is stored RAW
and never re-clamped: a window briefly made small must not permanently
rewrite the user's layout; the component clamps for display instead
(§21.1).

### 15.1 Discard, and dismissing the banner

The banner's only button is a dismiss `×` — it clears the MESSAGE and
nothing else. An attachment failure leaves nothing behind to clean up (a
refused file never staged, so there is no tile), and a failed send must
keep the draft it failed to deliver. The reported trap that fixed this
shape: the banner used to hold the Discard button, a user staring at
"Attachment upload failed" read it as "remove the failed attachment", and
lost a dictated prompt for it.

Discard itself lives in the control row beside Send, behind a two-click
arm: the first click arms it (`Discard draft?`, in error colors), the
second destroys. Anything that moves the target out from under the armed
click disarms it — an edit to the draft, a tile added or removed, a
session switch — as does five seconds of inaction; the
`Ctrl+Shift+Backspace` chord keeps its one-stroke semantics, deliberate
modifiers being their own confirmation. The arm is unconditional rather
than gated on draft length: an extra click to clear a stray character is
cheap, and a re-dictated prompt is not.

`discard()` cancels any in-flight upload, then clears draft, tiles and
error; `dismissError()` clears `error` only. The header `×` and Escape
(§12.2) still never destroy work.

## 16. Send path

### 16.0 An upload in flight is waited for, not abandoned

Sending while an attachment batch is still uploading waits for it, then
sends with the image included — the user attaches an image and then writes
a prompt ABOUT that image, so cancelling would deliver a question with its
subject missing. What makes the wait safe rather than a hang: `sendInFlight`
goes up BEFORE the wait (Send disables; single-flight guards; click-outside
cannot dismiss a prompt parked on its own picture); the batch always
settles (`Batch.done` resolves on every exit including a throw — a dead
connection arrives as an SFTP error via the SSH keepalive, and there is
deliberately no wall clock that could fire first); the payload is composed
AFTER the wait; and a failed upload does not send — banner and intact
draft, like every other refusal.

### 16.1 Sequence

Compose the payload → guard (empty, in flight) → wait for any upload, then
compose (§16.0) → `sendInFlight = true`, error cleared, **draft and tiles
stay on screen** (#745) → deliver (§16.2) under a 12s timeout → delivered:
clear draft + tiles, keep the card open and focused (§12.3); failed or
timed out: composed payload back in the draft, tiles dropped, banner with
a dismiss — the banner never holds Discard (§4.2, §15.1).

### 16.2 Transport, and the bracketed-paste requirement

The desktop writes into a PTY running the session join via
`api.shell.input`; there is no tmux control-mode client, so **the renderer
applies the bracketed-paste framing itself**. The rules, each from the
Kotlin:

- Wrap in `\e[200~`/`\e[201~` whenever the payload contains a line break.
  Since §5.1 always adds newlines when attachments are staged, **any
  attachment send is a paste send.** Getting this wrong makes each line of
  an attachment block a separate agent prompt.
- Send the submit `\r` **separately, after** the paste block, never inside
  it.
- Wait between body and Enter — 250ms for **every** send (the safe end of
  the Android range). Imperceptible, and Enter must never race the TUI's
  paste ingestion.
- Programs that do not enable bracketed paste render the markers
  literally; the Kotlin accepts that degradation explicitly. Do the same.

### 16.3 Routing

`sendRoute` (`src/shared/composerSend.ts`), pure and unit-tested against
the four cases: `withEnter && liveAgent === 'codex' → 'agent-payload'`;
`liveAgent → 'raw'`; `presumedAgent → 'agent-payload'`; else `'raw'`. The
Codex arm is live (agent kind arrives as the composer's prop, narrowed from
host detection); `presumedAgent` has no desktop source yet. The phone's
third arm, `'agent-conversation'`, is gone rather than merely unreachable —
it existed for the deleted Conversation tab and never did anything `'raw'`
did not.

### 16.4 Only one Send verb

Per §5.3 the composer submits, always. A "stage without submitting"
affordance belongs in a snippet-style surface outside the composer.

## 17. Attachments (composer side)

The upload backend is `src/main/attachments/AttachmentStager.ts` over
`attachments:stage` / `attachments:pickFiles`; the composer only consumes
it. Size policy is a branch split: a **picked file has no size cap** — it
streams to the host with `fastPut` and its bytes never live in this
process, so a multi-gigabyte attach takes as long as it takes — while
clipboard bytes and pathless drops arrive fully materialised and are
capped at 100 MiB (`MAX_IN_MEMORY_ATTACHMENT_BYTES`). Staging carries **no
wall clock** either: the Android `ATTACHMENT_UPLOAD_TIMEOUT_MS` (90s)
existed to turn a dead connection into a settled batch, and here the SSH
transport's keepalive does that job by rejecting the SFTP transfer
instead. The contract that matters: **when a stage result is `ok === false`
but `paths` is non-empty, attach those paths anyway and show the error**
(#570 — never throw survivors away). De-duplicate by remote path;
single-flight while a batch runs (attach button disabled; typing and
text-only Send stay live); removing a tile never touches the draft; after
a failed send the tiles are gone and their paths live in the draft text —
the resend must not re-append them. Staging is EAGER — bytes upload when
the file is attached, not when the prompt is sent (§27.7 relies on this).

## 18. Slash commands (desktop)

The catalog ships as data in `src/shared/agentCommands.ts` (per agent plus
the substring filter) — app-shipped, not user CRUD. **Grok is the one list
with no Android original**: it was assembled from the Grok CLI's commands
rather than ported, which makes it the one entry without a receipt — when a
`grok --help` is finally captured, check the list against it and DELETE
anything that turns out not to exist rather than annotating it. Dropdown
opens above the draft field when `slashQueryFor` is non-null and the
filtered list is non-empty; keyboard navigation (arrows, Enter/Tab accept,
Escape closes the dropdown only) is a desktop addition — the phone is
tap-only. Agent-kind gating: the `/` button is disabled and the dropdown
never opens when no agent kind is known; a shell pane gets null. Do not
invent a fallback catalog — never offer an unavailable command.

## 19. Snippets — deferred

No snippet storage exists on desktop; the `{}` button does not ship. When
snippets land, the rule is §8: a pick **appends to the draft, never sends**.

## 20. Keyboard

Register global chords on `window` with capture and
`preventDefault()` + `stopPropagation()`, so xterm's textarea never sees
them. **Every global here is a Shift-chord, and that is not a style**: bare
`Ctrl+K`, `Ctrl+L`, `Ctrl+A`, `Ctrl+E`, `Ctrl+R` are real terminal keys
(§3.1 of SHORTCUTS.md) and must keep reaching the pane. The chord table —
toggle, grow/shrink, attach; Enter sends, Shift+Enter newlines, Escape runs
the §12.2 ladder, `Ctrl+↑`/`↓` walk sent-prompt history (§28) — lives in
the shortcut registry and is tabulated in `docs/SHORTCUTS.md` §1.4.
`Enter`-sends is correct because the phone's single Send always submits
(§5.3) and the composer's whole purpose is submitting prompts. Do **not**
add a settings toggle for "Enter inserts a newline" — `Shift+Enter` is the
escape hatch.

## 21. Styling and geometry

Colour is the token set in DESIGN.md §4.3 — panel chrome `--surface`, draft
fill `--bg`, draft border `--border-strong` (WCAG 1.4.11: an input's
boundary must be ≥3:1), enforced by `tests/unit/designGates.test.ts`.

### 21.1 The composer FLOATS, and the user places it

Not a docked row, not a full-bleed strip: a card the user can drag anywhere
in the session body and resize from any edge, inside a `.composer-dock`
that is absolutely positioned, inset from the body, and transparent to the
mouse (pointer-events: none — the terminal stays clickable). The arithmetic
is pure, in `src/shared/composerGeometry.ts`, tested in
`tests/unit/composerGeometry.test.ts`; the component only measures the dock
and feeds deltas. The decisions the arithmetic encodes:

- **Geometry is four numbers measured from the resting corner**
  (`right/bottom/width/height`): the home is bottom-right, so the resting
  state is two zeroes, and a pane that gets *shorter* carries the card up
  with its bottom edge instead of pushing it out of sight.
- **The dock is INSET, not padded** — an absolutely positioned child
  resolves offsets against the containing block's *padding* box, so padding
  would not have held the card off the edges; insetting the dock means
  `right: 0; bottom: 0` *means* the resting corner, and the geometry module
  never has to know the inset.
- **Containment is total** — clamped fully inside the pane, always; there
  is no partially-lost state to recover from, so no rescue affordance is
  needed. Floors 360×190 (the height at which toolbar, two draft lines,
  tiles and Send row all fit); cap 80% of the pane.
- **Keep-out, not a wall**: the fixed toggle's measured corner box is
  `PaneBox.keepOut` — a card parked to the LEFT of the toggle may still sit
  on the pane's floor; a card spanning it is lifted above it, so the
  control that closes the card can never end up underneath it.
- **Snapping on mouse-UP after a MOVE only**, 12px, per axis — never during
  a drag (DESIGN.md §5.9 wants pointer-1:1) and never after a resize, which
  would silently change the size just chosen.
- **Dragging a maximized card leaves the maximized state** and keeps the
  box it had, exactly like dragging a maximized OS window restores it under
  the cursor.

### 21.2 The terminal-never-resizes guarantee

**The composer reserves nothing.** An earlier design gave the tab body a
permanent padding strip; the user asked for those rows back. The guarantee
never depended on the padding, only on its being a **constant**: the
terminal is sized by the pane, and no composer state can change it. Zero is
a constant. The cost, stated in §21.4: the toggle floats over the
bottom-right of the terminal, where tmux paints the right end of its status
line.

### 21.3 Inside the card

Ported proportions: draft box min-height two lines (below that the caret
line is clipped in half) with internal scroll; the slash dropdown renders
ABOVE the card's top edge — which is why the card is not `overflow:
hidden`, and why the top sashes close the card's corners themselves.

### 21.4 One toggle, one position — the control that never moves

**Exactly one open/close control, anchored to the PANE, not the card**:
pinned to the dock's bottom-right corner, identical in every state. The
card moves (§21.1), so a control riding on it has no fixed position to
offer; opening is a summons issued from somewhere else, and *that* is what
needs one unmoving pixel. A waiting draft shows as a 6px accent pip plus
tooltip copy (`railToggle`, pure and tested). The card also has a header
close button — dismissal last, in the conventional window order — and
maximize keeps its button rather than retreating into the header
double-click: a primary affordance should not live only behind an
undiscoverable one.

**Closing always hands the keyboard back to the terminal.** Every path —
pinned toggle, card close, Escape, the chords, close-on-send — routes
through one `hideComposer()` that focuses the pane. That is not a nicety:
the typing intercept of §26 lives on the terminal's own textarea, so a
close that left focus on a button would leave the next keystroke going
nowhere and the whole feature looking broken. `lastOpenMode` carries
docked-vs-maximized across the round trip whichever closer is used;
asserted end-to-end in `tests/e2e/composer.spec.ts`.

## 22. Deliberately NOT ported

- **Voice / dictation, the pending-transcription queue, the API-key vault**
  — ~60% of the Kotlin ViewModel exists for Whisper; none of it has a
  desktop analogue, and dropping it removes the entire reason Android's
  `requestSend` has a queue-until-transcription branch: desktop `send()` is
  a straight-line call.
- **Everything IME** — the keyboard-up chrome (§3.3), every inset-derived
  cap and header-drop rule. A desktop window has no soft keyboard. **Do not
  port any reserve constant, any height cap keyed on an inset, or any "hide
  the header when …" rule.** The one durable lesson: the Send row must
  always be reachable and a long draft must scroll *within* the composer
  instead of pushing controls out of view (`overflow-y: auto` on the draft,
  `flex: none` on the control row).
- **`TextFieldValue` composing-region handling** (#491) — a DOM textarea's
  `.value` is always the visible text. IME composition still exists in the
  DOM: guard Enter-to-send with `event.isComposing`, and that is the whole
  of it.
- **`SavedStateHandle` mirroring + the #746 owner stamp** — replaced by the
  persisted per-session map (§12.4).
- **Modal bottom sheet, scrim, swipe-to-dismiss, BackHandler** — the
  desktop composer floats but is never modal: no scrim, the terminal behind
  it stays live and clickable. Escape replaces Back; the toggle and chords
  replace the swipe.

## 23. What the desktop ADDS

1. **The hidden rail** (§12) — the phone has no equivalent; it just vanishes.
2. **Real keyboard shortcuts** (§20) and **slash-dropdown keyboard
   navigation** (§18) — the phone is tap-only.
3. **Paste-to-attach** (§23.4): on the draft's `paste` event, any
   non-plain-text clipboard item is staged as `{kind:'bytes'}`; plain text
   pastes normally. Screenshot → paste → attached tile.
4. **Drag-and-drop onto the card AND the terminal pane** (§23.5):
   TerminalView cancels the drop and emits the File objects to
   `PromptComposer.acceptDroppedFiles` — the same routing the paste chords
   use, so there is still one staging path and it lives in the composer.
   The files must ride the event (a DataTransfer is dead once the drop
   returns), and the panel opens before the upload runs — a drop is a
   summons. Only drags advertising `Files` are claimed on either surface, so
   the tab strip's drags fall through.
5. **Draft persistence across app restarts** (§12.4) — Android loses
   attachments on process death; desktop persists draft + attachments +
   mode.

## 24. Tests

The contracts live in `tests/unit/`: `composerText` (§14),
`composerSend` (§16.2–16.3), `composerAttachments`, `composerGeometry`
(§21.1), `composerStore` (the §4/§12 state rules), `composerOutsideClick`
(§12.2 guards), `composerDiscardControls` (§15.1), `composerHistoryRecall`
(§28), `DoodleCanvas` / `doodleGeometry` (§27); `tests/e2e/composer.spec.ts`
drives the composed surface. The integration invariant: compose a two-line
prompt with one staged attachment, send it, and assert with `tmux
capture-pane` that the pane received **one** submission containing both
lines and the `Attached
files:` block — the bracketed-paste proof (§16.2).

## 25. Dependencies, settled

**§25.2 The shells registry:** `src/renderer/stores/shells.ts` keeps a
`register` / `unregister` / `shellIdFor` registry keyed by session, so the
composer writes to the same shell the terminal shows. Everything else this
spec once depended on — session identity, agent detection, the attachments
IPC contract — landed.

## 26. Two behaviours the user drives from Settings

Both switches live in the settings store (`typingOpensComposer`,
`closeComposerOnSend`), both default **on**, both read through the store on
every use — flipping one takes effect on the next keystroke. They exist for
one reason, stated by the user: on the phone the composer is the primary
way you talk to the agent, and they want the same reflex here. Together
they make the rhythm: type anywhere, the card appears with what you typed;
send, it gets out of the way; type again, it is back.

### 26.1 `typingOpensComposer`

A printable keystroke at a CLOSED composer opens it and lands in the draft —
**the triggering character is not lost** (retyping the first letter of
every prompt would defeat the point). Decided by `isTypingKey` (pure,
unit-tested), intercepted in TerminalView's key handler, wired by the
workspace passing `interceptTyping` — the terminal knows nothing of the
composer; the composer nothing of the terminal's key handling.

**Where the line is drawn:** `isTypingKey` returns false — the key goes
straight to the shell — for anything with Ctrl/Meta/Alt (one rule covers
every shell chord; Shift is deliberately absent: Shift-A is a capital
letter); for any key whose `key` is not exactly one code point (the DOM
spells named keys out — Enter, Tab, Escape, arrows, F-keys — so one rule
covers the control keyboard); for a **bare space** (the near-universal
"next page" in pagers and tmux copy mode, and nobody begins a prompt with
it — only the TRIGGER is affected); and mid-IME-composition (composing text
belongs to whatever has focus). `preventDefault()` is the feature, not a
precaution: cancelling the native path is what stops xterm AND suppresses
the DOM keypress, so the character cannot reach the draft a second time on
top of the copy `typeInto` planted.

**How to get a plain terminal:** open the composer and click into the
terminal (the intercept only runs while it is CLOSED), or turn the setting
off. **No silent suppression hatches.** Earlier designs armed a suppression
from a dismissal and then from a click in the terminal; the user hit both
as ordinary static — in a terminal-centric app, clicking into the terminal
is how you focus the window and select a path, not a declaration of shell
intent — and reported typing opening the composer "sometimes" with nothing
on screen saying why. The hatch was removed outright; the intercept's
conditions stay visible on screen. The ONE exception is
`terminalOwnsTyping`, armed only by §12.2's short-draft hand-off — that
close PUT the user's text at the prompt, so re-catching the next keystroke
would fight the words it just delivered; a fact on screen, not a silent
hatch. It clears the moment the composer is summoned again. The accepted
cost: with the setting on and the panel closed, every printable keystroke
opens the composer. The user types prompts for a living here and chose
that trade in as many words.

### 26.2 `closeComposerOnSend`

After a delivered send the composer closes itself; the next keystroke
brings it back (§26.1). **Only a confirmed delivery closes it** — a
failure, including a timeout, leaves the card open: the composed payload is
back in the draft and the "Not sent" banner is showing, and closing over
the top of that would hide both, leaving an invisible unsent prompt with no
explanation. A partial attachment failure happens at STAGE time and has no
say here (§17). The rule lives in the store's
`send(key, deliver, { closeOnDelivery })` so the failure case is testable
without a settings fixture. It composes with `lastOpenMode`: a maximized
composer that closes on send re-opens maximized.

## 27. The doodle / annotate surface

`DoodleCanvas.vue`, reached from the attach row (blank sheet, clipboard, a
local file, a file on the host) and from the pencil on an already-staged
image tile (§27.7). Whatever the source, the image arrives as a URL an
`<img>` can load and leaves as PNG bytes through the `{kind:'bytes'}`
staging path the clipboard already uses — no new upload, remote-path, tile
or send code (§17, §23.4).

### 27.1 The document, and what "attached" means

The sheet is a list of ITEMS — strokes and text annotations — repainted
onto one canvas; `commit()` encodes that same canvas, so **anything visible
on the sheet is in the attached PNG by construction**. There is no preview
layer for the exporter to reproduce, which is the failure this design
exists to make impossible. The one thing that is NOT an item is the text
tool's caret — a real `<textarea>` floating over the canvas, invisible to
`toBlob` — so the commit path flushes the open editor into the document
*before* encoding. Attaching mid-sentence attaches the sentence (asserted
against a recording 2D context, not trusted).

### 27.2 Tools

Freehand, line/arrow, rectangle/ellipse, text. The rules that are decisions
rather than drawing: **Shift constrains line/arrow to 45° steps but is
deliberately NOT wired to rectangle/ellipse** — there the same key
conventionally means square/circle, a different constraint under the same
keycap; implementing one and leaving the other inert is worse than neither.
**A click with no drag commits nothing** — a zero-length arrow is invisible
but would still consume an Undo, and an Undo that appears to do nothing is
how users conclude undo is broken (only the pen means anything by a single
point: a dot). The arrowhead scales with stroke weight, capped at 60% of
the arrow's length; the shaft stops at the barb baseline so a fat round cap
cannot poke out of the point. One colour row and one weight row serve every
tool — weight drives stroke thickness and, through it, text size: they are
the same idea.

### 27.3 Text, and the Escape collision

`Enter` is a NEWLINE in the annotation editor (annotations wrap and are
routinely two lines — the opposite of the draft's Enter-sends, and fine:
the draft is a message being finished, this is a caption being laid out);
`Ctrl/Cmd+Enter` commits; `Ctrl+Z` is the textarea's own undo. **The
load-bearing part: `Escape` commits AND stops propagating.** This canvas
sits inside an OverlayPanel (Escape closes it) inside the composer (Escape
runs the §12.2 ladder), both listening for a bubbling Escape — without
`stopPropagation`, one Escape while typing a caption would throw away the
caption, the drawing and the composer, in that order. Handling it on the
focused element makes the open editor the innermost rung of the same ladder
— *Escape closes what you opened last* — without either outer handler
knowing this tool exists. It commits rather than cancels because Escape in
this app never destroys work (§12.2). Committed text stays editable (click
with the text tool); emptying an annotation deletes it — no separate delete
control, which would need a selection model this surface does not have.

### 27.4 Undo

`history` is a stack of previous versions of the item ARRAY — not
per-stroke pixel snapshots — which is what lets one Ctrl+Z cover every
mutation: strokes, shapes, placing a text annotation, **retyping an
existing one** (a mutation in the middle of the document, which a
pop-the-last-item stack cannot express), and **Clear**. Every mutation goes
through one function, so "does undo cover this tool?" is answerable by
reading one place.

### 27.5 Geometry lives outside the component

`src/shared/doodleGeometry.ts` holds the arithmetic — arrowheads, 45°
snapping, greedy line breaking with character-level breaking for an
unbreakable URL, block layout, hit testing. Pure: numbers and a `measure`
callback, no DOM, no canvas — that is what makes the parts most likely to
be subtly wrong testable without a canvas at all.

### 27.6 Typography, and the one token deviation

Family, weight and leading resolve from computed style at paint time — no
literal enters the `.vue`. **Size deliberately does NOT come from
`--fs-*`**: that ladder is a chrome density system topping out at 20px,
while this canvas is a bitmap up to 2048px wide. Size follows the selected
mark weight (8x, with a 36px floor), so a caption and the arrow pointing at
it read as one hand. (The ratio was once 4x, borrowed from the arrowhead —
and that borrowing was a reported bug: an arrowhead is a shape and survives
shrinking; type does not.) The test asserts what REACHES THE EYE, not the
constants against themselves.

### 27.7 Annotating an image that is already attached

The pencil appears on image tiles only, decided by `classifyByName` — the
same classifier the Files tab uses — NOT by "does the tile have a
thumbnail": a tile only carries a preview when it came from a paste or a
drop, so that rule would offer annotation on a dropped screenshot and
refuse it on the identical file attached through the paperclip. The
pixels: staging is eager (§17), so the host always has an authoritative
copy (`sftp:readBinary` is the fallback for any tile, including one
restored from a previous run) — but for the case people actually hit (a
screenshot pasted five seconds ago) the bytes are already in the renderer
behind the tile's object URL, so the local preview is tried first; only
tiles with no preview pay for the read.

**Replace, not keep alongside — and the ordering rule is load-bearing.**
"Annotate it" is a sentence about one image; keeping both would hand the
agent a clean copy and a scribbled copy of the same screenshot with nothing
to say which to believe. The swap is **in place** because paths are folded
into the prompt in tile order at send time (§5.1) — a draft saying
"compare the first screenshot with the second" is a statement about the
list's ordering, and remove-then-reattach would silently move the image to
the end. `replaceStagedAttachment()` is that ordering rule, pure and
tested; it reports `null` rather than appending when the target is gone.
The original on the host stays — `AttachmentRetentionPolicy` already owns
that directory's lifetime, and deleting eagerly would mean a new privileged
IPC channel to reclaim one screenshot from a directory that prunes itself.
**Re-annotating starts from the flattened result** — the second pass draws
on the PNG the first pass produced, not on vector items, which are not
persisted; `doodleAttachmentName()` strips the previous decoration so the
name is stable under any number of passes.

### 27.8 Cancelling no longer destroys the drawing

Every dismissal routes through `requestClose()`. An empty sheet still
closes on one Escape — a doodle opened by mistake must not argue. A sheet
with work raises a confirmation in its own footer, REPLACING the action row
rather than stacking above it (two stacked modals share one Escape listener
and no stacking order). An open caption is flushed into
the document first, so it counts as work. Escape keeps its §12.2 meaning —
it never destroys work: it arms the confirmation, and a second Escape
**dismisses the confirmation** rather than confirming it — the safe
direction on the key people press without reading. Discarding takes a
deliberate click on a button labelled Discard.

---

## 28. Sent-prompt history — repeat what you already sent

Prompts go into a tmux pane that may not be the one on screen, so re-running
one means retyping it from memory; the composer has `history` and the up
arrow, per session.

- **What is recorded:** every CONFIRMED delivery, as the COMPOSED payload —
  attachment paths already folded in — because that is the text that
  entered the pane, and a repeat should resend exactly what was sent.
  Failed and timed-out sends are never recorded: "up arrow" must not
  re-offer something that already failed once. A resent prompt has ONE
  place in the list — the top (zsh's `erasedups`, not bash's
  `ignoredups`), so the arrow never walks the same text twice. Capped at
  100, keyed like every per-session fact, carried across a rename by
  `rekey`.
- **The arrow walk:** `Ctrl/Cmd+↑` older, `Ctrl/Cmd+↓` newer, and one ↓
  past the newest hands back the draft the walk started from (held in
  `recallSaved` for exactly that — browsing never destroys work). **The
  chord, not the bare arrows**: plain ↑/↓ must stay caret keys for editing
  a multi-line draft. Any manual edit ends the browse; so do Discard, a
  delivered send, and a failed send's restore. Recalling a prompt that
  starts with `/` dismisses the dropdown rather than opening it: the text
  was not typed, so it is not a query.
- **Persistence:** `history` and `recallSaved` join the per-session blob
  (§15); the browse cursor itself does not survive a restart — it is a
  gesture — so a draft parked in `recallSaved` when the app went away is
  restored as THE draft.
