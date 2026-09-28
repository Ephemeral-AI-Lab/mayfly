/** Session browsing, content search, and archive admission owned by Harness.
 * @module @ephemeral-ai/mayfly/interaction/session-workspace-panel
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionProjectionBaseline, SessionSearchItem, SessionSearchValue, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-session-query'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { ui, type MayflyOverlayHandle, type MayflyListItem } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { sessionDetailNode, sessionLabel, sessionListFacts, sessionListItem, type SessionListFacts } from './session-list-model.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { sessionWorkspaceLabel } from './session-workspaces-model.ts'
import { cachedSessionTitle, readSessionListTitle, sessionListRows, type SessionListCache, type SessionListRow } from './session-list-reads.ts'

// Bound presentation independently of the query provider's configured page size.
const SEARCH_RESULT_LIMIT = 20
const SEARCH_SNIPPET_LENGTH = 240

export type SessionWorkspaceScope = { readonly kind: 'workspace', readonly cwd: string | undefined } | { readonly kind: 'search' }

export interface SessionWorkspacePanel {
  readonly handle: MayflyOverlayHandle
  catalogChanged(error?: string): void
}

interface WorkspaceOptions {
  readonly scope: SessionWorkspaceScope
  readonly loading: () => boolean
  readonly refresh: (signal: AbortSignal) => Promise<void>
  readonly changed: () => void
  readonly closeAll: () => void
  readonly onClosed: () => void
}

/** Open one workspace (or explicit global search), owned by the workspace picker. */
export function openSessionWorkspace(ctx: Context, signal: AbortSignal, t: MayflyTranslate, cache: SessionListCache, options: WorkspaceOptions): SessionWorkspacePanel {
  signal.throwIfAborted()
  const scope = options.scope
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
  let reminders: ReadonlySet<string> = new Set()
  let loadingReminders = true
  let now = Date.now()
  let searchItems: readonly SessionSearchItem[] | undefined
  const titles = new Map<string, string | null>()
  const baselines = new Map<string, SessionProjectionBaseline>()
  let recovery: AbortController | undefined
  let recovering = false
  let completedNames = 0
  let totalNames = 0
  let failedNames = 0
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
    completedNames = 0
    failedNames = 0
    totalNames = missing.length
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
          if (title === undefined) failedNames++
          completedNames++
          dirty = true
          schedulePaint()
        } catch (error) {
          if (!signal.aborted) {
            failedNames++
            completedNames++
            dirty = true
            schedulePaint()
            ctx.logger.warn(`sessions: title read failed for ${row.header.id}: ${String(error)}`)
          }
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
    const ids = new Set(searchItems?.map(item => item.sessionId) ?? [])
    catalogRows = sessionListRows(ctx, cache, scope.kind === 'workspace' ? { cwd: scope.cwd, ...(searchItems === undefined ? {} : { ids }) } : { ids })
    byId = new Map(catalogRows.map(row => [String(row.header.id), row]))
    sessions = catalogRows.map(row => row.summary)
    titles.clear()
    baselines.clear()
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
    await options.refresh(readSignal)
    if (readSignal.aborted || abort.aborted) return
    adoptRows()
  }
  const factsOf = (session: SessionSummary, archived = new Set(ctx.workspaceRegistry.archivedSessionIds), current = ctx.mayflyCurrentAgent.current()?.id): SessionListFacts => {
    // Every row this panel renders was adopted into `byId`, so the lookup is total.
    const row = byId.get(session.sessionId)!
    return sessionListFacts(session, {
      header: row.header,
      // A live `onChanged` value wins until the next adopt; cold titles come from the shared revision cache.
      title: titles.has(session.sessionId) ? titles.get(session.sessionId) : cachedSessionTitle(cache, row),
      projections: baselines.get(session.sessionId),
      archived: archived.has(session.sessionId),
      current: current === session.sessionId,
      reminders,
      now,
    })
  }
  const rows = (): readonly MayflyListItem[] => {
    const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
    const current = ctx.mayflyCurrentAgent.current()?.id
    return searchItems === undefined ? sessions.map(session => {
      const { parentId, ...item } = sessionListItem(factsOf(session, archived, current), now, home, t, false)
      return parentId !== undefined && byId.has(parentId) ? { ...item, parentId } : item
    }) : searchItems.map(item => {
      const session = byId.get(item.sessionId)?.summary
      const row: MayflyListItem = session === undefined ? { id: item.sessionId, label: item.sessionId } : sessionListItem(factsOf(session, archived, current), now, home, t, scope.kind === 'search')
      return { id: row.id, label: row.label, ...(row.badge === undefined ? {} : { badge: row.badge }), detailSpans: [{ text: item.snippet }], searchText: `${row.label} ${item.sessionId} ${session?.cwd ?? ''} ${item.snippet}` }
    })
  }
  const node = () => ui.surface({ title: t('Sessions'), chrome: 'overlay', child: ui.stack.column([
    ui.text(scope.kind === 'workspace' ? sessionWorkspaceLabel(scope.cwd, home, t) : t('All workspaces'), { tone: 'muted', overflow: 'truncate' }),
    ...(message === '' ? [] : [ui.text(message)]),
    ...(options.loading() || loadingReminders ? [ui.loader({ message: t('Loading workspace sessions…') })] : []),
    ...(recovering ? [ui.loader({ message: t('Loading session names… {done}/{total}', { done: completedNames, total: totalNames }) })] : []),
    ...(!recovering && failedNames > 0 ? [ui.text(t(failedNames === 1 ? '1 session name could not be loaded. Refresh to retry.' : '{count} session names could not be loaded. Refresh to retry.', { count: failedNames }), { tone: 'warning' })] : []),
    ui.form({ id: 'content-search', fields: [{ kind: 'input', id: 'query', label: t(scope.kind === 'workspace' ? 'Search this workspace’s conversations' : 'Search all conversation contents'), maxLength: 500, value: '' }] }),
    ui.list({ id: 'sessions', role: 'browse', tree: searchItems === undefined, filterable: true, selectedIds: [], items: rows(), empty: ui.empty({ title: t(options.loading() ? 'Waiting for sessions…' : scope.kind === 'search' && searchItems === undefined ? 'Enter text to search all workspaces' : 'No sessions') }) }),
    ui.actions({ id: 'session-actions', items: [{ id: 'search', label: 'Search contents', disabled: options.loading(), read: [{ pagePath: [], formId: 'content-search' }] }, ...(scope.kind === 'workspace' ? [{ id: 'refresh', label: 'All sessions', disabled: options.loading() }] : []), { id: 'back', label: t('Workspaces'), dismiss: true }] }),
  ]) })
  try {
    adoptRows()
    startRecovery()
    handle = openUiOverlay(ctx, { id: 'mayfly.sessions.workspace', title: t(scope.kind === 'workspace' ? 'Workspace sessions' : 'Search sessions'), presentation: 'editor', capturing: true, onEvent: { action: async (event, context) => {
      busy++
      const operation = AbortSignal.any([abort, context.signal])
      try {
        if (event.kind === 'activate') {
          if (event.actionId === 'search') {
            const query = event.inputs?.forms[0]?.fields.find(field => field.id === 'query')?.value
            if (typeof query !== 'string' || query.trim() === '') return { kind: 'failed', message: 'Enter search text' }
            context.report({ message: t('Searching conversations…'), severity: 'info' })
            let result: SessionSearchValue
            if (scope.kind === 'search') result = await ctx.sessionController.search({ query: query.trim() }, operation)
            else {
              const service = ctx.get('sessionQuery')
              if (service === undefined) return { kind: 'failed', message: t('Content search is unavailable') }
              const page = await service.searchSessions({
                query: query.trim(), sessionFilters: [{ kind: 'cwd', values: [scope.cwd ?? null] }],
                eventFilters: [{ kind: 'type', values: ['user/message', 'assistant/message'] }, { kind: 'surface', values: ['current'] }],
              }, { signal: operation })
              const matches = page.items.filter(item => item.header.cwd === scope.cwd)
              result = {
                items: matches.slice(0, SEARCH_RESULT_LIMIT).map(item => ({ sessionId: item.header.id, snippet: [...item.bestMatch.snippet].slice(0, SEARCH_SNIPPET_LENGTH).join('') })),
                hasMore: page.nextCursor !== undefined || matches.length > SEARCH_RESULT_LIMIT,
              }
            }
            if (operation.aborted) return { kind: 'cancelled' }
            if (result.items.some(item => !byId.has(item.sessionId))) {
              await refresh(operation)
            }
            if (operation.aborted) return { kind: 'cancelled' }
            searchItems = result.items
            adoptRows()
            startRecovery()
            message = result.hasMore ? 'More matches exist; narrow the search.' : ''
          } else if (event.actionId === 'refresh') {
            context.report({ message: t('Loading workspace sessions…'), severity: 'info' })
            await refresh(operation)
            if (operation.aborted) return { kind: 'cancelled' }
            searchItems = undefined
            adoptRows()
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
            options.closeAll()
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
          options.changed()
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
      options.onClosed()
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
    void readReminders().then(result => {
      if (abort.aborted) return
      reminders = result
      loadingReminders = false
      dirty = true
      publish()
    })
    return {
      handle,
      catalogChanged(error) {
        if (abort.aborted) return
        message = error ?? ''
        adoptRows()
        startRecovery()
      },
    }
  } catch (error) {
    cleanup()
    throw error
  }
}
