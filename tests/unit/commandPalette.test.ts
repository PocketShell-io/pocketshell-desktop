// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import CommandPalette from '@ui/app/components/CommandPalette.vue';
import type { PaletteCommand } from '@ui/app/commandPalette';

/**
 * The quick-actions palette's surface, against the REAL component (it
 * teleports to `<body>`, so every query below reads the document, not the
 * wrapper). What is pinned here is the contract the host workspace builds on:
 * everything shows until a query lands, the filter is a substring across
 * label, hint and keywords, the keyboard never needs the mouse, and a run
 * closes the palette BEFORE doing the thing.
 */

const commands: PaletteCommand[] = [
  { id: 'folder:a', label: 'Open alpha', hint: '~/git', keywords: 'alpha extra words', run: vi.fn() },
  { id: 'folder:b', label: 'Open beta', hint: '~/tmp', run: vi.fn() },
  { id: 'act:settings', label: 'Settings', run: vi.fn() },
];

let wrapper: VueWrapper | null = null;

function inputEl(): HTMLInputElement {
  return document.querySelector('.palette-input') as HTMLInputElement;
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll('.palette-item'));
}

function active(): Element | null {
  return document.querySelector('.palette-item.active');
}

/** Type into the palette's input the way a keystroke would land. */
async function type(text: string): Promise<void> {
  inputEl().value = text;
  inputEl().dispatchEvent(new Event('input'));
  await flushPromises();
}

beforeEach(async () => {
  vi.clearAllMocks();
  wrapper = mount(CommandPalette, {
    props: { commands, label: 'Quick actions' },
    attachTo: document.body,
  });
  await flushPromises();
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('the quick-actions palette', () => {
  it('shows every command until a query lands, builder order first', () => {
    expect(rows().map((r) => r.textContent)).toEqual([
      'Open alpha~/git',
      'Open beta~/tmp',
      'Settings',
    ]);
    expect(active()?.textContent).toContain('Open alpha');
  });

  it('filters across label, hint and keywords, case-insensitively', async () => {
    // A hint match: nothing in the label says `tmp`.
    await type('TMP');
    expect(rows().map((r) => r.textContent)).toEqual(['Open beta~/tmp']);

    // A keywords match that is never rendered.
    await type('extra');
    expect(rows().map((r) => r.textContent)).toEqual(['Open alpha~/git']);

    await type('zzz');
    expect(document.querySelector('.palette-empty')?.textContent).toContain('no matching');
  });

  it('the selection returns to the top when the filter moves', async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    await flushPromises();
    expect(active()?.textContent).toContain('Open beta');

    await type('set');
    expect(active()?.textContent).toContain('Settings');
  });

  it('the arrows move the selection and Enter runs it, closing first', async () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    await flushPromises();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    await flushPromises();
    expect(active()?.textContent).toContain('Settings');

    inputEl().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await flushPromises();

    expect(commands[2]!.run).toHaveBeenCalledOnce();
    expect(wrapper!.emitted('close')).toHaveLength(1);
  });

  it('Escape closes without running anything', () => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(wrapper!.emitted('close')).toHaveLength(1);
    expect(commands[0]!.run).not.toHaveBeenCalled();
  });

  it('a press outside closes it', () => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(wrapper!.emitted('close')).toHaveLength(1);
  });

  it('a click runs the pressed row and closes', async () => {
    rows()[2]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flushPromises();
    expect(commands[2]!.run).toHaveBeenCalledOnce();
    expect(wrapper!.emitted('close')).toHaveLength(1);
  });
});
