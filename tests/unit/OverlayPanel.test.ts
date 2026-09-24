// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, nextTick, onMounted, ref } from 'vue';

import OverlayPanel from '@ui/app/components/OverlayPanel.vue';

/**
 * OverlayPanel's focus contract — the minimal one, deliberately not a trap.
 *
 * Before this existed, opening any modal (Ports, Usage, Settings, New session,
 * Stop confirm) left keyboard focus on the trigger button BEHIND the scrim, so
 * Tab walked the obscured background and closing restored nothing. The
 * contract now is: take focus into the panel on open, hand it back on close,
 * and — the subtle half — never steal it from a dialog that focuses a field of
 * its own as it mounts. Slot children mount before the panel's own hook runs,
 * which is the ordering these tests pin down.
 *
 * Everything mounts with `attachTo`, because focus is a DOCUMENT property:
 * a detached wrapper can call `focus()` all it likes and `activeElement`
 * never moves.
 */

/**
 * Mirrors the app's real autofocus pattern: dialogs focus a field via a
 * function ref or a mounted hook (see SettingsView's `bindCaptureEl`), not the
 * `autofocus` ATTRIBUTE — which browsers only honour at page load and jsdom
 * does not honour at all. Calling `focus()` on insert is both what the app
 * does and what jsdom faithfully models, so the non-stealing property below is
 * exercised on the mechanism that actually exists.
 */
const AutoFocusField = defineComponent({
  setup() {
    const el = ref<HTMLInputElement | null>(null);
    onMounted(() => el.value?.focus());
    return { el };
  },
  template: '<input ref="el" aria-label="field" />',
});

let trigger: HTMLButtonElement;
let wrapper: VueWrapper | null = null;

beforeEach(() => {
  // The button the user "clicked" to open the panel, focused the way a real
  // click or Enter press leaves it.
  trigger = document.createElement('button');
  trigger.textContent = 'open';
  document.body.appendChild(trigger);
  trigger.focus();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
});

function show(slots?: Record<string, unknown>): VueWrapper {
  wrapper = mount(OverlayPanel, {
    props: { title: 'Test panel' },
    slots,
    attachTo: document.body,
  });
  return wrapper;
}

describe('OverlayPanel focus', () => {
  it('moves focus into the panel on open', () => {
    expect(document.activeElement).toBe(trigger);
    const w = show();
    const panel = w.get('.overlay-panel').element;
    // `tabindex="-1"` is what makes a plain div focusable at all —
    // programmatically, without joining the Tab order.
    expect(panel.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(panel);
  });

  it('hands focus back to the opener on close', () => {
    const w = show();
    expect(document.activeElement).not.toBe(trigger);
    w.unmount();
    wrapper = null;
    expect(document.activeElement).toBe(trigger);
  });

  it('does not steal focus from a child that focuses its own field', () => {
    const w = show({ default: AutoFocusField });
    const input = w.get('input[aria-label="field"]').element;
    // The child mounted (and focused) first; the panel saw focus already
    // inside itself and left it alone.
    expect(document.activeElement).toBe(input);
  });

  it('still restores the opener after a child held focus', () => {
    const w = show({ default: AutoFocusField });
    w.unmount();
    wrapper = null;
    expect(document.activeElement).toBe(trigger);
  });

  it('closes without error when the opener is gone by then', () => {
    const w = show();
    // The trigger can genuinely vanish while the panel is up — a session row
    // that removed itself, a re-render that replaced the button.
    trigger.remove();
    expect(() => {
      w.unmount();
    }).not.toThrow();
    wrapper = null;
    // Nothing to restore to; focus falls back to the document body.
    expect(document.activeElement).toBe(document.body);
  });

  it('keeps emitting close on Escape once focus is inside the panel', async () => {
    const w = show();
    document.activeElement?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    await nextTick();
    expect(w.emitted('close')).toHaveLength(1);
  });
});
