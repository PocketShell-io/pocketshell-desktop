import { defineStore } from 'pinia';
import { formatBytes } from '../../shared/byteSize';
import { ref } from 'vue';
import { api } from '../ipc';
import type { ConnectionId } from '../../shared/types';
import type { DirEntry } from '../../main/sftp/SftpService';
// The token NAMES only. previewStyle.ts imports nothing, so this costs the
// renderer bundle an array of fourteen strings rather than a markdown parser —
// see that file's header for why the list lives there.
import { PALETTE_TOKENS } from '../../main/preview/previewStyle';
import {
  classifyByName,
  classifyBytes,
  describeKind,
  type FileClass,
  type FileKind,
} from '../fileKind';
import { errorMessage } from '../../shared/errors';

/**
 * Files store: the SFTP browser state for the active connection. Holds the
 * current directory listing + the open file, which may be text in an editor
 * buffer, or bytes behind an object URL for the viewers.
 *
 * ## What the open file is, now that it is not always text
 *
 * `openFile` used to be one line: read the path as UTF-8 and bind it to a
 * textarea. That is what froze the app on an mp3 — several megabytes decoded
 * to U+FFFD and handed to a textarea as a single line. So an open file now
 * carries a KIND, decided before any bytes move (src/renderer/fileKind.ts),
 * and the kind decides which of three terminal states it lands in:
 *
 *   text            -> `openContent`, editable, savable
 *   image/audio/pdf -> `openUrl`, an object URL over a Blob with a real mime
 *   html/markdown/  -> BOTH: `openContent` for the editor and `previewUrl`
 *   svg                for a sandboxed frame, with `docView` saying which
 *                      one is on screen
 *   binary          -> `openNote`, a sentence and a download button
 *
 * There is no arm that falls back from one of the others to text. Every
 * failure — oversize, unreadable, a mime we could not name — ends in the
 * binary state with a reason, because a wall of mojibake is a worse answer
 * than a sentence saying what the file is.
 *
 * ## Per-session browsing position
 *
 * The Files tab is behind a `v-if` in the workspace, so leaving it unmounts
 * the view. `clear()` used to run on that unmount, which threw away the
 * directory the user had navigated to: going to Terminal and back dropped
 * them at the session's start directory every time. The remembered position
 * below fixes that WITHOUT weakening what `clear()` was for — one
 * connection's listing must never leak into another's — by keying the memory
 * on the connection as well as the session, and by clearing on DISCONNECT
 * rather than on unmount.
 */

/** How the open file is being presented. */
export type OpenMode = FileKind;

/**
 * Ceiling for the text editor.
 *
 * Not a guess at what SFTP can move — it is what a textarea can lay out.
 * Somewhere past a few MiB of one string the renderer's layout pass is
 * measured in seconds, which is the same freeze the mp3 caused with a
 * different cause. 8 MiB is comfortably above any source file or config and
 * still below the point where opening one costs a visible stall; a log
 * bigger than this is a download, and the panel says so.
 */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * Ceiling for the media viewers.
 *
 * `sftp:readBinary` was capped at 32 MiB for the doodle backdrop, where the
 * file size is the SMALL number — a 32 MiB JPEG decodes to a bitmap several
 * times larger, and that bitmap is what actually has to fit. Audio has no
 * such multiplier: the bytes are handed to a Blob and `<audio>` decodes them
 * a buffer at a time, so the file size IS the cost. Raising the audio ceiling
 * to 96 MiB therefore buys about an hour of 192 kbps stereo, or many hours of
 * spoken-word bitrates, at a peak cost of one 96 MiB copy across the IPC
 * bridge — which is real, and is why it is not raised further.
 *
 * The honest limitation stays: this reads the WHOLE file before playing a
 * note of it, because SFTP-backed range requests are not something the
 * renderer can express today. A podcast past the ceiling gets the binary
 * panel and a download button rather than a stall.
 */
const MAX_MEDIA_BYTES = 96 * 1024 * 1024;
/** Images and PDFs keep the original ceiling — both decode to much more. */
const MAX_DOCUMENT_BYTES = 32 * 1024 * 1024;

/**
 * Kinds that have an editor behind them and can therefore be saved.
 *
 * One predicate rather than an `=== 'text'` at each site, because there are
 * four of them — the Save button, the Ctrl+S chord, `save()` itself and the
 * dirty-buffer stash — and HTML becoming editable meant every one had to
 * learn the same new fact. Three out of four would have been a Save button
 * that works and a Ctrl+S that does nothing, which is precisely the kind of
 * half-regression the brief warned about.
 */
export function isEditable(mode: OpenMode | null): boolean {
  return mode === 'text' || mode === 'html' || mode === 'markdown' || mode === 'svg';
}

/**
 * Kinds shown as BOTH a render and their source.
 *
 * The trio `html`, `markdown` and `svg` is not a coincidence: these are the
 * formats whose whole point is what they look like when something renders
 * them, and which are still ordinary text files that a person opens a file
 * browser to fix a typo in. Everything else is one or the other. (This
 * comment used to claim the pair was "not likely to grow"; SVG proved the
 * shape — text source, visual render, renderable with no code of its own
 * run — is the definition of the set, and it joined through the same door.)
 */
export function hasPreview(mode: OpenMode | null): boolean {
  return mode === 'html' || mode === 'markdown' || mode === 'svg';
}

/** Everything a remembered session keeps while its tab is unmounted. */
interface RememberedPosition {
  cwd: string;
  /** Only ever a DIRTY text buffer — see `stash()`. */
  buffer: { path: string; content: string } | null;
  /**
   * True when the USER navigated here, false when this is merely where an
   * `open()` landed.
   *
   * Only a chosen directory outranks the start path a caller supplies. Without
   * this the two were the same fact, and a Files tab that fell back to the
   * login home once — because its session had no working directory yet — was
   * pinned to the home for the life of the tab, since the tab-id key never
   * changes to let a newer answer in. See `rememberHere`.
   */
  chosen: boolean;
}

export const useFilesStore = defineStore('files', () => {
  const cwd = ref<string>('');
  const entries = ref<DirEntry[]>([]);
  const loading = ref(false);
  const error = ref<string | null>(null);

  /**
   * The login home for the current connection, resolved once and reused.
   * The breadcrumb needs it to render `~/git/foo` as three crumbs instead of
   * spelling the same location twice (`~ / home / alexey`).
   */
  const home = ref<string>('');

  /** The currently-open file. */
  const openPath = ref<string | null>(null);
  const openMode = ref<OpenMode | null>(null);
  const openContent = ref<string>('');
  /** Object URL for the image/audio/pdf viewers; null in every other mode. */
  const openUrl = ref<string | null>(null);
  const openMime = ref<string | null>(null);
  const openSize = ref<number>(0);
  /** Why a file is in the binary panel rather than a viewer. */
  const openNote = ref<string | null>(null);
  const dirty = ref(false);
  const saving = ref(false);
  const opening = ref(false);

  /**
   * Errors about the OPEN FILE — a failed save or download — kept apart from
   * `error`, which is the LISTING's channel.
   *
   * The split exists because the two have different audiences in different
   * corners of the screen. A listing failure is about the tree, and renders in
   * the tree's footer — the left pane, where the user is looking when a
   * directory refuses to list. A failed Ctrl+S is about the editor: the user
   * is watching the Save button on the right when it fails (permissions, a
   * dropped link, a file moved under them), and when the reason landed in the
   * shared `error` ref it appeared in the far corner of a different pane — or
   * off-screen entirely if the tree was short — while the button merely
   * stopped saying "Saving…" and the file stayed dirty. That reads as "save
   * silently did nothing", which is the one thing a failed save must never
   * read as. FilesView renders this ref right under the editor bar, where the
   * eyes already are.
   *
   * `openFile` and `revealPath` failures stay OUT of this channel on the same
   * audience test: a file that cannot be opened lands in the binary panel
   * with its reason in `openNote`, and a dead reveal link is reported through
   * `error` because the tree is what the click was navigating.
   *
   * Cleared when a fresh save or download attempt starts (the message
   * describes the LAST attempt, not the file), and whenever the open file
   * changes or closes — a verdict on one file must not hang over the next.
   */
  const fileError = ref<string | null>(null);

  // -------------------------------------------------------------------------
  // HTML preview
  // -------------------------------------------------------------------------
  /**
   * The `psview://` URL for the open HTML file, and the token that revokes it.
   *
   * NOT an object URL, and the difference is the whole feature: a blob has no
   * path, so a document served from one cannot resolve `href="style.css"`
   * against anything and every real page renders unstyled. The URL here is on
   * a scheme main serves (src/main/preview/HtmlPreviewService.ts), so the
   * frame has a genuine base URL and the page's own relative references come
   * back to main as further requests, each answered by an SFTP read inside
   * the previewed file's folder — or, for a markdown preview, anywhere on the
   * host, so `../` and absolute links between docs open like the Files tab's
   * own browsing does.
   *
   * The token is a capability held on this side only so it can be handed back
   * to `preview.release`. Nothing in the renderer can do anything else with it.
   */
  const previewUrl = ref<string | null>(null);
  const previewToken = ref<string | null>(null);

  /**
   * Which half of a previewable document — HTML or markdown — is on screen.
   *
   * PREVIEW is the default, and it is a deliberate reversal of what the tab
   * does for every other text file. The reasoning is that the source is
   * already reachable in one click and is what this tab has always shown,
   * whereas the render is the thing that could not be had at all before — and
   * "can we also preview html files" is a request for the render. The one
   * exception is a file restored DIRTY (see `open()`): the preview shows what
   * is on the host, which by definition is not what the unsaved buffer says,
   * so an edit in progress opens on the editor that holds it.
   *
   * Named `docView` rather than `htmlView` since markdown joined: one flag for
   * both, because it is one piece of state — which half of the open document
   * the user is looking at — and two would have meant two ways to be on the
   * source tab.
   */
  const docView = ref<'preview' | 'source'>('preview');

  /**
   * True when the source contains a `<script>` tag.
   *
   * The preview runs nothing (see HtmlPreviewService's "scripts decision"), so
   * a page that builds its own body at runtime renders as an empty shell. This
   * flag is what lets the toolbar say so, which is the difference between an
   * honest degraded render and a blank pane the user reads as a bug in us.
   *
   * A regex over the source rather than a parse: the question is only "would a
   * reader be surprised that nothing ran", and for that a false positive on
   * the word `<script` inside a comment costs one line of explanatory text
   * that happens to be true anyway (nothing ran).
   */
  const openHasScripts = ref(false);

  /**
   * True when the source references a resource on a remote origin.
   *
   * This exists because of a blind spot in the asset counters, and the blind
   * spot is structural rather than a bug: a `<img src="https://tracker/…">` is
   * refused by the frame's own CSP INSIDE the renderer, so the request never
   * reaches main and main can never count it. Without this flag a page whose
   * every image is on a CDN would report "0 blocked" and render as a grid of
   * broken-image icons with nothing saying why — the exact "silently looks
   * broken" outcome the whole toolbar line exists to prevent.
   *
   * Deliberately keyed on `src=` and on a `<link>`'s `href=` rather than on
   * any `http` in the document. An `<a href="https://…">` is a LINK, not a
   * resource: nothing about it fails to load, and saying "remote resources are
   * not loaded" because a page cites a source would be its own small lie.
   */
  const openHasRemoteRefs = ref(false);

  /**
   * Does this source pull a sub-resource off a remote origin?
   *
   * Four patterns, because the formats that reach here spell the same fact
   * in three different syntaxes. The third — `![alt](https://…)` — is not an
   * edge case in this repo's world: a README's first three lines are usually
   * shields.io badges, every one of them a remote image, and without this the
   * preview would paint a row of broken-image icons under a toolbar reporting
   * nothing wrong. The fourth is SVG's spelling — `<image>` and `<use>` carry
   * their reference in `href` (or `xlink:href`), which none of the HTML or
   * markdown patterns would catch, and an SVG whose bitmap lives on a CDN
   * renders with exactly the hole the flag exists to explain.
   *
   * Every pattern matches RESOURCES only, never links, and for the same
   * reason each time: an `<a href="https://…">`, a `[spec](https://…)` or an
   * SVG `<a>` is a citation, nothing about it fails to load, and saying
   * "remote resources are not loaded" because a document cites a source would
   * be its own small lie. A reference-style markdown image is therefore
   * missed, deliberately — its definition line is indistinguishable from a
   * link's.
   */
  function referencesRemote(source: string): boolean {
    return (
      /\bsrc\s*=\s*["']?https?:/i.test(source) ||
      /<link\b[^>]*\bhref\s*=\s*["']?https?:/i.test(source) ||
      /!\[[^\]]*\]\(\s*<?https?:/i.test(source) ||
      /<(?:image|use)\b[^>]*\bhref\s*=\s*["']?https?:/i.test(source)
    );
  }

  /**
   * Per-preview asset counters, pushed from main as the frame loads.
   *
   * Reset to nulls whenever a preview is minted so a stale count from the
   * previous page can never be read as this page's.
   */
  const previewStats = ref<{
    loaded: number;
    blocked: number;
    missing: number;
    capped: boolean;
  } | null>(null);

  // One subscription for the life of the store. The payload is keyed by token
  // and everything for a token we are no longer showing is dropped, which is
  // what keeps a preview that is still finishing its last few requests from
  // writing counts into a file the user has already moved on from.
  api.preview.onStats((stats) => {
    if (stats.token !== previewToken.value) return;
    previewStats.value = {
      loaded: stats.loaded,
      blocked: stats.blocked,
      missing: stats.missing,
      capped: stats.capped,
    };
  });

  /**
   * A path the terminal asked this tab to show, waiting for the tab to take it.
   *
   * It is a REQUEST rather than a direct call, and the reason is the Files tab's
   * `v-if`: when the user clicks a path in the terminal the view is not mounted,
   * so nothing is in a position to navigate yet. Opening the file here and now
   * would be undone a moment later anyway — `FilesView`'s `onMounted` calls
   * `open()`, which resets the open file and restores the remembered directory.
   *
   * So the click leaves the target here, the session workspace watches this ref
   * to switch to the Files tab, and the view consumes it with {@link takeReveal}
   * AFTER `open()` has run. Whoever gets there first wins and the ref goes back
   * to null, so a reveal can never be applied twice.
   */
  const reveal = ref<string | null>(null);

  /** connection+session -> where that session's Files tab was last left. */
  const positions = new Map<string, RememberedPosition>();
  /** The key `open()` was last called with, so `stash()` knows whose state it is. */
  let currentKey: string | null = null;

  /**
   * Request tickets for the two shared async pipelines — directory listing
   * (`navTicket`: cd/goTo/open/refresh all commit into the same `cwd` +
   * `entries`) and the open document (`openTicket`: openFile commits into
   * `openPath`/`openContent`/`openMode`).
   *
   * Both pipelines have several awaits between the click and the commit, and
   * the shared refs are single-slot: without a guard, two rapid clicks race
   * and whichever transfer resolves LAST wins — file A's bytes rendered under
   * file B's path, or the listing of a directory the pane has already left.
   * Every caller increments at entry and re-checks after each await; a
   * superseded call commits nothing and simply returns. The same shape is
   * already used by the projects store (`browseRequest` there).
   */
  let navTicket = 0;
  let openTicket = 0;

  function positionKey(connectionId: ConnectionId, session: string | undefined): string {
    // The session is identified by its own start directory when the caller
    // has no name to give — which is exactly the identity we want, since two
    // sessions rooted in the same directory browsing together is not a bug.
    // A session whose path is still unknown keys on the empty string, and the
    // moment the path is recovered the key changes, so the FIRST visit after
    // the fix opens at the recovered directory rather than at a home
    // remembered from before it. See docs on the null-path bug.
    return `${connectionId}\x00${session ?? ''}`;
  }

  /**
   * Park the current session's position before switching away from it.
   *
   * Only a DIRTY buffer is kept. A clean one is a cache of bytes that are
   * still on the host and costs one cheap read to rebuild, while an unsaved
   * edit exists nowhere else — discarding it silently on a tab switch would
   * be a worse bug than the one this whole mechanism fixes. Media and binary
   * views are never kept: their object URLs are revoked on the way out, and
   * holding a 96 MiB blob per visited session is not a trade worth making.
   */
  function stash(): void {
    if (currentKey == null || !cwd.value) return;
    positions.set(currentKey, {
      cwd: cwd.value,
      buffer:
        dirty.value && openPath.value != null && isEditable(openMode.value)
          ? { path: openPath.value, content: openContent.value }
          : null,
      // Parking a tab does not make its directory a choice. Carrying the flag
      // through is what stops a tab that merely fell back to `~` from being
      // pinned there by the act of switching away from it.
      chosen: positions.get(currentKey)?.chosen === true,
    });
  }

  /**
   * Remember where we are right now, under the key we are already on, AS A
   * PLACE THE USER CHOSE.
   *
   * That distinction is the whole of a real bug. This is called from `cd`,
   * `goTo`, `save` and `closeFile` — all user navigation — and it used also to
   * be called by `open()` immediately after the INITIAL resolve, where it wrote
   * a directory nobody had chosen into the same slot and made it
   * indistinguishable from one they had.
   *
   * That is how a Files tab got stuck at `~`. A folder whose session had no
   * working directory resolves to the login home, `open()` recorded the home as
   * this tab's remembered position, and the read below prefers a remembered
   * position over the start path — so when the session's real directory arrived
   * (from a later refresh, or from the probe fix) and `FilesView` re-opened with
   * it, the home won and the tab never moved. Permanently, because the key is
   * the TAB ID and therefore never changes.
   *
   * `chosen` is what the initial resolve now writes false into. A position the
   * user actually navigated to still outranks any start path, which is the
   * behaviour "return to where I left this tab" depends on.
   */
  function rememberHere(): void {
    rememberPosition(true);
  }

  /**
   * Record the current directory WITHOUT claiming the user picked it.
   *
   * Worth storing at all so a switch away and back does not re-resolve, and so
   * `stash()` has a buffer slot to hang an unsaved edit on — but it must never
   * outrank a start path, because a start path is the app's best current answer
   * to "where does this tab belong" and this is merely where it landed once.
   */
  function rememberResolved(): void {
    rememberPosition(false);
  }

  function rememberPosition(chosen: boolean): void {
    if (currentKey == null || !cwd.value) return;
    const held = positions.get(currentKey);
    positions.set(currentKey, {
      cwd: cwd.value,
      buffer: held?.buffer ?? null,
      // Never DOWNGRADE: a tab the user navigated in stays theirs even if
      // something later re-opens it and lands on the same directory.
      chosen: chosen || held?.chosen === true,
    });
  }

  function revokeUrl(): void {
    if (openUrl.value) URL.revokeObjectURL(openUrl.value);
    openUrl.value = null;
    releasePreview();
  }

  /**
   * Hand a preview's token back to main, which makes every later request on it
   * 404.
   *
   * The object-URL sibling above and this one are called from the same places
   * for the same reason, but they are not the same kind of cleanup. Revoking a
   * blob frees memory in this process; releasing a preview closes a channel to
   * the REMOTE HOST. So it happens on every path out of a file — close,
   * replace, disconnect — rather than being left to garbage collection, and it
   * is why the token is tracked at all.
   */
  function releasePreview(): void {
    const token = previewToken.value;
    previewToken.value = null;
    previewUrl.value = null;
    // The COUNTS go, because they describe the render that is being thrown
    // away. `openHasScripts` and `openHasRemoteRefs` do NOT, and used to —
    // which was a real bug, caught by running the thing rather than by
    // reading it. Those two are facts about the SOURCE, derived from the
    // buffer, and the buffer is still open; clearing them here made the
    // "scripts are not run" line vanish on every Reload and on every theme
    // re-mint, leaving a page that renders as an empty shell with nothing
    // saying why. That line existing at all is the feature's answer to
    // "degraded and broken look identical", so silently dropping it was the
    // exact failure the toolbar was built to prevent.
    //
    // Nothing needs them cleared here: every path that actually closes a file
    // goes through `resetOpenFile`, which clears both, and `save` recomputes
    // them from the new buffer.
    previewStats.value = null;
    if (token) api.preview.release(token);
  }

  /**
   * Ask main for a preview of `path`, or fall back to the source view.
   *
   * A failure here is never fatal and never silent: the file is still text and
   * the editor still holds it, so the honest outcome is "you get the source,
   * and here is why you did not get the render" rather than a blank frame.
   *
   * The mode is taken from the open file's kind rather than passed in, so
   * there is exactly one place that decides which converter a preview gets and
   * every caller — open, save, reload, a theme switch — agrees by construction.
   *
   * [isSuperseded] lets an `openFile` in flight report that a newer file has since
   * taken over the pane: the mint then commits nothing, so a slow render for
   * the old file cannot land under the new one's path.
   */
  async function mintPreview(
    connectionId: ConnectionId,
    path: string,
    isSuperseded: () => boolean = () => false,
  ): Promise<void> {
    try {
      const { token, url } =
        openMode.value === 'markdown'
          ? await api.preview.openMarkdown(connectionId, path, currentPreviewStyle())
          : openMode.value === 'svg'
            ? await api.preview.openSvg(connectionId, path)
            : await api.preview.openHtml(connectionId, path);
      if (isSuperseded()) {
        api.preview.release(token);
        return;
      }
      previewToken.value = token;
      previewUrl.value = url;
      previewStats.value = { loaded: 0, blocked: 0, missing: 0, capped: false };
    } catch (e) {
      if (isSuperseded()) return;
      previewToken.value = null;
      previewUrl.value = null;
      previewStats.value = null;
      docView.value = 'source';
      openNote.value = `Preview unavailable: ${errorMessage(e)}`;
    }
  }

  /**
   * The applied theme, read out of the LIVE document rather than out of the
   * theme registry.
   *
   * `getComputedStyle` is the same trick DoodleCanvas uses for its pens, and it
   * is the right one here for two reasons. It needs no import of `themes.ts`,
   * so this store keeps knowing nothing about which themes exist; and it
   * resolves whatever is actually on `<html>` at this instant — which is what
   * the app is painted in, including the `system` case where the choice is an
   * OS preference rather than a stored id.
   *
   * The values go to main and end up inside the preview document's `<style>`.
   * They are re-validated there (previewStyle.ts) rather than trusted, and the
   * comment on VALUE_ALLOWED says why a value from this side of the bridge is
   * still checked on that side.
   */
  function currentPreviewStyle(): {
    palette: Record<string, string>;
    appearance: 'dark' | 'light';
  } {
    const computed = getComputedStyle(document.documentElement);
    const palette: Record<string, string> = {};
    for (const token of PALETTE_TOKENS) {
      palette[token] = computed.getPropertyValue(token).trim();
    }
    // App.vue sets `color-scheme` from the theme record's DECLARED appearance,
    // so this reads a stated fact rather than guessing one from a background
    // colour — which is the same thing themes.ts refuses to do.
    //
    // `getPropertyValue`, not the `.colorScheme` accessor: the accessor is
    // undefined in jsdom, and a `.includes` on it throws — which `mintPreview`
    // would then catch and turn into "Preview unavailable", i.e. the feature
    // silently off under test with no failing assertion pointing at the cause.
    const scheme = computed.getPropertyValue('color-scheme');
    return { palette, appearance: scheme.includes('light') ? 'light' : 'dark' };
  }

  /**
   * Re-render the open markdown preview in the theme that is applied now.
   *
   * A preview is a snapshot: the frame has already navigated, it runs no
   * scripts, and its document has its own `:root` that the app's tokens do not
   * cascade into — so there is no way to re-tint one in place. Re-minting is
   * the only mechanism available, and it is cheap enough to be the right one:
   * one SFTP read of a file the user is looking at, on an event (changing the
   * theme) that happens by hand.
   *
   * Only markdown, because only markdown is painted in our palette. An HTML
   * file brings its own styling and must not follow the app's theme — a page
   * that looks different here from how it looks in a browser would be a lie
   * about the file.
   */
  async function restylePreview(connectionId: ConnectionId): Promise<void> {
    if (openMode.value !== 'markdown' || openPath.value == null) return;
    if (previewToken.value == null) return;
    const path = openPath.value;
    releasePreview();
    await mintPreview(connectionId, path);
  }

  /**
   * Open the Files tab for a session.
   *
   * [startPath] is the session's working directory as tmux reported it, and
   * is used only on the FIRST visit — after that the position the user
   * navigated to wins, which is the whole point of remembering it.
   */
  async function open(
    connectionId: ConnectionId,
    startPath?: string,
    sessionKey?: string,
  ): Promise<void> {
    const key = positionKey(connectionId, sessionKey ?? startPath);
    if (currentKey !== key) stash();

    const remembered = positions.get(key);
    currentKey = key;

    // Default to the login home; sftp realPath('.') resolves it. Callers with
    // a better starting point (e.g. a session's working directory) pass one.
    //
    // The resolve runs INSIDE the guard, and that is the whole point of this
    // shape. `startPath` is a session's cwd as tmux reported it, which is not
    // guaranteed to be a path SFTP can resolve: helper/parsers.ts notes that
    // `session_path` "can even be a literal unexpanded `~/git`", and an SFTP
    // channel has no tilde expansion (the same fact AttachmentStager resolves
    // `realpath(".")` for). A rejection here used to escape `open` entirely,
    // which left `cwd` empty — and `refresh` early-returns on an empty cwd,
    // so nothing ever set `error`. The pane rendered zero entries and no
    // message: a silently empty Files tab that reads as an empty home
    // directory rather than as the failure it is.
    error.value = null;
    // A remembered position outranks the start path only when the USER put us
    // there. Otherwise the start path is the better answer, and it is the newer
    // one: it carries whatever the session's working directory has become since
    // this tab last resolved. See `rememberHere` for the bug this fixes.
    const wanted =
      remembered?.chosen === true ? remembered.cwd : (startPath ?? remembered?.cwd);
    let note: string | null = null;
    let resolved: string;
    const ticket = ++navTicket;
    try {
      resolved = await api.sftp.realPath(connectionId, stripTilde(wanted));
    } catch (e) {
      // The session's cwd is a convenience, not the point of the tab. When it
      // will not resolve, fall back to the login home so the user still gets a
      // browser, and say why the requested directory was not the one opened.
      try {
        resolved = await api.sftp.realPath(connectionId, '.');
        note = `Could not open ${wanted}: ${errorMessage(e)}`;
      } catch (homeErr) {
        // Home itself is unreachable — the connection is not usable for SFTP
        // at all, and there is nothing to fall back to.
        if (ticket !== navTicket) return;
        error.value = errorMessage(homeErr);
        return;
      }
    }
    // Another `open` (a second tab click during this resolve) superseded this
    // one: it owns the pane from here — cwd, the restored buffer, the listing.
    if (ticket !== navTicket) return;
    cwd.value = resolved;

    // Restore the unsaved edit this session was left with, if any. Nothing
    // else about the open file survives a switch (see `stash`).
    revokeUrl();
    if (remembered?.buffer) {
      // This branch bypasses `resetOpenFile`, so the open-file error channel
      // is emptied by hand: whatever failed before the tab switch was a
      // verdict on an attempt in the past, and re-showing it now would read
      // as a failure that just happened to the restored buffer.
      fileError.value = null;
      openPath.value = remembered.buffer.path;
      openContent.value = remembered.buffer.content;
      // Re-derive the kind from the NAME rather than pinning it to 'text'.
      // The buffer only ever holds an editable file, so this is 'text',
      // 'html' or 'markdown', and a previewable file that comes back as plain
      // text would lose its preview toggle for the rest of the session — a tab
      // switch quietly downgrading a file is exactly the kind of thing nobody
      // reports.
      const restored = classifyByName(remembered.buffer.path);
      openMode.value = hasPreview(restored.kind) ? restored.kind : 'text';
      openMime.value = restored.mime ?? 'text/plain';
      openNote.value = null;
      dirty.value = true;
      // No preview is minted for a restored buffer, and the view opens on the
      // SOURCE: what the preview would render is the host's copy, which is by
      // definition not what this unsaved buffer says. Saving mints one.
      docView.value = 'source';
      openHasScripts.value =
        hasPreview(openMode.value) && /<script[\s>]/i.test(openContent.value);
      openHasRemoteRefs.value =
        hasPreview(openMode.value) && referencesRemote(openContent.value);
    } else {
      resetOpenFile();
    }

    await refresh(connectionId, ticket);
    if (ticket !== navTicket) return;
    rememberResolved();
    // `refresh` clears `error` on entry, so a fallback note is re-applied
    // after it — and only when the listing itself did not fail with something
    // more immediate.
    if (note != null && error.value == null) error.value = note;

    // Only the breadcrumb needs the login home, and most of the time it comes
    // free: `stripTilde` turns "no start path", "~" and "~/" into ".", so the
    // resolve above ALREADY asked for the home and the fallback branch asks
    // for it by name. When neither applies it is fetched separately, off the
    // critical path and ignored on failure — the breadcrumb degrades to
    // absolute components, which is correct, just longer.
    if (!home.value) {
      if (note != null || stripTilde(wanted) === '.') {
        home.value = resolved;
      } else {
        void (async () => {
          try {
            home.value = await api.sftp.realPath(connectionId, '.');
          } catch {
            /* breadcrumb falls back to absolute components */
          }
        })();
      }
    }
  }

  /**
   * List `cwd` into `entries`. Part of the navigation pipeline: callers that
   * already hold a nav ticket (cd/goTo/open) pass it so the whole pipeline —
   * resolve, commit, list, remember — shares one notion of "superseded".
   * A bare call takes its own ticket.
   */
  async function refresh(
    connectionId: ConnectionId,
    ticket: number = ++navTicket,
  ): Promise<void> {
    if (!cwd.value) return;
    loading.value = true;
    error.value = null;
    try {
      const listed = await api.sftp.list(connectionId, cwd.value);
      // A newer navigation superseded this one while the listing was in
      // flight; its own refresh will paint `entries`, so committing here
      // would describe a directory the pane has already left.
      if (ticket !== navTicket) return;
      listed.sort((a, b) => {
        if (a.type === 'dir' && b.type !== 'dir') return -1;
        if (a.type !== 'dir' && b.type === 'dir') return 1;
        return a.name.localeCompare(b.name);
      });
      entries.value = listed;
    } catch (e) {
      if (ticket !== navTicket) return;
      error.value = errorMessage(e);
    } finally {
      // Only the current request owns the spinner; a superseded one must not
      // clear it out from under its successor.
      if (ticket === navTicket) loading.value = false;
    }
  }

  async function cd(connectionId: ConnectionId, dir: string): Promise<void> {
    const ticket = ++navTicket;
    // Resolve relative paths against cwd.
    const next = dir.startsWith('/') ? dir : joinPosix(cwd.value, dir);
    try {
      const resolved = await api.sftp.realPath(connectionId, next);
      // A newer navigation (another click, a goTo, a tab switch) was issued
      // while this realPath was in flight — it owns cwd now.
      if (ticket !== navTicket) return;
      cwd.value = resolved;
    } catch (e) {
      // Same rule on the error path: a stale cd's failure is not the pane's
      // business any more. Only the current navigation reports.
      if (ticket !== navTicket) return;
      throw e;
    }
    await refresh(connectionId, ticket);
    if (ticket !== navTicket) return;
    rememberHere();
  }

  /** Jump straight to an absolute directory (the breadcrumb's move). */
  async function goTo(connectionId: ConnectionId, path: string): Promise<void> {
    const ticket = ++navTicket;
    cwd.value = path;
    await refresh(connectionId, ticket);
    if (ticket !== navTicket) return;
    rememberHere();
  }

  /**
   * Open one file, choosing a presentation for it before reading anything.
   *
   * The order matters and is the fix for the freeze: stat FIRST (so an
   * oversized file is refused without being transferred), classify from the
   * name, and only then fetch bytes — through `readBinary`, never
   * `readFile`, so nothing can arrive already mangled by a UTF-8 decode that
   * should not have happened. Text is decoded here, in the renderer, after
   * the bytes have been looked at.
   */
  async function openFile(connectionId: ConnectionId, path: string): Promise<void> {
    const abs = path.startsWith('/') ? path : joinPosix(cwd.value, path);
    const ticket = ++openTicket;
    const superseded = (): boolean => ticket !== openTicket;
    revokeUrl();
    resetOpenFile();
    openPath.value = abs;
    opening.value = true;
    try {
      let size = 0;
      try {
        size = (await api.sftp.stat(connectionId, abs)).size;
      } catch {
        // A stat failure is not fatal on its own — the read below will
        // produce the real error — but it does mean the ceilings have to be
        // enforced by the read's own cap rather than up front.
        size = -1;
      }
      // A second click opened another file while this stat was in flight;
      // every commit below belongs to the newer file now.
      if (superseded()) return;
      openSize.value = Math.max(size, 0);

      const named = classifyByName(abs);
      openMime.value = named.mime;

      if (named.kind === 'binary') {
        showBinary(named, 'This is a binary file.');
        return;
      }

      const cap = capFor(named.kind);
      if (size > cap) {
        showBinary(
          named,
          `${describeKind(named)} is ${formatBytes(size)}, over the ${formatBytes(cap)} limit for opening it here.`,
        );
        return;
      }

      let bytes: Uint8Array;
      try {
        bytes = await api.sftp.readBinary(connectionId, abs, cap);
        if (superseded()) return;
      } catch (e) {
        // Never fall back to the text path on a failed read. The file is
        // whatever it was; all we lost is the ability to show it.
        if (superseded()) return;
        showBinary(named, errorMessage(e));
        return;
      }
      openSize.value = bytes.length;

      const cls = classifyBytes(named, bytes);
      openMime.value = cls.mime;
      if (hasPreview(cls.kind)) {
        // Decoded here for the SAME reason plain text is, and from the same
        // bytes: the editor half of the view has to work without a second
        // read, and the preview half is not fed from this buffer at all — main
        // re-reads the file over the preview scheme, because that is the only
        // way the document's relative references can resolve. So this is one
        // read for the source and one for the render, and they can briefly
        // disagree only if the file changes on the host between them.
        if (bytes.length > MAX_TEXT_BYTES) {
          const label = cls.kind === 'html' ? 'HTML' : cls.kind === 'svg' ? 'SVG' : 'Markdown';
          showBinary(
            cls,
            `${label} file is ${formatBytes(bytes.length)}, too large to open here.`,
          );
          return;
        }
        openContent.value = new TextDecoder('utf-8').decode(bytes);
        // Both notes apply to markdown as much as to HTML: raw `<script>` in a
        // README does not run either (markdownDocument.ts explains why raw HTML
        // is passed through at all), and a badge row is remote images.
        openHasScripts.value = /<script[\s>]/i.test(openContent.value);
        openHasRemoteRefs.value = referencesRemote(openContent.value);
        openMode.value = cls.kind;
        docView.value = 'preview';
        dirty.value = false;
        await mintPreview(connectionId, abs, superseded);
        return;
      }
      if (cls.kind === 'text') {
        if (bytes.length > MAX_TEXT_BYTES) {
          showBinary(cls, `Text file is ${formatBytes(bytes.length)}, too large to edit here.`);
          return;
        }
        openContent.value = new TextDecoder('utf-8').decode(bytes);
        openMode.value = 'text';
        dirty.value = false;
        return;
      }
      if (cls.kind === 'image' || cls.kind === 'audio' || cls.kind === 'pdf') {
        // `slice()` because the Uint8Array came across the IPC bridge and a
        // Blob must own bytes that outlive this call.
        openUrl.value = URL.createObjectURL(
          new Blob([bytes.slice()], { type: cls.mime ?? 'application/octet-stream' }),
        );
        openMode.value = cls.kind;
        return;
      }
      showBinary(cls, 'This is a binary file.');
    } finally {
      // A superseded open must not clear the spinner its successor set.
      if (!superseded()) opening.value = false;
    }
  }

  /** The one terminus for everything that cannot be shown. Never text. */
  function showBinary(cls: FileClass, note: string): void {
    openMode.value = 'binary';
    openMime.value = cls.mime;
    openContent.value = '';
    openNote.value = note;
    dirty.value = false;
  }

  function capFor(kind: FileKind): number {
    if (kind === 'audio') return MAX_MEDIA_BYTES;
    if (kind === 'image' || kind === 'pdf') return MAX_DOCUMENT_BYTES;
    // `html` and `markdown` share the EDITOR's ceiling, not a viewer's, and
    // that is the conservative choice on purpose: a previewable document always
    // ends up decoded into the editor buffer as well as framed, because the
    // source toggle has to work without a second read. So the number that has
    // to hold is the one that bounds a string the editor can lay out.
    if (hasPreview(kind)) return MAX_TEXT_BYTES;
    // `text` and `unknown` share the editor's ceiling: an unknown file is
    // only read at all so its bytes can be sniffed, and if it turns out to be
    // text it goes straight into the editor, so it must not be bigger than
    // the editor can hold.
    return MAX_TEXT_BYTES;
  }

  /**
   * Save the open file back to the host. Text, HTML, markdown and SVG — the
   * kinds that have an editor behind them; nothing else is editable.
   */
  async function save(connectionId: ConnectionId): Promise<boolean> {
    if (!openPath.value || !isEditable(openMode.value)) return false;
    saving.value = true;
    // A new attempt retires the last attempt's verdict: leaving the old
    // message up while "Saving…" runs would show a failure that has not
    // happened yet, and a retry that succeeds must take the message down.
    fileError.value = null;
    try {
      await api.sftp.writeFile(connectionId, openPath.value, openContent.value);
      dirty.value = false;
      openHasScripts.value = /<script[\s>]/i.test(openContent.value);
      openHasRemoteRefs.value = referencesRemote(openContent.value);
      rememberHere();
      // A saved document gets a FRESH preview rather than a reloaded one.
      //
      // Re-minting is what makes the frame show the new bytes — the URL
      // changes, so the frame navigates, with no cache to defeat and no
      // reload() call reaching across into a sandboxed document that would not
      // accept one anyway. It also resets the request and byte budgets, which
      // is correct: the user saving a file is a new act of intent, not a
      // continuation of the last render's allowance.
      if (hasPreview(openMode.value)) {
        releasePreview();
        await mintPreview(connectionId, openPath.value);
      }
      return true;
    } catch (e) {
      // Into the open file's channel, NOT `error`: the user is looking at the
      // Save button, not at the tree footer. See `fileError` for the audit
      // that moved this.
      fileError.value = errorMessage(e);
      return false;
    } finally {
      saving.value = false;
    }
  }

  /**
   * Download the open file to a location the user picks. This is the binary
   * panel's only action, and the reason refusing to render something is not a
   * dead end.
   */
  async function download(connectionId: ConnectionId): Promise<string | null> {
    if (!openPath.value) return null;
    fileError.value = null;
    try {
      return await api.sftp.saveAs({ connectionId, remotePath: openPath.value });
    } catch (e) {
      // The Download… button lives in the binary panel, in the editor area —
      // so its failure belongs beside it, in the open file's channel, for the
      // same reason a failed save does. (FileTree's own save-a-row action
      // keeps reporting through `error`: that one is acted on IN the tree.)
      fileError.value = errorMessage(e);
      return null;
    }
  }

  function setContent(content: string): void {
    openContent.value = content;
    dirty.value = true;
  }

  function resetOpenFile(): void {
    // The open file's error goes with the open file: every path that closes
    // or replaces one comes through here, so this is the one place the
    // channel is emptied for "the file changed".
    fileError.value = null;
    openPath.value = null;
    openMode.value = null;
    openContent.value = '';
    openMime.value = null;
    openNote.value = null;
    openSize.value = 0;
    dirty.value = false;
    docView.value = 'preview';
    openHasScripts.value = false;
    openHasRemoteRefs.value = false;
  }

  /** Show the source of the open document, or its render. */
  function setDocView(view: 'preview' | 'source'): void {
    docView.value = view;
  }

  /**
   * Render the page again, from the host, under a fresh capability.
   *
   * Two things make this a button rather than an implementation detail.
   *
   * The first is ordinary: the file lives on a machine other people are using,
   * and a preview is a snapshot. Re-reading it is what a browser's reload does
   * and there is no reason to make the user close and re-open the file for it.
   *
   * The second is a real limitation of a preview that cannot run scripts, and
   * is the reason this exists at all. A previewed document may contain
   * `<a href="https://…">` links. Clicking one is a navigation of the frame,
   * and main hands the URL to the system browser while the app's own CSP
   * refuses the in-app navigation (`frame-src` names no remote scheme) —
   * correctly, since following it in-app would tell that server which document
   * on which host the user is inspecting. But Chromium's refusal can replace
   * the frame's document with its error page, and with no scripts in the frame
   * there is nothing we can install to intercept the click first. So a click
   * that opens a web link can leave the preview showing that error page, and
   * this is how the user gets the render back. Re-minting rather than
   * reloading because the token is one-shot: it resets the asset budget too,
   * which is what a deliberate re-render should do.
   */
  async function reloadPreview(connectionId: ConnectionId): Promise<void> {
    if (!hasPreview(openMode.value) || openPath.value == null) return;
    const path = openPath.value;
    releasePreview();
    openNote.value = null;
    docView.value = 'preview';
    await mintPreview(connectionId, path);
  }

  function closeFile(): void {
    revokeUrl();
    resetOpenFile();
    rememberHere();
  }

  // -------------------------------------------------------------------------
  // Reveal — a path clicked in the terminal
  // -------------------------------------------------------------------------

  /**
   * Ask the Files tab to show a path that appeared in terminal output.
   *
   * [raw] is the path exactly as the remote program printed it and [sessionCwd]
   * is the session's working directory, because a relative path in a session's
   * output is relative to THAT directory — not to the login home, and not to
   * wherever the user happens to have browsed this tab to. Resolution happens
   * here, at click time, while the session is still the one we are looking at.
   *
   * Nothing is stat'ed and nothing is fetched: the terminal linkifies
   * optimistically (see terminalPaths.ts — a stat per token of output would be
   * an SFTP round trip per token), so "it does not exist" is answered by
   * {@link revealPath} when the click is actually acted on.
   */
  function requestReveal(raw: string, sessionCwd?: string | null): void {
    reveal.value = resolveRemotePath(raw, sessionCwd);
  }

  /** Take the pending reveal, if any, and clear it. */
  function takeReveal(): string | null {
    const held = reveal.value;
    reveal.value = null;
    return held;
  }

  /**
   * Navigate to `path`: the file itself if it is a file, the directory itself
   * if it is a directory.
   *
   * This is where an optimistic link meets reality. A path that does not
   * resolve, or that resolves to something we cannot stat, sets `error` — the
   * same field a failed listing uses and the same one FileTree already renders,
   * so a dead link says so in the place the user is already looking rather than
   * silently leaving them in the wrong directory.
   */
  async function revealPath(connectionId: ConnectionId, path: string): Promise<void> {
    let abs: string;
    try {
      abs = await api.sftp.realPath(connectionId, path);
    } catch (e) {
      error.value = `Could not open ${path}: ${errorMessage(e)}`;
      return;
    }

    let type: DirEntry['type'];
    try {
      // `stat` follows symlinks (see SftpService), so a symlink to a directory
      // opens as the directory, which is what clicking one should do.
      type = (await api.sftp.stat(connectionId, abs)).type;
    } catch (e) {
      error.value = `Could not open ${abs}: ${errorMessage(e)}`;
      return;
    }

    if (type === 'dir') {
      closeFile();
      await goTo(connectionId, abs);
      return;
    }
    // Move the listing to the containing directory as well as opening the
    // file: the point of the click is "show me this", and a file open over an
    // unrelated directory listing is half an answer.
    await goTo(connectionId, parentOf(abs));
    await openFile(connectionId, abs);
  }

  /**
   * Drop everything for a connection.
   *
   * This is a DISCONNECT operation, not a tab-switch one. It exists so a
   * singleton store cannot show one host's listing to another, which is a
   * real hazard and stays guarded — what it must not do is run when the user
   * merely looks at the terminal for a moment.
   */
  function clear(connectionId?: ConnectionId): void {
    cwd.value = '';
    entries.value = [];
    error.value = null;
    home.value = '';
    currentKey = null;
    // A reveal that has not been taken yet names a path on the connection that
    // just went away; applying it later would ask the NEXT host for it.
    reveal.value = null;
    closeFile();
    if (connectionId == null) {
      positions.clear();
      return;
    }
    const prefix = `${connectionId}\x00`;
    for (const key of [...positions.keys()]) {
      if (key.startsWith(prefix)) positions.delete(key);
    }
  }

  return {
    cwd,
    home,
    entries,
    loading,
    error,
    fileError,
    openPath,
    openMode,
    openContent,
    openUrl,
    openMime,
    openSize,
    openNote,
    previewUrl,
    previewToken,
    previewStats,
    docView,
    openHasScripts,
    openHasRemoteRefs,
    dirty,
    saving,
    opening,
    reveal,
    setDocView,
    reloadPreview,
    restylePreview,
    open,
    refresh,
    cd,
    goTo,
    openFile,
    setContent,
    save,
    download,
    closeFile,
    requestReveal,
    takeReveal,
    revealPath,
    clear,
  };
});

/**
 * Turn a possibly-tilde-prefixed path into one an SFTP channel can resolve.
 *
 * A session's cwd comes from tmux and can be a literal, unexpanded `~/git`
 * (helper/parsers.ts says so explicitly, and canonicalisation there
 * deliberately never expands it). SFTP has no shell to do the expanding, so
 * `realpath("~/git")` looks for a DIRECTORY NAMED `~` and fails.
 *
 * No home lookup is needed to fix it: an SFTP session's relative root is the
 * login home — that is why `realpath(".")` is how the home is found in the
 * first place — so dropping the `~/` leaves a relative path that resolves to
 * exactly the same place, in the same single round trip.
 *
 * Only a leading `~` that refers to OUR home is handled. `~other/x` is left
 * alone: it means another user's home, which relative resolution would get
 * wrong, and failing honestly beats opening the wrong directory.
 */
export function stripTilde(path: string | undefined): string {
  if (path == null || path === '') return '.';
  if (path === '~') return '.';
  if (path.startsWith('~/')) {
    const rest = path.slice(2);
    return rest === '' ? '.' : rest;
  }
  return path;
}

/**
 * Turn a path someone did not browse to — printed by a program, or typed into
 * the path bar — into one this connection's SFTP channel can resolve.
 *
 * The output is either absolute or relative-to-the-login-home, which are the
 * two things `sftp.realPath` understands — an SFTP session's relative root IS
 * the login home, which is the same fact {@link stripTilde} is built on and
 * the reason no home lookup is needed anywhere in here.
 *
 * THREE anchorings, and the first two ignore [base] completely:
 *
 *   - absolute (`/tmp/olya-v3tts.mp3`) is already complete. It is returned
 *     untouched — never joined to anything, which is the bug this shape of
 *     function is famous for (`/home/alexey/git/foo//tmp/olya-v3tts.mp3`);
 *   - `~/x` is anchored on the login home, so it goes through `stripTilde`
 *     and lands relative to the SFTP root, which is that same home;
 *   - anything else is relative, and only then does [base] matter.
 *
 * What [base] is depends on who is asking, and it is the caller's job to know:
 * a path in a session's output is relative to where that SESSION runs
 * (`SessionSummary.path`), while a path typed into the Files tab is relative
 * to the directory being BROWSED. Either can itself be a literal, unexpanded
 * `~/git/foo` (helper/parsers.ts says so of session paths), which is why the
 * base goes through `stripTilde` rather than being used as it came.
 *
 * `..` and `.` inside the path are left for the remote `realpath` to fold:
 * doing it here would mean guessing about symlinks the host knows about and we
 * do not.
 */
export function resolveRemotePath(raw: string, base?: string | null): string {
  if (raw.startsWith('/')) return raw;
  if (raw === '~' || raw.startsWith('~/')) return stripTilde(raw);

  const rel = raw.startsWith('./') ? raw.slice(2) : raw;
  if (rel === '') return '.';
  const from = stripTilde(base ?? undefined);
  // No base at all leaves it at '.', where joining would produce a leading
  // './'. Relative-to-home is the best guess available and is exactly what
  // `open()` falls back to for the same missing fact.
  return from === '.' ? rel : joinPosix(from, rel);
}

/**
 * The same resolution, for a path a HUMAN typed or pasted into the path bar.
 *
 * The only difference is the cleanup in front of it, and every part of that
 * cleanup is there because of how paths reach a clipboard. A path copied out
 * of a shell arrives quoted (`'/tmp/my file.mp3'`) because that is how the
 * shell needed it written; a path copied out of a log or a chat arrives with
 * whitespace around it. Neither is a typo worth an error message.
 *
 * Returns null for an empty field, which is "do nothing" rather than an error:
 * pressing Enter on a blank path bar should dismiss it, not complain.
 *
 * A SPACE INSIDE THE PATH IS FINE HERE, and that is a deliberate difference
 * from the terminal-output detector, which refuses any candidate containing one
 * (see terminalPaths.ts). The refusal there is about ambiguity: a space in a
 * line of output could be the end of the path or a character in it, and there
 * is no way to know. In a path bar there is no ambiguity at all — the whole
 * field is the path, the user said so by typing it there — so `/tmp/my
 * file.mp3` is accepted exactly as written.
 */
export function normaliseTypedPath(raw: string, base?: string | null): string | null {
  const cleaned = stripQuotes(raw.trim()).trim();
  if (cleaned === '') return null;
  return resolveRemotePath(cleaned, base);
}

/**
 * Drop ONE matched pair of surrounding quotes. Only a matched pair, and only
 * one: a filename may legitimately start or end with a quote, and stripping
 * greedily would mangle it.
 */
function stripQuotes(s: string): string {
  if (s.length < 2) return s;
  const first = s.charAt(0);
  if (first !== '"' && first !== "'" && first !== '`') return s;
  return s.endsWith(first) ? s.slice(1, -1) : s;
}

/** The containing directory of an absolute path; `/` has no parent but itself. */
function parentOf(path: string): string {
  return path.replace(/\/[^/]+$/, '') || '/';
}

/** POSIX join (the remote is always unix, even on a Windows client). */
function joinPosix(base: string, rel: string): string {
  if (rel === '.') return base;
  if (rel === '..') return base.replace(/\/[^/]+$/, '') || '/';
  if (base.endsWith('/')) return base + rel;
  return base + '/' + rel;
}
