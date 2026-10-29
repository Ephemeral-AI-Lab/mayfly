/**
 * Pure Remote model and reasoning-effort picker surfaces migrated from the
 * legacy component without importing its private interaction controllers.
 * @module @ephemeral-ai/mayfly/remote/features/ui/model-picker
 */

import { panel, ui, type MayflyListItem, type MayflySurfaceNode } from '@ephemeral-ai/mayfly-ui'

/** Thinking segment metadata for one model row. */
export interface RemoteModelPickerStrip {
  readonly efforts: readonly string[]
  readonly inherited?: string
  readonly pinned?: string
}

/** One model picker row. */
export interface RemoteModelPickerRow {
  readonly id: string
  readonly label: string
  readonly group: string
  readonly detail?: string
  readonly current?: boolean
  readonly strip?: RemoteModelPickerStrip
}

/** Complete model picker presentation. */
export interface RemoteModelPickerFacts {
  readonly title: string
  readonly description: string
  readonly thinking: string
  readonly rows: readonly RemoteModelPickerRow[]
  readonly live?: string
  readonly empty: string
}

/** Format a context window in binary units. */
export function formatRemotePickerContextWindow(tokens: number): string {
  if (tokens < 1024) return `${tokens}`
  const units = ['k', 'm', 'g']
  let value = tokens
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1 }
  const text = Number.isInteger(value) || value >= 10 ? `${Math.round(value)}` : value.toFixed(1)
  return `${text}${units[unit]}`
}

function rowItem(row: RemoteModelPickerRow, thinking: string): MayflyListItem {
  const inherited = row.strip?.inherited !== undefined && row.strip.efforts.includes(row.strip.inherited) ? row.strip.inherited : undefined
  const pinned = row.strip?.pinned !== undefined && row.strip.efforts.includes(row.strip.pinned) ? row.strip.pinned : undefined
  return {
    id: row.id,
    label: row.label,
    group: row.group,
    ...row.detail === undefined ? {} : { detail: row.detail },
    ...row.current === true ? { current: true } : {},
    ...row.strip === undefined ? {} : { segment: {
      label: thinking,
      options: row.strip.efforts.map(id => ({ id, label: id })),
      ...pinned === undefined ? {} : { selectedId: pinned },
      ...inherited === undefined ? {} : { inheritedId: inherited },
    } },
  }
}

/** Pure model picker node. */
export function RemoteModelPicker(facts: RemoteModelPickerFacts): MayflySurfaceNode {
  return panel({
    title: facts.title,
    subtitle: facts.description,
    escapeLabel: 'close',
    body: ui.list({
      id: 'selection',
      role: 'browse',
      acceptVerb: 'choose',
      numbered: 'focus',
      selectedIds: facts.live === undefined ? [] : [facts.live],
      filterable: true,
      items: facts.rows.map(row => rowItem(row, facts.thinking)),
      empty: ui.empty({ title: facts.empty }),
    }),
  })
}

/** Reasoning-effort slider presentation. */
export interface RemoteEffortPickerFacts {
  readonly title: string
  readonly description: string
  readonly levels: readonly string[]
  readonly inherited?: string
  readonly pinned?: string
  readonly startCaption: string
  readonly endCaption: string
}

/** Pure reasoning-effort picker node. */
export function RemoteEffortPicker(facts: RemoteEffortPickerFacts): MayflySurfaceNode {
  const known = (id: string | undefined): string | undefined => id !== undefined && facts.levels.includes(id) ? id : undefined
  const inherited = known(facts.inherited)
  const pinned = known(facts.pinned)
  return panel({
    title: facts.title,
    subtitle: facts.description,
    escapeLabel: 'cancel',
    body: ui.stack.column([
      ui.spacer(),
      ui.slider({
        id: 'effort',
        autofocus: true,
        levels: facts.levels.map(id => ({ id, label: id })),
        ...pinned === undefined || pinned === inherited ? {} : { selectedId: pinned },
        ...inherited === undefined ? {} : { inheritedId: inherited },
        startCaption: facts.startCaption,
        endCaption: facts.endCaption,
      }),
      ui.spacer(),
    ]),
  })
}
