/**
 * Panel for `/files`: the session's recorded deliverables as a read-only list
 * over the shared panel chrome.
 * @module @ephemeral-ai/mayfly/remote/panels/operations/files
 */

import { panel, ui, type MayflyListItem, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** Stable control and action ids for the deliverables browser. */
export const REMOTE_FILES_LIST_ID = 'files-list'
export const REMOTE_FILES_REFRESH_ID = 'files-refresh'

/** One delivered file as this frontend renders it. */
export interface RemoteFilesRow {
  /** Projection row id; unique per session event and index. */
  readonly id: string
  /** The delivered path, exactly as the Host recorded it. */
  readonly path: string
  /** The agent's note about the file, when the delivery carried one. */
  readonly description: string | undefined
}

/** Deliverables browser state; `available` is false until the Host publishes the projection. */
export interface RemoteFilesState {
  readonly available: boolean
  readonly rows: readonly RemoteFilesRow[]
}

function fileItems(rows: readonly RemoteFilesRow[]): readonly MayflyListItem[] {
  return rows.map((row): MayflyListItem => {
    const description = row.description
    return {
      id: row.id,
      label: row.path,
      ...(description === undefined ? {} : {
        cells: [{ spans: [{ text: description, tone: 'muted' as const }], align: 'right' as const, min: 1, shed: 3 }],
      }),
      searchText: description === undefined ? row.path : `${row.path} ${description}`,
    }
  })
}

/** Build the read-only deliverables browser. */
export function remoteFilesNode(state: RemoteFilesState, t: MayflyTranslate): MayflyUiNode {
  return panel({
    title: t('Delivered files'),
    escapeLabel: 'close',
    body: ui.stack.column([
      ui.list({
        id: REMOTE_FILES_LIST_ID,
        role: 'browse',
        selectedIds: [],
        filterable: true,
        filterMode: 'slash',
        items: fileItems(state.rows),
        empty: ui.empty({
          title: state.available
            ? t('No files were delivered in this session yet')
            : t('This session does not expose the deliverables projection'),
        }),
      }),
      ui.text(t('Only files the agent recorded as delivered are listed; no path is read from disk.'), { tone: 'muted', overflow: 'wrap' }),
      ui.actions({ id: 'files-actions', items: [{ id: REMOTE_FILES_REFRESH_ID, label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
    ]),
  })
}
