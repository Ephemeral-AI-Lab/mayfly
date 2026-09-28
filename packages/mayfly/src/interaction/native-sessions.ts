/** Session browsing, content search, and archive admission owned by Harness.
 * @module @ephemeral-ai/mayfly/interaction/native-sessions
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SessionProjectionBaseline, SessionSearchItem, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-session-query'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { ui, type MayflyOverlayHandle, type MayflyListItem } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { sessionDetailNode, sessionLabel, sessionListFacts, sessionListItem, type SessionListFacts } from './session-list-model.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { cachedSessionTitle, createSessionListCache, readSessionListTitle, refreshSessionList, sessionListRows, type SessionListRow } from './session-list-reads.ts'

export async function openSessions(ctx: Context, signal: AbortSignal, t: MayflyTranslate, cache = createSessionListCache(ctx)): Promise<CommandResult> {
  if (signal.aborted || ctx.mayflyOverlays.focus('mayfly.sessions')) return { kind: 'success' }
  const lifetime = new AbortController()
  const abort = AbortSignal.any([signal, lifetime.signal])
  const cleanup = ctx.effect(() => () => { lifetime.abort(); clearTimeout(repaint); recovery?.abort(); offProjection?.() })
  const home = homedir()
  let handle: MayflyOverlayHandle | undefined
  let detail: MayflyOverlayHandle | undefined
  let offProjection: (() => void) | undefined
  let sessions: readonly SessionSummary[] = []
  let catalogRows: readonly SessionListRow[] = []
  let byId = new Map<string, SessionListRow>()
  let loading = true
  let reminders: ReadonlySet<string> = new Set()
  let now = Date.now()
  let searchItems: readonly SessionSearchItem[] | undefined
  const titles = new Map<string, string | null>()
  const baselines = new Map<string, SessionProjectionBaseline>()
  let recovery: AbortController | undefined
  let recovering = false
  let busy = 0
  let dirty = false
  let repaint: ReturnType<typeof setTimeout> | undefined
  const publish = () => {
    clearTimeout(repaint)
    repaint = undefined
    if (abort.aborted || handle?.closed !== false || busy > 0 || !dirty) return
    dirty = false
    handle.set(node())
  }
  const schedulePaint = () => { if (!abort.aborted) repaint ??= setTimeout(publish, 100) }
  // Four direct log reads avoid repeated corpus scans. Repaint is coalesced
  // independently of completion order so one large log cannot delay other rows.
  const recoverTitles = async (generation: AbortController) => {
    if (ctx.get('sessionPersistence') === undefined) return
    const signal = AbortSignal.any([abort, generation.signal])
    const missing = catalogRows.filter(row => !row.live && cachedSessionTitle(cache, row) === undefined)
    recovering = missing.length > 0
    dirty = true
    schedulePaint()
    let cursor = 0
    const worker = async () => {
      while (!signal.aborted && cursor < missing.length) {
        const row = missing[cursor++]!
        try {
          const title = await readSessionListTitle(ctx, cache, row, signal)
          if (signal.aborted) return
          if (title !== undefined) titles.set(row.header.id, title)
          dirty = true
          schedulePaint()
        } catch (error) {
          if (!signal.aborted) ctx.logger.warn(`sessions: title read failed for ${row.header.id}: ${String(error)}`)
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(4, missing.length) }, worker))
    if (!signal.aborted) { recovering = false; dirty = true; publish() }
  }
  const startRecovery = () => {
    recovery?.abort()
    recovery = new AbortController()
    void recoverTitles(recovery)
  }
  let message = ''
  const adoptRows = () => {
    catalogRows = sessionListRows(ctx, cache)
    byId = new Map(catalogRows.map(row => [String(row.header.id), row]))
    sessions = catalogRows.map(row => row.summary)
    titles.clear()
    baselines.clear()
    for (const row of catalogRows) {
      const title = cachedSessionTitle(cache, row)
      if (title !== undefined) titles.set(row.header.id, title)
    }
    now = Date.now()
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
    recovery?.abort()
    recovering = false
    const [, reminding] = await Promise.all([refreshSessionList(ctx, cache, readSignal), readReminders()])
    if (readSignal.aborted || abort.aborted) return
    loading = false
    reminders = reminding
    adoptRows()
  }
  const factsOf = (session: SessionSummary, archived = new Set(ctx.workspaceRegistry.archivedSessionIds), current = ctx.mayflyCurrentAgent.current()?.id): SessionListFacts => sessionListFacts(session, {
    header: byId.get(session.sessionId)?.header,
    title: titles.get(session.sessionId),
    projections: baselines.get(session.sessionId),
    archived: archived.has(session.sessionId),
    current: current === session.sessionId,
    reminders,
    now,
  })
  const rows = (): readonly MayflyListItem[] => {
    const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
    const current = ctx.mayflyCurrentAgent.current()?.id
    return searchItems === undefined ? sessions.map(session => sessionListItem(factsOf(session, archived, current), now, home, t)) : searchItems.map(item => {
      const session = byId.get(item.sessionId)?.summary
      const row: MayflyListItem = session === undefined ? { id: item.sessionId, label: item.sessionId } : sessionListItem(factsOf(session, archived, current), now, home, t)
      return { id: row.id, label: row.label, ...(row.badge === undefined ? {} : { badge: row.badge }), detailSpans: [{ text: item.snippet }], searchText: `${row.label} ${item.sessionId} ${session?.cwd ?? ''} ${item.snippet}` }
    })
  }
  const node = () => ui.surface({ title: 'Sessions', chrome: 'overlay', child: ui.stack.column([
    ...(message === '' ? [] : [ui.text(message)]),
    ...(loading ? [ui.text('Loading sessions…', { tone: 'muted' })] : []),
    ...(recovering ? [ui.text('Loading session titles…', { tone: 'muted' })] : []),
    ui.form({ id: 'content-search', fields: [{ kind: 'input', id: 'query', label: 'Search conversation contents', value: '' }] }),
    ui.list({ id: 'sessions', role: 'browse', tree: searchItems === undefined, filterable: true, selectedIds: [], items: rows(), empty: ui.empty({ title: 'No sessions' }) }),
    ui.actions({ id: 'session-actions', items: [{ id: 'search', label: 'Search contents', disabled: loading, read: [{ pagePath: [], formId: 'content-search' }] }, { id: 'refresh', label: 'All sessions', disabled: loading }, { id: 'close', label: 'Close', dismiss: true }] }),
  ]) })
  try {
    adoptRows()
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
            if (result.items.some(item => !byId.has(item.sessionId))) {
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
        const session = id === undefined ? undefined : byId.get(id)?.summary
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
          dirty = true
          publish()
          return { kind: 'completed', dismiss: true }
        } } }, detailNode(), { signal: abort, reopen: 'replace' })
        return { kind: 'completed' }
      } finally {
        busy--
        // Let the shared action acknowledgement settle before a data repaint.
        schedulePaint()
      }
    } } }, node(), { signal: abort, reopen: 'replace', onClosed: () => {
      detail?.close()
      recovery?.abort()
      clearTimeout(repaint)
      cleanup()
    } })
    offProjection = ctx.sessionProjections.onChanged((session, key, value) => {
      if (abort.aborted || key !== 'title' || (typeof value !== 'string' && value !== null)) return
      const row = byId.get(session.id)
      if (row?.header !== session.header || ctx.sessions.get(session.id) !== session) return
      baselines.delete(session.id)
      titles.set(session.id, value)
      dirty = true
      schedulePaint()
    })
    void refresh().then(() => {
      if (abort.aborted) return
      dirty = true
      publish()
      startRecovery()
    }).catch(error => {
      if (abort.aborted) return
      loading = false
      message = `Could not load sessions: ${String(error)}`
      dirty = true
      publish()
    })
    return { kind: 'success' }
  } catch (error) {
    cleanup()
    return { kind: 'error', text: String(error) }
  }
}
