// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';

/**
 * The session tree's Maintenance section — the door back to the tool
 * workspaces (docs/MONITOR.md). It is not permanent chrome: at this
 * component's boundary the rule is the `maintenanceTools` prop, which the
 * wrapper reads from maintenance.ts's per-host tool list — one closable row
 * per tool, the section gone when the list is empty (and forced on while the
 * workspace itself is on screen). What the section does once showing:
 *
 *  - a row per tool, outside the filter — a door a session query could close
 *    is not a door back;
 *  - a row's click emits the SAME `select` the folder rows do, carrying the
 *    workspace directory and the tool's identity as the tab hand-off, so
 *    navigation and the re-click focus are the folder rows' own machinery;
 *  - a row's × emits `closeTool` with the tool's kind — the last close
 *    retires the section, which is the user saying "I don't have it";
 *  - the rows take no part in the host's gestures: no drag, no row menu.
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

const HTOP = { kind: 'htop', identity: 'tool:aws:htop' };

describe('the Maintenance section', () => {
  it('is absent while the host has no open tools', () => {
    expect(mountRows().find('.maintenance-section').exists()).toBe(false);
  });

  it('renders one row per open tool, even on a host with no sessions', () => {
    const wrapper = mountRows({ maintenanceTools: [HTOP] });
    const section = wrapper.find('.maintenance-section');
    expect(section.exists()).toBe(true);
    expect(section.get('.folder-label').text()).toBe('Maintenance');
    expect(section.findAll('.dir-header .label').map((l) => l.text())).toEqual(['htop']);
    expect(section.findAll('.maintenance-close')).toHaveLength(1);
  });

  it('survives the filter, which narrows sessions, not doors', () => {
    const wrapper = mountRows({
      maintenanceTools: [HTOP],
      filtering: true,
      filterQuery: 'zzz-nothing',
    });
    expect(wrapper.find('.maintenance-section').exists()).toBe(true);
  });

  it('opens the workspace with the tool’s tab selected, the folder rows’ own select', async () => {
    const wrapper = mountRows({ maintenanceTools: [HTOP] });
    await wrapper.get('.maintenance-section .dir-header').trigger('click');

    const events = wrapper.emitted<[SessionDirectory, string]>('select');
    expect(events).toHaveLength(1);
    expect(events![0]![0].key).toBe(MAINTENANCE_ROOT);
    expect(events![0]![1]).toBe('tool:aws:htop');
  });

  it('closes a tool from its row’s ×, naming the kind', async () => {
    const wrapper = mountRows({ maintenanceTools: [HTOP] });
    await wrapper.get('.maintenance-section .maintenance-close').trigger('click');

    const events = wrapper.emitted<[string]>('closeTool');
    expect(events).toHaveLength(1);
    expect(events![0]![0]).toBe('htop');
  });

  it('marks itself current while the maintenance workspace is open', () => {
    const wrapper = mountRows({ maintenanceTools: [HTOP], activeFolder: MAINTENANCE_ROOT });
    expect(wrapper.get('.maintenance-section .dir-header').classes()).toContain('current');

    const other = mountRows({ maintenanceTools: [HTOP], activeFolder: '~/git' });
    expect(other.find('.maintenance-section .dir-header').classes()).not.toContain('current');
  });

  it('takes no part in the host’s gestures: no drag, no row menu', async () => {
    const wrapper = mountRows({ maintenanceTools: [HTOP] });
    const row = wrapper.get('.maintenance-section .dir-header');

    expect(row.attributes('draggable')).toBeUndefined();
    await row.trigger('contextmenu');
    expect(wrapper.emitted('menu')).toBeUndefined();
  });
});
