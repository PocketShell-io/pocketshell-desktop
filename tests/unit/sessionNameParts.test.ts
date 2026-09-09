import { describe, expect, it } from 'vitest';
import {
  APLEXER_DEFAULT_TAG,
  normalisePart,
  resolveAplexerTag,
  sanitisePart,
} from '../../src/shared/sessionNameParts';

/**
 * These cases pin the ORDER of the replacements, not just their result: main
 * derives session names with this function and the renderer decides whether a
 * name is redundant with its folder using the same one, so a change here
 * silently changes both.
 */
describe('sanitisePart', () => {
  it('collapses `.`/`:` runs to a single `_` before anything else', () => {
    expect(sanitisePart('a..b')).toBe('a_b');
    expect(sanitisePart('a::b')).toBe('a_b');
    expect(sanitisePart('v1.2.3')).toBe('v1_2_3');
  });

  it('collapses any other disallowed run to a single `-` and trims it', () => {
    expect(sanitisePart('a  b')).toBe('a-b');
    expect(sanitisePart('!!a!!')).toBe('a');
    expect(sanitisePart('...')).toBe('_');
    expect(sanitisePart('!!!')).toBe('');
  });

  it('leaves already-safe characters alone', () => {
    expect(sanitisePart('Abc_123-x')).toBe('Abc_123-x');
  });
});

/**
 * The rename field's as-you-type pass. It must apply the SAME character rules
 * as `sanitisePart` — it is built on it, so drift is not possible — but it
 * must NOT trim: a `-` is typed at the end of a field first, and an as-you-
 * type edge trim eats it on landing, making `foo-bar` untypable.
 */
describe('normalisePart', () => {
  it('applies the same character rules as sanitisePart', () => {
    expect(normalisePart('a..b')).toBe('a_b');
    expect(normalisePart('a  b')).toBe('a-b');
    expect(normalisePart('!!a!!')).toBe('-a-');
  });

  it('keeps edge hyphens for the commit-time trim to take', () => {
    expect(normalisePart('foo-')).toBe('foo-');
    expect(normalisePart('-foo')).toBe('-foo');
    expect(normalisePart('-')).toBe('-');
    expect(sanitisePart('foo-')).toBe('foo');
  });
});

/**
 * The aplexer tag derivation. A tag is namespaced per workspace, so its
 * default does not need the folder in it — it is `main`, and the free-tag
 * walk continues `main-2`, `main-3` at create time.
 */
describe('resolveAplexerTag', () => {
  it('falls back to `main`, not to the folder derivation', () => {
    expect(resolveAplexerTag(null)).toBe('main');
    expect(resolveAplexerTag(undefined)).toBe('main');
    expect(resolveAplexerTag('')).toBe('main');
    // Punctuation-only cannot be a name either.
    expect(resolveAplexerTag('...')).toBe('main');
    expect(APLEXER_DEFAULT_TAG).toBe('main');
  });

  it('honours a label that survives sanitising, and sanitises it', () => {
    expect(resolveAplexerTag('Staging!')).toBe('Staging');
    expect(resolveAplexerTag('  my tag  ')).toBe('my-tag');
  });
});
