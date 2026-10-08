// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { SessionSummary } from '@pocketshell/core';
import { sessionIdentityKey } from '@pocketshell/core';
import { groupSessionsIntoRoots, type SessionDirectory } from '@ui/app/sessionTree';
import SessionTreeRowsView from '@ui/app/components/SessionTreeRowsView.vue';

describe('native Windows live session folders', () => {
  it('keeps identical display names isolated by full workspace and immutable UUID in the rendered folder selection', async () => {
    const paths = ['C:/Work One/same', 'C:/Work Two/same'];
    const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
    const sessions: SessionSummary[] = paths.map((workspace, i) => ({
      name: 'same:main', tag: 'main', workspace, path: workspace,
      aplexerId: ids[i], backend: 'aplexer', created: 100, activity: 100, attached: false,
    }));
    const roots = groupSessionsIntoRoots(sessions, null, ['C:/Work One', 'C:/Work Two']);
    expect(roots.map((root) => root.sessionCount)).toEqual([1, 1]);
    expect(sessionIdentityKey(sessions[0]!.name, sessions[0])).not.toBe(
      sessionIdentityKey(sessions[1]!.name, sessions[1]),
    );
    const wrapper = mount(SessionTreeRowsView, {
      props: { roots, home: null, now: 200, defaultStartIn: null, tabOrders: {} },
    });
    const folders = wrapper.findAll('.dir-header');
    expect(folders).toHaveLength(2);
    for (const folder of folders) await folder.trigger('click');
    const selections = wrapper.emitted<[SessionDirectory]>('select')!;
    expect(selections).toHaveLength(2);
    expect(selections.map(([folder]) => folder.path)).toEqual(paths);
    expect(selections.map(([folder]) => folder.rows.map((row) => row.session.aplexerId)))
      .toEqual([[ids[0]], [ids[1]]]);
    expect(selections.map(([folder]) => folder.rows.map((row) => row.session.workspace)))
      .toEqual([[paths[0]], [paths[1]]]);
    wrapper.unmount();
  });
});
