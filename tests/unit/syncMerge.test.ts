import { describe, expect, it } from 'vitest';
import {
  aliasesToAutoCheck,
  assembleSyncSet,
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

describe('assembleSyncSet', () => {
  it('sends only the ticked aliases — unticked hosts never leave the machine', () => {
    const out = assembleSyncSet([host('a'), host('b'), host('c')], [], ['b']);
    expect(out.map((h) => h.name)).toEqual(['b']);
  });

  it('takes a ticked alias the config lacks from the account', () => {
    const remote = [host('b', 'remote.example.com', 2222)];
    const out = assembleSyncSet([host('a')], remote, ['a', 'b']);
    expect(out).toEqual([host('a'), host('b', 'remote.example.com', 2222)]);
  });

  it('prefers the LOCAL entry when both sides have a ticked alias', () => {
    const out = assembleSyncSet(
      [host('a', 'local.example.com', 22)],
      [host('a', 'remote.example.com', 2222)],
      ['a'],
    );
    expect(out[0]!.hostname).toBe('local.example.com');
    expect(out[0]!.port).toBe(22);
  });

  it('drops a tick with no entry on either side, at no cost to the others', () => {
    expect(assembleSyncSet([], [], ['ghost'])).toEqual([]);
    expect(assembleSyncSet([host('a')], [], ['ghost', 'a']).map((h) => h.name)).toEqual(['a']);
  });

  it('ignores unticked remote hosts entirely', () => {
    const out = assembleSyncSet([host('a')], [host('r1'), host('r2')], ['a']);
    expect(out.map((h) => h.name)).toEqual(['a']);
  });

  it('honours the ticked order and tolerates duplicates', () => {
    const out = assembleSyncSet([host('a'), host('b')], [], ['b', 'a', 'b']);
    expect(out.map((h) => h.name)).toEqual(['b', 'a']);
  });

  it('is empty when nothing is ticked', () => {
    expect(assembleSyncSet([host('a')], [host('r')], [])).toEqual([]);
  });
});

describe('aliasesToAutoCheck', () => {
  it('lists account aliases the selection lacks', () => {
    expect(aliasesToAutoCheck([host('a'), host('b')], ['b'], [])).toEqual(['a']);
  });

  it('is empty when the selection already covers the account', () => {
    expect(aliasesToAutoCheck([host('a')], ['a', 'x'], [])).toEqual([]);
  });

  it('is every alias on a fresh machine', () => {
    expect(aliasesToAutoCheck([host('a'), host('b')], [], [])).toEqual(['a', 'b']);
  });

  it('never claims an alias the local config already has — an untick must stand', () => {
    // The user unticked 'dropped'; the account still holds it. Because the
    // config has the alias, the untick survives the next pull.
    expect(aliasesToAutoCheck([host('kept'), host('dropped')], ['kept'], ['kept', 'dropped'])).toEqual([]);
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
