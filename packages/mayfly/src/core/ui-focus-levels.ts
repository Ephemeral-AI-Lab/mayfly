/**
 * Focus levels and the `←` ladder (spec 4.5): where a `←` that no control used goes, where `Esc` returns focus to, and
 * whether a control has anything left to do with `←`. The compiler owns focus itself; these are the pure decisions it
 * asks of the control list, so each rule reads on its own.
 *
 * @module @ephemeral-ai/mayfly/core/ui-focus-levels
 */

/** How a tab control's strip is drawn and worded, recorded when the compiler walks the controls. */
export interface TabsTraits {
  /** Drawn as a vertical rail in this viewport (not folded into the strip below 60 columns). */
  readonly rail: boolean
  readonly wizard: boolean
  readonly count: number
  /** The word the hint row uses for the tab switch. */
  readonly hintLabel?: string
}

/** The part of a focus-order control these rules read. */
export interface LevelControl {
  readonly group: string
  readonly tabs?: TabsTraits
}

/**
 * The group of the surface's rail that a `←` no control used moves focus to, wherever the rail sits in the focus order:
 * the nearest rail before the focused control, else the first. There is none while the focused control is on a rail
 * (`←` leaves nothing further to leave) or when the surface has no rail.
 * @param controls - the controls in focus order.
 * @param activeIndex - the index of the focused control.
 * @returns the rail's group id, or undefined.
 */
export function railGroupFor(controls: readonly LevelControl[], activeIndex: number): string | undefined {
  const active = controls[activeIndex]
  if (active === undefined || active.tabs?.rail === true) return undefined
  const rails: { readonly group: string, readonly index: number }[] = []
  for (const [index, control] of controls.entries()) if (control.tabs?.rail === true && !rails.some(rail => rail.group === control.group)) rails.push({ group: control.group, index })
  return (rails.filter(rail => rail.index < activeIndex).at(-1) ?? rails[0])?.group
}

/**
 * Whether `←` would change a stepped control (a select, a segment strip, a number): it does while there is an enabled
 * option before the current one, or none is current yet (the strip then starts from the edge the arrow points into).
 * @param enabled - the ids of the options that can be chosen, in order.
 * @param current - the current option's id, if any.
 */
export function canStepLeft(enabled: readonly string[], current: string | null | undefined): boolean {
  return enabled.length > 0 && enabled.indexOf(current as string) !== 0
}
