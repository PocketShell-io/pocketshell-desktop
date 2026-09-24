// @vitest-environment jsdom
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import AppIcon from '@ui/components/AppIcon.vue';
import ComposerControls from '@ui/components/ComposerControls.vue';

const UI_SOURCE = resolve(__dirname, '..', '..', '..', 'pocketshell-core', 'packages', 'ui', 'src');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? sourceFiles(full) : [full];
  });
}

describe('shared UI component contracts', () => {
  it('renders accessible AppIcon SVGs with inherited colour and the requested size', () => {
    const wrapper = mount(AppIcon, {
      props: { name: 'alert-triangle', size: 14, title: 'Warning' },
    });

    expect(wrapper.get('svg').attributes()).toMatchObject({
      width: '14',
      height: '14',
      stroke: 'currentColor',
      role: 'img',
    });
    expect(wrapper.get('title').text()).toBe('Warning');
  });

  it('exposes composer actions only through props and emitted intent events', async () => {
    const wrapper = mount(ComposerControls, {
      props: {
        uploadingCount: 0,
        agentKind: 'agent',
        canSend: true,
        sendInFlight: false,
        draftLength: 1,
        attachmentCount: 0,
        discardArmed: false,
      },
    });

    await wrapper.get('button[aria-label="Attach to prompt"]').trigger('click');
    await wrapper.get('button[aria-label="Draw or annotate an image"]').trigger('click');
    await wrapper.get('button[aria-label="Slash commands"]').trigger('click');
    await wrapper.get('button.discard').trigger('click');
    await wrapper.get('button.send').trigger('click');

    expect(wrapper.emitted('attach')).toEqual([[]]);
    expect(wrapper.emitted('doodle')).toEqual([[]]);
    expect(wrapper.emitted('slash')).toEqual([[]]);
    expect(wrapper.emitted('discardClick')).toEqual([[]]);
    expect(wrapper.emitted('send')).toEqual([[]]);
  });

  it('has no runtime or type imports from Electron, Node or the window bridge', () => {
    // The app tree (src/app) is the platform-agnostic workspace UI: its stores
    // use pinia, and it reaches the host only through the @ui/app/ipc seam —
    // never `window.api` directly. The primitives beside it stay store-free.
    // Electron and Node stay banned everywhere: nothing in this package may
    // know which platform hosts it.
    const forbiddenEverywhere =
      /(?:from\s*|import\s*\()\s*['"](?:electron(?:\/[^'"]*)?|node:[^'"]*|fs|net)['"]|window\.api|process\.env/u;
    const piniaOutsideApp = /(?:from\s*|import\s*\()\s*['"]pinia['"]/u;
    const offenders = sourceFiles(UI_SOURCE)
      .filter((file) => /\.(?:ts|vue)$/.test(file))
      .flatMap((file) => {
        const rel = file.slice(UI_SOURCE.length + 1);
        const text = readFileSync(file, 'utf8');
        const hits: string[] = [];
        if (forbiddenEverywhere.test(text)) hits.push(`${rel}: electron/node/window bridge`);
        if (!rel.startsWith('app/') && piniaOutsideApp.test(text)) hits.push(`${rel}: pinia outside the app tree`);
        return hits;
      });

    expect(offenders).toEqual([]);
  });
});
