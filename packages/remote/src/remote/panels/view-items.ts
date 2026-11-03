/**
 * Current Mayfly summary and expanded-view builders for Remote-owned panes.
 * @module @ephemeral-ai/mayfly/remote/panels/view-items
 */

import { ui, type MayflyInlineSpan, type MayflyListItem, type MayflyStatusNode, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** Fixed row count of an expanded status view. */
export const REMOTE_VIEW_PANEL_ROWS = 7

/** Build one compact mark/label/progress summary. */
export function remoteItemSummary(mark: MayflyInlineSpan, label: string, done: number, total: number): MayflyStatusNode {
  return remoteSummary(mark, label, `${String(done)}/${String(total)}`)
}

/** Build one compact mark/label/count summary. */
export function remoteCountSummary(mark: MayflyInlineSpan, label: string, count: number): MayflyStatusNode {
  return remoteSummary(mark, label, String(count))
}

function remoteSummary(mark: MayflyInlineSpan, label: string, progress: string): MayflyStatusNode {
  return ui.richText([mark, { text: ' ' }, { text: `${label} `, tone: 'muted' }, { text: progress }])
}

/** Build the shared selectable list view with stable padding and hidden actions. */
export function remoteViewList(id: string, items: readonly MayflyListItem[], actions: MayflyUiNode): MayflyUiNode {
  const padding = Array.from({ length: Math.max(0, REMOTE_VIEW_PANEL_ROWS - items.length) }, (_, index): MayflyListItem => ({
    id: `${id}-pad-${String(index)}`,
    label: '',
    gap: true,
  }))
  return ui.stack.column([
    ui.list({ id, role: 'browse', items: [...items, ...padding], maxRows: REMOTE_VIEW_PANEL_ROWS, acceptVerb: 'open', autofocus: true }),
    actions,
  ])
}
