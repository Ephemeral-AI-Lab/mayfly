/**
 * What every item of the status row shares (todo, goal, and the jobs and agents that follow): a compact summary of a
 * mark, one muted label, and its progress and time (`● todo 2/12 4m 12s`), an expanded panel of one fixed length that scrolls when its content is
 * longer, and the `viewHistory` setting that decides whether finished items are listed beside the live ones. The panel
 * names no extra key: the lane's own keys (`↑/↓` to scroll, `←/→` between items, `Esc` back) are all it uses.
 *
 * @module @ephemeral-ai/mayfly/transcript/view-items
 */

import type { Context } from '@deepseek-ai/cordis'
import { ui, type MayflyInlineSpan, type MayflyRichTextNode, type MayflyStatusNode, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { compactElapsedMs } from './agent-presentation.ts'
import { SHED, shedNode } from './status-shed.ts'

/** The rows of every expanded panel; a longer panel scrolls and counts the rows below. */
export const VIEW_PANEL_ROWS = 7

/**
 * The compact summary of an item: its mark, its muted label, how far it is over how many, and its time: `● todo 2/12 4m 12s`.
 * The time is the first thing the status row gives up when it is crowded (`SHED.time`), so the narrower form is
 * `● todo 2/12`. Cut to the room it is given by the row.
 * @param mark - the small mark at the left.
 * @param label - the translated label (`todo`).
 * @param done - how many are finished (a goal's rounds started).
 * @param total - how many there are (the goal's round cap).
 * @param elapsedMs - the time the item has been tracked.
 * @returns the status node.
 */
export function itemSummary(mark: MayflyInlineSpan, label: string, done: number, total: number, elapsedMs: number): MayflyStatusNode {
  const words = (time: boolean): MayflyRichTextNode => ui.richText([
    mark, { text: ' ' }, { text: `${label} `, tone: 'muted' }, { text: `${String(done)}/${String(total)}` },
    ...time ? [{ text: ` ${compactElapsedMs(Math.max(0, elapsedMs))}`, tone: 'muted' as const }] : [],
  ])
  return shedNode(words(true), [{ rank: SHED.time, node: words(false) }])
}

/**
 * The expanded panel: the rows in a viewport of {@link VIEW_PANEL_ROWS} that scrolls vertically past it, and the item's
 * buttons under it when it has any. The scroll lets the panel take focus; it cannot be expanded, it draws a scrollbar
 * only when its rows pass the length, and its last row counts the rows still below.
 * @param id - the scroll's id.
 * @param rows - the panel's rows.
 * @param actions - the item's buttons (an `actions` node), drawn under the scroll.
 * @returns the panel node.
 */
export function viewPanel(id: string, rows: readonly MayflyUiNode[], actions?: MayflyUiNode): MayflyUiNode {
  const scroll = ui.scroll(ui.stack.column(rows), { id, height: VIEW_PANEL_ROWS, expandable: false, more: true, scrollbar: rows.length > VIEW_PANEL_ROWS })
  return actions === undefined ? scroll : ui.stack.column([scroll, actions])
}

/**
 * Follow the `viewHistory` setting.
 * @param ctx - plugin context; needs `mayflyInteractionState` once it is up.
 * @param onChange - called after the setting changed.
 * @returns `history`, which reads the current value.
 */
export function followViewHistory(ctx: Context, onChange: () => void): { readonly history: () => boolean } {
  const read = (): boolean => ctx.get('mayflyInteractionState')?.settingsSource()?.viewHistory === true
  let current = read()
  ctx.effect(() => ctx.on('settings/document-updated', (namespace) => {
    if (String(namespace) !== 'mayfly') return
    const next = read()
    if (next === current) return
    current = next
    onChange()
  }))
  return { history: () => current }
}
