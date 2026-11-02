/** Reference workspace/session browser over authoritative native Client snapshots. @module */
import type { SessionSummary, SessionSearchResultItem } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import {
  SessionBrowser, sessionListItem, sessionWorkspaceTab, interactionTranslator, mountInteractionLocale,
  type SessionBrowserFacts, type SessionListFacts, type SessionWorkspaceLabelFacts,
} from '@ephemeral-ai/mayfly/session-browser'
import type { MayflyUiActionEvent, MayflyUiActionReply, MayflyUiEventContext, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { HostClient, SessionRef } from '../../client/types.ts'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import type { RemoteFeatureContext } from '../features.ts'
import { RemoteFeatureOperation, remoteErrorMessage, remoteProperty, remoteValue } from './official.ts'

/** Final application dependency: the router owns selection, the browser owns only presentation. */
export interface RemoteSessionsBrowser {
  open(client: HostClient, current: SessionRef | undefined, select: (sessionId: string) => void, signal?: AbortSignal): void
}

/** Host paths and the integrator's independent child-conversation presentation. */
export interface RemoteSessionsBrowserOptions {
  readonly home?: (client: HostClient) => string
  readonly directory?: () => string
  readonly openChild?: (client: HostClient, address: SubagentAddress, signal: AbortSignal) => Promise<void>
}

interface BrowserProjectionValues {
  readonly title?: string
  readonly sessionListMetadata?: { readonly lastPromptAt?: number }
  readonly tokenUsage?: { readonly uncachedInputTokens: number, readonly cacheReadTokens: number, readonly cacheWriteTokens: number, readonly outputTokens: number }
  readonly sessionStats?: SessionListFacts['stats']
  readonly modelSelection?: { readonly lastUsed?: SessionListFacts['model'], readonly next?: SessionListFacts['model'] }
  readonly agentPreset?: string
}

/** Adapt one Client summary's readonly facts; listing never retains a Session or opens history. */
export function remoteSessionListFacts(
  summary: SessionSummary,
  options: { readonly current: boolean, readonly archived: boolean, readonly reminders: ReadonlySet<string>, readonly now: number, readonly values?: Readonly<Record<string, unknown>> },
): SessionListFacts {
  const values = { ...summary.projectionValues, ...options.values } as BrowserProjectionValues
  const title = (values.title ?? summary.title)?.trim()
  const stats = values.sessionStats
  const promptedAt = values.sessionListMetadata?.lastPromptAt ?? (stats !== undefined && stats.turns > 0 ? summary.updatedAt : undefined)
  const lastActiveAt = summary.running ? options.now : promptedAt
  const usage = values.tokenUsage
  const model = values.modelSelection?.lastUsed ?? values.modelSelection?.next
  return {
    id: summary.id, running: summary.running, archived: options.archived, current: options.current,
    reminders: options.reminders.has(summary.id), migrationRequired: summary.formatStatus === 'migration-required',
    ...title === undefined || title === '' ? {} : { title },
    ...summary.cwd === undefined ? {} : { cwd: summary.cwd },
    ...lastActiveAt === undefined ? {} : { lastActiveAt },
    ...summary.parentId === undefined ? {} : { parentId: summary.parentId },
    ...summary.origin === undefined ? {} : { origin: summary.origin },
    ...values.agentPreset === undefined ? {} : { preset: values.agentPreset },
    ...usage === undefined ? {} : { tokens: { input: usage.uncachedInputTokens, cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens, output: usage.outputTokens } },
    ...stats === undefined ? {} : { stats },
    ...model === undefined ? {} : { model },
  }
}

const SEARCH_ID = 'search:all'
const OTHER_ID = 'workspace:unregistered'
type SessionsContext = Pick<RemoteFeatureContext, 'ctx' | 'hosts' | 'notice' | 'subscribeLocale'>

/** Native Client browsing with generation-owned reads, confirmations, and unload cleanup. */
export class RemoteSessionsBrowserController implements RemoteSessionsBrowser {
  private readonly t: ReturnType<typeof interactionTranslator>
  private readonly offTopology: () => void
  private operation: RemoteFeatureOperation | undefined
  private browser: RemoteBrowserPanel | undefined
  private disposed = false

  constructor(private readonly context: SessionsContext, private readonly options: RemoteSessionsBrowserOptions = {}) {
    mountInteractionLocale(context.ctx)
    this.t = interactionTranslator(context.ctx)
    this.offTopology = context.hosts.subscribe(() => {
      if (this.operation?.valid() === false) this.operation.dispose()
    })
  }

  /** Open one exact Host catalog; a later open replaces its local observation. */
  open(client: HostClient, current: SessionRef | undefined, select: (sessionId: string) => void, signal?: AbortSignal): void {
    if (signal?.aborted === true) return
    this.operation?.dispose()
    if (this.disposed || !this.context.hosts.list().includes(client)) return
    const selected = this.context.hosts.current()
    // Native snapshot getters are synchronous; this exact attached Client is still admitted here.
    const operation = new RemoteFeatureOperation(this.context, client, selected?.client === client ? selected : undefined, signal)
    this.operation = operation
    const t = this.t
    const home = this.options.home?.(client) ?? ''
    let scope: string | undefined
    let detailId: string | undefined
    let activity = ''
    let message = ''
    let loading = true
    let loadingReminders = true
    let reminders: ReadonlySet<string> = new Set()
    let searchItems: readonly SessionSearchResultItem[] | undefined
    let readGeneration = 0
    let detailGeneration = 0
    let searchLifetime: AbortController | undefined
    let panel!: RemoteBrowserPanel
    const valid = (): boolean => operation.valid()
    const catalog = (): readonly SessionSummary[] => {
      const value = client.sessions.list.getSnapshot()
      return value.ids.flatMap(id => value.byId[id] === undefined ? [] : [value.byId[id]!])
    }
    const workspaceSnapshot = () => client.workspaces.list.getSnapshot()
    const directory = (): string => catalog().find(row => row.id === current?.sessionId)?.cwd ?? this.options.directory?.() ?? ''
    const membership = (): ReadonlyMap<string, string> => {
      const workspaces = workspaceSnapshot().items
      const result = new Map<string, string>()
      for (const workspace of workspaces) for (const id of workspace.sessionIds) result.set(id, workspace.workspaceId)
      for (const summary of catalog()) {
        if (result.has(summary.id)) continue
        const workspace = workspaces.find(item => item.path === summary.cwd)
        if (workspace !== undefined) result.set(summary.id, workspace.workspaceId)
      }
      return result
    }
    const groups = (): readonly SessionWorkspaceLabelFacts[] => {
      const rows = catalog()
      const placed = membership()
      const currentId = current === undefined ? undefined : placed.get(current.sessionId)
      const workspaces: SessionWorkspaceLabelFacts[] = workspaceSnapshot().items.map(workspace => ({
        id: `workspace:${workspace.workspaceId}`, cwd: workspace.path, title: workspace.title,
        count: rows.filter(row => placed.get(row.id) === workspace.workspaceId).length,
        current: currentId === undefined ? workspace.path === directory() : workspace.workspaceId === currentId,
      }))
      const others = rows.filter(row => !placed.has(row.id))
      if (others.length > 0) workspaces.push({ id: OTHER_ID, cwd: undefined, count: others.length, label: 'Other sessions' })
      return workspaces
    }
    const resetPage = (): void => {
      detailGeneration += 1
      detailId = undefined
      activity = ''
      searchItems = undefined
      searchLifetime?.abort()
    }
    const ensureScope = (): void => {
      const workspaces = groups()
      if (scope === SEARCH_ID || workspaces.some(item => item.id === scope)) return
      scope = (workspaces.find(item => item.current) ?? workspaces.find(item => item.count > 0) ?? workspaces[0])?.id ?? SEARCH_ID
      resetPage()
    }
    const inScope = (): readonly SessionSummary[] => {
      const placed = membership()
      return catalog().filter(row => scope === SEARCH_ID || (scope === OTHER_ID ? !placed.has(row.id) : `workspace:${placed.get(row.id) ?? ''}` === scope))
    }
    const factsOf = (summary: SessionSummary, exact = false): SessionListFacts => remoteSessionListFacts(summary, {
      current: current?.host === client.key && current.sessionId === summary.id,
      archived: workspaceSnapshot().archivedSessionIds.includes(summary.id), reminders, now: Date.now(),
      ...exact ? { values: client.sessions.list.getSnapshot().projectionsBySession[summary.id]?.values ?? {} } : {},
    })
    const view = (): MayflyUiNode => {
      ensureScope()
      const allGroups = groups()
      const rows = inScope()
      const byId = new Map(rows.map(row => [row.id as string, row]))
      const items = searchItems === undefined ? scope === SEARCH_ID ? [] : rows.map(summary => {
        const { parentId, ...item } = sessionListItem(factsOf(summary), Date.now(), home, t, scope === OTHER_ID)
        return parentId !== undefined && byId.has(parentId) ? { ...item, parentId } : item
      }) : searchItems.flatMap(hit => {
        const summary = byId.get(hit.sessionId)
        if (summary === undefined) return []
        const item = sessionListItem(factsOf(summary), Date.now(), home, t, scope === OTHER_ID || scope === SEARCH_ID)
        return [{ ...item, detail: hit.snippet, searchText: `${item.label} ${hit.sessionId} ${summary.cwd ?? ''} ${hit.snippet}` }]
      })
      const summary = detailId === undefined ? undefined : byId.get(detailId)
      if (summary === undefined) detailId = undefined
      // ensureScope admitted a current workspace, whose native WorkspaceView always carries its title.
      const title = scope === SEARCH_ID ? t('All workspaces') : scope === OTHER_ID ? t('Other sessions') : allGroups.find(item => item.id === scope)!.title!
      const detailProjection = summary === undefined ? undefined : client.sessions.list.getSnapshot().projectionsBySession[summary.id]
      const state: SessionBrowserFacts = {
        title, tabs: [...allGroups.map(group => sessionWorkspaceTab(group, directory(), home, t)), { id: SEARCH_ID, label: t('All workspaces') }],
        activeTab: scope!, items, now: Date.now(), globalSearch: scope === SEARCH_ID, awaitingSearch: searchItems === undefined,
        busy: loading, loading: loading || loadingReminders || workspaceSnapshot().phase === 'pending', message,
        ...summary === undefined ? {} : { detail: {
          facts: factsOf(summary, true), activity,
          notice: detailProjection?.state === 'migration-required'
            ? t('This session uses an older saved format; its details show the last saved values. Open it to finish the migration.') : '',
        } },
      }
      return SessionBrowser(state, t)
    }
    const publish = (): void => { if (valid()) panel?.refresh() }
    const refresh = async (signal: AbortSignal = operation.signal): Promise<void> => {
      const generation = ++readGeneration
      loading = true
      publish()
      try {
        await client.sessions.refresh()
        if (!valid() || signal.aborted || generation !== readGeneration) return
        message = workspaceSnapshot().state === 'error' ? remoteErrorMessage(workspaceSnapshot().error) : ''
      } catch (error) {
        if (!valid() || signal.aborted || generation !== readGeneration) return
        message = t('Could not load workspaces: {error}', { error: remoteErrorMessage(error) })
      } finally {
        if (valid() && !signal.aborted && generation === readGeneration) { loading = false; publish() }
      }
    }
    const readDetails = async (event: MayflyUiActionEvent, eventContext: MayflyUiEventContext): Promise<MayflyUiActionReply> => {
      if (event.kind !== 'selection-accept' || event.controlId !== 'sessions') return { kind: 'completed' }
      const summary = inScope().find(row => row.id === event.selectedIds[0])
      if (summary === undefined) return { kind: 'failed', message: 'Session is no longer listed; refresh the catalog.' }
      const generation = ++detailGeneration
      const signal = AbortSignal.any([operation.signal, eventContext.signal])
      try { await client.sessions.refreshProjections(summary.id) }
      catch (error) {
        return !valid() || signal.aborted || generation !== detailGeneration ? { kind: 'cancelled' } : { kind: 'failed', message: `Could not read session details: ${remoteErrorMessage(error)}` }
      }
      if (!valid() || signal.aborted || generation !== detailGeneration) return { kind: 'cancelled' }
      const projection = client.sessions.list.getSnapshot().projectionsBySession[summary.id]
      if (!catalog().some(row => row.id === summary.id)) return { kind: 'failed', message: 'Session is no longer available; refresh the catalog.' }
      if (projection?.state === 'error') return { kind: 'failed', message: `Could not read session details: ${remoteErrorMessage(projection.error)}` }
      detailId = summary.id
      activity = ''
      publish()
      return { kind: 'completed' }
    }
    const act = async (event: MayflyUiActionEvent, eventContext: MayflyUiEventContext): Promise<MayflyUiActionReply> => {
      // openRemoteBrowser checks exact ownership and caller cancellation before entering this handler.
      if (event.kind === 'selection-accept') return await readDetails(event, eventContext)
      if (event.kind !== 'activate') return { kind: 'completed' }
      const signal = AbortSignal.any([operation.signal, eventContext.signal])
      if (event.actionId === 'search') {
        const query = event.inputs?.forms[0]?.fields.find(field => field.id === 'query')?.value
        if (typeof query !== 'string' || query.trim() === '') return { kind: 'failed', message: 'Enter search text' }
        searchLifetime?.abort()
        searchLifetime = new AbortController()
        const searchSignal = AbortSignal.any([signal, searchLifetime.signal])
        eventContext.report({ message: t('Searching conversations…'), severity: 'info' })
        let result: Awaited<ReturnType<HostClient['sessions']['search']>>
        try { result = await client.sessions.search(query.trim(), searchSignal) }
        catch (error) {
          if (!valid() || searchSignal.aborted) return { kind: 'cancelled' }
          throw error
        }
        if (!valid() || searchSignal.aborted) return { kind: 'cancelled' }
        if (!result.ok) return { kind: 'failed', message: remoteErrorMessage(result.error) }
        if (result.value.items.some(item => !catalog().some(row => row.id === item.sessionId))) await refresh(searchSignal)
        if (!valid() || searchSignal.aborted) return { kind: 'cancelled' }
        searchItems = result.value.items
        message = result.value.hasMore ? 'More matches exist; narrow the search.' : ''
        publish()
        return { kind: 'completed' }
      }
      if (event.actionId === 'reload' || event.actionId === 'refresh') {
        resetPage()
        await refresh(signal)
        return signal.aborted || !valid() ? { kind: 'cancelled' } : { kind: 'completed' }
      }
      if (event.actionId === 'search-all') {
        scope = SEARCH_ID
        resetPage()
        publish()
        return { kind: 'completed' }
      }
      const summary = inScope().find(row => row.id === detailId)
      if (summary === undefined) return { kind: 'completed' }
      const generation = detailGeneration
      if (event.actionId === 'open') {
        if (workspaceSnapshot().archivedSessionIds.includes(summary.id)) return { kind: 'failed', message: 'Restore the session first' }
        if (summary.origin === 'subagent' && summary.parentId !== undefined) {
          if (current === undefined) return { kind: 'failed', message: 'Open the lead session first' }
          const address = client.sessions.subagentAddress(summary.id)
          const ancestors = new Set<string>()
          let parent: string | undefined = summary.parentId
          while (parent !== undefined && parent !== current.sessionId && !ancestors.has(parent)) {
            ancestors.add(parent)
            parent = catalog().find(row => row.id === parent)?.parentId
          }
          if (address === undefined || parent !== current.sessionId) return { kind: 'failed', message: 'Open this child’s lead session first' }
          if (this.options.openChild === undefined) return { kind: 'failed', message: 'Opening child conversations is unavailable in this composition' }
          await this.options.openChild(client, address, signal)
          if (!valid() || signal.aborted || generation !== detailGeneration) return { kind: 'cancelled' }
        } else select(summary.id)
        panel.close()
        return { kind: 'completed' }
      }
      try {
        if (event.actionId === 'restore') await client.workspaces.unarchiveSession(summary.id)
        else if (event.actionId === 'archive' || event.actionId === 'stop-archive') await client.workspaces.archiveSession(summary.id, { stopActivity: event.actionId === 'stop-archive' })
        else return { kind: 'completed' }
      } catch (error) {
        if (!valid() || signal.aborted || generation !== detailGeneration) return { kind: 'cancelled' }
        const failure = remoteProperty(error, 'rpcError')
        const details = remoteProperty(failure, 'details')
        const entries = remoteProperty(details, 'activity')
        if (remoteProperty(failure, 'code') !== 'workspace/session-active' || !Array.isArray(entries)) throw error
        activity = entries.map(entry => `${String(remoteProperty(entry, 'kind'))}: ${JSON.stringify(remoteProperty(entry, 'items') ?? [])}`).join('\n')
        return { kind: 'accepted', node: view(), source: [] }
      }
      if (!valid() || signal.aborted || generation !== detailGeneration) return { kind: 'cancelled' }
      resetPage()
      await refresh(signal)
      return signal.aborted || !valid() ? { kind: 'cancelled' } : { kind: 'completed' }
    }
    panel = openRemoteBrowser(this.context, {
      id: 'mayfly.sessions', scope: { kind: 'app', targetId: `sessions:${client.key}` }, signal: operation.signal,
      isCurrent: valid, view,
      observe: event => {
        if (event.kind !== 'tab-change' || event.controlId !== 'session-rail') return
        if (event.tabId !== SEARCH_ID && !groups().some(group => group.id === event.tabId)) return
        scope = event.tabId
        resetPage()
        publish()
      },
      action: act,
      back: () => {
        if (detailId === undefined) return false
        detailGeneration += 1
        detailId = undefined
        activity = ''
        publish()
        return true
      },
      onClosed: () => operation.dispose(),
    })
    this.browser = panel
    operation.onDispose(() => {
      searchLifetime?.abort()
      panel.close()
      if (this.operation === operation) { this.operation = undefined; this.browser = undefined }
    })
    operation.onDispose(client.sessions.list.subscribe(publish))
    operation.onDispose(client.workspaces.list.subscribe(publish))
    operation.onDispose(client.state.subscribe(() => { if (!valid()) operation.dispose() }))
    void refresh()
    void (async () => {
      try {
        const entries = await remoteValue(client.remote.schedule.catalog())
        if (valid()) reminders = new Set(entries.filter(entry => entry.status === 'active').map(entry => String(entry.sessionId)))
      } catch { /* Schedule is optional; the catalog row still works without reminder badges. */ }
      finally { if (valid()) { loadingReminders = false; publish() } }
    })()
  }

  /** Release Frontend observations and pending reads; Host work continues. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.offTopology()
    this.operation?.dispose()
    this.browser?.close()
  }
}
