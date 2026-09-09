import { describe, expect, it } from 'vitest';
import { formatLogLine } from '../../src/main/log';

// formatLogLine stamps with `new Date()`, so pin the shape rather than the
// exact value: ISO-8601 stamp, scope in brackets, message, optional JSON.
const LINE_SHAPE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[scope\] /;

describe('formatLogLine', () => {
  it('formats `stamp [scope] message` with a trailing newline', () => {
    const line = formatLogLine('scope', 'the message');
    expect(line).toMatch(new RegExp(LINE_SHAPE.source + 'the message\\n'));
  });

  it('appends the data record as one JSON object', () => {
    const line = formatLogLine('scope', 'msg', { alpha: 1, beta: 'x' });
    expect(line).toMatch(new RegExp(LINE_SHAPE.source + 'msg \\{"alpha":1,"beta":"x"\\}\\n'));
  });

  it('writes the unserialisable marker instead of throwing on circular data', () => {
    const data: Record<string, unknown> = {};
    data['self'] = data;
    const line = formatLogLine('scope', 'msg', data);
    expect(line).toMatch(new RegExp(LINE_SHAPE.source + 'msg \\{"_":"unserialisable"\\}\\n'));
  });

  it('never emits a bare `msg ` with no detail when data is omitted', () => {
    expect(formatLogLine('scope', 'msg').endsWith('msg\n')).toBe(true);
  });
});
