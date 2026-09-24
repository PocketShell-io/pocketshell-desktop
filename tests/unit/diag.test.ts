// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';

/**
 * The unhandled-error nets. Until this existed, a renderer error that escaped
 * its component vanished: the view died mid-render, the panel went blank, and
 * a packaged app — no console anywhere — gave the user nothing to report and
 * nothing to paste. These tests pin the two halves of the fix: every catch
 * lands in the desktop log via `api.diag.log`, and the strip the user sees is
 * bounded, de-duplicated and dismissible.
 */

/** The sink the mock routes through, so one test can make it fail. */
const logged: Array<{ kind: string; message: string; stack?: string }> = [];
let logImpl: (entry: { kind: string; message: string; stack?: string }) => void = (entry) => {
  logged.push(entry);
};

vi.mock('@ui/app/ipc', () => ({
  api: {
    diag: {
      log: (entry: { kind: string; message: string; stack?: string }): void => logImpl(entry),
    },
  },
}));

const { recordDiagError, diagErrors } = await import('@ui/app/diag');
const DiagBanner = (await import('@ui/app/components/DiagBanner.vue')).default;

beforeEach(() => {
  logged.length = 0;
  logImpl = (entry) => {
    logged.push(entry);
  };
  diagErrors.value = [];
});

describe('recordDiagError', () => {
  it('forwards to the desktop log and shows on the strip', () => {
    recordDiagError('render', new Error('Cannot read properties of undefined'));

    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      kind: 'render',
      message: 'Cannot read properties of undefined',
    });
    expect(diagErrors.value).toHaveLength(1);
  });

  it('accepts non-Error throwables (strings, rejections with a plain reason)', () => {
    recordDiagError('unhandledrejection', 'socket hung up');
    expect(diagErrors.value[0]!.message).toBe('socket hung up');
  });

  it('collapses a repeat of the same error instead of stacking copies', () => {
    // A poll or a repeated render can fire the same failure many times a
    // second; the strip is a report, not a counter.
    recordDiagError('render', new Error('boom'));
    recordDiagError('render', new Error('boom'));
    recordDiagError('render', new Error('boom'));

    expect(diagErrors.value).toHaveLength(1);
    // The log still carries every occurrence — the dedupe is a UI courtesy.
    expect(logged).toHaveLength(3);
  });

  it('a different error after a repeat starts a new row, and the list is capped', () => {
    for (let i = 0; i < 6; i += 1) recordDiagError('render', new Error(`boom ${i}`));

    expect(diagErrors.value).toHaveLength(4);
    expect(diagErrors.value.map((e) => e.message)).toEqual(['boom 2', 'boom 3', 'boom 4', 'boom 5']);
  });

  it('survives the log channel being dead — reporting must not throw', () => {
    logImpl = () => {
      throw new Error('channel gone');
    };

    expect(() => recordDiagError('render', new Error('the real error'))).not.toThrow();
    expect(diagErrors.value[0]!.message).toBe('the real error');
  });
});

describe('DiagBanner', () => {
  it('renders nothing while the nets are quiet', () => {
    const wrapper = mount(DiagBanner);
    expect(wrapper.find('.diag-strip').exists()).toBe(false);
  });

  it('shows the recorded error, dismissible, stack as the title', async () => {
    recordDiagError('render', new TypeError('Cannot read properties of undefined (reading x)'));
    const wrapper = mount(DiagBanner);

    const strip = wrapper.find('.diag-strip');
    expect(strip.exists()).toBe(true);
    expect(strip.text()).toContain('render');
    expect(strip.text()).toContain('Cannot read properties of undefined (reading x)');
    expect(wrapper.find('.row').attributes('title')).toContain('TypeError');

    await wrapper.find('.dismiss').trigger('click');
    expect(diagErrors.value).toHaveLength(0);
    expect(wrapper.find('.diag-strip').exists()).toBe(false);
  });

  it('one dismiss per row: other errors stay', async () => {
    recordDiagError('render', new Error('first'));
    recordDiagError('error', new Error('second'));
    const wrapper = mount(DiagBanner);

    await wrapper.findAll('.dismiss')[0]!.trigger('click');
    expect(diagErrors.value.map((e) => e.message)).toEqual(['second']);
  });
});
