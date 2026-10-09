import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const source = readFileSync(resolve(__dirname, '../../electron-builder.yml'), 'utf8');
function architectures(platform: string): string[] {
  const block = source.split(`${platform}:\n`)[1]?.split(/^[a-z]+:/m)[0] ?? '';
  return [...block.matchAll(/^\s+- (x64|arm64)\s*$/gm)].map((match) => match[1]!);
}

describe('native Windows package architecture', () => {
  it('ships only x64 while the installed ConPTY closure is x64', () => {
    expect(architectures('win')).toEqual(['x64']);
  });
  it('preserves both macOS and Linux architectures', () => {
    expect(new Set(architectures('mac'))).toEqual(new Set(['x64', 'arm64']));
    expect(new Set(architectures('linux'))).toEqual(new Set(['x64', 'arm64']));
  });
});
