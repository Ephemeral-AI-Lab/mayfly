/** Session browsing, content search, and archive admission owned by Harness.
 * @module @ephemeral-ai/mayfly/interaction/native-sessions
 */
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { ui, type MayflyOverlayHandle, type MayflyListItem } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { openUiOverlay } from './ui-overlay.ts'

export async function openSessions(ctx: Context, signal: AbortSignal, t: MayflyTranslate): Promise<CommandResult> {
  const lifetime = new AbortController()
  const abort = AbortSignal.any([signal, lifetime.signal])
  const cleanup = ctx.effect(() => () => lifetime.abort())
  let handle: MayflyOverlayHandle | undefined
  let detail: MayflyOverlayHandle | undefined
  let sessions: readonly SessionSummary[] = []
  let searchRows: readonly MayflyListItem[] | undefined
  let message = ''
  const refresh = async () => { sessions = (await ctx.sessionController.list({}, abort)).items }
  const rows = (): readonly MayflyListItem[] => searchRows ?? sessions.map(session => {
    const reminders = session.projections?.values.schedule
    return {
      id: session.sessionId, label: session.projections?.values.title ?? session.sessionId,
      detail: `${session.cwd ?? ''} · ${session.running ? 'running' : 'inactive'}${ctx.workspaceRegistry.archivedSessionIds.includes(session.sessionId) ? ' · archived' : ''}`,
      ...(session.parentSessionId === undefined ? {} : { parentId: session.parentSessionId }),
      ...(Array.isArray(reminders) && reminders.length > 0 ? { badge: t('Reminders') } : {}),
    }
  })
  const node = () => ui.surface({ title: 'Sessions', chrome: 'overlay', child: ui.stack.column([
    ...(message === '' ? [] : [ui.text(message)]),
    ui.form({ id: 'content-search', fields: [{ kind: 'input', id: 'query', label: 'Search conversation contents', value: '' }] }),
    ui.list({ id: 'sessions', role: 'browse', tree: searchRows === undefined, filterable: true, selectedIds: [], items: rows(), empty: ui.empty({ title: 'No sessions' }) }),
    ui.actions({ id: 'session-actions', items: [{ id: 'search', label: 'Search contents', read: [{ pagePath: [], formId: 'content-search' }] }, { id: 'refresh', label: 'All sessions' }, { id: 'close', label: 'Close', dismiss: true }] }),
  ]) })
  try {
    await refresh()
    if (abort.aborted) {
      cleanup()
      return { kind: 'success' }
    }
    handle = openUiOverlay(ctx, { id: 'mayfly.sessions', title: 'Sessions', presentation: 'editor', capturing: true, onEvent: { action: async (event, context) => {
      if (event.kind === 'activate') {
        if (event.actionId === 'search') {
          const query = event.inputs?.forms[0]?.fields.find(field => field.id === 'query')?.value
          if (typeof query !== 'string' || query.trim() === '') return { kind: 'failed', message: 'Enter search text' }
          const result = await ctx.sessionController.search({ query: query.trim() }, context.signal)
          searchRows = result.items.map(item => ({ id: item.sessionId, label: sessions.find(session => session.sessionId === item.sessionId)?.projections?.values.title ?? item.sessionId, detail: item.snippet }))
          message = result.hasMore ? 'More matches exist; narrow the search.' : ''
        } else if (event.actionId === 'refresh') {
          await refresh()
          searchRows = undefined
          message = ''
        }
        return { kind: 'accepted', node: node(), source: [] }
      }
      if (event.kind !== 'selection-accept') return { kind: 'completed' }
      const id = event.selectedIds[0]
      const session = sessions.find(session => session.sessionId === id)
      if (session === undefined) return { kind: 'failed', message: 'Session is no longer listed; refresh the catalog.' }
      const archived = ctx.workspaceRegistry.archivedSessionIds.includes(session.sessionId)
      const detailNode = (activity = '') => ui.surface({ title: session.projections?.values.title ?? session.sessionId, chrome: 'overlay', child: ui.stack.column([
        ui.text(`${session.sessionId}\n${session.cwd ?? ''}\n${activity}`),
        ui.actions({ id: 'session-detail-actions', items: [
          { id: 'open', label: 'Open conversation', disabled: archived, ...(archived ? { disabledReason: 'Restore the session first' } : {}) },
          { id: archived ? 'restore' : 'archive', label: archived ? 'Restore' : 'Archive', confirm: archived ? 'Restore this session?' : 'Archive this session?' },
          ...(activity === '' ? [] : [{ id: 'stop-archive', label: 'Stop activity and archive', intent: 'danger' as const, confirm: `Stop this session’s activity and archive it?\n${activity}` }]),
          { id: 'close', label: 'Close', dismiss: true },
        ] }),
      ]) })
      detail = openUiOverlay(ctx, { id: 'mayfly.sessions.detail', title: 'Session', presentation: 'editor', capturing: true, onEvent: { action: async action => {
        if (action.kind !== 'activate') return { kind: 'completed' }
        if (action.actionId === 'open') {
          if (ctx.workspaceRegistry.archivedSessionIds.includes(session.sessionId)) return { kind: 'failed', message: 'Restore the session first' }
          if (session.origin === 'subagent' && session.parentSessionId !== undefined) {
            const primary = ctx.mayflyCurrentAgent.primary()
            if (primary === null) return { kind: 'failed', message: 'Open the lead session first' }
            const children = await ctx.subagents.listDescendants(primary.id, abort)
            const child = children.find(child => child.kind === 'child' && child.id === session.sessionId)
            if (child?.kind !== 'child') return { kind: 'failed', message: 'Open this child’s lead session first' }
            ctx.mayflyCurrentAgent.openAuxiliary({ kind: 'subagent', sessionId: child.id, parentSessionId: child.parentId, mode: child.mode, label: child.label ?? child.id })
          } else ctx.emit('mayfly/request-resume', session.sessionId)
          handle?.close()
          return { kind: 'completed' }
        }
        try {
          if (action.actionId === 'restore') await ctx.workspaceRegistry.unarchiveSession(SessionId(session.sessionId))
          else if (action.actionId === 'archive' || action.actionId === 'stop-archive') await ctx.workspaceRegistry.archiveSession(session.sessionId, { stopActivity: action.actionId === 'stop-archive' })
          else return { kind: 'completed' }
        } catch (error) {
          if (error instanceof WorkspaceActiveSessionError) return { kind: 'accepted', node: detailNode(error.activity.map(item => `${item.kind}: ${JSON.stringify(item.items ?? [])}`).join('\n')), source: [] }
          throw error
        }
        await refresh()
        if (!abort.aborted && handle?.closed === false) handle.set(node())
        return { kind: 'completed', dismiss: true }
      } } }, detailNode(), { signal: abort, reopen: 'replace' })
      return { kind: 'completed' }
    } } }, node(), { signal: abort, reopen: 'replace', onClosed: () => {
      detail?.close()
      cleanup()
    } })
    return { kind: 'success' }
  } catch (error) {
    cleanup()
    return { kind: 'error', text: String(error) }
  }
}
