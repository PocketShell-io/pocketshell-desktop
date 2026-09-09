import { describe, expect, it } from 'vitest';
import {
  mergeHostLists,
  parseSyncPayload,
  serializeSyncPayload,
} from '../../src/shared/syncMerge';
import type { HostEntry } from '../../src/shared/types';

function host(name: string, hostname = `${name}.example.com`, port = 22): HostEntry {
  return {
    name,
    hostname,
    port,
    user: 'alexey',
    identityFile: null,
    proxyJump: null,
    forwardAgent: false,
    localForwards: [],
    remoteForwards: [],
    fromConfig: true,
  };
}

describe('mergeHostLists', () => {
  it('unions both sides, local first in local order', () => {
    const out = mergeHostLists([host('a'), host('b')], [host('b'), host('c')]);
    expect(out.hosts.map((h) => h.name)).toEqual(['a', 'b', 'c']);
    expect(out.addedFromRemote).toEqual(['c']);
    expect(out.changed).toBe(true);
  });

  it('keeps the LOCAL entry when both sides know a host', () => {
    const out = mergeHostLists([host('a', 'local.example.com', 22)], [host('a', 'remote.example.com', 2222)]);
    expect(out.hosts[0]!.hostname).toBe('local.example.com');
    expect(out.addedFromRemote).toEqual([]);
  });

  it('reports unchanged when the remote adds nothing', () => {
    const local = [host('a')];
    expect(mergeHostLists(local, [host('a')]).changed).toBe(false);
    expect(mergeHostLists(local, []).changed).toBe(false);
  });

  it('is symmetric enough to converge: syncing twice adds nothing new', () => {
    const local = [host('a')];
    const remote = [host('a'), host('b')];
    const first = mergeHostLists(local, remote);
    const second = mergeHostLists(first.hosts, remote);
    expect(second.changed).toBe(false);
    expect(second.hosts.map((h) => h.name)).toEqual(['a', 'b']);
  });
});

describe('payload round-trip', () => {
  it('serializes and parses hosts', () => {
    const hosts = [host('a', 'a.example.com', 2222)];
    expect(parseSyncPayload(serializeSyncPayload(hosts))).toEqual(hosts);
  });

  it('parses garbage and wrong shapes to an empty list', () => {
    expect(parseSyncPayload('not json')).toEqual([]);
    expect(parseSyncPayload('{"hosts":"nope"}')).toEqual([]);
    expect(parseSyncPayload('{"other":1}')).toEqual([]);
  });

  it('drops entries without a name and hostname', () => {
    const payload = serializeSyncPayload([
      host('good'),
      { ...host('bad'), hostname: '' },
    ]);
    expect(parseSyncPayload(payload).map((h) => h.name)).toEqual(['good']);
  });
});
