// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

/**
 * The session tree's pinned Maintenance section — the door back to the tool
 * workspaces (docs/MONITOR.md). The roots around it are the host's grouping;
 * this section is the app's own chrome, and the contracts pinned here are
 * what that difference means:
 *
 *  - it renders for every host, on top of any grouping and any filter — a
 *    door that a session query could close is not a door back;
 *  - its row emits the SAME `select` the folder rows do, carrying a key-only
 *    directory, so navigation and the re-click focus are the folder rows'
 *    own machinery;
 *  - it takes no part in the host's interactions: no drag, no row menu.
 */

import SessionTreeRowsView from '@ui/app/components/SessionTreeRowsView.vue';
import type { SessionDirectory } from '@ui/app/sessionTree';
import { MAINTENANCE_ROOT } from '@pocketshell/core';

function mountRows(overrides: Record<string, unknown> = {}) {
  return mount(SessionTreeRowsView, {
    props: {
      roots: [],
      home: '/home/alexey',
      now: 1_000_000,
      defaultStartIn: null,
      tabOrders: {},
      ...overrides,
    },
  });
}

describe('the pinned Maintenance section', () => {
  it('renders on a host with no sessions at all', () => {
    const wrapper = mountRows();
    const section = wrapper.find('.maintenance-section');
    expect(section.exists()).toBe(true);
    expect(section.get('.folder-label').text()).toBe('Maintenance');
    expect(section.find('.dir-header .label').text()).toBe('htop');
  });

  it('survives the filter, which narrows sessions, not doors', () => {
    const wrapper = mountRows({ filtering: true, filterQuery: 'zzz-nothing' });
    expect(wrapper.find('.maintenance-section').exists()).toBe(true);
  });

  it('emits the folder rows’ own select, keyed to the maintenance root', async () => {
    const wrapper = mountRows();
    await wrapper.get('.maintenance-section .dir-header').trigger('click');

    const events = wrapper.emitted<[SessionDirectory]>('select');
    expect(events).toHaveLength(1);
    expect(events![0]![0].key).toBe(MAINTENANCE_ROOT);
  });

  it('marks itself current while the maintenance workspace is open', () => {
    const wrapper = mountRows({ activeFolder: MAINTENANCE_ROOT });
    expect(wrapper.get('.maintenance-section .dir-header').classes()).toContain('current');

    const other = mountRows({ activeFolder: '~/git' });
    expect(other.find('.maintenance-section .dir-header').classes()).not.toContain('current');
  });

  it('takes no part in the host’s gestures: no drag, no row menu', async () => {
    const wrapper = mountRows();
    const row = wrapper.get('.maintenance-section .dir-header');

    expect(row.attributes('draggable')).toBeUndefined();
    await row.trigger('contextmenu');
    expect(wrapper.emitted('menu')).toBeUndefined();
  });
});
