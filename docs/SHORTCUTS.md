# Keyboard

The chord list itself is **data**, in `src/shared/shortcuts.ts`, rendered
verbatim in Settings → Keyboard. This file is only the reasoning the registry
cannot carry. `Ctrl` means Ctrl-or-Command everywhere: every call site spells
`e.ctrlKey || e.metaKey`.

---

## 1. What is bound, surface by surface

### 1.1 The terminal pane — `TerminalView.vue`, `onCustomKey`

| Chord | Does | Note |
|---|---|---|
| `Ctrl+V` / `Ctrl+Shift+V` | Put the clipboard in the composer | Both chords, same command — the split is keyboard-vs-mouse, not chord-vs-chord: a pane where one paste chord opens the composer and its twin feeds the shell is a coin toss called after the clipboard has already gone somewhere. `Ctrl+Alt+V` is left alone — that is AltGr. |
| `Ctrl+Shift+C` | Copy the selection | Only with a selection; falls through otherwise. |
| `Ctrl+C` | Copy the selection | The Windows-console contract: with a selection it copies, without one it falls through and is SIGINT (§3.1). |
| *any printable key* | Opens the composer with the keystroke | Gated on `typingOpensComposer` and the composer being closed; stood down after a short-draft hand-off (COMPOSER.md §12.2). |
| right-click | Paste into the shell | The only route to the shell's own paste. |
| mouse-up after a drag | Copy the selection | Ditto. |
| middle-click | Nothing — deliberately | xterm answers a middle-button `auxclick` by letting the BROWSER's middle-click paste feed the shell silently; the pane cancels it in the capture phase. |
| drag, release | Select in the pane; copy on release | Plain and Shift+drag always take the LOCAL path even with mouse reporting on — the remote-owned path took the gesture away and the user read that as selection being broken. `terminalMouseSelection.ts` forces button-1 to the local selection service. |
| Alt+drag — reporting ON | Select in TMUX instead | tmux paints its copy-mode highlight; the release yanks it back as OSC 52 (`osc52.ts` writes it to the clipboard). |
| drop a file on the pane | Attach it to the composer | Emits the File objects to PromptComposer (COMPOSER.md §23.5). A tab drag carries a different mime type and is not claimed. |

Both paste chords are cancelled with `preventDefault()`, and that is
load-bearing: an un-cancelled event gets acted on a second time by the
browser (the doubled-paste bug; §4).

### 1.2 Navigation — the two arrow pairs

One capture-phase `keydown` on `window` each, so the chords work with focus
anywhere. The axes match the screen: tabs run across the top, folder rows
down the left.

| Chord | Does | Owner |
|---|---|---|
| `Ctrl+[` / `Ctrl+]` | The tab to the left / right; **stops** at the ends | `FolderWorkspaceView.vue` |
| `Ctrl+↑` / `Ctrl+↓` | The folder workspace above / below; stops at the ends; crosses root headers | `HostWorkspaceView.vue` |

What they cost, stated rather than assumed: through xterm `Ctrl+[` IS Escape
(readline's meta-prefix) and `Ctrl+]` is GS — Meta stays reachable through
Alt; the arrows are the cheaper pair, readline leaves them unbound. They
stand down inside a real text field — but the terminal is deliberately NOT
in that set, or the chords would do nothing in the one place they exist for.
The removed `Ctrl+Tab` cycle, `Ctrl+1..9` and `Ctrl+Shift+PageUp/Down` each
handed real keys back to the pane (§3.4 tabulates what those were).

### 1.3 The Files tab — `FilesView.vue`, `onKeydown`

`Ctrl+S` save-when-dirty · `Ctrl+L` path bar · `Ctrl+F` tree filter ·
arrows/Home/End step the list (roving focus). Inside the tree's two fields,
Enter commits and Escape cancels. An open file runs CodeMirror's own keymaps
(configured, not written by this app).

### 1.4 The prompt composer — `PromptComposer.vue`

Window-level, capture: `Ctrl+\`` and `Ctrl+Shift+K` toggle ·
`Ctrl+Shift+↑/↓` grow/shrink · `Ctrl+Shift+A` attach. In the draft: Enter and
Ctrl+Enter send, Shift+Enter newline, `Ctrl+Shift+Backspace` discards,
Escape runs the close ladder (COMPOSER.md §12.2), arrows/Tab/Enter drive the
slash dropdown while it is open. The full table lives in the registry.

### 1.5 The annotate surface — `DoodleCanvas.vue`

`Ctrl+Z` undo · `Escape` commits the open caption (this app's Escape never
destroys work) · `Ctrl+Enter` commits.

### 1.6 Everywhere

| Chord | Does | Where |
|---|---|---|
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` (plus keypad and `Ctrl+Shift+=` spellings) | Zoom in / out / reset | `before-input-event` in main, decided in `zoomKeys.ts` |
| `Ctrl+Shift+W` | Close the window | `windowKeys.ts`, same door |
| `Ctrl+Shift+I` | Toggle DevTools | ditto |
| `Ctrl+W` | Delete the word before the caret — text fields only | window keydown in `App.vue`; stands down inside `.xterm` and does not install on darwin |
| `Escape` | Close the panel in front | `OverlayPanel.vue`, `PopupMenu.vue` |

**Electron's default menu is removed** (`Menu.setApplicationMenu(null)`, darwin
keeps its platform menu). It bound fifteen accelerators this app never
declared, and two had already cost a bug. `Ctrl+W` was the load-bearing case:
at the terminal it never was the menu's to lose (xterm cancels the keydown
and sends `\x17`, and a cancelled keydown never reaches an accelerator) — the
surfaces that lost the whole app to one keystroke were the text fields with
no delete-word to perform, which is why the answer was removing the menu, and
why `Ctrl+W` deletes a word in text fields again.

The two `Ctrl+Shift+` chords in main were admitted on one test: driven
against the real xterm, each produces **nothing** at the terminal, so
claiming them costs the shell no key. Anything matched in
`before-input-event` is taken from the terminal *everywhere*, which is why
that test is the entry requirement.

### 1.8 Session creation — quick create in `FolderWorkspaceView.vue`, picker in `SessionTree.vue`, both `onWindowKeydown`

The `Ctrl+N` pair splits by how much the user already knows:

| Chord | Does | Note |
|---|---|---|
| `Ctrl+N` | Starts a plain shell in the folder workspace in front — one press, no dialog — and puts the keyboard in the new pane | `FolderWorkspaceView` |
| `Ctrl+Shift+N` | Opens the panel's creation picker — the folder-first dialog, caret in its filter | `SessionTree.vue` |

The quick half is the app's one deliberate bare-Ctrl chord taken against a key
the shell receives: `Ctrl+N` is `^N` — readline next-history, next-line in
emacs and vi — and it is claimed at the user's word, because a quick create is
what the unshifted chord is *for* and the shifted twin is already the dialog.
The cost lives in the registry note beside the binding, and
`terminalCanEncode` says it again in Settings. It stands down inside a text
field and while a tab rename is open, refuses key repeat (a held chord would
mint a session per repeat), and is live only while a folder workspace is
mounted — with focus in any of its tabs, Files included. On the host list,
where no folder is open, there is no "this folder" to create in and no
handler is standing.

The picker half takes nothing from the shell: the shifted letter encodes
nothing at the terminal. `Ctrl+Shift+P` was refused, not skipped — it is a
live rebind target the persistence guard already defends. Stands down inside a
text field and while the picker is open; live whenever the panel is mounted,
collapsed included.

---

## 2. The registry

`src/shared/shortcuts.ts` — one `ShortcutSpec` per binding: stable `id` (the
key on disk), `surface`, user's-words `label`, `defaults`, `rebindable`,
`note`, and `owner` (`app` | `main` | `menu` | `library`). `owner` is the
honest half of "configurable": a chord recognised in main cannot read the
renderer's localStorage, and a CodeMirror keymap is not ours to move — both
are still listed, because a key that does something is a key the user asks
about. Chords match on `KeyboardEvent.key` (the layout-produced character);
on the Russian layout `ё` canonicalises to `` ` ``, so `Ctrl+Ё` is
`composer.toggle` exactly as `Ctrl+\`` is.

Two entries in the surface-collision graph (`SURFACE_COLLISIONS`, symmetric
and reflexive, test-proven) are findings rather than transcription:

- **The composer is live on the Files tab** — mounted outside the tab body
  behind a `v-show`, handler on `window` with capture — so `Ctrl+\`` there
  toggles a panel the user cannot see.
- **The Files tab has no terminal behind it** — which is why `Ctrl+S` may be
  Save there and may never be anything at a shell, where it is XOFF. That
  asymmetry is why this is a graph and not "everything collides".

`Escape` (and `Enter`) are **ladders**: each rung stops the key before it
reaches the next one out — one keypress closes the innermost thing that is
open. Rungs share a chord by design, must not be reported as conflicts, and
are `rebindable: false` — what makes a ladder work is handler order, which a
chord picker cannot express.

---

## 3. What cannot be bound, and why

Ordered from the most specific cause to the least, so a chord that is both
reserved *and* already taken reports the reason it can never be had.

### 3.1 Chords that belong to the shell

Refused on every surface that collides with `terminal`. All **bare Ctrl** —
not an oversight: a terminal encodes `Ctrl+letter` as one control byte and
cannot express `Ctrl+Shift+letter` at all. That is why every app chord that
sits next to a terminal wears Shift.

| Chord | Why |
|---|---|
| `Ctrl+C` | SIGINT when nothing is selected — the only way to stop a running program; with a selection the pane copies (§1.1), fixed either way. |
| `Ctrl+D` | End of input — the only way to exit a shell or a REPL. |
| `Ctrl+Z` | SIGTSTP — suspends the foreground job. |
| `Ctrl+B` / `Ctrl+A` | tmux's two common prefixes; `Ctrl+A` is also readline's beginning-of-line. |
| `Ctrl+\` | SIGQUIT — the stop that works when SIGINT does not. |
| `Ctrl+S` / `Ctrl+Q` | XOFF freezes the terminal; XON is the only way back. |

Deliberately short: it covers being unable to **stop, exit, suspend or
unfreeze** a program, and being unable to reach tmux. Keys that merely annoy
(`Ctrl+R`, `Ctrl+U`) are not here — refusing those would be this app deciding
how somebody edits their command line. A **bare `Alt` chord** is refused on
the same surfaces: Alt is Meta at a terminal.

### 3.2 Accelerators Electron's menu owns

Split by whether a cancelled keydown takes them back (measured, not assumed —
exactly what `preventDefault()` fixed in the doubled-paste bug):

- **Editing roles** (undo/redo/cut/copy/paste/selectAll) act on whatever holds
  focus and yield to a cancelled keydown. **Bindable**, with §4's requirement.
- **Window and app roles** (`Ctrl+W`, `Ctrl+Q`, `Ctrl+M`, `Ctrl+R`, `F11`,
  `F12`, …) are handled before the renderer; `preventDefault()` does not
  reach them. Binding one gets you the command **and** the role. **Refused.**
- **Zoom roles** — disarmed by main, owned by `zoom.*`. **Refused** because
  they are taken.

### 3.4 What a terminal *can* send

`terminalCanEncode()` is an annotation, not a refusal: it answers "what did I
just lose?", shown beside every terminal and tab binding **both ways round**,
derived from the chord in force. The rows that matter:

| Chord | What xterm emits |
|---|---|
| `Ctrl+Tab` | `HT` — at a prompt, completion |
| `Ctrl+<arrow>` | `ESC [ 1 ; 5 <A-D>` — readline reads D/C as backward/forward-word; what the arrow chords (§1.2) cost |
| `Ctrl+Shift+<arrow>` | `ESC [ 1 ; 6 <A-D>` — modifiers ride in the CSI parameter |
| `Ctrl+1`, `Ctrl+2`, `Ctrl+9` | nothing — the only free digits |
| `Ctrl+Shift+<letter>` | **nothing** |

The last row is the rule the app's chords rely on. `zoomKeys.ts` refuses
`Ctrl+Shift+-` as a zoom-out spelling for the mirror-image reason: it is
Ctrl+`_`, readline's undo.

---

## 4. The non-negotiable: `preventDefault()` **and** `return false`

Wherever a chord is intercepted in the terminal, both. Three bugs came from
`return false` alone:

> xterm's `_keyDown` bails at the custom handler and, unlike `_keyPress`, never
> calls its own `cancel()`. So returning false stops **xterm** and leaves the
> DOM event live, and the browser goes on to perform its own default action.

That produced the doubled first letter and the doubled paste. Regression
tests (`terminalTypingIntercept.test.ts`, `terminalPasteChord.test.ts`)
assert `defaultPrevented` rather than a byte count, because jsdom cannot
reproduce the second write — what it can assert is the thing that makes the
second write impossible. Every new interception copies that shape.

---

## 5. Persistence and call sites

`shortcutOverrides` in the settings store follows its three-step recipe.
**Only the differences are stored, never the whole table** — a stored full
table would freeze whatever shipped the day the user first opened the screen,
so a later build that moved a chord would never reach them; resetting a
binding deletes its override, because absence is the only spelling of
"whatever the app currently thinks is right". Degradation is per entry;
full validation (reserved chords, conflicts) runs inside `resolveBindings`,
the only point where every other binding is known.

No chord is spelled inline at a call site — `isShortcut(bindings, id, e)` is
the whole test, which is what makes the Settings list the truth rather than a
second copy. `settings.shortcutBindings` is a computed, so a rebinding takes
effect on the next keystroke; `chordsFor` falls back to defaults so a binding
can never silently stop working. Every renderer handler reads the registry.
The one deliberate exception: `main/windowChords.ts` and `shared/zoomKeys.ts`
recognise their chords in main, before the page sees the key, and main cannot
read the renderer's localStorage — listed and locked rather than wired.
