import { describe, expect, it } from 'vitest';

/**
 * The verdicts terminalUrls.ts hands back about a FINISHED line.
 *
 * The joins that produce that line are terminalLinks.ts's business (tested
 * there, against the panes the reports came from); what is under test here
 * is where a URL starts, where it stops, and — the half that decides whether
 * the feature is trustworthy — everything it must leave alone. The peel is
 * the path detector's own (terminalPaths.ts), so `(url).` underlines without
 * the decoration and opens without it too.
 */
const { findUrls } = await import('@ui/app/terminalUrls');

/** The URLs of one line, as strings. */
const urls = (line: string): string[] => findUrls(line).map((m) => m.url);

describe('findUrls', () => {
  it('finds the one URL in a line of prose', () => {
    expect(urls('open https://example.com/x now')).toEqual(['https://example.com/x']);
  });

  it('matches http as well as https', () => {
    expect(urls('see http://example.com for more')).toEqual(['http://example.com']);
  });

  it('spans offsets without the decoration it peeled', () => {
    const line = '(open https://example.com/a).';
    const [match] = findUrls(line);
    expect(match?.url).toBe('https://example.com/a');
    expect(line.slice(match?.start ?? 0, match?.end ?? 0)).toBe('https://example.com/a');
  });

  it('peels sentence punctuation and a closer with no opener inside', () => {
    expect(urls('saved https://example.com/a/b.png.')).toEqual(['https://example.com/a/b.png']);
    expect(urls('it is (https://example.com/a) yes')).toEqual(['https://example.com/a']);
  });

  it('keeps a closer that the URL itself has opened', () => {
    expect(urls('wiki: https://en.wikipedia.org/wiki/A_(B) end')).toEqual([
      'https://en.wikipedia.org/wiki/A_(B)',
    ]);
  });

  it('keeps percent-escapes and query strings whole', () => {
    expect(
      urls(
        'compare: https://x.io/e/01a08215/compare?experiments=%5B%2201a08216%22%2C%2201a08217%22%5D done',
      ),
    ).toEqual([
      'https://x.io/e/01a08215/compare?experiments=%5B%2201a08216%22%2C%2201a08217%22%5D',
    ]);
  });

  it('peels a markdown autolink close angle', () => {
    expect(urls('read <https://example.com/a> first')).toEqual(['https://example.com/a']);
  });

  it('takes a query embedding a second scheme as ONE address', () => {
    expect(urls('go https://a.io/r?next=https://b.io/s end')).toEqual([
      'https://a.io/r?next=https://b.io/s',
    ]);
  });

  it('refuses a bare scheme and a scheme with no authority', () => {
    expect(urls('https:// and more')).toEqual([]);
    expect(urls('https:///x is degenerate')).toEqual([]);
  });

  it('leaves every other scheme alone — file for the Files tab, ssh for nobody', () => {
    expect(urls('file:///home/alexey/x.png')).toEqual([]);
    expect(urls('push to ssh://git@host/team/repo.git')).toEqual([]);
  });

  it('finds nothing in plain prose', () => {
    expect(urls('no address here, just words')).toEqual([]);
  });
});

/**
 * The schemeless family: the `127.0.0.1:8300` a dev box prints when it
 * reports where a server it just started listens. Nothing else in the pane
 * claims it — WebLinksAddon's regex is anchored on `https?://` — so the
 * detector supplies the `http://` itself and flags the match `schemeless`,
 * which is how the provider knows a single-row one is its alone.
 */
describe('findUrls — bare IPv4 addresses', () => {
  it('links a dev-server address with its port, supplying the scheme', () => {
    const line = 'dev server is still up on 127.0.0.1:8300 if you want it';
    const [match] = findUrls(line);
    expect(match?.url).toBe('http://127.0.0.1:8300');
    expect(match?.schemeless).toBe(true);
    // The underline spans what the user reads — the bare address, not the
    // scheme this module bolted on for the click.
    expect(line.slice(match?.start ?? 0, match?.end ?? 0)).toBe('127.0.0.1:8300');
  });

  it('links a bare address with no port and one with a path and query', () => {
    expect(urls('pinging 10.0.0.3 now')).toEqual(['http://10.0.0.3']);
    expect(urls('open 192.168.1.24:8080/admin/settings?tab=users first')).toEqual([
      'http://192.168.1.24:8080/admin/settings?tab=users',
    ]);
  });

  it('peels sentence punctuation and a closer with no opener inside', () => {
    expect(urls('it listens on (127.0.0.1:8300).')).toEqual(['http://127.0.0.1:8300']);
    expect(urls('reached 127.0.0.1:8300/health) just now')).toEqual([
      'http://127.0.0.1:8300/health',
    ]);
  });

  it('takes scheme and bare addresses in one line, each exactly once', () => {
    // The scheme URL's own octets are inside its span — the bare scan must
    // not re-claim them as a second link.
    expect(urls('api on http://127.0.0.1:8300 and ui on 127.0.0.1:5173')).toEqual([
      'http://127.0.0.1:8300',
      'http://127.0.0.1:5173',
    ]);
  });

  it('refuses a fifth group, an over-large octet and a leading-zero octet', () => {
    expect(urls('see 1.2.3.4.5 in the log')).toEqual([]);
    expect(urls('see 256.0.0.1 in the log')).toEqual([]);
    expect(urls('see 999.999.999.999 in the log')).toEqual([]);
    expect(urls('see 01.2.3.4 in the log')).toEqual([]);
  });

  it('refuses an address with a letter, digit or dot on its left shoulder', () => {
    expect(urls('release v1.2.3.4 today')).toEqual([]);
    expect(urls('the a.127.0.0.1 name resolves')).toEqual([]);
    expect(urls('id 9127.0.0.1 is not an address')).toEqual([]);
  });

  it('refuses a colon that is not a port', () => {
    expect(urls('at 127.0.0.1:8300:8080 maybe')).toEqual([]);
  });

  it('leaves IPv6 alone, bracketed or bare', () => {
    expect(urls('listening on [::1]:8300 now')).toEqual([]);
    expect(urls('listening on ::1 now')).toEqual([]);
  });
});

/**
 * The schemeless domain family: `datatalks.club/blog/sponsor-…html`, the
 * shape a CLI prints when it names a page without its scheme. The rules are
 * deliberately tighter than for the bare-IP half of the family — a bare
 * domain is a hostname being mentioned as often as an address, so it needs
 * a port or a path before it is believed.
 */
describe('findUrls — bare domain addresses', () => {
  it('links a domain with a path, supplying the scheme', () => {
    const line =
      'The live page at datatalks.club/blog/sponsor-datatalks-club.html will show the changes';
    const [match] = findUrls(line);
    expect(match?.url).toBe('http://datatalks.club/blog/sponsor-datatalks-club.html');
    expect(match?.schemeless).toBe(true);
    // The underline spans what the user reads, and the case they typed —
    // the shape HOSTNAME reads case-insensitively — comes through whole.
    expect(line.slice(match?.start ?? 0, match?.end ?? 0)).toBe(
      'datatalks.club/blog/sponsor-datatalks-club.html',
    );
  });

  it('links a domain with a port, and a port plus path', () => {
    expect(urls('api on api.example.com:8443 today')).toEqual(['http://api.example.com:8443']);
    expect(urls('open datatalks.club:8080/blog/post?id=7 first')).toEqual([
      'http://datatalks.club:8080/blog/post?id=7',
    ]);
  });

  it('admits a single-segment path on a normal TLD', () => {
    expect(urls('repo at github.com/vercel now')).toEqual(['http://github.com/vercel']);
    expect(urls('docs at example.com/blog/ now')).toEqual(['http://example.com/blog/']);
  });

  it('leaves a bare domain plain — a mentioned hostname, and an email half', () => {
    expect(urls('visit datatalks.club for the course')).toEqual([]);
    expect(urls('write to alexey@datatalks.club now')).toEqual([]);
  });

  it('refuses the prose slash of a .js domain — Node.js/Python is not an address', () => {
    expect(urls('built with Node.js/Python this time')).toEqual([]);
    expect(urls('choose Vue.js/React or both')).toEqual([]);
  });

  it('still admits a .js domain with somewhere real to go', () => {
    expect(urls('see next.js/docs/getting-started now')).toEqual([
      'http://next.js/docs/getting-started',
    ]);
    expect(urls('see node.js:3000 now')).toEqual(['http://node.js:3000']);
    expect(urls('see node.js/blog/ now')).toEqual(['http://node.js/blog/']);
  });

  it('refuses scp and git-remote colon shapes', () => {
    expect(urls('scp file datatalks.club:/tmp/x now')).toEqual([]);
    expect(urls('clone git@github.com:org/repo.git now')).toEqual([]);
  });

  it('keeps both families and a scheme URL out of each other on one line', () => {
    expect(
      urls('page datatalks.club/blog/x.html mirrors http://127.0.0.1:8300 and 10.0.0.3'),
    ).toEqual(['http://datatalks.club/blog/x.html', 'http://127.0.0.1:8300', 'http://10.0.0.3']);
  });
});
