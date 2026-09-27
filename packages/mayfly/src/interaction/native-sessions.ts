/** Session browsing, content search, and archive admission owned by Harness.
 * @module @ephemeral-ai/mayfly/interaction/native-sessions
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { ui, type MayflyOverlayHandle, type MayflyListItem } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { sessionDetailNode, sessionLabel, sessionListFacts, sessionListItem, type SessionListFacts } from './session-list-model.ts'
import { openUiOverlay } from './ui-overlay.ts'

export async function openSessions(ctx: Context, signal: AbortSignal, t: MayflyTranslate): Promise<CommandResult> {
  const lifetime = new AbortController()
  const abort = AbortSignal.any([signal, lifetime.signal])
  const cleanup = ctx.effect(() => () => lifetime.abort())
  const home = homedir()
  let handle: MayflyOverlayHandle | undefined
  let detail: MayflyOverlayHandle | undefined
  let sessions: readonly SessionSummary[] = []
  let headers: ReadonlyMap<string, SessionHeader> = new Map()
  let now = Date.now()
  let searchRows: readonly MayflyListItem[] | undefined
  let message = ''
  // Stored headers carry the creation time and preset the summaries omit;
  // without the query service (or on a listing failure) rows omit the span.
  const readHeaders = async (): Promise<ReadonlyMap<string, SessionHeader>> => {
    const query = ctx.get('sessionQuery')
    if (query === undefined) return new Map()
    try {
      return new Map((await query.listSessions(abort)).map(record => [String(record.header.id), record.header]))
    } catch (error) {
      if (!abort.aborted) ctx.logger.warn(`sessions: stored header listing failed: ${String(error)}`)
      return new Map()
    }
  }
  const refresh = async () => {
    const [listed, stored] = await Promise.all([ctx.sessionController.list({}, abort), readHeaders()])
    sessions = listed.items
    headers = stored
    now = Date.now()
  }
  const factsOf = (session: SessionSummary): SessionListFacts => sessionListFacts(session, {
    header: headers.get(String(session.sessionId)),
    archived: ctx.workspaceRegistry.archivedSessionIds.includes(session.sessionId),
    current: String(ctx.mayflyCurrentAgent.primary()?.id) === String(session.sessionId),
    now,
  })
  const rows = (): readonly MayflyListItem[] => searchRows ?? sessions.map(session => sessionListItem(factsOf(session), now, home, t))
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
          searchRows = result.items.map(item => {
            const session = sessions.find(session => session.sessionId === item.sessionId)
            return { id: item.sessionId, label: session === undefined ? item.sessionId : sessionLabel(factsOf(session), t), detail: item.snippet }
          })
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
      const facts = factsOf(session)
      const archived = facts.archived
      const detailNode = (activity = '') => ui.surface({ title: sessionLabel(facts, t), chrome: 'overlay', child: ui.stack.column([
        sessionDetailNode(facts, now, t),
        ...(activity === '' ? [] : [ui.text(activity, { tone: 'warning' })]),
        ui.actions({ id: 'session-detail-actions', items: [
          { id: 'open', label: 'Open conversation', disabled: archived, ...(archived ? { disabledReason: 'Restore the session first' } : {}) },
          { id: archived ? 'restore' : 'archive', label: archived ? 'Restore' : 'Archive', confirm: archived ? 'Restore this session?' : 'Archive this session?' },
          ...(activity === '' ? [] : [{ id: 'stop-archive', label: 'Stop activity and archive', intent: 'danger' as const, confirm: { title: 'Stop this session’s activity and archive it?', detail: activity, confirmLabel: 'Stop and archive', tone: 'danger' as const } }]),
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
