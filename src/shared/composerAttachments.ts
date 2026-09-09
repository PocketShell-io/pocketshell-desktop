/**
 * Pure list surgery on the composer's staged attachments.
 *
 * ## Why this is a module and not three lines inside a component
 *
 * Staging happens at ATTACH time, not at send time: `AttachmentStager` uploads
 * the bytes the moment a file is pasted, dropped or picked, and the tile the
 * user then sees is identified by the REMOTE PATH that upload returned. That
 * makes "annotate the image I already attached" a genuine replacement rather
 * than an edit — a second upload lands at a second path, and the tile list has
 * to swap one identity for another.
 *
 * The swap has to happen IN PLACE, and that is the whole reason for the fuss.
 * The paths are folded into the prompt in tile order at send time
 * (docs/COMPOSER.md §5.1), so a draft that says "the second screenshot" is a
 * statement about this array's ordering. Removing the original and appending
 * the annotated version — the only thing the existing store actions can
 * express between them — silently moves the image to the end and makes that
 * sentence false. Annotating is not reattaching.
 *
 * Keeping the arithmetic here, pure and generic over the element type, means
 * the ordering rule can be tested without a Pinia store, a canvas or an SSH
 * connection, and means the renderer and the store can share one definition of
 * it rather than growing two that drift.
 */

/** The only field this module needs: attachments are identified by remote path. */
export interface HasRemotePath {
  remotePath: string;
}

/**
 * The scope a session's attachments upload into, relative to
 * `~/.pocketshell/attachments`.
 *
 * An aplexer session carries its workspace (the canonical remote path of
 * the checkout) and its session name IS the tag within that workspace, so
 * the scope nests `<workspace-basename>/<tag>` — `dtc-site/main`,
 * `dtc-site/main-2` — and files from one project land in one directory
 * across all of its tags. Only the SHAPE is decided here: the segments
 * come back raw, and `AttachmentStager.safeScopePath` sanitises each one.
 *
 * A session without a workspace — every tmux session, whose names are
 * host-global and need no disambiguation — scopes to the bare session
 * name, the shape every upload had before workspaces existed.
 */
export function attachmentScopeKey(sessionName: string, workspace?: string | null): string {
  const name = (workspace ?? '').replace(/\/+$/, '').split('/').pop() ?? '';
  return name !== '' ? `${name}/${sessionName}` : sessionName;
}

/**
 * Swap `targetPath` for `next`, keeping the target's POSITION.
 *
 * Returns a new array, or `null` when `targetPath` is not in `list` — which is
 * a real case rather than a defensive one: the upload of an annotated image is
 * a round trip to the host, and the user is free to hit `×` on the tile, hit
 * Discard, or send the prompt while it is in flight. A caller that gets `null`
 * should do nothing at all; re-adding an attachment the user has since removed
 * would be worse than losing the annotation.
 *
 * If `next.remotePath` somehow already appears elsewhere in the list, that
 * other copy is dropped. `mergePaths` in the store guarantees remote paths are
 * unique across the tile list, and this keeps that invariant true rather than
 * quietly producing a list where removal by path would delete two tiles. In
 * practice it never fires — remote names carry a per-second timestamp and a
 * batch ordinal — but the invariant is cheaper to preserve than to debug.
 */
export function replaceStagedAttachment<T extends HasRemotePath>(
  list: readonly T[],
  targetPath: string,
  next: T,
): T[] | null {
  const index = list.findIndex((a) => a.remotePath === targetPath);
  if (index < 0) return null;
  const out: T[] = [];
  for (let i = 0; i < list.length; i++) {
    if (i === index) {
      out.push(next);
      continue;
    }
    // Drop a pre-existing tile carrying the incoming path — see the doc above.
    if (list[i]!.remotePath === next.remotePath) continue;
    out.push(list[i]!);
  }
  return out;
}

/**
 * Turn a tilde-form attachment path into one SFTP can address.
 *
 * `AttachmentStager` returns display paths like
 * `~/.pocketshell/attachments/main/20260825-101500-01-shot.png`, because that
 * is the form worth pasting into a prompt — the agent reads it through a shell
 * that expands it. SFTP has no shell and no tilde expansion (which is exactly
 * why the stager resolves the home directory itself before uploading), so
 * reading those same bytes BACK for annotation has to undo the abbreviation.
 *
 * `home` is what `realPath(".")` answered on the session's SFTP channel. A
 * path that is not tilde-form is returned untouched: it is already absolute,
 * or it is relative and the server will resolve it against the same home
 * anyway.
 */
/**
 * The stager's own `<yyyyMMdd-HHmmss>-<NN>-` prefix, and the bare
 * `-<yyyyMMdd-HHmmss>` suffix the doodle surface adds. Both are recognised so
 * a name can be stripped back to the part a human chose.
 */
const STAGED_PREFIX = /^\d{8}-\d{6}-\d{2}-/;
const STAMP_SUFFIX = /-\d{8}-\d{6}$/;

/**
 * Name for the PNG a doodle produces, given the backdrop it was drawn on.
 *
 * The interesting case is the SECOND pass. Annotating an already-annotated
 * attachment is supported and is the honest behaviour (the sheet starts from
 * the flattened first pass), but the name it starts from has by then been
 * through two machines: the doodle surface wrapped it as
 * `annotated-<source>-<stamp>.png`, and `AttachmentStager` prefixed THAT with
 * its own `<stamp>-<ordinal>-` on upload. Naively wrapping it again gives
 * `annotated-20260825-101500-01-annotated-shot-20260825-101459-<stamp>.png`,
 * which grows without bound and buries the one word — `shot` — that tells the
 * user which screenshot this is.
 *
 * So both machine decorations are peeled off before the new ones go on. One
 * prefix and one timestamp say everything three of each would, and the result
 * is stable under repeated annotation: `annotated-shot-<latest stamp>.png`.
 *
 * A backdrop with no name at all (the blank sheet) is not an annotation of
 * anything, so it gets the neutral `doodle-` prefix instead.
 */
export function doodleAttachmentName(backdropName: string | null, stamp: string): string {
  const base = (backdropName ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(STAGED_PREFIX, '')
    .replace(STAMP_SUFFIX, '')
    .replace(/^(annotated-)+/, '')
    .replace(/^-+|-+$/g, '');
  return base === '' ? `doodle-${stamp}.png` : `annotated-${base}-${stamp}.png`;
}

export function absoluteAttachmentPath(displayPath: string, home: string): string {
  if (displayPath === '~') return home;
  if (!displayPath.startsWith('~/')) return displayPath;
  const rest = displayPath.slice(2);
  const base = home.endsWith('/') ? home.slice(0, -1) : home;
  return rest === '' ? base : `${base}/${rest}`;
}
