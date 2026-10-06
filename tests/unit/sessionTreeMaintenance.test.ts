// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

/**
 * The session tree's Maintenance section — the door to the tool workspaces.
 * It is not permanent chrome: at this component's
 * boundary the rule is the `maintenanceCount` prop, which the wrapper reads
 * from maintenance.ts's per-host tool list — ONE row, whatever the tool
 * count (the tools are the workspace's tabs, listed there and nowhere
 * here), the section gone while the count is zero (and forced on while the
 * workspace itself is on screen). What the row does once showing:
 *
 *  - it sits outside the filter — a door a session query could close is not
 *    a door;
 *  - its click emits the SAME `select` the folder rows do, carrying the
 *    workspace directory and NO tab hand-off — which tool tab lands in
 *    front is the workspace's own memory — so navigation, re-click focus
 *    and the current tint are the folder rows' own machinery;
 *  - it names no tool: the label is the workspace's, the count is how much
 *    is in it, and closing a tool happens at the tab bar's ×, not here;
 *  - the row takes no part in the host's gestures: no drag, no row menu.
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

describe('the Maintenance section', () => {
  it('is absent while the host has no open tools', () => {
    expect(mountRows().find('.maintenance-section').exists()).toBe(false);
  });

  it('is one row whatever is open, naming the workspace and counting the tools', () => {
    const wrapper = mountRows({ maintenanceCount: 2 });
    const section = wrapper.find('.maintenance-section');
    expect(section.exists()).toBe(true);
    expect(section.findAll('.dir-header')).toHaveLength(1);
    expect(section.get('.dir-header .label').text()).toBe('Maintenance');
    expect(section.get('.count').text()).toBe('2');
  });

  it('survives the filter, which narrows sessions, not doors', () => {
    const wrapper = mountRows({
      maintenanceCount: 1,
      filtering: true,
      filterQuery: 'zzz-nothing',
    });
    expect(wrapper.find('.maintenance-section').exists()).toBe(true);
  });

  it('opens the workspace with no tab hand-off, the folder rows’ own select', async () => {
    const wrapper = mountRows({ maintenanceCount: 1 });
    await wrapper.get('.maintenance-section .dir-header').trigger('click');

    const events = wrapper.emitted<[SessionDirectory]>('select');
    expect(events).toHaveLength(1);
    expect(events![0]!.length).toBe(1);
    expect(events![0]![0].key).toBe(MAINTENANCE_ROOT);
  });

  it('marks itself current while the maintenance workspace is open', () => {
    const wrapper = mountRows({ maintenanceCount: 1, activeFolder: MAINTENANCE_ROOT });
    expect(wrapper.get('.maintenance-section .dir-header').classes()).toContain('current');

    const other = mountRows({ maintenanceCount: 1, activeFolder: '~/git' });
    expect(other.find('.maintenance-section .dir-header').classes()).not.toContain('current');
  });

  it('takes no part in the host’s gestures: no drag, no row menu', async () => {
    const wrapper = mountRows({ maintenanceCount: 1 });
    const row = wrapper.get('.maintenance-section .dir-header');

    expect(row.attributes('draggable')).toBeUndefined();
    await row.trigger('contextmenu');
    expect(wrapper.emitted('menu')).toBeUndefined();
  });
});
