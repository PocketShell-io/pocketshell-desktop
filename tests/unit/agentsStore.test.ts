import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';

/**
 * The agents store used to be almost entirely the Conversation tab's state,
 * and this file used to test that: `loadForSession`, the transcript `source`,
 * `fail`, and the stale-reply guard. All of it went with the feature
 *
 *
 * What is left is the usage half, and it is tested here rather than left
 * uncovered because the removal changed it: `loading` used to be written ONLY
 * by the conversation loader while being READ by the usage refresh button in
 * UsageView.vue and HostWorkspaceView.vue. Deleting the writer without giving
 * `loadUsage` ownership would have left a spinner that never spins, with a
 * green test suite. That is exactly the failure a deletion of this size can
 * hide, so it gets an assertion.
 */

const usage = vi.fn();

const profiles = vi.fn();

vi.mock('@ui/app/ipc', () => ({
  api: {
    helper: { usage: (connectionId: string): unknown => usage(connectionId) },
    agent: { profiles: (connectionId: string): unknown => profiles(connectionId) },
  },
}));

import { useAgentsStore } from '@ui/app/stores/agents';

beforeEach(() => {
  setActivePinia(createPinia());
  usage.mockReset();
  profiles.mockReset();
});

describe('agents store (usage)', () => {
  it('loads the usage rows', async () => {
    usage.mockResolvedValue([{ provider: 'codex', status: 'ok' }]);
    const store = useAgentsStore();
    expect(store.usage).toEqual([]);
    await store.loadUsage('conn-1');
    expect(usage).toHaveBeenCalledWith('conn-1');
    expect(store.usage).toHaveLength(1);
  });

  it('raises `loading` while the fetch is in flight and lowers it after', async () => {
    let release: (rows: unknown[]) => void = () => {};
    usage.mockReturnValue(
      new Promise<unknown[]>((resolve) => {
        release = resolve;
      }),
    );
    const store = useAgentsStore();
    const inFlight = store.loadUsage('conn-1');
    expect(store.loading).toBe(true);
    release([]);
    await inFlight;
    expect(store.loading).toBe(false);
  });

  /**
   * `loadUsage` used to have a try/finally with no catch, so a host without
   * the helper made the rejection escape to the refresh button's handler and
   * the panel silently kept whatever it had. It now answers the same way
   * `loadProfiles` does: resolve, and put the reason in `usageError`.
   */
  it('records a failure in `usageError` instead of throwing', async () => {
    usage.mockRejectedValue(new Error('no helper'));
    const store = useAgentsStore();
    await expect(store.loadUsage('conn-1')).resolves.toBeUndefined();
    expect(store.usageError).toBe('no helper');
    expect(store.loading).toBe(false);
  });

  it('keeps the stale rows when a refresh fails', async () => {
    // A table that is a few minutes old with a reason attached beats an empty
    // one — the store keeps the rows so the view can show both.
    usage.mockResolvedValueOnce([{ provider: 'codex', status: 'ok' }]);
    usage.mockRejectedValueOnce(new Error('connection lost'));
    const store = useAgentsStore();
    await store.loadUsage('conn-1');
    await store.loadUsage('conn-1');
    expect(store.usage).toHaveLength(1);
    expect(store.usageError).toBe('connection lost');
  });

  it('clears the error on the next attempt, so a recovery does not keep accusing', async () => {
    usage.mockRejectedValueOnce(new Error('no helper'));
    usage.mockResolvedValueOnce([{ provider: 'claude', status: 'ok' }]);
    const store = useAgentsStore();
    await store.loadUsage('conn-1');
    expect(store.usageError).toBe('no helper');
    await store.loadUsage('conn-1');
    expect(store.usageError).toBeNull();
    expect(store.usage).toHaveLength(1);
  });
});

/**
 * The profile half, which had no renderer caller at all until the launch
 * dialog. `agent:profiles` has been wired end to end since 88cc932 taught it
 * the 0.4.44 `{"profiles": […]}` envelope, so what is new here is only the
 * store: parsing rows into something the picker can render, and SWALLOWING a
 * failure rather than rethrowing it — the pattern `loadUsage` above has since
 * adopted too.
 *
 * The swallow is deliberate and is why it gets a test. A profile is optional:
 * omitting `--profile` launches the engine default, which is exactly what a
 * host with no profiles wants. So a failed fetch must degrade the picker, not
 * the launch.
 */
describe('agents store (profiles)', () => {
  it('parses the rows the host actually emits', async () => {
    profiles.mockResolvedValue([
      { name: 'Claude', engine: 'claude', config_dir: null, default: true },
      { name: 'Claude (Z.AI)', engine: 'claude', config_dir: '/home/t/.zlaude', default: false },
    ]);
    const store = useAgentsStore();
    await store.loadProfiles('conn-1');
    expect(profiles).toHaveBeenCalledWith('conn-1');
    expect(store.profiles.map((p) => p.name)).toEqual(['Claude', 'Claude (Z.AI)']);
    expect(store.profilesError).toBeNull();
  });

  it('treats a host with no profiles as empty, not an error', async () => {
    profiles.mockResolvedValue([]);
    const store = useAgentsStore();
    await store.loadProfiles('conn-1');
    expect(store.profiles).toEqual([]);
    expect(store.profilesError).toBeNull();
  });

  it('records a failure instead of throwing, so the dialog still opens', async () => {
    profiles.mockRejectedValue(new Error('no helper'));
    const store = useAgentsStore();
    await expect(store.loadProfiles('conn-1')).resolves.toBeUndefined();
    expect(store.profiles).toEqual([]);
    expect(store.profilesError).toBe('no helper');
    expect(store.profilesLoading).toBe(false);
  });

  it('lets a later host win, so a stale answer cannot overwrite it', async () => {
    let releaseOld: (rows: unknown[]) => void = () => {};
    profiles.mockReturnValueOnce(new Promise((r) => { releaseOld = r; }));
    profiles.mockResolvedValueOnce([
      { name: 'Codex', engine: 'codex', config_dir: null, default: true },
    ]);
    const store = useAgentsStore();
    const old = store.loadProfiles('conn-1');
    await store.loadProfiles('conn-2');
    // conn-1 answers late, after we have already moved to conn-2.
    releaseOld([{ name: 'Claude', engine: 'claude', config_dir: null, default: true }]);
    await old;
    expect(store.profiles.map((p) => p.name)).toEqual(['Codex']);
  });
});
