/** Session browsing, content search, and archive admission owned by Harness.
 * @module @ephemeral-ai/mayfly/interaction/native-sessions
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionProjectionBaseline, SessionSearchItem, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-session-query'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { ui, type MayflyOverlayHandle, type MayflyListItem } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { sessionDetailNode, sessionLabel, sessionListFacts, sessionListItem, type SessionListFacts } from './session-list-model.ts'
import { openUiOverlay } from './ui-overlay.ts'

export async function openSessions(ctx: Context, signal: AbortSignal, t: MayflyTranslate): Promise<CommandResult> {
  const lifetime = new AbortController()
  const abort = AbortSignal.any([signal, lifetime.signal])
  const cleanup = ctx.effect(() => () => { lifetime.abort(); clearTimeout(repaint); recovery?.abort() })
  const home = homedir()
  let handle: MayflyOverlayHandle | undefined
  let detail: MayflyOverlayHandle | undefined
  let sessions: readonly SessionSummary[] = []
  let headers: ReadonlyMap<string, SessionHeader> = new Map()
  let reminders: ReadonlySet<string> = new Set()
  let now = Date.now()
  let searchItems: readonly SessionSearchItem[] | undefined
  const titles = new Map<string, string>()
  const baselines = new Map<string, SessionProjectionBaseline>()
  let recovery: AbortController | undefined
  let recovering = false
  let busy = 0
  let dirty = false
  let repaint: ReturnType<typeof setTimeout> | undefined
  const publish = () => {
    if (abort.aborted || handle?.closed !== false || busy > 0 || !dirty) return
    dirty = false
    handle.set(node())
  }
  // Native title reads borrow logs with bounded concurrency. Small batches
  // let the catalog paint immediately and release reads as soon as it closes.
  const recoverTitles = async (generation: AbortController) => {
    const query = ctx.get('sessionQuery')
    if (query === undefined) return
    const signal = AbortSignal.any([abort, generation.signal])
    const missing = sessions.filter(session => session.projections?.values.title === undefined && !titles.has(session.sessionId))
    recovering = missing.length > 0
    dirty = true
    publish()
    try {
      for (let offset = 0; offset < missing.length; offset += 32) {
        const results = await query.readTitleSnapshots(missing.slice(offset, offset + 32).map(session => session.sessionId), signal)
        if (signal.aborted) return
        for (const result of results) {
          if (result.status === 'rejected') continue
          if (result.value.title !== undefined) titles.set(result.sessionId, result.value.title.title)
        }
        dirty = true
        publish()
      }
    } catch (error) {
      if (!signal.aborted) ctx.logger.warn(`sessions: title recovery failed: ${String(error)}`)
    } finally {
      if (!signal.aborted) { recovering = false; dirty = true; publish() }
    }
  }
  const startRecovery = () => {
    recovery?.abort()
    recovery = new AbortController()
    void recoverTitles(recovery)
  }
  let message = ''
  // Stored headers carry the creation time and preset the summaries omit;
  // without the query service (or on a listing failure) rows omit the span.
  const readHeaders = async (readSignal: AbortSignal): Promise<ReadonlyMap<string, SessionHeader>> => {
    const query = ctx.get('sessionQuery')
    if (query === undefined) return new Map()
    try {
      return new Map((await query.listSessions(readSignal)).map(record => [String(record.header.id), record.header]))
    } catch (error) {
      if (!readSignal.aborted) ctx.logger.warn(`sessions: stored header listing failed: ${String(error)}`)
      return new Map()
    }
  }
  // One Host catalog read badges every row; absent service leaves the set empty.
  const readReminders = async (): Promise<ReadonlySet<string>> => {
    const schedule = ctx.get('schedule')
    if (schedule === undefined) return new Set()
    try {
      return new Set((await schedule.catalog()).filter(entry => entry.status === 'active').map(entry => String(entry.sessionId)))
    } catch (error) {
      if (!abort.aborted) ctx.logger.warn(`sessions: reminder catalog failed: ${String(error)}`)
      return new Set()
    }
  }
  const refresh = async (readSignal = abort) => {
    const [listed, stored, reminding] = await Promise.all([ctx.sessionController.list({}, readSignal), readHeaders(readSignal), readReminders()])
    if (readSignal.aborted || abort.aborted) return
    recovery?.abort()
    recovering = false
    baselines.clear()
    titles.clear()
    sessions = listed.items
    headers = stored
    reminders = reminding
    now = Date.now()
  }
  const factsOf = (session: SessionSummary): SessionListFacts => sessionListFacts(session, {
    header: headers.get(String(session.sessionId)),
    title: titles.get(session.sessionId),
    projections: baselines.get(session.sessionId),
    archived: ctx.workspaceRegistry.archivedSessionIds.includes(session.sessionId),
    current: String(ctx.mayflyCurrentAgent.current()?.id) === String(session.sessionId),
    reminders,
    now,
  })
  const rows = (): readonly MayflyListItem[] => {
    const byId = new Map(sessions.map(session => [session.sessionId, session]))
    return searchItems === undefined ? sessions.map(session => sessionListItem(factsOf(session), now, home, t)) : searchItems.map(item => {
      const session = byId.get(item.sessionId)
      const row: MayflyListItem = session === undefined ? { id: item.sessionId, label: item.sessionId } : sessionListItem(factsOf(session), now, home, t)
      return { id: row.id, label: row.label, ...(row.badge === undefined ? {} : { badge: row.badge }), detailSpans: [{ text: item.snippet }], searchText: `${row.label} ${item.sessionId} ${session?.cwd ?? ''} ${item.snippet}` }
    })
  }
  const node = () => ui.surface({ title: 'Sessions', chrome: 'overlay', child: ui.stack.column([
    ...(message === '' ? [] : [ui.text(message)]),
    ...(recovering ? [ui.text('Loading session titles…', { tone: 'muted' })] : []),
    ui.form({ id: 'content-search', fields: [{ kind: 'input', id: 'query', label: 'Search conversation contents', value: '' }] }),
    ui.list({ id: 'sessions', role: 'browse', tree: searchItems === undefined, filterable: true, selectedIds: [], items: rows(), empty: ui.empty({ title: 'No sessions' }) }),
    ui.actions({ id: 'session-actions', items: [{ id: 'search', label: 'Search contents', read: [{ pagePath: [], formId: 'content-search' }] }, { id: 'refresh', label: 'All sessions' }, { id: 'close', label: 'Close', dismiss: true }] }),
  ]) })
  try {
    await refresh()
    if (abort.aborted) {
      cleanup()
      return { kind: 'success' }
    }
    handle = openUiOverlay(ctx, { id: 'mayfly.sessions', title: 'Sessions', presentation: 'editor', capturing: true, onEvent: { action: async (event, context) => {
      busy++
      const operation = AbortSignal.any([abort, context.signal])
      try {
        if (event.kind === 'activate') {
          if (event.actionId === 'search') {
            const query = event.inputs?.forms[0]?.fields.find(field => field.id === 'query')?.value
            if (typeof query !== 'string' || query.trim() === '') return { kind: 'failed', message: 'Enter search text' }
            const result = await ctx.sessionController.search({ query: query.trim() }, operation)
            if (operation.aborted) return { kind: 'cancelled' }
            if (result.items.some(item => !sessions.some(session => session.sessionId === item.sessionId))) {
              await refresh(operation)
              if (!operation.aborted) startRecovery()
            }
            if (operation.aborted) return { kind: 'cancelled' }
            searchItems = result.items
            message = result.hasMore ? 'More matches exist; narrow the search.' : ''
          } else if (event.actionId === 'refresh') {
            await refresh(operation)
            if (operation.aborted) return { kind: 'cancelled' }
            searchItems = undefined
            startRecovery()
            message = ''
          }
          return { kind: 'accepted', node: node(), source: [] }
        }
        if (event.kind !== 'selection-accept') return { kind: 'completed' }
        const id = event.selectedIds[0]
        const session = sessions.find(session => session.sessionId === id)
        if (session === undefined) return { kind: 'failed', message: 'Session is no longer listed; refresh the catalog.' }
        try {
          const baseline = await ctx.sessionController.projections({ sessionId: session.sessionId }, operation)
          if (operation.aborted) return { kind: 'cancelled' }
          if (baseline === null) return { kind: 'failed', message: 'Session is no longer available; refresh the catalog.' }
          baselines.set(session.sessionId, baseline)
          now = Date.now()
          dirty = true
        } catch (error) {
          if (operation.aborted) return { kind: 'cancelled' }
          return { kind: 'failed', message: `Could not read session details: ${String(error)}` }
        }
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
        detail = openUiOverlay(ctx, { id: 'mayfly.sessions.detail', title: 'Session', presentation: 'editor', capturing: true, onEvent: { action: async (action, context) => {
          const operation = AbortSignal.any([abort, context.signal])
          if (action.kind !== 'activate') return { kind: 'completed' }
          if (action.actionId === 'open') {
            if (ctx.workspaceRegistry.archivedSessionIds.includes(session.sessionId)) return { kind: 'failed', message: 'Restore the session first' }
            if (session.origin === 'subagent' && session.parentSessionId !== undefined) {
              const primary = ctx.mayflyCurrentAgent.primary()
              if (primary === null) return { kind: 'failed', message: 'Open the lead session first' }
              const children = await ctx.subagents.listDescendants(primary.id, operation)
              if (operation.aborted) return { kind: 'cancelled' }
              if (ctx.mayflyCurrentAgent.primary() !== primary) return { kind: 'failed', message: 'The lead session changed; reopen this conversation.' }
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
          if (operation.aborted) return { kind: 'cancelled' }
          await refresh(operation)
          if (!operation.aborted) { handle!.set(node()); startRecovery() }
          return { kind: 'completed', dismiss: true }
        } } }, detailNode(), { signal: abort, reopen: 'replace' })
        return { kind: 'completed' }
      } finally {
        busy--
        // Let the shared action acknowledgement settle before a data repaint.
        clearTimeout(repaint)
        repaint = setTimeout(publish, 0)
      }
    } } }, node(), { signal: abort, reopen: 'replace', onClosed: () => {
      detail?.close()
      recovery?.abort()
      clearTimeout(repaint)
      cleanup()
    } })
    startRecovery()
    return { kind: 'success' }
  } catch (error) {
    cleanup()
    return { kind: 'error', text: String(error) }
  }
}
