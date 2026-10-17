/** Explicit file actions over recorded native deliveries, per-turn workspace changes, and the selected filesystem.
 * @module @ephemeral-ai/mayfly/interaction/deliverables-command
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-workspace-changes/types'
import type {
  WorkspaceChangedFile,
  WorkspaceChanges,
  WorkspaceChangesSummary,
  WorkspaceFileDiff,
} from '@deepseek-ai/dsh-workspace-changes/types'
import { ui, type MayflyListItem, type MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
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

/** The list id of one file in a turn summary; the seq keeps turns apart. */
function changedId(seq: number, index: number): string {
  return `changes:${String(seq)}:${String(index)}`
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

/**
 * Render one file comparison as the scrollable diff body.
 * @param diff - the native comparison, or `undefined` when the Host no longer has it.
 * @returns the text body.
 */
function formatWorkspaceDiff(diff: WorkspaceFileDiff | undefined): string {
  if (diff === undefined) return 'No comparison is available for this turn.'
  if (diff.kind === 'binary') return 'Binary file; no text comparison.'
  if (diff.kind === 'oversized') return 'File too large to compare.'
  const lines: string[] = []
  if (diff.coarse) lines.push('Large change; showing whole-file replacement.', '')
  if (diff.hunks.length === 0) lines.push('No line changes.')
  for (const hunk of diff.hunks) {
    lines.push(
      `@@ -${String(hunk.oldStart)},${String(hunk.oldLines)} +${String(hunk.newStart)},${String(hunk.newLines)} @@`,
      ...hunk.lines,
    )
  }
  return lines.join('\n')
}

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
    const items = (): MayflyListItem[] => {
      const latest = latestChanges()
      return [
        ...files().map((file): MayflyListItem => ({
          id: file.id,
          label: file.path,
          group: 'Delivered',
          ...(file.description === undefined ? {} : { detail: file.description }),
        })),
        ...(latest === undefined ? [] : latest.summary.files.map((file, index): MayflyListItem => ({
          id: changedId(latest.seq, index),
          label: file.display,
          group: changesGroup(latest.summary),
          detail: changedFileDetail(file),
        }))),
      ]
    }
    const node = () => ui.surface({ title: 'Files', chrome: 'overlay', child: ui.stack.column([
      ui.list({ id: 'files', role: 'browse', filterable: true, filterMode: 'slash', groupGap: true, selectedIds: [], items: items(), empty: ui.empty({ title: 'No files' }) }),
    ]) })
    /** Open one changed file's native comparison. */
    const openChange = async (owner: Context, latest: LatestChanges, index: number, file: WorkspaceChangedFile, signal: AbortSignal) => {
      const service = ctx.get('workspaceChanges') as WorkspaceChanges | undefined
      if (service === undefined) return { kind: 'completed' as const }
      let diff: WorkspaceFileDiff | undefined
      try {
        diff = await service.diff(agent.session.id, latest.seq, index, signal)
      } catch (error) {
        return { kind: 'failed' as const, message: describe(error) }
      }
      if (signal.aborted || ctx.mayflyCurrentAgent.current() !== agent) return { kind: 'cancelled' as const }
      await openAgentOverlay(owner, agent, { id: 'mayfly.files.changes', title: file.display, presentation: 'editor', capturing: true }, ui.surface({ title: file.display, chrome: 'overlay', child: ui.stack.column([
        ui.scroll(ui.text(formatWorkspaceDiff(diff)), { scrollbar: true }),
      ]) }), () => () => ({ kind: 'completed' }), { signal: lifetime.signal, reopen: 'replace' })
      return { kind: 'completed' as const }
    }
    let handle: MayflyOverlayHandle | undefined
    handle = await openAgentOverlay(ctx, agent, { id: 'mayfly.files', title: 'Files', presentation: 'editor', capturing: true }, node(), owner => {
      owner.effect(() => ctx.sessionProjections.onChanged((session, key) => { if (session === agent.session && key === 'mayflyDeliverables') handle?.set(node()) }))
      // A new turn's changed-file summary is announced by a log-only event,
      // not a projection key: reread the Host service when it lands.
      owner.effect(() => owner.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'workspace/changes') handle?.set(node())
      }))
      return async (event, context) => {
        if (event.kind !== 'selection-accept') return { kind: 'completed' }
        const selectedId = event.selectedIds[0]
        if (selectedId === undefined) return { kind: 'cancelled' }
        const latest = latestChanges()
        if (latest !== undefined) {
          const index = latest.summary.files.findIndex((_, at) => changedId(latest.seq, at) === selectedId)
          const file = index === -1 ? undefined : latest.summary.files[index]
          if (file !== undefined) return openChange(owner, latest, index, file, context.signal)
        }
        const file = files().find(file => file.id === selectedId)
        if (file === undefined) return { kind: 'cancelled' }
        const fs = agent.ctx.fs
        // A current operation resolves from the native current directory, not the original project header.
        const target = await fs.resolve(file.path, { cwd: agentDirectory(ctx, agent), signal: context.signal })
        const stat = await fs.stat(target, context.signal)
        if (context.signal.aborted || ctx.mayflyCurrentAgent.current() !== agent) return { kind: 'cancelled' }
        const path = fs.processPath(target)
        await openAgentOverlay(owner, agent, { id: 'mayfly.files.detail', title: file.path, presentation: 'editor', capturing: true }, ui.surface({ title: file.path, chrome: 'overlay', child: ui.stack.column([
          ui.text(`${file.description ?? ''}\n${target.displayPath}\n${stat === undefined ? t('File unavailable') : `${stat.type} · ${stat.size ?? t('unknown')} ${t('bytes')}`}`),
          ui.actions({ id: 'file-actions', items: [
            { id: 'copy', label: 'Copy path', hintLabel: 'copy path', semantic: 'copy' as const, hidden: true },
            ...(stat?.type === 'file' ? [{ id: 'preview', label: 'Preview text', hintLabel: 'preview', key: 'p', hidden: true }, ...(ctx.sessionController.canOpenWorkspacePath() ? [{ id: 'open', label: 'Open', hintLabel: 'open', key: 'o', hidden: true }] : [])] : []),
          ] }),
        ]) }), scope => async (action, operation) => {
          if (action.kind !== 'activate') return { kind: 'completed' }
          if (action.actionId === 'copy') { await copyTextToClipboard(path)
          return { kind: 'completed', feedback: { severity: 'success', message: 'Path copied' } } }
          if (action.actionId === 'open') { await ctx.sessionController.openWorkspacePath({ path }, operation.signal)
          return { kind: 'completed', feedback: { severity: 'info', message: 'Open request handed to the host application' } } }
          if (action.actionId === 'preview') {
            const bytes = await fs.readBytes(target, operation.signal, 256 * 1024)
            const text = bytes.includes(0) ? 'Binary file; use Open in an external application.' : new TextDecoder().decode(bytes)
            await openAgentOverlay(scope, agent, { id: 'mayfly.files.preview', title: file.path, presentation: 'editor', capturing: true }, ui.surface({ title: file.path, chrome: 'overlay', child: ui.stack.column([
              ui.scroll(ui.text(text), { scrollbar: true }),
            ]) }), () => () => ({ kind: 'completed' }), { signal: lifetime.signal, reopen: 'replace' })
          }
          return { kind: 'completed' }
        }, { signal: lifetime.signal, reopen: 'replace' })
        return { kind: 'completed' }
      }
    }, { signal: lifetime.signal, reopen: 'focus' })
    return { kind: 'success' }
  } })
}
