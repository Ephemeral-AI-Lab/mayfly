/**
 * The model picker: one filterable, numbered list of the catalog's models, grouped by provider, in a borderless panel.
 * A row is the model and its context (a muted description column); the live row is green with a `✓`, and the cursor
 * opens on it. A model that exposes thinking levels carries them as a segment: the list shows the focused row's level
 * on one line under the rows (`● Thinking: high (default)`), where `←`/`→` change it, `Delete` returns it to the
 * provider's default, and `Enter` commits the model with the pinned level (none while unpinned). The picker has no
 * buttons. Every text is final (translated by the command that publishes the facts).
 *
 * @module components/model-picker
 */

import { ui, type MayflyListItem, type MayflySurfaceNode } from '@ephemeral-ai/mayfly-ui'

/** The thinking control of one row. */
export interface ModelPickerStrip {
  /** The levels the model exposes, in order. */
  readonly efforts: readonly string[]
  /** The provider's default level, when known: the strip's inherited option. */
  readonly inherited?: string | undefined
  /** The level pinned on this row, when the session pins one; unpinned rows leave it out. */
  readonly pinned?: string | undefined
}

/** One model of the catalog. */
export interface ModelPickerRow {
  readonly id: string
  /** `<provider>/<model>`. */
  readonly label: string
  /** The provider's display name: the group heading. */
  readonly group: string
  /** The context size, already formatted (`977k context`). */
  readonly detail?: string | undefined
  /** The live row: green with a `✓`. */
  readonly current?: boolean | undefined
  /** Absent for a model that exposes no thinking levels. */
  readonly strip?: ModelPickerStrip | undefined
}

/** The facts of one picker. */
export interface ModelPickerFacts {
  readonly title: string
  /** The muted description under the title. */
  readonly description: string
  /** The caption of the thinking strip (`Thinking`): it names `←`/`→` in the hint row. */
  readonly thinking: string
  readonly rows: readonly ModelPickerRow[]
  /** The live row's id: the cursor opens on it. */
  readonly live?: string | undefined
  /** The empty state's title (`No models advertised`). */
  readonly empty: string
}

/**
 * Format a context window in binary units.
 * @param tokens - the window in tokens.
 * @returns `512`, `1k`, `1.5k`, `977k`, `1m`.
 */
export function formatContextWindow(tokens: number): string {
  if (tokens < 1024) return `${tokens}`
  const units = ['k', 'm', 'g']
  let value = tokens
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  const text = Number.isInteger(value) || value >= 10 ? `${Math.round(value)}` : value.toFixed(1)
  return `${text}${units[unit]}`
}

function rowItem(row: ModelPickerRow, thinking: string): MayflyListItem {
  const { strip } = row
  const inherited = strip?.inherited !== undefined && strip.efforts.includes(strip.inherited) ? strip.inherited : undefined
  const pinned = strip?.pinned !== undefined && strip.efforts.includes(strip.pinned) ? strip.pinned : undefined
  return {
    id: row.id, label: row.label, group: row.group,
    ...(row.detail === undefined ? {} : { detail: row.detail }),
    ...(row.current === true ? { current: true } : {}),
    ...(strip === undefined ? {} : { segment: {
      label: thinking,
      options: strip.efforts.map(id => ({ id, label: id })),
      ...(pinned === undefined ? {} : { selectedId: pinned }),
      ...(inherited === undefined ? {} : { inheritedId: inherited }),
    } }),
  }
}

/**
 * The picker surface.
 * @param facts - the catalog rows and texts.
 * @returns the overlay surface around one browse list.
 */
export function ModelPicker(facts: ModelPickerFacts): MayflySurfaceNode {
  return ui.surface({
    chrome: 'overlay', title: facts.title, subtitle: facts.description,
    child: ui.list({
      id: 'selection', role: 'browse', acceptVerb: 'choose', numbered: 'focus', selectedIds: facts.live === undefined ? [] : [facts.live], filterable: true,
      items: facts.rows.map(row => rowItem(row, facts.thinking)),
      empty: ui.empty({ title: facts.empty }),
    }),
  })
}

/** The facts of the `/effort` panel. Every text is final (translated by the command that publishes the facts). */
export interface EffortPickerFacts {
  readonly title: string
  /** The muted description: the model and its provider default. */
  readonly description: string
  /** The levels the model exposes, in order. */
  readonly levels: readonly string[]
  /** The provider's default level, when known. */
  readonly inherited?: string | undefined
  /** The level the session pins; a level equal to the default is the same as none. */
  readonly pinned?: string | undefined
  readonly startCaption: string
  readonly endCaption: string
}

/**
 * The `/effort` panel: the thinking level of the current model as a slider, in a borderless panel. `Enter` answers
 * `slider-accept` with the pinned level (or none while the slider follows the provider default); `Esc` leaves the
 * session as it was. There are no buttons.
 * @param facts - the levels and texts.
 * @returns the overlay surface around one slider.
 */
export function EffortPicker(facts: EffortPickerFacts): MayflySurfaceNode {
  const known = (id: string | undefined): string | undefined => id !== undefined && facts.levels.includes(id) ? id : undefined
  const inherited = known(facts.inherited)
  const pinned = known(facts.pinned)
  return ui.surface({
    chrome: 'overlay', title: facts.title, subtitle: facts.description, escapeLabel: 'cancel',
    child: ui.stack.column([
      ui.spacer(),
      ui.slider({
        id: 'effort', autofocus: true,
        levels: facts.levels.map(id => ({ id, label: id })),
        ...(pinned === undefined || pinned === inherited ? {} : { selectedId: pinned }),
        ...(inherited === undefined ? {} : { inheritedId: inherited }),
        startCaption: facts.startCaption, endCaption: facts.endCaption,
      }),
      ui.spacer(),
    ]),
  })
}
