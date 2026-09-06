import { beforeEach, describe, expect, it } from 'vitest';
import {
  LAUNCH_HANDOFF_TTL_MS,
  clearAgentLaunch,
  parkAgentLaunch,
  parkedAgentLaunch,
  takeAgentLaunch,
} from '../../src/renderer/pendingAgentLaunch';
import type { LaunchChoice } from '../../src/shared/agentLaunch';

/**
 * The one-slot handoff that carries an agent choice from the session panel —
 * which can create a session but has no terminal — to the folder workspace,
 * which has one.
 *
 * Everything here is about the slot NOT firing where it should not. A launch
 * is a line typed into somebody's shell, so the interesting failures are all
 * of the form "it ran in the wrong place" or "it ran long after anyone asked".
 */
const CHOICE: LaunchChoice = {
  kind: 'claude',
  dir: '/home/alexey/git/dataops',
  skipPermissions: true,
  profile: null,
};

beforeEach(clearAgentLaunch);

describe('pendingAgentLaunch', () => {
  it('hands the choice to the session it was parked for', () => {
    parkAgentLaunch('conn-1', 'git-dataops-2', CHOICE, 1_000);
    expect(takeAgentLaunch('conn-1', 'git-dataops-2', 1_500)).toEqual(CHOICE);
  });

  it('is one-shot — a second collector gets nothing', () => {
    parkAgentLaunch('conn-1', 'git-dataops-2', CHOICE, 1_000);
    takeAgentLaunch('conn-1', 'git-dataops-2', 1_500);
    expect(takeAgentLaunch('conn-1', 'git-dataops-2', 1_600)).toBeNull();
  });

  it('refuses a different HOST', () => {
    // Two connections can hold sessions of the same derived name, because the
    // name comes from the folder and people keep the same folders on two boxes.
    parkAgentLaunch('conn-1', 'git-dataops-2', CHOICE, 1_000);
    expect(takeAgentLaunch('conn-2', 'git-dataops-2', 1_500)).toBeNull();
  });

  it('refuses a different SESSION', () => {
    parkAgentLaunch('conn-1', 'git-dataops-2', CHOICE, 1_000);
    expect(takeAgentLaunch('conn-1', 'git-dataops', 1_500)).toBeNull();
  });

  it('leaves the slot alone on a miss, so the right collector still finds it', () => {
    // The collector runs on every tab-bar change of every workspace the user
    // passes through. A "not mine" answer that consumed the slot would mean
    // the launch was eaten by a workspace on the way to the right one.
    parkAgentLaunch('conn-1', 'git-dataops-2', CHOICE, 1_000);
    takeAgentLaunch('conn-1', 'some-other-session', 1_500);
    expect(takeAgentLaunch('conn-1', 'git-dataops-2', 1_600)).toEqual(CHOICE);
  });

  it('expires rather than firing a command nobody asked for any more', () => {
    parkAgentLaunch('conn-1', 'git-dataops-2', CHOICE, 1_000);
    expect(takeAgentLaunch('conn-1', 'git-dataops-2', 1_000 + LAUNCH_HANDOFF_TTL_MS + 1)).toBeNull();
    // And it is GONE, not merely refused — nothing will ever claim it.
    expect(parkedAgentLaunch.value).toBeNull();
  });

  it('survives long enough to read the outcome banner', () => {
    // The banner is a deliberate stop (a `tmux-fallback` session has no memory
    // cap), so the TTL must not be a latency budget the user can lose by
    // reading.
    parkAgentLaunch('conn-1', 'git-dataops-2', CHOICE, 0);
    expect(takeAgentLaunch('conn-1', 'git-dataops-2', 30_000)).toEqual(CHOICE);
  });

  it('keeps the LAST parked launch when two are created without visiting either', () => {
    parkAgentLaunch('conn-1', 'first', CHOICE, 1_000);
    parkAgentLaunch('conn-1', 'second', { ...CHOICE, kind: 'codex' }, 1_100);
    expect(takeAgentLaunch('conn-1', 'first', 1_200)).toBeNull();
    expect(takeAgentLaunch('conn-1', 'second', 1_200)).toMatchObject({ kind: 'codex' });
  });

  it('refuses a same-named tag in another folder when both workspaces are known', () => {
    // aplexer tags repeat across workspaces: a launch parked for folder A's
    // `review` must not fire in folder B's `review`.
    parkAgentLaunch('conn-1', 'review', CHOICE, 1_000, '/home/alexey/git/a');
    expect(takeAgentLaunch('conn-1', 'review', 1_500, '/home/alexey/git/b')).toBeNull();
    // And the miss leaves the slot alone for the right folder.
    expect(takeAgentLaunch('conn-1', 'review', 1_600, '/home/alexey/git/a')).toEqual(CHOICE);
  });

  it('matches leniently when either side has no workspace', () => {
    // tmux rows carry no workspace, and neither do old parks — both match the
    // way they always did rather than stranding the launch.
    parkAgentLaunch('conn-1', 'git-dataops-2', CHOICE, 1_000);
    expect(takeAgentLaunch('conn-1', 'git-dataops-2', 1_500, '/home/alexey/git/dataops')).toEqual(CHOICE);

    parkAgentLaunch('conn-1', 'review', CHOICE, 1_000, '/home/alexey/git/a');
    expect(takeAgentLaunch('conn-1', 'review', 1_500)).toEqual(CHOICE);
  });
});
