/**
 * The completion palette for the standalone editor: the editor's `/`, `@`, and
 * `#` list painted as plain rows directly above its frame.
 *
 * `@ephemeral-ai/mayfly/core` keeps the list as state only — its
 * `CompletionList.render` returns no rows on purpose, so opening the palette
 * never reflows the editor or the conversation, and the host is expected to
 * draw it as an overlay. The published core does not export that painter, so
 * this frontend owns the drawing: the same non-capturing, bottom-anchored
 * overlay the in-process TUI mounts, reading `editor.completion()`.
 * @module @ephemeral-ai/mayfly/remote/completion-drawer
 */

import type { MayflyComponent, MayflyEditor, MayflyScreenService, MayflySemanticColors } from '@ephemeral-ai/mayfly/core'

/** The most rows the palette shows; the rest scroll behind the focused one. */
const DRAWER_ROWS = 6
/** Cells before the arrow, in line with the prompt symbol of the frame (`│ > `). */
const ARROW_COLUMN = 2
/** The widest name column; a longer name is cut with an ellipsis. */
const MAX_NAME_COLUMN = 24
/** The least room the detail keeps before the row's end. */
const MIN_DETAIL_COLUMNS = 8

type Measure = {
  readonly visibleWidth: (text: string) => number
  readonly truncateToWidth: (text: string, width: number) => string
}

interface DrawerRow {
  readonly name: string
  readonly detail?: string
  readonly focused: boolean
}

/** Cut text to `columns`, marking the cut with an ellipsis. */
function fit(measure: Measure, text: string, columns: number): string {
  if (columns <= 0) return ''
  return measure.visibleWidth(text) <= columns ? text : measure.truncateToWidth(text, columns)
}

/** The first row of the window: the focused row stays inside it, centred when the list is longer. */
function windowStart(count: number, index: number, rows: number): number {
  return Math.max(0, Math.min(index - Math.floor(rows / 2), count - rows))
}

/** Paint the palette rows: an arrow on the focused row, names, then the detail. */
function paintRows(rows: readonly DrawerRow[], width: number, measure: Measure, colors: MayflySemanticColors): string[] {
  const nameColumn = Math.min(
    MAX_NAME_COLUMN,
    Math.max(...rows.map(row => measure.visibleWidth(row.name)), 1),
  )
  return rows.map((row) => {
    const arrow = row.focused ? '›' : ' '
    const lead = ' '.repeat(ARROW_COLUMN) + arrow + ' '
    const name = fit(measure, row.name, nameColumn).padEnd(nameColumn)
    const room = width - ARROW_COLUMN - 2 - nameColumn - 2
    const detail = row.detail === undefined || room < MIN_DETAIL_COLUMNS
      ? ''
      : fit(measure, row.detail, room)
    const plain = `${lead}${name}${detail === '' ? '' : `  ${detail}`}`
    const padded = plain + ' '.repeat(Math.max(0, width - measure.visibleWidth(plain)))
    return row.focused
      ? colors.selectedBg(padded)
      : padded
  })
}

/** One overlay component whose rows follow the editor's open completion list. */
class RemoteCompletionDrawer implements MayflyComponent {
  constructor(
    private readonly editor: MayflyEditor,
    private readonly measure: Measure,
    private readonly colors: MayflySemanticColors,
  ) {}

  /** Whether the palette shows: a list with at least one item is open. */
  get open(): boolean {
    return this.rowCount() > 0
  }

  /** The rows the palette shows now; the overlay's bottom offset reads it. */
  get rows(): number {
    return this.rowCount()
  }

  render(width: number): string[] {
    const view = this.editor.completion()
    if (view === undefined || view.items.length === 0) return []
    const count = Math.min(DRAWER_ROWS, view.items.length)
    const start = windowStart(view.items.length, view.index, count)
    const rows = view.items.slice(start, start + count).map((item, offset): DrawerRow => ({
      name: item.value,
      ...item.detail === undefined ? {} : { detail: item.detail },
      focused: start + offset === view.index,
    }))
    return paintRows(rows, Math.max(1, width), this.measure, this.colors)
  }

  invalidate(): void {}

  private rowCount(): number {
    const view = this.editor.completion()
    return view === undefined || view.items.length === 0 ? 0 : Math.min(DRAWER_ROWS, view.items.length)
  }
}

/**
 * Mount the completion palette over the editor.
 * @param screen - owner of the overlay layer and the editor's row offset.
 * @param editor - the exact editor whose list is drawn.
 * @param colors - the palette.
 * @param measure - visible width and truncation.
 * @returns the handle that removes the overlay.
 */
export function mountRemoteCompletionDrawer(
  screen: MayflyScreenService,
  editor: MayflyEditor,
  colors: MayflySemanticColors,
  measure: Measure,
): { dispose(): void } {
  // A headless screen (the one the frontend specs mount) has no overlay layer;
  // the palette then simply does not exist rather than failing the whole boot.
  if (typeof (screen as { showOverlay?: unknown }).showOverlay !== 'function') {
    return { dispose() {} }
  }
  const drawer = new RemoteCompletionDrawer(editor, measure, colors)
  const handle = screen.showOverlay(drawer, {
    anchor: 'bottom-left',
    nonCapturing: true,
    get width() { return Math.max(1, screen.columns) },
    get offsetY() { return -screen.editorRowsFromBottom },
    visible: () => drawer.open,
  })
  return { dispose() { handle.hide() } }
}
