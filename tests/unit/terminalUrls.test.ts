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
const { findUrls } = await import('../../src/renderer/terminalUrls');

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
