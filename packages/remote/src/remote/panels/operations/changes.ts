/**
 * Per-turn workspace change summary, selected-file diff, and deliverables rows.
 * @module @ephemeral-ai/mayfly/remote/panels/operations/changes
 */

import type {
  MayflyWorkspaceChangesSummary as ClientChangesSummary,
  MayflyWorkspaceFileDiff as ClientFileDiff,
} from '../../../frontend/host-contract.ts'
import { browser, panel, ui, type MayflyListItem, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** File list control id shared by the changes browser pages. */
export const REMOTE_CHANGES_LIST_ID = 'changes-files'
/** Refresh action id for the summary read. */
export const REMOTE_CHANGES_REFRESH_ID = 'changes-refresh'

/** Summary value of one turn; `null` means the Host recorded no changes. */
export type RemoteChangesSummary = ClientChangesSummary
/** Diff value of one listed file; `null` means the comparison is unavailable. */
export type RemoteChangesFileDiff = ClientFileDiff

/** Deliverables projection facts; absent while the Host face has not published the key. */
export interface RemoteChangesDeliverables {
  readonly available: boolean
  readonly paths: readonly string[]
}

/** Changes browser state: the turn cut, summary, focused file, diff, and deliverables. */
export interface RemoteChangesState {
  readonly seq: number | undefined
  readonly summary: RemoteChangesSummary | undefined
  readonly selectedIndex: number | undefined
  readonly diff: RemoteChangesFileDiff | null | undefined
  readonly diffError: string | undefined
  readonly deliverables: RemoteChangesDeliverables
  readonly error: string | undefined
}

function fileItem(summary: RemoteChangesSummary, index: number): MayflyListItem {
  const file = summary.files[index]
  if (file === undefined) return { id: String(index), label: '', searchText: '' }
  const flagged = file.binary === true || file.oversized === true
  const counts = flagged ? '' : `+${String(file.added)} -${String(file.deleted)}`
  const flag = file.binary === true ? ' [binary]' : file.oversized === true ? ' [oversized]' : ''
  return {
    id: String(index),
    label: file.display,
    cells: [
      { spans: [{ text: `${counts}${flag}`, tone: flagged ? 'warning' : 'default' }], align: 'right', min: 10, shed: 1 },
    ],
    searchText: file.display,
  }
}

function diffNode(diff: RemoteChangesFileDiff | null | undefined, error: string | undefined, t: MayflyTranslate): MayflyUiNode {
  if (error !== undefined) return ui.text(error, { tone: 'danger', overflow: 'wrap' })
  if (diff === undefined) return ui.text(t('Select a file to compare its turn-start and turn-end contents'), { tone: 'muted' })
  if (diff === null) return ui.text(t('No comparison is available for this file'), { tone: 'muted' })
  if (diff.kind !== 'text') {
    return ui.fields([
      { label: t('File'), value: [{ text: diff.display }] },
      { label: t('Kind'), value: [{ text: diff.kind === 'binary' ? t('binary file; no lines are served') : t('oversized file; listed without comparison'), tone: 'warning' }] },
    ])
  }
  const sections = diff.hunks.map(hunk => [
    `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`,
    ...hunk.lines,
  ].join('\n'))
  return ui.stack.column([
    ui.fields([
      { label: t('File'), value: [{ text: diff.display }] },
      { label: t('Turn start'), value: [{ text: diff.before ? t('present') : t('absent'), tone: diff.before ? 'default' as const : 'warning' as const }] },
      { label: t('Turn end'), value: [{ text: diff.after ? t('present') : t('absent'), tone: diff.after ? 'default' as const : 'warning' as const }] },
      ...diff.coarse ? [{ label: t('Comparison'), value: [{ text: t('timed out; every line is shown as replaced'), tone: 'warning' as const }] }] : [],
    ]),
    ...sections.length === 0 ? [ui.text(t('No content differences'), { tone: 'muted' })] : sections.map(section => ui.code(section, { language: 'diff', label: true })),
  ])
}

function deliverablesNode(deliverables: RemoteChangesDeliverables, t: MayflyTranslate): MayflyUiNode {
  if (!deliverables.available) return ui.text(t('deliverables projection unavailable'), { tone: 'muted' })
  if (deliverables.paths.length === 0) return ui.text(t('No delivered files recorded yet'), { tone: 'muted' })
  return ui.stack.column(deliverables.paths.map(path => ui.richText([{ text: '❑ ', tone: 'success' }, { text: path }])))
}

/** Build the workspace changes browser with the deliverables tail. */
export function remoteChangesPanel(state: RemoteChangesState, t: MayflyTranslate): MayflyUiNode {
  const files = state.summary?.files ?? []
  const list = (id: string): MayflyUiNode => ui.list({
    id,
    role: 'browse',
    selectedIds: state.selectedIndex === undefined ? [] : [String(state.selectedIndex)],
    items: files.map((_, index) => fileItem(state.summary!, index)),
    empty: ui.empty({ title: state.error ?? t('No changed files recorded for this turn') }),
  })
  const head = state.summary === undefined
    ? ui.text(state.error ?? t('No changed files recorded for this turn'), { tone: state.error === undefined ? 'muted' : 'danger', overflow: 'wrap' })
    : ui.fields([
      { label: t('Turn'), value: [{ text: String(state.summary.turn) }] },
      { label: t('Files'), value: [{ text: `${String(state.summary.files.length)}/${String(state.summary.total)}` }] },
      { label: t('Lines'), value: [{ text: `+${String(state.summary.added)} -${String(state.summary.deleted)}`, tone: 'success' }] },
    ])
  return panel({
    title: t('Workspace changes'),
    escapeLabel: 'close',
    body: ui.stack.column([
      head,
      browser({
        list: list(REMOTE_CHANGES_LIST_ID),
        listNarrow: list('changes-files-narrow'),
        detail: diffNode(state.summary === undefined ? undefined : state.selectedIndex === undefined ? undefined : state.diff, state.diffError, t),
        narrow: 'list',
      }),
      ui.divider({ label: t('Deliverables') }),
      deliverablesNode(state.deliverables, t),
      ui.actions({ id: 'changes-actions', items: [{ id: REMOTE_CHANGES_REFRESH_ID, label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true }] }),
    ]),
  })
}
