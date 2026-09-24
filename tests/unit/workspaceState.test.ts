// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  lastFolderKey,
  readLastFolder,
  readWorkspaceMemory,
  workspaceMemoryKey,
  writeLastFolder,
  writeWorkspaceMemory,
} from '@ui/app/workspaceState';

/**
 * The persisted half of the folder workspace's tab state
 * (src/renderer/workspaceState.ts).
 *
 * The workspace model itself is exercised in folderWorkspaceRestore.test.ts,
 * which mounts the view over these keys; this file pins the storage contract
 * on its own, because it is a contract with the PAST — whatever a previous
 * launch wrote, or a user hand-edited, has to be readable or safely refused
 * here, with no workspace mounted to catch it.
 */

beforeEach(() => {
  localStorage.clear();
});

describe('workspaceState — the persisted workspace record', () => {
  it('round-trips a record', () => {
    const memory = {
      filesTabs: [{ id: '~/git/x::files:1', path: '/home/me/git/x/docs' }],
      activeTab: 'git-x-2',
      mru: ['git-x', 'git-x-2'],
    };
    writeWorkspaceMemory(workspaceMemoryKey('hetzner', '~/git/x'), memory);
    expect(readWorkspaceMemory(workspaceMemoryKey('hetzner', '~/git/x'))).toEqual(memory);
  });

  it('keeps keys apart per host and folder', () => {
    writeLastFolder('hetzner', '~/git/x');
    writeLastFolder('alpha', '~/git/y');
    expect(readLastFolder('hetzner')).toBe('~/git/x');
    expect(readLastFolder('alpha')).toBe('~/git/y');
  });

  it('reads none when there is nothing stored', () => {
    expect(readWorkspaceMemory(workspaceMemoryKey('hetzner', '~/git/x'))).toBeNull();
    expect(readLastFolder('hetzner')).toBeNull();
  });

  it('reads an empty folder name as none', () => {
    localStorage.setItem(lastFolderKey('hetzner'), '');
    expect(readLastFolder('hetzner')).toBeNull();
  });

  it('refuses a record that is not an object rather than throwing', () => {
    localStorage.setItem(workspaceMemoryKey('hetzner', '~/git/x'), 'null');
    expect(readWorkspaceMemory(workspaceMemoryKey('hetzner', '~/git/x'))).toBeNull();

    localStorage.setItem(workspaceMemoryKey('hetzner', '~/git/x'), '[1,2]');
    expect(readWorkspaceMemory(workspaceMemoryKey('hetzner', '~/git/x'))).toBeNull();

    localStorage.setItem(workspaceMemoryKey('hetzner', '~/git/x'), '{broken');
    expect(readWorkspaceMemory(workspaceMemoryKey('hetzner', '~/git/x'))).toBeNull();
  });

  it('drops bad fields field-by-field instead of discarding the record', () => {
    localStorage.setItem(
      workspaceMemoryKey('hetzner', '~/git/x'),
      JSON.stringify({
        filesTabs: [
          'not-an-entry',
          { path: '/no/id' },
          { id: '', path: '/empty/id' },
          { id: 'ok', path: 42, extra: true },
          { id: '~/git/x::files:9', path: null },
          { id: '~/git/x::files:10' },
        ],
        activeTab: 42,
        mru: ['git-x', 7, null, 'git-x-2'],
      }),
    );
    expect(readWorkspaceMemory(workspaceMemoryKey('hetzner', '~/git/x'))).toEqual({
      filesTabs: [
        { id: 'ok', path: null },
        { id: '~/git/x::files:9', path: null },
        { id: '~/git/x::files:10', path: null },
      ],
      activeTab: null,
      mru: ['git-x', 'git-x-2'],
    });
  });

  it('reads fields that are the wrong container as empty', () => {
    localStorage.setItem(
      workspaceMemoryKey('hetzner', '~/git/x'),
      JSON.stringify({ filesTabs: {}, activeTab: 'git-x', mru: 'git-x' }),
    );
    expect(readWorkspaceMemory(workspaceMemoryKey('hetzner', '~/git/x'))).toEqual({
      filesTabs: [],
      activeTab: 'git-x',
      mru: [],
    });
  });
});
