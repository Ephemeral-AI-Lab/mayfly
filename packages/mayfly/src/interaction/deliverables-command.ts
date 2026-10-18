/** Explicit file actions over recorded native deliveries, per-turn workspace changes, and the selected filesystem.
 * @module @ephemeral-ai/mayfly/interaction/deliverables-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-workspace-changes/types'
import type {
  WorkspaceChangedFile,
  WorkspaceChanges,
  WorkspaceChangesSummary,
  WorkspaceDiffHunk,
  WorkspaceFileDiff,
} from '@deepseek-ai/dsh-workspace-changes/types'
import { browser, panel, ui, type MayflyField, type MayflyListCell, type MayflyListItem, type MayflyOverlayHandle, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type {} from '../conversation/deliverables.ts'
import { agentDirectory } from '../internal/session-directory.ts'
import { openAgentOverlay } from './agent-overlay.ts'
import { copyTextToClipboard } from './clipboard-write.ts'
import { interactionTranslator } from './locale.ts'

export const name = 'mayfly-deliverables-command'
export const inject = ['commands', 'sessionProjections', 'sessionController', 'mayflyCurrentAgent', 'mayflyOverlays']

/** One recorded `deliverables/presented` file, as the Mayfly projection carries it. */
interface DeliveredFile {
  readonly id: string
  readonly path: string
  readonly description?: string | undefined
}

/** The latest recorded `workspace/changes` turn and its native summary. */
interface LatestChanges {
  /** The announcing event's sequence, the summary's handle on the Host. */
  readonly seq: number
  /** The changed-file summary the Host still serves. */
  readonly summary: WorkspaceChangesSummary
}

/** A focused list row resolved to its native source. */
type FileRow =
  | { readonly kind: 'delivered', readonly file: DeliveredFile }
  | { readonly kind: 'changed', readonly latest: LatestChanges, readonly index: number, readonly file: WorkspaceChangedFile }

/** The loaded detail of one delivered file. */
interface DeliveredDetail {
  readonly kind: 'delivered'
  readonly loading?: boolean
  readonly target?: FsTarget
  readonly path?: string
  readonly displayPath?: string
  readonly fileType?: 'file' | 'directory' | 'other'
  readonly size?: number
  readonly error?: string
  readonly preview?: string
}

/** The loaded detail of one changed file. */
interface ChangedDetail {
  readonly kind: 'changed'
  readonly loading?: boolean
  readonly diff?: WorkspaceFileDiff
  readonly error?: string
}

type FileDetail = DeliveredDetail | ChangedDetail

/** The list id of one file in a turn summary; the seq keeps turns apart. */
function changedId(seq: number, index: number): string {
  return `changes:${String(seq)}:${String(index)}`
}

function rowId(row: FileRow): string {
  return row.kind === 'delivered' ? row.file.id : changedId(row.latest.seq, row.index)
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

/** Render a thrown value for a failed action. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function field(label: string, value: string, tone: 'default' | 'muted' | 'danger' = 'default'): MayflyField {
  return { label, value: [{ text: value, tone }] }
}

export function apply(ctx: Context): void {
  const t = interactionTranslator(ctx)
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  ctx.commands.register({ name: 'files', description: 'Browse files delivered by the agent', handler: async invocation => {
    const agent = invocation.agent
    if (ctx.mayflyCurrentAgent.current() !== agent) return { kind: 'error', text: 'No current Agent' }
    const files = (): readonly DeliveredFile[] => ctx.sessionProjections.snapshot(agent.session, ['mayflyDeliverables']).values.mayflyDeliverables ?? []
    /** The latest `workspace/changes` turn whose summary this Host still serves. */
    const latestChanges = (): LatestChanges | undefined => {
      const service = ctx.get('workspaceChanges') as WorkspaceChanges | undefined
      if (service === undefined) return undefined
      const event = agent.session.snapshotEvents().findLast(candidate => candidate.type === 'workspace/changes')
      if (event === undefined) return undefined
      const summary = service.summary(agent.session.id, event.seq)
      return summary === undefined ? undefined : { seq: event.seq, summary }
    }
    const items = (): readonly MayflyListItem[] => {
      const latest = latestChanges()
      return [
        ...files().map((file): MayflyListItem => ({
          id: file.id,
          label: file.path,
          group: 'Delivered',
          ...(file.description === undefined ? {} : { detail: file.description }),
        })),
        ...(latest === undefined ? [] : latest.summary.files.map((file, index): MayflyListItem => {
          const cells = changedCells(file)
          return {
            id: changedId(latest.seq, index),
            label: file.display,
            group: changesGroup(latest.summary),
            ...(cells === undefined ? { detail: changedFileDetail(file) } : { cells }),
          }
        })),
      ]
    }
    const rowOf = (id: string | undefined): FileRow | undefined => {
      if (id === undefined) return undefined
      const file = files().find(item => item.id === id)
      if (file !== undefined) return { kind: 'delivered', file }
      const latest = latestChanges()
      if (latest === undefined) return undefined
      const index = latest.summary.files.findIndex((_, at) => changedId(latest.seq, at) === id)
      const changed = index === -1 ? undefined : latest.summary.files[index]
      return changed === undefined ? undefined : { kind: 'changed', latest, index, file: changed }
    }
    const firstRow = (): FileRow | undefined => {
      const delivered = files()[0]
      if (delivered !== undefined) return { kind: 'delivered', file: delivered }
      const latest = latestChanges()
      const file = latest?.summary.files[0]
      return latest === undefined || file === undefined ? undefined : { kind: 'changed', latest, index: 0, file }
    }
    let handle: MayflyOverlayHandle | undefined
    let focusedId: string | undefined
    let detailMode = false
    let detail: FileDetail | undefined
    let loadAbort: AbortController | undefined
    let loadGeneration = 0
    const cancelLoad = (): void => {
      loadAbort?.abort()
      loadAbort = undefined
      loadGeneration += 1
    }
    const deliveredActions = (state: DeliveredDetail | undefined): MayflyUiNode => {
      const path = state?.path
      const canPreview = state?.fileType === 'file' && state.target !== undefined
      const canOpen = canPreview && ctx.sessionController.canOpenWorkspacePath()
      return ui.actions({ id: 'file-actions', items: [
        { id: 'copy', label: 'Copy path', hintLabel: 'copy path', semantic: 'copy' as const, hidden: true, disabled: path === undefined },
        ...(canOpen ? [{ id: 'open', label: 'Open', hintLabel: 'open', key: 'o', hidden: true }] : []),
        ...(canPreview ? [{ id: 'preview', label: 'Preview text', hintLabel: 'preview', key: 'p', hidden: true }] : []),
      ] })
    }
    const deliveredBody = (row: Extract<FileRow, { readonly kind: 'delivered' }>): MayflyUiNode => {
      const state = detail?.kind === 'delivered' ? detail : undefined
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
    const changedBody = (row: Extract<FileRow, { readonly kind: 'changed' }>): MayflyUiNode => {
      const state = detail?.kind === 'changed' ? detail : undefined
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
    const detailBody = (row: FileRow | undefined): MayflyUiNode => row === undefined
      ? ui.text(items().length === 0 ? t('No files') : t('Select a file to see its details'), { tone: 'muted' })
      : row.kind === 'delivered' ? deliveredBody(row) : changedBody(row)
    const view = (): MayflyUiNode => {
      const all = items()
      const row = rowOf(focusedId)
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
    const publish = (): void => {
      if (handle?.closed === false) handle.set(view())
    }
    const load = async (row: FileRow, generation: number, signal: AbortSignal): Promise<void> => {
      try {
        if (row.kind === 'delivered') {
          const fs = agent.ctx.fs
          const target = await fs.resolve(row.file.path, { cwd: agentDirectory(ctx, agent), signal })
          const stat = await fs.stat(target, signal)
          if (signal.aborted || generation !== loadGeneration || focusedId !== row.file.id || ctx.mayflyCurrentAgent.current() !== agent) return
          detail = {
            kind: 'delivered', target, path: fs.processPath(target), displayPath: target.displayPath,
            ...(stat === undefined ? {} : { fileType: stat.type, ...(stat.size === undefined ? {} : { size: stat.size }) }),
          }
        } else {
          const service = ctx.get('workspaceChanges') as WorkspaceChanges | undefined
          const diff = service === undefined ? undefined : await service.diff(agent.session.id, row.latest.seq, row.index, signal)
          if (signal.aborted || generation !== loadGeneration || focusedId !== rowId(row) || ctx.mayflyCurrentAgent.current() !== agent) return
          detail = diff === undefined ? { kind: 'changed' } : { kind: 'changed', diff }
        }
      } catch (error) {
        if (signal.aborted || generation !== loadGeneration || ctx.mayflyCurrentAgent.current() !== agent) return
        detail = row.kind === 'delivered' ? { kind: 'delivered', error: describe(error) } : { kind: 'changed', error: describe(error) }
      }
      publish()
    }
    const focus = (id: string | undefined): void => {
      if (id === focusedId && detail !== undefined) return
      cancelLoad()
      focusedId = id
      const row = rowOf(id)
      if (row === undefined) {
        detail = undefined
        publish()
        return
      }
      detail = row.kind === 'delivered' ? { kind: 'delivered', loading: true } : { kind: 'changed', loading: true }
      const generation = loadGeneration
      const controller = new AbortController()
      loadAbort = controller
      publish()
      void load(row, generation, AbortSignal.any([lifetime.signal, controller.signal]))
    }
    const refreshView = (): void => {
      const all = items()
      if (focusedId === undefined || !all.some(item => item.id === focusedId)) {
        const next = firstRow()
        focus(next === undefined ? undefined : rowId(next))
        return
      }
      publish()
    }
    const initial = firstRow()
    focusedId = initial === undefined ? undefined : rowId(initial)
    if (initial !== undefined) detail = initial.kind === 'delivered' ? { kind: 'delivered', loading: true } : { kind: 'changed', loading: true }
    handle = await openAgentOverlay(ctx, agent, { id: 'mayfly.files', title: 'Files', presentation: 'editor', capturing: true }, view(), owner => {
      owner.effect(() => ctx.sessionProjections.onChanged((session, key) => { if (session === agent.session && key === 'mayflyDeliverables') refreshView() }))
      // A new turn's changed-file summary is announced by a log-only event,
      // not a projection key: reread the Host service when it lands.
      owner.effect(() => owner.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'workspace/changes') refreshView()
      }))
      return async (event, context) => {
        if (event.kind === 'dismiss') {
          if (detailMode) {
            detailMode = false
            publish()
            return { kind: 'completed', dismiss: false }
          }
          return { kind: 'completed' }
        }
        if (event.kind === 'selection-accept') {
          if (event.controlId !== 'files' && event.controlId !== 'files-narrow') return { kind: 'completed' }
          const id = event.selectedIds[0]
          if (id === undefined) return { kind: 'cancelled' }
          focus(id)
          if (event.controlId === 'files-narrow') detailMode = true
          publish()
          return { kind: 'completed' }
        }
        if (event.kind !== 'activate') return { kind: 'completed' }
        const state = detail?.kind === 'delivered' ? detail : undefined
        if (event.actionId === 'copy') {
          if (state?.path === undefined) return { kind: 'failed', message: 'File unavailable' }
          await copyTextToClipboard(state.path)
          return { kind: 'completed', feedback: { severity: 'success', message: 'Path copied' } }
        }
        if (event.actionId === 'open') {
          if (state?.path === undefined) return { kind: 'failed', message: 'File unavailable' }
          await ctx.sessionController.openWorkspacePath({ path: state.path }, context.signal)
          return { kind: 'completed', feedback: { severity: 'info', message: 'Open request handed to the host application' } }
        }
        if (event.actionId !== 'preview') return { kind: 'completed' }
        if (state?.preview !== undefined) {
          const { preview: _preview, ...rest } = state
          detail = rest
          publish()
          return { kind: 'completed' }
        }
        if (state?.target === undefined) return { kind: 'failed', message: 'File unavailable' }
        const bytes = await agent.ctx.fs.readBytes(state.target, context.signal, 256 * 1024)
        if (context.signal.aborted) return { kind: 'cancelled' }
        const text = bytes.includes(0) ? 'Binary file; use Open in an external application.' : new TextDecoder().decode(bytes)
        detail = { ...state, preview: text }
        publish()
        return { kind: 'completed' }
      }
    }, { signal: lifetime.signal, reopen: 'focus' })
    if (handle === undefined) return { kind: 'success' }
    if (initial !== undefined) {
      const controller = new AbortController()
      loadAbort = controller
      void load(initial, loadGeneration, AbortSignal.any([lifetime.signal, controller.signal]))
    }
    return { kind: 'success' }
  } })
}
