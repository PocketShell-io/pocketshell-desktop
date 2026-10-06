import { beforeEach, describe, expect, it } from 'vitest';
import type { HostEntry } from '@pocketshell/core';
import {
  autoConnectAttempted,
  decideAutoConnect,
  defaultHostStatus,
  launchDefaultHost,
  markAutoConnectAttempted,
  readLaunchRequest,
  resetAutoConnectLatch,
} from '@ui/app/autoConnect';

/**
 * The launch-time auto-connect decision. Every case here is one the user can
 * reach in about two clicks and none of them are reachable from a component
 * test without a live SSH host, which is exactly why the rule was factored out
 * of HostPickerView.
 */

function host(name: string): HostEntry {
  return {
    name,
    hostname: `${name}.example`,
    port: 22,
    user: 'me',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: true,
  };
}

const HOSTS = [host('hetzner'), host('fixture')];

const base = {
  defaultHost: null as string | null,
  hosts: HOSTS,
  attempted: false,
  connected: false,
};

beforeEach(resetAutoConnectLatch);

describe('decideAutoConnect', () => {
  it('connects to the default host on a cold launch', () => {
    const decision = decideAutoConnect({ ...base, defaultHost: 'hetzner' });
    expect(decision).toEqual({ action: 'connect', host: HOSTS[0] });
  });

  it('shows the picker when no default is set', () => {
    expect(decideAutoConnect(base)).toEqual({ action: 'skip', reason: 'no-default' });
  });

  it('treats a blank default as no default', () => {
    expect(decideAutoConnect({ ...base, defaultHost: '   ' }).action).toBe('skip');
  });

  it('degrades to the picker when the default is gone from the config', () => {
    // The requirement that matters: this is a skip, not a crash and not a
    // dial against a host that does not exist.
    expect(decideAutoConnect({ ...base, defaultHost: 'deleted-box' })).toEqual({
      action: 'skip',
      reason: 'unknown-host',
    });
  });

  it('degrades to the picker when the config yielded no hosts at all', () => {
    expect(decideAutoConnect({ ...base, defaultHost: 'hetzner', hosts: [] }).action).toBe('skip');
  });

  it('fires ONCE per launch — a second visit to the picker does not re-dial', () => {
    expect(decideAutoConnect({ ...base, defaultHost: 'hetzner' }).action).toBe('connect');
    markAutoConnectAttempted();
    expect(decideAutoConnect({ ...base, defaultHost: 'hetzner', attempted: true })).toEqual({
      action: 'skip',
      reason: 'already-attempted',
    });
  });

  it('does not re-dial when a connection is already live (Back from the workspace)', () => {
    expect(decideAutoConnect({ ...base, defaultHost: 'hetzner', connected: true })).toEqual({
      action: 'skip',
      reason: 'already-connected',
    });
  });

  it('stays latched after a FAILED attempt, so a dead default cannot trap the user', () => {
    // The picker marks the latch before dialling precisely so this holds even
    // when the dial rejects the key or times out.
    markAutoConnectAttempted();
    expect(
      decideAutoConnect({ ...base, defaultHost: 'hetzner', attempted: autoConnectAttempted() })
        .action,
    ).toBe('skip');
  });
});

describe('the latch', () => {
  it('starts clear and stays set once marked', () => {
    expect(autoConnectAttempted()).toBe(false);
    markAutoConnectAttempted();
    expect(autoConnectAttempted()).toBe(true);
    markAutoConnectAttempted();
    expect(autoConnectAttempted()).toBe(true);
  });
});

describe('defaultHostStatus', () => {
  it('reports none / present / missing', () => {
    expect(defaultHostStatus(null, HOSTS)).toBe('none');
    expect(defaultHostStatus('', HOSTS)).toBe('none');
    expect(defaultHostStatus('hetzner', HOSTS)).toBe('present');
    expect(defaultHostStatus('deleted-box', HOSTS)).toBe('missing');
  });

  it('is answered independently of the once-per-launch latch', () => {
    // The banner must keep telling the truth after the attempt is spent.
    markAutoConnectAttempted();
    expect(defaultHostStatus('deleted-box', HOSTS)).toBe('missing');
  });
});

describe('readLaunchRequest', () => {
  it('reads a plain launch: no requested host, default allowed', () => {
    expect(readLaunchRequest('')).toEqual({
      requestedHost: null,
      defaultAutoConnectAllowed: true,
    });
  });

  it('reads the host a launch named, without whitespace', () => {
    expect(readLaunchRequest('?host=win35')).toEqual({
      requestedHost: 'win35',
      defaultAutoConnectAllowed: true,
    });
    expect(readLaunchRequest('?window=workspace&host=%20win35%20')).toEqual({
      requestedHost: 'win35',
      defaultAutoConnectAllowed: false,
    });
  });

  it('marks a secondary window by its window=workspace marker', () => {
    expect(readLaunchRequest('?window=workspace')).toEqual({
      requestedHost: null,
      defaultAutoConnectAllowed: false,
    });
  });

  it('reads an empty host value as no host, not as a name', () => {
    expect(readLaunchRequest('?host=&window=workspace').requestedHost).toBeNull();
  });
});

describe('launchDefaultHost', () => {
  it('an explicitly requested host replaces the stored default', () => {
    expect(
      launchDefaultHost({ requestedHost: 'win35', defaultAutoConnectAllowed: true }, 'hetzner'),
    ).toBe('win35');
  });

  it('a plain first launch offers the stored default', () => {
    expect(
      launchDefaultHost({ requestedHost: null, defaultAutoConnectAllowed: true }, 'hetzner'),
    ).toBe('hetzner');
  });

  it('a secondary window offers no default, even with one stored', () => {
    expect(
      launchDefaultHost({ requestedHost: null, defaultAutoConnectAllowed: false }, 'hetzner'),
    ).toBeNull();
  });

  it('a secondary window asked for a host still gets that host', () => {
    expect(
      launchDefaultHost({ requestedHost: 'win35', defaultAutoConnectAllowed: false }, 'hetzner'),
    ).toBe('win35');
  });

  it('feeds decideAutoConnect unchanged: a requested unknown host is a plain skip', () => {
    const decision = decideAutoConnect({
      defaultHost: launchDefaultHost(
        { requestedHost: 'ghost', defaultAutoConnectAllowed: false },
        'hetzner',
      ),
      hosts: HOSTS,
      attempted: false,
      connected: false,
    });
    expect(decision).toEqual({ action: 'skip', reason: 'unknown-host' });
  });
});
