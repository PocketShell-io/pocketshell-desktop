# Keyboard

Every chord this app claims, where it is implemented, and what it cost. The
list itself is **data**, in `src/shared/shortcuts.ts`, and is rendered
verbatim in Settings → Keyboard; this file is the reasoning behind it.

---

## 1. The audit

What is actually bound, surface by surface. `Ctrl` means Ctrl-or-Command
everywhere: every call site in the app spells the test
`e.ctrlKey || e.metaKey`, so the distinction has never existed here.

### 1.1 The terminal pane — `TerminalView.vue`, `onCustomKey`

| Chord | Does | Note |
|---|---|---|
| `Ctrl+V` | Put the clipboard in the composer | Costs readline's `quoted-insert`. `Ctrl+Alt+V` is left alone — that is AltGr. |
| `Ctrl+Shift+V` | Put the clipboard in the composer | The same command. It used to paste into the shell; see below. |
| `Ctrl+Shift+C` | Copy the selection | Only when there is a selection; falls through otherwise. |
| `Ctrl+C` | Copy the selection | The Windows-console contract: with a selection it copies, without one it falls through and is SIGINT. Fixed — see §3.1. |
| *any printable key* | Opens the composer with the keystroke | Not a chord. Gated on the `typingOpensComposer` setting and on the composer being closed — and stood down after a short-draft hand-off (COMPOSER.md §12.2) until the panel is summoned again. |
| right-click | Paste into the shell | Not a chord, and now the ONLY route to the shell's own paste. |
| mouse-up after a drag | Copy the selection | Ditto. |
| middle-click | Nothing — deliberately | xterm answers a middle-button `auxclick` by moving its helper textarea under the cursor, which lets the BROWSER's middle-click paste feed the clipboard to the shell silently. The pane cancels the `auxclick` and the press's default in the capture phase, before xterm sees either; mouse REPORTING still forwards press/release to the remote (`onTerminalAuxClick`). |
| drag or Shift+drag, release — mouse reporting ON | Select in the pane; copy on release | The same local selection as with reporting off (terminalMouseSelection.ts). The highlight persists. |
| Alt+drag — mouse reporting ON | Select in TMUX instead | tmux paints its copy-mode highlight, and releasing yanks it; the yank reaches the pane as OSC 52 and lands in the clipboard, while tmux dismisses the highlight. |
| drop a file on the pane | Attach it to the composer | Not a chord either. Emits the File objects to PromptComposer, which opens and stages them (COMPOSER.md §23.5). A tab drag carries a different mime type and is not claimed. |

**A drag has two owners, decided by mouse reporting AND by Alt.** Plain drag
and Shift+drag always take the LOCAL path — xterm's own selection, copied on
mouse-up — because the remote-owned path took that gesture away and the user
read the result ("I select some code and the highlight disappears") as
selection being broken, first under the plain grip and then, when the first
fix handed Shift to tmux, under the Shift grip that fix had inherited from
the old bypass. terminalMouseSelection.ts is what forces it: with mouse
reporting on, xterm consults `SelectionService.shouldForceSelection` before
reporting a mousedown, and the pane replaces that predicate so button-1
forces the local selection service unless Alt is held — Alt is the event that
leaves for the remote. Wheel and
hover-motion reporting never pass through the predicate, so tmux keeps
scrolling pane history under the wheel. On the Alt path tmux paints the
highlight and its drag-end (`copy-pipe; cancel`) dismisses it on release —
the vanishing highlight now marks the explicit hand-off, and the yank is not
lost: tmux offers it to the outer terminal as `ESC ] 52 ; … ` (OSC 52), and
the pane's handler (`osc52.ts`) writes it to the clipboard. A tmux keyboard
yank (`prefix+[` … `y`) arrives the same way.

**Both paste chords go to the composer; the split is keyboard-vs-mouse, not
chord-vs-chord** — `Ctrl+Shift+V` is the chord every terminal emulator trains
into the hand, and a pane where one paste chord opens the composer while its
twin feeds the shell is a coin toss called only after the clipboard has already
gone somewhere. Both chords are cancelled with `preventDefault()`, and that is
load-bearing: an un-cancelled event gets acted on a second time by the browser
(the doubled-paste bug; §4).

`onCustomKey` also *declines* the workspace tab chords (§1.2) so that a pane
mounted outside a folder workspace cannot turn one into shell input.

Plus xterm's own `Shift+PageUp` / `Shift+PageDown`, which scroll the pane's
buffer, and — since the tab-move chord was removed — `Ctrl+Shift+PageUp` /
`PageDown` as well. Not this app's.

### 1.2 Navigation — the two arrow pairs

One `keydown` on `window` in **capture** each, so the chords work with focus in
the terminal, the file tree or the composer alike. The two pairs are axes of
ONE gesture, and the axes match the screen: the tab bar runs across the top of
a workspace, the folder rows run down the panel on the left.

| Chord | Does | Owner |
|---|---|---|
| `Ctrl+[` / `Ctrl+]` | The tab to the left / right; **stops** at the ends | `FolderWorkspaceView.vue` |
| `Ctrl+↑` / `Ctrl+↓` | The folder workspace above / below in the panel; **stops** at the ends; crosses root headers without stopping | `HostWorkspaceView.vue` — it changes WHICH workspace is mounted, and that view owns the route |

**The tab step clamps** — being thrown to the opposite end is not what "further
left" asked for. **What the brackets cost**, stated rather than assumed: through
xterm `Ctrl+[` IS Escape (`0x1B`) — readline's meta-prefix — and `Ctrl+]` is GS
(`0x1D`); Meta chords stay reachable through Alt. `Ctrl+↑`/`Ctrl+↓` is the
cheaper pair: readline leaves those unbound by default.

**Where they stand down:** inside a real text field. The terminal is
deliberately NOT in that set even though xterm's input sink is literally a
`<textarea>`; an editable inside `.xterm` is not an editable, or the chords
would do nothing in the one place they exist for.

**Three chord families were removed** to make room, at the user's request: the
`Ctrl+Tab` cycle, `Ctrl+1`..`Ctrl+9`, and `Ctrl+Shift+PageUp`/`PageDown`. Each
removal **handed real keys back to the pane**; what each costs is recorded
beside the former registry slots in `src/shared/shortcuts.ts` and tabulated in
§3.4.

### 1.3 The Files tab — `FilesView.vue`, `onKeydown`

| Chord | Does |
|---|---|
| `Ctrl+S` | Save the open file (only when dirty) |
| `Ctrl+L` | Put the caret in the path bar |
| `Ctrl+F` | Focus the tree filter |
| `ArrowDown` / `ArrowUp` / `Home` / `End` | Step through the file list (roving focus; live only while a row has focus) |

Plus, inside the tree's own two fields (`FileTree.vue`): `Enter` commits,
`Escape` cancels, blur cancels.

Plus CodeMirror's entire `defaultKeymap` + `historyKeymap` + `indentWithTab`
inside an open file (`CodeEditor.vue`). That is a keymap this app configures
but does not write; the entries that matter to a reader are `Ctrl+Z` for undo,
`Ctrl+Y` and `Ctrl+Shift+Z` for redo, and `Ctrl+M` for the tab-focus escape
hatch.

### 1.4 The prompt composer — `PromptComposer.vue`

Window-level, `capture: true`, registered in `onMounted` (`onGlobalKey`):

| Chord | Does |
|---|---|
| `Ctrl+\`` | Toggle the composer |
| `Ctrl+Shift+K` | Toggle the composer |
| `Ctrl+Shift+Up` | Grow — costs `ESC [ 1 ; 6 A` at the pane; see §3.4 |
| `Ctrl+Shift+Down` | Shrink, and close past `docked` |
| `Ctrl+Shift+A` | Attach a file |

In the draft textarea (`onDraftKeydown`):

| Chord | Does |
|---|---|
| `Enter`, `Ctrl+Enter` | Send |
| `Shift+Enter` | Newline |
| `Ctrl+Shift+Backspace` | Discard the draft |
| `Escape` | The ladder: close the slash dropdown, else close the panel — handing a short draft (under five characters) to the pane, unsubmitted (COMPOSER.md §12.2) |
| `Up` / `Down` / `Tab` / `Enter` | Move and accept in the slash-command dropdown, while it is open |

### 1.5 The annotate surface — `DoodleCanvas.vue`

| Chord | Does |
|---|---|
| `Ctrl+Z` | Undo the last mark |
| `Escape` | **Commits** the open caption (this app's Escape never destroys work) |
| `Ctrl+Enter` | Commits the open caption |

### 1.6 Everywhere

| Chord | Does | Where |
|---|---|---|
| `Ctrl+=`, `Ctrl++`, `Ctrl+Shift+=`, keypad `+` | Zoom in | `before-input-event` in main, decided in `zoomKeys.ts` |
| `Ctrl+-`, keypad `-` | Zoom out | ditto |
| `Ctrl+0`, keypad `0` | Reset zoom | ditto |
| `Ctrl+Shift+W` | Close the window | `before-input-event` in main, decided in `windowKeys.ts` |
| `Ctrl+Shift+I` | Toggle DevTools | ditto |
| `Ctrl+W` | Delete the word before the caret — text fields only; stands down in the terminal and the code editor | window keydown in `App.vue` (`text.deleteWordBackward`) |
| `Escape` | Close the panel in front | `OverlayPanel.vue`, `PopupMenu.vue` |

The two `Ctrl+Shift+` chords exist because §1.7's menu is gone. Both were
admitted on the same test: driven against the real xterm, each produces
**nothing** at the terminal (`onData` is empty), so claiming them costs the
shell no key. Anything matched in `before-input-event` is taken from the
terminal *everywhere*, because `preventDefault()` there suppresses the page's
keydown as well as the accelerator — which is why that test is the entry
requirement rather than a nicety.

### 1.7 Electron's default menu — removed

**This app built no menu**, so every accelerator of Electron's default menu was
live and none of it appeared anywhere in this repo. The whole menu is now gone
on Windows and Linux — `Menu.setApplicationMenu(null)` in `src/main/index.ts`,
with the reasoning in `src/shared/windowKeys.ts`. darwin keeps its menu: there
the chord is `Cmd+W`, which is the platform convention, and the app menu
carries Quit/Hide/Services.

`Ctrl+W` itself was the load-bearing case, and it now splits by surface. At the
terminal it never was the menu's to lose: xterm cancels the keydown as part of
its ctrl-letter mapping and sends `\x17` — readline's delete-word — and a
cancelled keydown never reaches an accelerator. The surfaces that lost the
whole app to one keystroke were the ones with no delete-word to perform (the
composer's draft, the Files path box, the tree filter, the code editor,
Settings) — which is why the answer was removing the menu rather than
swallowing the key at the terminal, and why `Ctrl+W` now deletes a word in text
fields again (§1.6). That handler stands down inside `.xterm`, so the shell
keeps its `\x17`, and it does not install on darwin.

### 1.8 Session creation — `SessionTree.vue`, `onWindowKeydown`

| Chord | Does | Owner |
|---|---|---|
| `Ctrl+Shift+N` | Opens the session panel's creation picker — in the panel's first root, caret in its filter | `SessionTree.vue` |

**Why `Ctrl+Shift+N`**: the shifted letter encodes nothing at the terminal, so
no shell behavior is taken; `Ctrl+Shift+P` was refused, not skipped — it is a
live rebind target the settings persistence guard already defends (an override
colliding with another binding's default is refused at load). **Where it stands
down:** inside a text field, and while the picker is already open; Escape
closes. Live whenever the session panel is mounted, collapsed included — the
panel is `v-show`'d, not unmounted.

---

## 2. The registry

`src/shared/shortcuts.ts`. One `ShortcutSpec` per binding:

```ts
{
  id:         'terminal.pasteIntoShell',   // stable; it is the key on disk
  surface:    'terminal',
  label:      'Paste into the shell',      // what it DOES, in the user's words
  defaults:   ['Ctrl+Shift+V'],
  owner:      'app' | 'main' | 'menu' | 'library',
  rebindable: true,
  note:       '…why this chord and not another…',
  ladders:    ['escape'],                  // rungs share a chord by design
}
```

`owner` is the honest half of "configurable". A chord recognised in the main
process cannot read the renderer's `localStorage`; a chord in CodeMirror's own
keymap is not ours to move. Both are still **listed**, because a key that does
something in this app is a key the user is asking about.

`Chord` is `{ ctrl, alt, shift, key }`, matched on `KeyboardEvent.key` — the
character the layout produced — for the reason `zoomKeys.ts` sets out at length.
One character folds on purpose: on the Russian layout the backquote keycap is
engraved `ё`, so `ё`/`Ё` canonicalise to `` ` `` and `Ctrl+Ё` is `composer.toggle`
exactly as `Ctrl+\`` is; the capture field stores the one canonical spelling
either way. Its stored spelling is `Ctrl+Shift+V`, modifiers in a fixed order so
that one chord has exactly one string and cannot appear twice in an override map.

### 2.1 Surfaces, and what "same surface" means

Conflict detection needs "two commands on one chord in the same surface" to be
decidable, and in this app the surfaces genuinely overlap. `SURFACE_COLLISIONS`
is the graph; it is symmetric and reflexive, and a test proves both.

| | global | workspace | terminal | composer | files | doodle |
|---|---|---|---|---|---|---|
| **global** | • | • | • | • | • | • |
| **workspace** | • | • | • | • | • | |
| **terminal** | • | • | • | • | | |
| **composer** | • | • | • | • | • | • |
| **files** | • | • | | • | • | |
| **doodle** | • | | | • | | • |

Two entries in that table are findings rather than transcription, and both are
load-bearing:

- **The composer is live on the Files tab** — `FolderWorkspaceView` mounts it
  outside the tab body behind a `v-show`, its handler on `window` with
  `capture: true`; `Ctrl+\`` there toggles a panel the user cannot see.
- **The Files tab has no terminal behind it** — which is why `Ctrl+S` may be
  Save there and may never be anything at a shell, where it is XOFF. That
  asymmetry is the entire reason this is a graph and not "everything collides
  with everything".

### 2.2 Ladders

`Escape` is handled by the doodle's caption editor, by the composer, and by the
overlay chrome, each stopping it before it reaches the next one out — one
keypress closes the innermost thing that is open; `Enter` is the same shape.
Rungs share a chord **by design**, so conflict detection must not report them,
and every rung is `rebindable: false` — what makes a ladder work is the order
handlers run in, which a chord picker cannot express. The field is a *list*
because a binding can be a rung of two ladders at once (the doodle's caption
editor finishes on `Escape` **and** on `Ctrl+Enter`).

---

## 3. What cannot be bound, and why

Ordered from the most specific cause to the least, so a chord that is both
reserved *and* already taken reports the reason it can never be had.

### 3.1 Chords that belong to the shell

Refused on every surface that collides with `terminal`. All of them are **bare
Ctrl** chords, which is not an oversight: a terminal encodes `Ctrl+letter` as a
single control byte and has no way to express `Ctrl+Shift+letter` at all. That
is why every app chord in this repo that sits next to a terminal wears Shift,
and why `Ctrl+Shift+C` is fine while `Ctrl+C` is not — the one bare-Ctrl
exception being `Ctrl+C`'s copy-when-selected, which is fixed and conditional
(§1.1) and so can never be moved onto another command.

| Chord | Why |
|---|---|
| `Ctrl+C` | SIGINT when nothing is selected — the only way to stop a running program. With a selection the pane copies instead (§1.1), which is fixed; no rebindable command may take the chord either way. |
| `Ctrl+D` | End of input — the only way to exit a shell or a REPL. |
| `Ctrl+Z` | SIGTSTP — suspends the foreground job. |
| `Ctrl+B` | tmux's default prefix. Without it there is no tmux. |
| `Ctrl+A` | The other tmux prefix in common use, and readline's beginning-of-line. |
| `Ctrl+\` | SIGQUIT — the stop that works when SIGINT does not. |
| `Ctrl+S` | XOFF. Freezes the terminal, and `Ctrl+Q` is the only way back. |
| `Ctrl+Q` | XON — the way back out of a frozen terminal. |

The list is deliberately short: it covers being unable to **stop, exit, suspend
or unfreeze** a program, and being unable to reach tmux at all. Keys that merely
annoy (`Ctrl+R`'s reverse search, `Ctrl+U`'s kill-line) are not here — refusing
those would be this app deciding how somebody edits their command line.

A **bare `Alt` chord** is refused on the same surfaces: `Alt` is Meta at a
terminal, sending `ESC` and then the key, which readline and every
Emacs-flavoured program read.

### 3.2 Accelerators Electron's menu owns

Split by whether a cancelled keydown takes them back. That split is measured,
not assumed — it is exactly what `preventDefault()` fixed in the doubled-paste
bug.

- **Editing roles** — `undo`, `redo`, `cut`, `copy`, `paste`,
  `pasteAndMatchStyle`, `selectAll` — act on whatever holds focus, and a
  cancelled keydown suppresses them. **Bindable**, with the standing
  requirement in §4.
- **Window and app roles** — `Ctrl+W`, `Ctrl+Q`, `Ctrl+M`, `Ctrl+R`,
  `Ctrl+Shift+R`, `Ctrl+Shift+I`, `F11`, `F12` — are handled by the menu, and
  `preventDefault()` in the renderer does not reach it. Binding a command to one
  of these gets you the command **and** the role. **Refused.**
- **Zoom roles** — already disarmed by main and already owned by
  `zoom.in` / `zoom.out` / `zoom.reset`. **Refused** because they are taken.

### 3.3 Chords that are not shortcuts

- No `Ctrl` and no `Alt`: it would swallow ordinary typing.
- A modifier pressed on its own.

### 3.4 What a terminal *can* send

`terminalCanEncode()` is an annotation, not a refusal: it answers "what did I
just lose?", and the Settings list shows the answer beside every terminal and
tab binding, **both ways round**, derived from the chord currently in force —
because rebinding changes the answer. Measured against the xterm this app
ships (`evaluateKeyboardEvent` in
`node_modules/@xterm/xterm/src/common/input/Keyboard.ts`):

| Chord | What xterm emits |
|---|---|
| `Ctrl+Tab` | `HT` — `case 9` is reached before the ctrl branch and is gated only on Shift, so Ctrl is ignored. At a prompt that is completion. |
| `Ctrl+Shift+Tab` | `ESC [ Z` (back-tab) |
| `Ctrl+3`..`Ctrl+7` | `ESC`, `FS`, `GS`, `RS`, `US` — keyCodes 51-55 map to `keyCode - 51 + 27` |
| `Ctrl+8` | `DEL` |
| `Ctrl+1`, `Ctrl+2`, `Ctrl+9` | nothing — the only free digits |
| `Ctrl+<arrow>` | `ESC [ 1 ; 5 <A-D>` — readline reads `D`/`C` as backward-word / forward-word, and leaves `A`/`B` unbound. This is what the arrow chords (§1.2) cost. |
| `Ctrl+Shift+<arrow>` | `ESC [ 1 ; 6 <A-D>` — modifiers ride in the CSI parameter |
| `Ctrl+Shift+PageUp` | xterm's own scrollback, not bytes |
| `Ctrl+Shift+2` / `Ctrl+Shift+-` | `NUL` / `US` — matched on the character `@` / `_`, after Shift has changed it |
| `Ctrl+Shift+<letter>` | **nothing** |

The last row is the rule the app's chords actually rely on — **`Ctrl+Shift+<letter>`
encodes nothing**, which is why every app chord that sits next to a terminal
wears Shift (§3.1). `zoomKeys.ts` refuses `Ctrl+Shift+-` as a zoom-out spelling
for the mirror-image reason: it is Ctrl+`_`, readline's undo.

---

## 4. The non-negotiable: `preventDefault()` **and** `return false`

Wherever a chord is intercepted in the terminal, both. Three bugs came from
`return false` alone:

> xterm's `_keyDown` bails at the custom handler and, unlike `_keyPress`, never
> calls its own `cancel()`. So returning false stops **xterm** and leaves the
> DOM event live, and the browser goes on to perform its own default action.

That produced the doubled first letter and the doubled paste. Both have
regression tests — `tests/unit/terminalTypingIntercept.test.ts` and
`tests/unit/terminalPasteChord.test.ts` — which assert `defaultPrevented`
rather than a byte count, because jsdom performs no default action and cannot
reproduce the second write. What it *can* assert is the thing that makes the
second write impossible.

Every new interception in `onCustomKey` copies that shape.

---

## 5. Persistence

`shortcutOverrides: Record<string, string>` in `src/renderer/stores/settings.ts`,
added by the store's own three-step recipe (field on `AppSettings`, entry in
`SETTING_SPECS`, control in `SettingsView.vue`).

**Only the differences are stored, never the whole table.** A stored full table
would freeze whatever shipped on the day the user first opened the screen, so a
later build that moved a chord would never reach them. Resetting a binding
therefore **deletes** its override rather than writing today's default into it:
absence is the only spelling of "whatever the app currently thinks is right".

Degradation is per entry, like every other collection this app stores. An
override naming an id this build dropped, a value that is not a chord, or one
naming a binding this build made *fixed*, costs that entry and nothing else.
Full validation — reserved chords, menu accelerators, conflicts — runs inside
`resolveBindings` while the resolved map is being built, because that is the
only point at which every other binding is known.

---

## 6. Call sites

The registry is only the truth if the handlers read it. The shape every
`if (e.ctrlKey && e.key === 'x')` becomes:

```ts
const settings = useSettingsStore();

if (isShortcut(settings.shortcutBindings, 'terminal.pasteIntoShell', e)) {
  e.preventDefault();          // AND return false, in the terminal. §4.
  void pasteFromClipboard();
  return false;
}
```

Two rules govern every call site:

1. **No chord is spelled inline.** `isShortcut(bindings, id, e)` is the whole
   test. That is what makes the Settings list the truth rather than a second
   copy of it.
2. **In the terminal, `preventDefault()` AND `return false`.** Both. See §4.

`settings.shortcutBindings` is a computed, so a rebinding takes effect on the
next keystroke rather than on the next mount; `chordsFor` falls back to the
defaults for a handler that resolved before the store was ready, so a binding
can never end up missing and silently stop working.

**Wired.** Every renderer handler reads the registry instead of spelling its
chords inline — `TerminalView.vue`, `FolderWorkspaceView.vue`,
`HostWorkspaceView.vue`, `SessionTree.vue`, `FilesView.vue`,
`PromptComposer.vue`, `DoodleCanvas.vue` — leaving no second copy of any chord
to drift. The wiring surfaced two latent defects on its way in: the arrow
pairs' defaults were stored as display spellings (`Ctrl+Left`) that `keydown`
never reports, and the copy branch in `TerminalView.vue` was missing its
`preventDefault()`. Both fixed.

The one deliberate exception — kept, not pending:

| File | Why it keeps its own matcher |
|---|---|
| `main/index.ts`, `shared/zoomKeys.ts` | `zoom.*` and `window.*` are recognised in the main process, before the page sees the key, and main cannot read the renderer's localStorage. Listed and locked rather than wired. |
