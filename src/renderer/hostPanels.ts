/**
 * The host-scoped overlay destinations, named once.
 *
 * Ports, Usage and Settings are reachable from two surfaces that must never
 * disagree — the session panel's header and the collapsed rail — and their
 * open/closed state lives in a third place, `HostWorkspaceView`'s `panel` ref.
 * Three files, one vocabulary.
 *
 * How they are reached changed by direct order: the overflow
 * menu (components/HostActionsMenu.vue) is gone, and each of Ports and Usage
 * is its own icon button in both surfaces. That overturns ca79ae2's "unlabelled
 * glyphs are a memory test" ruling at the user's say-so; the words did not
 * vanish, they moved onto each button's `title`/accessible name. The two
 * buttons come from one component, components/HostPanelButtons.vue, so the
 * surfaces cannot drift the way a menu trigger and its list could not.
 *
 * It is a plain module rather than a type exported from the `.vue` file for a
 * practical reason as well as a tidy one: `env.d.ts` declares every `*.vue` as
 * `DefineComponent<…, any>`, so a named type exported from a component is
 * invisible to the type-aware lint rules and collapses to `any` at the import
 * site. A `.ts` module is seen by everything.
 *
 * NOTE for whoever adds the next host overlay: an entry here needs a GLYPH,
 * because there is no menu row left to hide behind — and the header strip this
 * renders into was already re-floored once (200 → 232px) to fit seven controls. A fourth button means moving the floor again or
 * displacing a control; check the arithmetic in SessionTree's template before
 * adding the row. Both surfaces pick new items up for free.
 */

export type HostPanel = 'ports' | 'usage' | 'settings';

export interface HostPanelItem {
  /** Settings is NOT an item: the gear predates and outlives this list. */
  panel: Exclude<HostPanel, 'settings'>;
  /** The full phrase — the button's tooltip and its whole accessible name. */
  label: string;
  /**
   * An `AppIconName`, spelled here rather than imported from AppIcon.vue for
   * the env.d.ts reason above. The glue in HostPanelButtons.vue hands it back
   * to `<AppIcon :name>`, whose prop is the real union — so a typo here fails
   * the build there, and this declaration cannot drift from the registry.
   */
  icon: 'arrow-right-left' | 'bar-chart-2';
}

/** The two overlay buttons, in strip order. */
export const HOST_PANEL_ITEMS: readonly HostPanelItem[] = [
  { panel: 'ports', label: 'Port forwarding', icon: 'arrow-right-left' },
  { panel: 'usage', label: 'Provider usage', icon: 'bar-chart-2' },
];
