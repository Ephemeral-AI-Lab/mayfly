/**
 * What every item of the status row shares (todo, goal, and the jobs and agents that follow): a compact summary of a
 * mark, one muted label, and its progress (`● todo 2/12`), an expanded panel of one fixed length that scrolls when its content is
 * longer, and the `viewHistory` setting that decides whether finished items are listed beside the live ones. The panel
 * names no extra key: the lane's own keys (`↑/↓` to scroll, `←/→` between items, `Esc` back) are all it uses.
 *
 * @module @ephemeral-ai/mayfly/transcript/view-items
 */

import type { Context } from '@deepseek-ai/cordis'
import { ui, type MayflyInlineSpan, type MayflyListItem, type MayflyStatusNode, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** The rows of every expanded panel; a longer panel scrolls and counts the rows below. */
export const VIEW_PANEL_ROWS = 7

/**
 * The compact summary of an item: its mark, its muted label, and how far it is over how many: `● todo 2/12`. The time
 * is the panel's, never the row's. Cut to the room it is given by the row.
 * @param mark - the small mark at the left.
 * @param label - the translated label (`todo`).
 * @param done - how many are finished (a goal's rounds started).
 * @param total - how many there are (the goal's round cap).
 * @returns the status node.
 */
export function itemSummary(mark: MayflyInlineSpan, label: string, done: number, total: number): MayflyStatusNode {
  return summaryNode(mark, label, `${String(done)}/${String(total)}`)
}

/**
 * The compact summary of an item that has a count and no total (jobs): `● jobs 2`.
 * @param mark - the small mark at the left.
 * @param label - the translated label (`jobs`).
 * @param count - how many are live.
 * @returns the status node.
 */
export function countSummary(mark: MayflyInlineSpan, label: string, count: number): MayflyStatusNode {
  return summaryNode(mark, label, String(count))
}

function summaryNode(mark: MayflyInlineSpan, label: string, progress: string): MayflyStatusNode {
  return ui.richText([mark, { text: ' ' }, { text: `${label} `, tone: 'muted' }, { text: progress }])
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
 * The expanded panel of an item whose rows can be chosen (agents, jobs): the rows in a list of {@link VIEW_PANEL_ROWS}
 * that holds a cursor (`↑/↓` select, `Enter` opens) and counts the rows above and below, with the item's keys beside it.
 * It is the one place a panel is not a plain scroll, since a row has to be chosen. A shorter list is padded with blank
 * rows to the panel's length, so the hint row sits at the bottom as it does under a scroll.
 * @param id - the list's id.
 * @param items - the rows.
 * @param actions - the item's keys (a hidden `actions` node), which may act on the selected row.
 * @returns the panel node.
 */
export function viewList(id: string, items: readonly MayflyListItem[], actions: MayflyUiNode): MayflyUiNode {
  const padding = Array.from({ length: Math.max(0, VIEW_PANEL_ROWS - items.length) }, (_, index): MayflyListItem => ({ id: `${id}-pad-${String(index)}`, label: '', gap: true }))
  return ui.stack.column([ui.list({ id, role: 'browse', items: [...items, ...padding], maxRows: VIEW_PANEL_ROWS, acceptVerb: 'open', autofocus: true }), actions])
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
