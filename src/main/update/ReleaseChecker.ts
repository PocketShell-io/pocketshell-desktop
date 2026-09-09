/**
 * Release checker — the desktop port of the Android app's
 * `ReleaseChecker.kt`: one poll of the GitHub Releases API, compared against
 * the running version, answered as a THREE-WAY result.
 *
 * The three-way shape is the point, and it is inherited rather than invented.
 * Issue #515 on the phone: an earlier API collapsed "no newer release" and
 * "the check itself failed" into the same null, so a cold-launch network blip
 * produced exactly the same silent no-banner as a genuinely current install.
 * `up-to-date` and `failed` are different answers here for the same reason.
 *
 * Like the phone, this app does NOT self-install anything. The result carries
 * a download URL; opening it (the system browser, then the user unpacks or
 * installs) is the user's act, not ours — sideloading is the user's choice.
 *
 * The network dependency is injected (`fetcher`) so every decision in this
 * file is unit-testable without a network, and the caller in ipc.ts is left
 * with nothing but wiring.
 */

import type { UpdateCheckResult as ReleaseCheckResult } from '../../shared/types.js';

// The result type lives in shared/types so main and the preload surface
// agree on it; the name here keeps the checker's own vocabulary.

const RELEASES_API = 'https://api.github.com/repos/alexeygrigorev/pocketshell-desktop/releases/latest';

export interface CheckInput {
  currentVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  fetcher: typeof fetch;
  /** The API endpoint, injectable so tests never touch the network. */
  endpoint?: string;
}

/**
 * Compare two dotted version strings after stripping a leading `v`. Returns
 * true when [tag] is STRICTLY newer than [current]. Non-numeric parts make
 * the comparison false — a tag this function cannot read is not evidence of
 * an update, and nagging on a parse failure would be worse than missing one.
 */
export function isNewerRelease(tag: string, current: string): boolean {
  const parse = (v: string) =>
    v
      .replace(/^v/i, '')
      .split('.')
      .map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  const tagParts = parse(tag);
  const currentParts = parse(current);
  const rows = Math.max(tagParts.length, currentParts.length);
  for (let i = 0; i < rows; i++) {
    const t = tagParts[i] ?? 0;
    const c = currentParts[i] ?? 0;
    if (Number.isNaN(t) || Number.isNaN(c)) return false;
    if (t !== c) return t > c;
  }
  return false;
}

/**
 * Pick the release asset that matches THIS machine, or null when the release
 * has nothing for it (a failure to match is not an update offer). Mirrors
 * what the pipeline uploads:
 *
 *   win    PocketShell-<v>-win-x64.zip / PocketShell-<v>-win-arm64.zip
 *   mac    PocketShell-<v>-mac.zip (x64) / PocketShell-<v>-arm64-mac.zip
 *   linux  PocketShell-<v>.AppImage / PocketShell-<v>-arm64.AppImage
 *
 * `contains 'arm64'` is the whole arm/x64 distinction — x64 asset names never
 * carry it and arm ones always do. AppImage is the Linux offer because it is
 * the one artifact that runs without an install step; a deb user can still
 * take it from the release page.
 */
export function pickAsset(
  assets: readonly { name: string; downloadUrl: string }[],
  platform: NodeJS.Platform,
  arch: string,
): { downloadUrl: string } | null {
  const isArm = arch === 'arm64';
  const matches = assets.filter((asset) => {
    const name = asset.name.toLowerCase();
    const archOk = name.includes('arm64') === isArm;
    if (platform === 'win32') return archOk && name.endsWith('.zip');
    if (platform === 'darwin') return archOk && name.includes('mac') && name.endsWith('.zip');
    if (platform === 'linux') return archOk && name.endsWith('.appimage');
    return false;
  });
  // Newest first is a guess we never have to make: `releases/latest` holds
  // one release. If it somehow carries several matching assets, the list
  // order decides, deterministically for a given tag.
  return matches[0] ?? null;
}

/**
 * One check. Never throws — every failure mode (HTTP, parse, network) comes
 * back as `failed` with a reason, because the caller is a banner that can
 * only show what it is told.
 */
export async function checkForUpdate(input: CheckInput): Promise<ReleaseCheckResult> {
  const { currentVersion, platform, arch, fetcher, endpoint = RELEASES_API } = input;
  try {
    const response = await fetcher(endpoint, {
      headers: {
        Accept: 'application/vnd.github+json',
        // The GitHub API rejects unauthenticated calls without a UA.
        'User-Agent': 'pocketshell-desktop-release-check',
      },
    });
    if (!response.ok) {
      return {
        status: 'failed',
        reason: `releases/latest answered ${response.status}`,
        currentVersion,
      };
    }
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) {
      return { status: 'failed', reason: 'release payload was not an object', currentVersion };
    }
    const doc = body as {
      tag_name?: unknown;
      html_url?: unknown;
      assets?: unknown;
    };
    if (typeof doc['tag_name'] !== 'string' || typeof doc['html_url'] !== 'string') {
      return { status: 'failed', reason: 'release payload was missing tag/url', currentVersion };
    }
    const tagName = doc['tag_name'];
    if (!isNewerRelease(tagName, currentVersion)) {
      return { status: 'up-to-date', currentVersion };
    }
    const rawAssets = Array.isArray(doc['assets']) ? doc['assets'] : [];
    const assets = rawAssets.flatMap((asset: unknown) => {
      if (typeof asset !== 'object' || asset === null) return [];
      const record = asset as { name?: unknown; browser_download_url?: unknown };
      if (typeof record['name'] !== 'string' || typeof record['browser_download_url'] !== 'string') {
        return [];
      }
      return [{ name: record['name'], downloadUrl: record['browser_download_url'] }];
    });
    const asset = pickAsset(assets, platform, arch);
    if (!asset) {
      return {
        status: 'failed',
        reason: `release ${tagName} has no asset for ${platform}/${arch}`,
        currentVersion,
      };
    }
    return {
      status: 'available',
      currentVersion,
      tagName,
      downloadUrl: asset.downloadUrl,
      notesUrl: doc['html_url'],
    };
  } catch (err) {
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      currentVersion,
    };
  }
}

