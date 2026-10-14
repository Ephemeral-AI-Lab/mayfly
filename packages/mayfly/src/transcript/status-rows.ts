/** The two status rows as one wire node for the footer node slot.
 * @module @ephemeral-ai/mayfly/transcript/status-rows
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyStackNode, MayflyStatusEntry, MayflyStatusNode, MayflyUiChild, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { textOf, ui } from '@ephemeral-ai/mayfly-ui'

/** What the footer shows besides the registered entries. */
export interface StatusFooterState {
  /** The entry id of the item whose view is entered (its panel is painted under the footer), if one is. */
  readonly active?: string | undefined
}

/** How many cells row 2 is divided into: an item takes one fifth of the width however many items there are. */
export const ROW_2_CELLS = 5

/** One entry as an admission child of row 1: the registration's priority, band, and overflow. */
function childOf(entry: MayflyStatusEntry): MayflyUiChild {
  const { definition } = entry
  return ui.child(entry.node!, {
    id: entry.id,
    priority: definition.priority ?? 0,
    band: definition.band ?? 'left',
    ...(definition.overflow === undefined ? {} : { overflow: definition.overflow }),
  })
}

/** One entry as a cell of row 2: a fifth of the row, cut with `…` where it does not fit. */
function cellOf(entry: MayflyStatusEntry): MayflyUiChild {
  const node = entry.node!
  return ui.child(node.kind === 'text' || node.kind === 'rich-text' ? { ...node, overflow: 'truncate' } : node, { id: entry.id })
}

/** The words of a status node, for the width of what is drawn under them. */
function wordsOf(node: MayflyStatusNode): string {
  if (node.kind === 'text') return textOf(node.content)
  if (node.kind === 'rich-text') return node.spans.map(span => span.text).join('')
  return ''
}

/**
 * The row that marks the entered item: the same cells as row 2, with a heavy line under the words of the active one
 * and nothing under the rest.
 */
function underlineRow(entries: readonly MayflyStatusEntry[], active: string, measure: (text: string) => number): MayflyStackNode {
  return ui.stack.row(entries.map(entry => ui.child(
    entry.id === active ? ui.text('━'.repeat(Math.max(1, measure(wordsOf(entry.node!)))), { tone: 'muted' }) : ui.text(' '),
    { id: `${entry.id}/underline` },
  )), { gap: 2, cells: ROW_2_CELLS })
}

/**
 * The footer: row 1 (facts) and, only when it has an entry, row 2 (views). Row 1 is an admission row, so a registry
 * entry and a plugin entry are admitted by one rule; row 2 gives each item a fifth of its width, in priority order. An
 * empty row 2 is not in the node, which makes the footer one line by default. While a view is entered row 2 stays as
 * it is, a heavy line under the words of that item marks it, and its panel is painted under the footer.
 * @param entries - the registry's entries followed by the lane's summaries, in admission order.
 * @param state - what the lane adds.
 * @param measure - the visible width of a text, in cells.
 * @returns the node, or `null` when no entry has anything to show.
 */
export function buildStatusFooter(entries: readonly MayflyStatusEntry[], state: StatusFooterState, measure: (text: string) => number): MayflyUiNode | null {
  const shown = entries.filter(entry => entry.node !== null)
    .toSorted((left, right) => (left.definition.priority ?? 0) - (right.definition.priority ?? 0) || left.id.localeCompare(right.id))
  const rowOf = (entry: MayflyStatusEntry): 1 | 2 => entry.definition.row === 2 ? 2 : 1
  const row1 = shown.filter(entry => rowOf(entry) === 1).map(childOf)
  const row2Entries = shown.filter(entry => rowOf(entry) === 2)
  const marked = state.active !== undefined && row2Entries.some(entry => entry.id === state.active)
  const rows = [
    ui.stack.row(row1),
    ui.stack.row(row2Entries.map(cellOf), { gap: 2, cells: ROW_2_CELLS }),
    ...marked ? [underlineRow(row2Entries, state.active!, measure)] : [],
  ].filter(row => row.children.length > 0)
  if (rows.length === 0) return null
  return ui.surface({ chrome: 'none', padding: 1, child: ui.stack.column(rows) })
}

/** What the footer owner asks of the screen: the node slot and the lane's read-only window. */
type StatusFooterScreen = Pick<Context['mayflyScreen'], 'mountNodeSlot' | 'views'>

/**
 * Lease the footer node slot and keep it showing the two status rows: it publishes again when a registry entry, a lane
 * summary, or the entered state changes, and not when the node would be the same. The lease and the listeners are
 * released with the Fiber.
 * @param ctx - the plugin context; needs `mayflyStatus`.
 * @param screen - the screen that holds the footer slot and the views lane.
 */
export function mountStatusFooter(ctx: Context, screen: StatusFooterScreen): void {
  const slot = screen.mountNodeSlot('status.footer', { region: 'footer' })
  const { views } = screen
  let published = ''
  const refresh = (): void => {
    const entries = [...ctx.mayflyStatus.list(), ...views.statusEntries()]
    const state: StatusFooterState = { active: views.isEntered && views.active !== undefined ? `views/${views.active}` : undefined }
    const key = `${state.active ?? ''}|${entries.map(entry => `${entry.id}:${String(entry.revision)}`).join(',')}`
    if (key === published) return
    published = key
    slot.set(buildStatusFooter(entries, state, text => ctx.mayflyComponents.visibleWidth(text)))
  }
  ctx.effect(() => {
    const offStatus = ctx.mayflyStatus.subscribe(refresh)
    const offViews = views.subscribe(refresh)
    refresh()
    return () => {
      offStatus()
      offViews()
      slot.dispose()
    }
  })
}
