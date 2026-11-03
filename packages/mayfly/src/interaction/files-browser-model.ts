/** Frozen rc.2 Files browser over readonly delivery and native change facts. @module */
import type { WorkspaceChangedFile, WorkspaceChangesSummary, WorkspaceDiffHunk, WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import { browser, panel, ui, type MayflyField, type MayflyListCell, type MayflyListItem, type MayflyTranslate, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

/** One recorded file delivery. */
export interface FilesDeliveredFile {
  readonly id: string
  readonly path: string
  readonly description?: string | undefined
}

/** Native summary addressed by its announcing event. */
export interface FilesLatestChanges {
  readonly seq: number
  readonly summary: WorkspaceChangesSummary
}

/** One resolved browser row. */
export type FilesRow =
  | { readonly kind: 'delivered', readonly file: FilesDeliveredFile }
  | { readonly kind: 'changed', readonly latest: FilesLatestChanges, readonly index: number, readonly file: WorkspaceChangedFile }

/** Filesystem metadata without a retained native filesystem target. */
export interface FilesDeliveredDetail {
  readonly kind: 'delivered'
  readonly loading?: boolean
  readonly path?: string
  readonly displayPath?: string
  readonly fileType?: 'file' | 'directory' | 'other'
  readonly size?: number
  readonly error?: string
  readonly preview?: string
  readonly previewable?: boolean
}

/** One native comparison, or its pending/error state. */
export interface FilesChangedDetail {
  readonly kind: 'changed'
  readonly loading?: boolean
  readonly diff?: WorkspaceFileDiff
  readonly error?: string
}

/** Renderer-neutral browser state, owned by each independent controller. */
export interface FilesBrowserFacts {
  readonly files: readonly FilesDeliveredFile[]
  readonly latest?: FilesLatestChanges | undefined
  readonly focusedId?: string | undefined
  readonly detailMode: boolean
  readonly detail?: FilesDeliveredDetail | FilesChangedDetail | undefined
  readonly canOpen: boolean
}

/** The list id of one file in a turn summary; the seq keeps turns apart. */
export function filesChangedId(seq: number, index: number): string {
  return `changes:${String(seq)}:${String(index)}`
}

export function filesRowId(row: FilesRow): string {
  return row.kind === 'delivered' ? row.file.id : filesChangedId(row.latest.seq, row.index)
}

/**
 * Describe one changed file for its list row: line counts, or why no counts
 * exist.
 * @param file - the changed file.
 * @returns the detail text.
 */
function changedFileDetail(file: WorkspaceChangedFile): string {
  if (file.binary === true) return 'binary'
  if (file.oversized === true) return 'oversized'
  const parts: string[] = []
  if (file.added > 0) parts.push(`+${String(file.added)}`)
  if (file.deleted > 0) parts.push(`-${String(file.deleted)}`)
  return parts.length === 0 ? 'changed' : parts.join(' ')
}

/** Aligned count columns for a changed file; a binary or oversized file keeps one note cell. */
function changedCells(file: WorkspaceChangedFile): readonly MayflyListCell[] | undefined {
  if (file.binary === true) return [{ spans: [{ text: 'binary', tone: 'muted' }], align: 'right' }]
  if (file.oversized === true) return [{ spans: [{ text: 'oversized', tone: 'muted' }], align: 'right' }]
  const cells: MayflyListCell[] = []
  if (file.added > 0) cells.push({ spans: [{ text: `+${String(file.added)}`, tone: 'success' }], align: 'right', min: 2, shed: 2 })
  if (file.deleted > 0) cells.push({ spans: [{ text: `-${String(file.deleted)}`, tone: 'danger' }], align: 'right', min: 2, shed: 1 })
  return cells.length === 0 ? undefined : cells
}

/**
 * The group heading for one turn's changed files, with the turn's totals.
 * @param summary - the native summary.
 * @returns the heading text.
 */
function changesGroup(summary: WorkspaceChangesSummary): string {
  const parts = [`Changed · turn ${String(summary.turn)}`]
  if (summary.added > 0) parts.push(`+${String(summary.added)}`)
  if (summary.deleted > 0) parts.push(`-${String(summary.deleted)}`)
  if (summary.total > summary.files.length) parts.push(`${String(summary.files.length)} of ${String(summary.total)} files`)
  return parts.join(' · ')
}

/** One hunk's prior and updated sides, in the form `ui.diff` aligns. */
function hunkSides(hunk: WorkspaceDiffHunk): { readonly before: string, readonly after: string } {
  const before: string[] = []
  const after: string[] = []
  for (const line of hunk.lines) {
    const sign = line[0]
    const text = line.slice(1)
    if (sign !== '+') before.push(text)
    if (sign !== '-') after.push(text)
  }
  return { before: before.join('\n'), after: after.join('\n') }
}

/**
 * Render one file comparison as shared `ui.diff` nodes, one per native hunk.
 * @param diff - the native comparison, or `undefined` when the Host no longer has it.
 * @returns the comparison body.
 */
function diffContent(diff: WorkspaceFileDiff | undefined): MayflyUiNode {
  if (diff === undefined) return ui.text('No comparison is available for this turn.', { tone: 'muted' })
  if (diff.kind === 'binary') return ui.text('Binary file; no text comparison.', { tone: 'muted' })
  if (diff.kind === 'oversized') return ui.text('File too large to compare.', { tone: 'muted' })
  const nodes: MayflyUiNode[] = []
  if (diff.coarse) nodes.push(ui.text('Large change; showing whole-file replacement.', { tone: 'warning' }))
  if (diff.hunks.length === 0) nodes.push(ui.text('No line changes.', { tone: 'muted' }))
  const numberWidth = diff.hunks.reduce((width, hunk) => Math.max(width, String(hunk.oldStart + hunk.oldLines - 1).length, String(hunk.newStart + hunk.newLines - 1).length), 1)
  for (const hunk of diff.hunks) {
    const sides = hunkSides(hunk)
    nodes.push(ui.diff(sides.before, sides.after, { start: hunk.newStart, beforeStart: hunk.oldStart, hunkHeader: true, context: 3, numberWidth }))
  }
  return ui.stack.column(nodes)
}

function field(label: string, value: string, tone: 'default' | 'muted' | 'danger' = 'default'): MayflyField {
  return { label, value: [{ text: value, tone }] }
}

export function filesBrowserItems(facts: FilesBrowserFacts): readonly MayflyListItem[] {
  const latest = facts.latest
  return [
    ...facts.files.map((file): MayflyListItem => ({
      id: file.id,
      label: file.path,
      group: 'Delivered',
      ...(file.description === undefined ? {} : { detail: file.description }),
    })),
    ...(latest === undefined ? [] : latest.summary.files.map((file, index): MayflyListItem => {
      const cells = changedCells(file)
      return {
        id: filesChangedId(latest.seq, index),
        label: file.display,
        group: changesGroup(latest.summary),
        ...(cells === undefined ? { detail: changedFileDetail(file) } : { cells }),
      }
    })),
  ]
}
/** Resolve one current readonly row by its stable browser id. */
export function filesBrowserRow(facts: FilesBrowserFacts, id: string | undefined): FilesRow | undefined {
  if (id === undefined) return undefined
  const file = facts.files.find(item => item.id === id)
  if (file !== undefined) return { kind: 'delivered', file }
  const latest = facts.latest
  if (latest === undefined) return undefined
  const index = latest.summary.files.findIndex((_, at) => filesChangedId(latest.seq, at) === id)
  const changed = index === -1 ? undefined : latest.summary.files[index]
  return changed === undefined ? undefined : { kind: 'changed', latest, index, file: changed }
}
/** Build the exact responsive rc.2 Files panel from one facts snapshot. */
export function FilesBrowser(facts: FilesBrowserFacts, t: MayflyTranslate): MayflyUiNode {
  const deliveredActions = (state: FilesDeliveredDetail | undefined): MayflyUiNode => {
    const path = state?.path
    const canPreview = state?.fileType === 'file' && state.previewable === true
    const canOpen = canPreview && facts.canOpen
    return ui.actions({ id: 'file-actions', items: [
      { id: 'copy', label: 'Copy path', hintLabel: 'copy path', semantic: 'copy' as const, hidden: true, disabled: path === undefined },
      ...(canOpen ? [{ id: 'open', label: 'Open', hintLabel: 'open', key: 'o', hidden: true }] : []),
      ...(canPreview ? [{ id: 'preview', label: 'Preview text', hintLabel: 'preview', key: 'p', hidden: true }] : []),
    ] })
  }
  const deliveredBody = (row: Extract<FilesRow, { readonly kind: 'delivered' }>): MayflyUiNode => {
    const state = facts.detail?.kind === 'delivered' ? facts.detail : undefined
    if (state?.loading === true) return ui.stack.column([ui.loader({ message: t('Loading file…') }), deliveredActions(state)])
    if (state?.preview !== undefined) return ui.stack.column([
      ui.child(ui.scroll(ui.text(state.preview), { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 }),
      deliveredActions(state),
    ])
    const fields = [
      field(t('Name'), row.file.path),
      ...(row.file.description === undefined ? [] : [field(t('Description'), row.file.description)]),
      ...(state?.displayPath === undefined ? [] : [field(t('Path'), state.displayPath)]),
      field(t('Type'), state?.fileType ?? (state?.error === undefined ? t('unknown') : t('File unavailable'))),
      field(t('Size'), state?.size === undefined ? t('unknown') : `${String(state.size)} ${t('bytes')}`),
      ...(state?.error === undefined ? [] : [field(t('Status'), state.error, 'danger' as const)]),
    ]
    return ui.stack.column([ui.fields(fields), deliveredActions(state)])
  }
  const changedBody = (row: Extract<FilesRow, { readonly kind: 'changed' }>): MayflyUiNode => {
    const state = facts.detail?.kind === 'changed' ? facts.detail : undefined
    const fields = [
      field(t('Name'), row.file.display),
      field(t('Turn'), String(row.latest.summary.turn)),
      field(t('Change'), changedFileDetail(row.file)),
    ]
    const body = state === undefined || state.loading === true
      ? ui.loader({ message: t('Loading comparison…') })
      : state.error === undefined ? diffContent(state.diff) : ui.text(state.error, { tone: 'danger' })
    return ui.stack.column([
      ui.fields(fields),
      ui.child(ui.scroll(body, { scrollbar: true }), { basis: 0, grow: 1, minSize: 1 }),
    ])
  }
  const detailBody = (row: FilesRow | undefined): MayflyUiNode => row === undefined
    ? ui.text(filesBrowserItems(facts).length === 0 ? t('No files') : t('Select a file to see its details'), { tone: 'muted' })
    : row.kind === 'delivered' ? deliveredBody(row) : changedBody(row)
  const all = filesBrowserItems(facts)
  const row = filesBrowserRow(facts, facts.focusedId)
  const focusedId = facts.focusedId
  const detailMode = facts.detailMode
  const label = all.find(item => item.id === focusedId)?.label
  const detailOpen = detailMode && row !== undefined
  const list = (id: string) => ui.list({ id, role: 'browse' as const, filterable: true, filterMode: 'slash' as const, groupGap: true, marker: 'selection' as const, acceptVerb: 'open' as const, selectedIds: [], items: all, empty: ui.empty({ title: t('No files') }) })
  return panel({
    title: detailOpen && label !== undefined ? label : 'Files',
    escapeLabel: detailOpen ? 'back' : 'close',
    body: browser({
      list: list('files'),
      listNarrow: list('files-narrow'),
      detail: detailBody(row),
      narrow: detailOpen ? 'detail' : 'list',
    }),
  })
}
