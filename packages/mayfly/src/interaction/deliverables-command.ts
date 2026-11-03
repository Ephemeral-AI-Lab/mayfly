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
  WorkspaceFileDiff,
} from '@deepseek-ai/dsh-workspace-changes/types'
import type { MayflyOverlayHandle, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { FilesBrowser, filesBrowserRow, filesRowId, type FilesBrowserFacts } from './files-browser-model.ts'
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

/** Render a thrown value for a failed action. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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
    const rowOf = (id: string | undefined): FileRow | undefined => filesBrowserRow(facts(), id)
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
    const facts = (): FilesBrowserFacts => {
      let renderedDetail: FilesBrowserFacts['detail'] = detail
      if (detail?.kind === 'delivered') {
        const { target, ...metadata } = detail
        renderedDetail = { ...metadata, previewable: target !== undefined }
      }
      return {
        files: files(), latest: latestChanges(), focusedId, detailMode, detail: renderedDetail,
        canOpen: ctx.sessionController.canOpenWorkspacePath(),
      }
    }
    const view = (): MayflyUiNode => FilesBrowser(facts(), t)
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
          if (signal.aborted || generation !== loadGeneration || focusedId !== filesRowId(row) || ctx.mayflyCurrentAgent.current() !== agent) return
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
      if (rowOf(focusedId) === undefined) {
        const next = firstRow()
        focus(next === undefined ? undefined : filesRowId(next))
        return
      }
      publish()
    }
    const initial = firstRow()
    focusedId = initial === undefined ? undefined : filesRowId(initial)
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
