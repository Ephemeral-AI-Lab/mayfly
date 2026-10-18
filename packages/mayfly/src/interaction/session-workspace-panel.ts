/** Session browsing, content search, and archive admission owned by Harness.
 * The list and search come from the Session Controller catalog; the detail
 * sheet is one controller projection read.
 * @module @ephemeral-ai/mayfly/interaction/session-workspace-panel
 */
import { homedir } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionProjectionValues, SessionProjectionsValue, SessionSearchItem, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-schedule'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { ui, type MayflyOverlayHandle, type MayflyListItem } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type {} from '../app/conversation-views.ts'
import { sessionDetailNode, sessionLabel, sessionListFacts, sessionListItem, type SessionListFacts } from './session-list-model.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { sessionListRows, type SessionListCache } from './session-list-reads.ts'
import { sessionWorkspacePlacements } from './session-workspaces-model.ts'

/** The panel's catalog scope: one registered workspace, every unowned session, or a global search. */
export type SessionWorkspaceScope =
  | { readonly kind: 'workspace', readonly workspaceId: WorkspaceId, readonly path: string, readonly title: string }
  | { readonly kind: 'other' }
  | { readonly kind: 'search' }

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

/** One Session the panel holds after a scope pass. */
interface PanelRow {
  readonly summary: SessionSummary
}

/** Open one workspace (or explicit global search), owned by the workspace picker. */
export function openSessionWorkspace(ctx: Context, signal: AbortSignal, t: MayflyTranslate, cache: SessionListCache, options: WorkspaceOptions): SessionWorkspacePanel {
  signal.throwIfAborted()
  const scope = options.scope
  const lifetime = new AbortController()
  const abort = AbortSignal.any([signal, lifetime.signal])
  const cleanup = ctx.effect(() => () => { lifetime.abort(); clearTimeout(repaint) })
  const home = homedir()
  let handle: MayflyOverlayHandle | undefined
  let detail: MayflyOverlayHandle | undefined
  /** The complete native catalog and its placement, refreshed together. */
  let catalog: readonly SessionSummary[] = []
  let placements: ReadonlyMap<string, WorkspaceId> = new Map()
  /** The Sessions this panel's scope currently shows. */
  let panelRows: readonly PanelRow[] = []
  let byId = new Map<string, SessionSummary>()
  let scopeIds: ReadonlySet<string> = new Set()
  let exact = new Map<string, NonNullable<SessionProjectionsValue>>()
  let reminders: ReadonlySet<string> = new Set()
  let loadingReminders = true
  let resolving = true
  let now = Date.now()
  let searchItems: readonly SessionSearchItem[] | undefined
  let message = ''
  let busy = 0
  let dirty = false
  let adoptGeneration = 0
  let repaint: ReturnType<typeof setTimeout> | undefined
  const publish = () => {
    clearTimeout(repaint)
    repaint = undefined
    if (abort.aborted || handle?.closed !== false || busy > 0 || !dirty) return
    dirty = false
    handle.set(node())
  }
  const schedulePaint = () => { if (!abort.aborted) repaint ??= setTimeout(publish, 100) }
  /** Adopt the last catalog + placement pair into this scope's rows. */
  const adoptRows = (): void => {
    const inScopeSummary = (summary: SessionSummary): boolean => {
      if (scope.kind === 'search') return true
      const placed = placements.get(String(summary.sessionId))
      return scope.kind === 'other' ? placed === undefined : placed === scope.workspaceId
    }
    const inScope = catalog.filter(inScopeSummary)
    scopeIds = new Set(inScope.map(summary => String(summary.sessionId)))
    if (searchItems !== undefined) searchItems = searchItems.filter(item => scopeIds.has(String(item.sessionId)))
    // Global search starts on its query prompt, not the whole catalog.
    panelRows = scope.kind === 'search' && searchItems === undefined ? [] : inScope.map(summary => ({ summary }))
    byId = new Map(inScope.map(summary => [String(summary.sessionId), summary]))
    now = Date.now()
  }
  /** Resolve the catalog and every Session's native workspace, then repaint. */
  const adopt = async (readSignal: AbortSignal): Promise<void> => {
    const generation = ++adoptGeneration
    resolving = true
    dirty = true
    schedulePaint()
    catalog = sessionListRows(ctx, cache)
    const placed = await sessionWorkspacePlacements(ctx.workspaceRegistry, catalog)
    if (generation !== adoptGeneration || readSignal.aborted || abort.aborted) return
    placements = placed
    adoptRows()
    resolving = false
    dirty = true
    publish()
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
    await options.refresh(readSignal)
    if (readSignal.aborted || abort.aborted) return
    await adopt(readSignal)
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
      const { parentId, ...item } = sessionListItem(factsOf(summary, undefined, archived, current), now, home, t, false)
      return parentId !== undefined && byId.has(parentId) ? { ...item, parentId } : item
    }) : searchItems.map(item => {
      const summary = byId.get(String(item.sessionId))
      const row: MayflyListItem = summary === undefined ? { id: item.sessionId, label: item.sessionId } : sessionListItem(factsOf(summary, undefined, archived, current), now, home, t, scope.kind !== 'workspace')
      return { id: row.id, label: row.label, ...(row.badge === undefined ? {} : { badge: row.badge }), detailSpans: [{ text: item.snippet }], searchText: `${row.label} ${item.sessionId} ${summary?.cwd ?? ''} ${item.snippet}` }
    })
  }
  const scopeTitle = (): string => scope.kind === 'workspace'
    ? scope.title
    : scope.kind === 'other' ? t('Other sessions') : t('All workspaces')
  const node = () => ui.surface({ title: t('Sessions'), chrome: 'overlay', child: ui.stack.column([
    ui.text(scopeTitle(), { tone: 'muted', overflow: 'truncate' }),
    ...(message === '' ? [] : [ui.text(message)]),
    ...(options.loading() || resolving || loadingReminders ? [ui.loader({ message: t('Loading workspace sessions…') })] : []),
    ui.form({ id: 'content-search', enterSubmits: 'search', fields: [{ kind: 'input', id: 'query', label: t(scope.kind === 'search' ? 'Search all conversation contents' : 'Search this workspace’s conversations'), maxLength: 500, value: '' }] }),
    ui.list({ id: 'sessions', role: 'browse', tree: searchItems === undefined, filterable: true, filterMode: 'slash', selectedIds: [], items: rows(), empty: ui.empty({ title: t(options.loading() || resolving ? 'Waiting for sessions…' : scope.kind === 'search' && searchItems === undefined ? 'Enter text to search all workspaces' : 'No sessions') }) }),
    ui.actions({ id: 'session-actions', items: [{ id: 'search', label: 'Search contents', hintLabel: 'search', hidden: true, disabled: options.loading(), read: [{ pagePath: [], formId: 'content-search' }] }, ...(scope.kind === 'workspace' ? [{ id: 'refresh', label: 'All sessions', hintLabel: 'all sessions', key: 'a', hidden: true, disabled: options.loading() }] : [])] }),
  ]) })
  try {
    adoptRows()
    handle = openUiOverlay(ctx, { id: 'mayfly.sessions.workspace', title: t(scope.kind === 'workspace' ? 'Workspace sessions' : 'Search sessions'), presentation: 'editor', capturing: true, onEvent: { action: async (event, context) => {
      busy++
      const operation = AbortSignal.any([abort, context.signal])
      try {
        if (event.kind === 'activate') {
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
          } else if (event.actionId === 'refresh') {
            context.report({ message: t('Loading workspace sessions…'), severity: 'info' })
            searchItems = undefined
            await refresh(operation)
            if (operation.aborted) return { kind: 'cancelled' }
            message = ''
          }
          return { kind: 'accepted', node: node(), source: [] }
        }
        if (event.kind !== 'selection-accept') return { kind: 'completed' }
        const id = event.selectedIds[0]
        const session = id === undefined ? undefined : byId.get(id)
        if (session === undefined) return { kind: 'failed', message: 'Session is no longer listed; refresh the catalog.' }
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
        now = Date.now()
        dirty = true
        const facts = factsOf(session, exact.get(String(session.sessionId))?.values)
        const archived = facts.archived
        const notice = baseline.kind === 'migration-required'
          ? t('This session uses an older saved format; its details show the last saved values. Open it to finish the migration.')
          : ''
        const detailNode = (activity = '') => ui.surface({ title: sessionLabel(facts, t), chrome: 'overlay', child: ui.stack.column([
          sessionDetailNode(facts, now, t),
          ...(notice === '' ? [] : [ui.text(notice, { tone: 'warning' })]),
          ...(activity === '' ? [] : [ui.text(activity, { tone: 'warning' })]),
          ui.actions({ id: 'session-detail-actions', items: [
            { id: 'open', label: 'Open conversation', hintLabel: 'open', key: 'o', hidden: true, disabled: archived, ...(archived ? { disabledReason: 'Restore the session first' } : {}) },
            { id: archived ? 'restore' : 'archive', label: archived ? 'Restore' : 'Archive', hintLabel: archived ? 'restore' : 'archive', key: 'a', hidden: true, confirm: archived ? 'Restore this session?' : 'Archive this session?' },
            ...(activity === '' ? [] : [{ id: 'stop-archive', label: 'Stop activity and archive', hintLabel: 'stop and archive', key: 's', hidden: true, intent: 'danger' as const, confirm: { title: 'Stop this session’s activity and archive it?', detail: activity, confirmLabel: 'Stop and archive', tone: 'danger' as const } }]),
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
              if (child.mode === 'external') return { kind: 'failed', message: 'External subagents have no local conversation' }
              ctx.mayflyConversations.open({ kind: 'subagent', sessionId: child.id, parentSessionId: child.parentId, mode: child.mode, label: child.label ?? child.id })
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
      clearTimeout(repaint)
      cleanup()
      options.onClosed()
    } })
    void adopt(abort).catch(error => {
      if (abort.aborted) return
      message = t('Could not load workspaces: {error}', { error: String(error) })
      resolving = false
      dirty = true
      publish()
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
        void adopt(abort).catch(failure => {
          if (abort.aborted) return
          message = t('Could not load workspaces: {error}', { error: String(failure) })
          resolving = false
          dirty = true
          publish()
        })
      },
    }
  } catch (error) {
    cleanup()
    throw error
  }
}
