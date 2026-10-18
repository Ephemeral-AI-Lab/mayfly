/** Workspace-first session browsing in one editor panel: a rail of
 * workspaces and one live page of scoped sessions, with a session's detail in
 * that same page. The catalog comes from the Session Controller and the
 * placement from the native Workspace registry; a detail is one controller
 * projection read.
 * @module @ephemeral-ai/mayfly/interaction/session-workspace-panel
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionProjectionValues, SessionProjectionsValue, SessionSearchItem, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-schedule'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { panel, rail, ui, type MayflyListItem, type MayflyOverlayHandle, type MayflyTabItem, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type {} from '../app/conversation-views.ts'
import { sessionDetailNode, sessionLabel, sessionListFacts, sessionListItem, type SessionListFacts } from './session-list-model.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { refreshSessionList, sessionListRows, type SessionListCache } from './session-list-reads.ts'
import { sessionWorkspacePlacements, sessionWorkspaceTab, sessionWorkspaces, type SessionWorkspace } from './session-workspaces-model.ts'

/** The panel's catalog scope: one registered workspace, every unowned session, or a global search. */
export type SessionWorkspaceScope =
  | { readonly kind: 'workspace', readonly workspaceId: WorkspaceId, readonly path: string, readonly title: string }
  | { readonly kind: 'other' }
  | { readonly kind: 'search' }

/** The single editor-slot sessions panel. */
export interface SessionsPanel {
  readonly handle: MayflyOverlayHandle
}

/** The rail row that enters the global content search. */
const SEARCH_ROW_ID = 'search:all'

/** One Session the panel holds after a scope pass. */
interface PanelRow {
  readonly summary: SessionSummary
}

/**
 * Open the workspace rail and its scoped session page as one editor panel.
 * @param ctx - the commands context.
 * @param signal - the dispatching command's cancellation.
 * @param t - interaction translator.
 * @param cache - the listing cache retained by the command Fiber.
 * @returns the live panel handle.
 */
export function openSessionsPanel(ctx: Context, signal: AbortSignal, t: MayflyTranslate, cache: SessionListCache): SessionsPanel {
  signal.throwIfAborted()
  const lifetime = new AbortController()
  const abort = AbortSignal.any([signal, lifetime.signal])
  const cleanup = ctx.effect(() => () => { lifetime.abort() })
  const home = homedir()
  let handle: MayflyOverlayHandle | undefined
  /** The complete native catalog and its placement, refreshed together. */
  let catalog: readonly SessionSummary[] = []
  let placements: ReadonlyMap<string, WorkspaceId> = new Map()
  let groups: readonly SessionWorkspace[] = []
  /** The Sessions the active scope currently shows. */
  let panelRows: readonly PanelRow[] = []
  let byId = new Map<string, SessionSummary>()
  let scopeIds: ReadonlySet<string> = new Set()
  let exact = new Map<string, NonNullable<SessionProjectionsValue>>()
  let reminders: ReadonlySet<string> = new Set()
  let loadingReminders = true
  let loading = true
  let resolving = true
  let now = Date.now()
  let searchItems: readonly SessionSearchItem[] | undefined
  let message = ''
  let activity = ''
  let scope: SessionWorkspaceScope | undefined
  let detailId: string | undefined
  let adoptGeneration = 0
  const currentCwd = (): string => ctx.mayflyConversations.primary()?.session.header.cwd ?? process.cwd()
  /** The registered workspace holding the displayed conversation, when one does. */
  const currentWorkspaceId = async (): Promise<WorkspaceId | undefined> => {
    try {
      return (await ctx.workspaceRegistry.resolveByPath(currentCwd()))?.id
    } catch {
      return undefined
    }
  }
  const publish = (): void => {
    if (!abort.aborted && handle?.closed === false) handle.set(node())
  }
  /** Adopt the last catalog + placement pair into the active scope's rows. */
  const adoptRows = (): void => {
    const inScopeSummary = (summary: SessionSummary): boolean => {
      if (scope === undefined) return true
      if (scope.kind === 'search') return true
      const placed = placements.get(String(summary.sessionId))
      return scope.kind === 'other' ? placed === undefined : placed === scope.workspaceId
    }
    const inScope = catalog.filter(inScopeSummary)
    scopeIds = new Set(inScope.map(summary => String(summary.sessionId)))
    if (searchItems !== undefined) searchItems = searchItems.filter(item => scopeIds.has(String(item.sessionId)))
    // Global search starts on its query prompt, not the whole catalog.
    panelRows = scope?.kind === 'search' && searchItems === undefined ? [] : inScope.map(summary => ({ summary }))
    byId = new Map(inScope.map(summary => [String(summary.sessionId), summary]))
    if (detailId !== undefined && !byId.has(detailId)) {
      detailId = undefined
      activity = ''
    }
    now = Date.now()
  }
  /** Resolve the catalog and every Session's native workspace, then repaint. */
  const adopt = async (readSignal: AbortSignal): Promise<void> => {
    const generation = ++adoptGeneration
    resolving = true
    publish()
    catalog = sessionListRows(ctx, cache)
    const placed = await sessionWorkspacePlacements(ctx.workspaceRegistry, catalog)
    if (generation !== adoptGeneration || readSignal.aborted || abort.aborted) return
    placements = placed
    const current = await currentWorkspaceId()
    if (generation !== adoptGeneration || readSignal.aborted || abort.aborted) return
    groups = sessionWorkspaces(ctx.workspaceRegistry.list(), catalog, placed, current)
    adoptRows()
    ensureScope()
    resolving = false
    publish()
  }
  const workspaceScope = (workspace: SessionWorkspace): SessionWorkspaceScope => workspace.workspaceId === undefined
    ? { kind: 'other' }
    : { kind: 'workspace', workspaceId: workspace.workspaceId, path: workspace.cwd ?? '', title: workspace.title ?? workspace.cwd ?? '' }
  const chooseScope = (workspace: SessionWorkspace): void => {
    scope = workspaceScope(workspace)
    detailId = undefined
    activity = ''
    searchItems = undefined
    adoptRows()
  }
  /** Keep the scope on a rail row; the current or first workspace opens first. */
  const ensureScope = (): void => {
    if (scope?.kind === 'search') return
    const workspaceId = scope?.kind === 'workspace' ? scope.workspaceId : undefined
    const present = workspaceId !== undefined
      ? groups.some(workspace => workspace.workspaceId === workspaceId)
      : scope?.kind === 'other' ? groups.some(workspace => workspace.workspaceId === undefined) : false
    if (present) return
    const workspace = groups.find(item => item.current === true) ?? groups.find(item => item.count > 0) ?? groups[0]
    if (workspace === undefined) {
      scope = { kind: 'search' }
      adoptRows()
      return
    }
    chooseScope(workspace)
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
  const refresh = async (readSignal: AbortSignal = abort): Promise<void> => {
    loading = true
    publish()
    try {
      await refreshSessionList(ctx, cache, readSignal)
      readSignal.throwIfAborted()
      await adopt(readSignal)
      readSignal.throwIfAborted()
      message = ''
    } catch (error) {
      if (readSignal.aborted || abort.aborted) return
      message = t('Could not load workspaces: {error}', { error: String(error) })
      resolving = false
    } finally {
      if (!readSignal.aborted && !abort.aborted) {
        loading = false
        publish()
      }
    }
  }
  /** Listing rows read only the summary hints; a detail passes its exact projection values. */
  const factsOf = (session: SessionSummary, values?: SessionProjectionValues, archived = new Set(ctx.workspaceRegistry.archivedSessionIds), current = ctx.mayflyConversations.displayed()?.sessionId): SessionListFacts => sessionListFacts(session, {
    values,
    archived: archived.has(session.sessionId),
    current: current === session.sessionId,
    reminders,
    now,
  })
  const rows = (): readonly MayflyListItem[] => {
    const archived = new Set(ctx.workspaceRegistry.archivedSessionIds)
    const current = ctx.mayflyConversations.displayed()?.sessionId
    return searchItems === undefined ? panelRows.map(({ summary }) => {
      const { parentId, ...item } = sessionListItem(factsOf(summary, undefined, archived, current), now, home, t, scope?.kind !== 'workspace')
      return parentId !== undefined && byId.has(parentId) ? { ...item, parentId } : item
    }) : searchItems.map(item => {
      const summary = byId.get(String(item.sessionId))
      const row: MayflyListItem = summary === undefined ? { id: item.sessionId, label: item.sessionId } : sessionListItem(factsOf(summary, undefined, archived, current), now, home, t, scope?.kind !== 'workspace')
      return { ...row, detail: item.snippet, searchText: `${row.label} ${item.sessionId} ${summary?.cwd ?? ''} ${item.snippet}` }
    })
  }
  const listTitle = (): string => {
    if (scope?.kind === 'search') return t('All workspaces')
    if (scope?.kind === 'other') return t('Other sessions')
    if (scope?.kind === 'workspace') return scope.title === '' ? scope.path : scope.title
    return t('Sessions')
  }
  const railItems = (): readonly MayflyTabItem[] => [
    ...groups.map(workspace => sessionWorkspaceTab(workspace, currentCwd(), home, t)),
    { id: SEARCH_ROW_ID, label: t('All workspaces') },
  ]
  const activeRailId = (): string => {
    if (scope?.kind === 'workspace') return `workspace:${String(scope.workspaceId)}`
    if (scope?.kind === 'other') return groups.find(workspace => workspace.workspaceId === undefined)?.id ?? SEARCH_ROW_ID
    return SEARCH_ROW_ID
  }
  const railBody = (content: MayflyUiNode): MayflyUiNode => {
    const items = railItems()
    const active = items.some(item => item.id === activeRailId()) ? activeRailId() : items[0]!.id
    return rail({
      rail: { id: 'session-rail', activeId: active, items, hintLabel: t('workspaces') },
      content,
    })
  }
  const detailActions = (facts: SessionListFacts): MayflyUiNode => ui.actions({ id: 'session-detail-actions', items: [
    { id: 'open', label: 'Open conversation', hintLabel: 'open', key: 'o', hidden: true, disabled: facts.archived, ...(facts.archived ? { disabledReason: 'Restore the session first' } : {}) },
    { id: facts.archived ? 'restore' : 'archive', label: facts.archived ? 'Restore' : 'Archive', hintLabel: facts.archived ? 'restore' : 'archive', key: 'a', hidden: true, confirm: facts.archived ? 'Restore this session?' : 'Archive this session?' },
    ...(activity === '' ? [] : [{ id: 'stop-archive', label: 'Stop activity and archive', hintLabel: 'stop and archive', key: 's', hidden: true, intent: 'danger' as const, confirm: { title: 'Stop this session’s activity and archive it?', detail: activity, confirmLabel: 'Stop and archive', tone: 'danger' as const } }]),
  ] })
  const listPage = (): MayflyUiNode => ui.stack.column([
    ...(message === '' ? [] : [ui.text(message, { tone: 'warning' })]),
    ...(loading || resolving || loadingReminders ? [ui.loader({ message: t('Loading workspace sessions…') })] : []),
    ui.form({ id: 'content-search', enterSubmits: 'search', ...(scope?.kind === 'search' ? { autofocus: true } : {}), fields: [{ kind: 'input', id: 'query', label: t(scope?.kind === 'search' ? 'Search all conversation contents' : 'Search this workspace’s conversations'), maxLength: 500, value: '' }] }),
    ui.list({ id: 'sessions', role: 'browse', tree: searchItems === undefined, filterable: true, filterMode: 'slash', selectedIds: [], autofocus: scope?.kind !== 'search', items: rows(), empty: ui.empty({ title: t(loading || resolving ? 'Waiting for sessions…' : scope?.kind === 'search' && searchItems === undefined ? 'Enter text to search all workspaces' : 'No sessions') }) }),
    ui.actions({ id: 'session-actions', items: [
      { id: 'search', label: 'Search contents', hintLabel: 'search', hidden: true, disabled: loading || resolving, read: [{ pagePath: [], formId: 'content-search' }] },
      { id: 'refresh', label: t('All sessions'), hintLabel: t('all sessions'), key: 'a', hidden: true, disabled: loading || resolving },
      { id: 'reload', label: t('Refresh'), hintLabel: t('refresh'), semantic: 'refresh', hidden: true, disabled: loading || resolving },
      { id: 'search-all', label: t('Search all contents'), hintLabel: t('search all'), semantic: 'search', hidden: true, disabled: loading || resolving },
    ] }),
  ])
  const detailPage = (facts: SessionListFacts, notice: string): MayflyUiNode => ui.stack.column([
    sessionDetailNode(facts, now, t),
    ...(notice === '' ? [] : [ui.text(notice, { tone: 'warning' })]),
    ...(activity === '' ? [] : [ui.text(activity, { tone: 'warning' })]),
    detailActions(facts),
  ])
  const node = (): MayflyUiNode => {
    const summary = detailId === undefined ? undefined : byId.get(detailId)
    if (summary !== undefined) {
      const facts = factsOf(summary, exact.get(String(summary.sessionId))?.values)
      const notice = exact.get(String(summary.sessionId))?.kind === 'migration-required'
        ? t('This session uses an older saved format; its details show the last saved values. Open it to finish the migration.')
        : ''
      return panel({ title: sessionLabel(facts, t), escapeLabel: 'back', body: railBody(detailPage(facts, notice)) })
    }
    return panel({ title: listTitle(), escapeLabel: 'close', body: railBody(listPage()) })
  }
  try {
    adoptRows()
    handle = openUiOverlay(ctx, {
      id: 'mayfly.sessions', presentation: 'editor', capturing: true,
      onEvent: {
        observe: event => {
          if (event.kind !== 'tab-change' || event.controlId !== 'session-rail') return
          if (event.tabId === SEARCH_ROW_ID) {
            scope = { kind: 'search' }
            detailId = undefined
            activity = ''
            searchItems = undefined
            adoptRows()
            publish()
            return
          }
          const workspace = groups.find(item => item.id === event.tabId)
          if (workspace === undefined) return
          chooseScope(workspace)
          publish()
        },
        action: async (event, context) => {
          if (event.kind === 'dismiss') {
            if (detailId !== undefined) {
              detailId = undefined
              activity = ''
              publish()
              return { kind: 'completed', dismiss: false }
            }
            return { kind: 'completed' }
          }
          if (event.kind === 'selection-accept' && event.controlId === 'sessions') {
            const id = event.selectedIds[0]
            const session = id === undefined ? undefined : byId.get(id)
            if (session === undefined) return { kind: 'failed', message: 'Session is no longer listed; refresh the catalog.' }
            const operation = AbortSignal.any([abort, context.signal])
            let baseline: SessionProjectionsValue
            try {
              baseline = await ctx.sessionController.projections({ sessionId: session.sessionId }, operation)
            } catch (error) {
              if (operation.aborted) return { kind: 'cancelled' }
              return { kind: 'failed', message: `Could not read session details: ${String(error)}` }
            }
            if (operation.aborted) return { kind: 'cancelled' }
            if (baseline === null) return { kind: 'failed', message: 'Session is no longer available; refresh the catalog.' }
            exact.set(String(session.sessionId), baseline)
            detailId = String(session.sessionId)
            activity = ''
            now = Date.now()
            publish()
            return { kind: 'completed' }
          }
          if (event.kind !== 'activate') return { kind: 'completed' }
          const operation = AbortSignal.any([abort, context.signal])
          if (event.actionId === 'search') {
            const query = event.inputs?.forms[0]?.fields.find(field => field.id === 'query')?.value
            if (typeof query !== 'string' || query.trim() === '') return { kind: 'failed', message: 'Enter search text' }
            context.report({ message: t('Searching conversations…'), severity: 'info' })
            const result = await ctx.sessionController.search({ query: query.trim() }, operation)
            if (operation.aborted) return { kind: 'cancelled' }
            const visible = new Set(catalog.map(summary => String(summary.sessionId)))
            if (result.items.some(item => !visible.has(String(item.sessionId)))) {
              await refresh(operation)
              if (operation.aborted) return { kind: 'cancelled' }
            }
            searchItems = result.items
            adoptRows()
            message = result.hasMore ? 'More matches exist; narrow the search.' : ''
            publish()
            return { kind: 'completed' }
          }
          if (event.actionId === 'refresh' || event.actionId === 'reload') {
            context.report({ message: t('Loading workspace sessions…'), severity: 'info' })
            searchItems = undefined
            await refresh(operation)
            if (operation.aborted) return { kind: 'cancelled' }
            message = ''
            publish()
            return { kind: 'completed' }
          }
          if (event.actionId === 'search-all') {
            scope = { kind: 'search' }
            detailId = undefined
            activity = ''
            searchItems = undefined
            adoptRows()
            publish()
            return { kind: 'completed' }
          }
          const session = detailId === undefined ? undefined : byId.get(detailId)
          if (session === undefined) return { kind: 'completed' }
          if (event.actionId === 'open') {
            if (ctx.workspaceRegistry.archivedSessionIds.includes(session.sessionId)) return { kind: 'failed', message: 'Restore the session first' }
            if (session.origin === 'subagent' && session.parentSessionId !== undefined) {
              const primary = ctx.mayflyCurrentAgent.primary()
              if (primary === null) return { kind: 'failed', message: 'Open the lead session first' }
              const children = await ctx.subagents.listDescendants(primary.id, operation)
              if (operation.aborted) return { kind: 'cancelled' }
              if (ctx.mayflyCurrentAgent.primary() !== primary) return { kind: 'failed', message: 'The lead session changed; reopen this conversation.' }
              const child = children.find(child => child.kind === 'child' && child.id === session.sessionId)
              if (child?.kind !== 'child') return { kind: 'failed', message: 'Open this child’s lead session first' }
              if (child.mode === 'external') return { kind: 'failed', message: 'External subagents have no local conversation' }
              ctx.mayflyConversations.open({ kind: 'subagent', sessionId: child.id, parentSessionId: child.parentId, mode: child.mode, label: child.label ?? child.id })
            } else ctx.emit('mayfly/request-resume', session.sessionId)
            handle?.close()
            return { kind: 'completed' }
          }
          try {
            if (event.actionId === 'restore') await ctx.workspaceRegistry.unarchiveSession(SessionId(session.sessionId))
            else if (event.actionId === 'archive' || event.actionId === 'stop-archive') await ctx.workspaceRegistry.archiveSession(session.sessionId, { stopActivity: event.actionId === 'stop-archive' })
            else return { kind: 'completed' }
          } catch (error) {
            if (error instanceof WorkspaceActiveSessionError) {
              activity = error.activity.map(item => `${item.kind}: ${JSON.stringify(item.items ?? [])}`).join('\n')
              return { kind: 'accepted', node: node(), source: [] }
            }
            throw error
          }
          if (operation.aborted) return { kind: 'cancelled' }
          detailId = undefined
          activity = ''
          await refresh(operation)
          if (operation.aborted) return { kind: 'cancelled' }
          return { kind: 'completed' }
        },
      },
    }, node(), { signal: abort, reopen: 'replace', onClosed: cleanup })
    void refresh(lifetime.signal)
    void readReminders().then(result => {
      if (abort.aborted) return
      reminders = result
      loadingReminders = false
      publish()
    })
    return { handle }
  } catch (error) {
    cleanup()
    throw error
  }
}
