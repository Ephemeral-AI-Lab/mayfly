import { ui, type MayflyInlineSpan, type MayflyStatusNode, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** The rows of every expanded panel; a longer panel scrolls and counts the rows below. */
const VIEW_PANEL_ROWS = 7

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

