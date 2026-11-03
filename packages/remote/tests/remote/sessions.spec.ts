/** Native catalog browsing and exact Host-generation lifetime through real UI registries. @module */
import { Context } from '@deepseek-ai/cordis'
import type { SessionListState, SessionSummary, SessionProjectionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/types'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { MayflyOverlayService } from '@ephemeral-ai/mayfly-ui/provider'
import type { MayflyUiEvent } from '@ephemeral-ai/mayfly-ui'
import { MayflyLocaleService } from '@ephemeral-ai/mayfly/frontend'
import { compileMayflyUiNode } from '@ephemeral-ai/mayfly/core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureSelection } from '../../src/remote/features.ts'
import { RemoteSessionsBrowserController, remoteSessionListFacts } from '../../src/remote/features/sessions.ts'
import { fakeMayflyComponents, plainColors } from './render-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const select = (id: string): MayflyUiEvent => ({ kind: 'selection-accept', pagePath: [], controlId: 'sessions', selectedIds: [id] })
const action = (id: string): MayflyUiEvent => ({ kind: 'activate', pagePath: [], controlId: 'session-actions', actionId: id })
const tab = (id: string): MayflyUiEvent => ({ kind: 'tab-change', pagePath: [], controlId: 'session-rail', tabId: id })
const search = (query: string): MayflyUiEvent => ({ kind: 'activate', pagePath: [], controlId: 'session-actions', actionId: 'search', inputs: { actionId: 'search', draftRevision: 0, source: [], forms: [{ pagePath: [], formId: 'content-search', draftRevision: 0, fields: [{ id: 'query', change: 'set', value: query }] }] } })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}

function summary(id: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
  return { id: SessionId(id), displayTitle: id, title: id, cwd: '/host/repo', running: false, retainedBy: {}, blank: false, updatedAt: 1000, ...overrides }
}

async function fixture(options: { sessionless?: boolean, noPaths?: boolean, noOpenChild?: boolean } = {}) {
  const ctx = new Context(); contexts.push(ctx)
  const overlays = new MayflyOverlayService(ctx)
  const locale = new MayflyLocaleService(ctx as never, { preference: 'en' })
  const sessionListeners = new Set<() => void>()
  const workspaceListeners = new Set<() => void>()
  const connectionListeners = new Set<() => void>()
  const topologyListeners = new Set<() => void>()
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const currentId = SessionId('current')
  const ref = { host: HostKey('one'), sessionId: currentId }
  let rows = [summary('current', { projectionValues: { sessionListMetadata: { blank: false, lastPromptAt: 1000 }, title: 'Current' } as never }), summary('child', { parentId: currentId, origin: 'subagent' }), summary('other', { cwd: '/host/elsewhere' })]
  let workspaceRows: readonly WorkspaceView[] = [{ workspaceId: 'repo' as WorkspaceView['workspaceId'], path: '/host/repo', title: 'Repo', sessionIds: [currentId, SessionId('child')], createdAt: '', updatedAt: '' }]
  let archived: readonly ReturnType<typeof SessionId>[] = []
  let projections: Readonly<Record<string, SessionProjectionSnapshot>> = {}
  let missingId: ReturnType<typeof SessionId> | undefined
  let workspaceState: 'idle' | 'loading' | 'error' = 'idle'
  let workspaceError: unknown = null
  let generation = 1
  const snapshot = (): SessionListState => ({ ids: [...rows.map(row => row.id), ...missingId === undefined ? [] : [missingId]], byId: Object.fromEntries(rows.map(row => [row.id, row])), phase: 'ready', projectionsBySession: projections })
  const sessions = {
    list: { getSnapshot: snapshot, subscribe: subscribe(sessionListeners) },
    refresh: vi.fn(async () => {}),
    refreshProjections: vi.fn(async (_id: ReturnType<typeof SessionId>) => {}),
    retain: vi.fn(),
    search: vi.fn(async (_query: string, _signal: AbortSignal) => ({ ok: true as const, value: { items: [] as { sessionId: ReturnType<typeof SessionId>, snippet: string }[], hasMore: false } })),
    subagentAddress: vi.fn((id: ReturnType<typeof SessionId>) => id === 'child' ? { parentSessionId: currentId, childSessionId: id, mode: 'continuable' as const } : undefined),
  }
  const workspaces = {
    list: { getSnapshot: () => ({ items: workspaceRows, archivedSessionIds: archived, pinnedSessionIds: [], state: workspaceState, phase: 'ready', error: workspaceError }), subscribe: subscribe(workspaceListeners) },
    archiveSession: vi.fn(async (id: ReturnType<typeof SessionId>, _options?: { stopActivity?: boolean }) => { archived = [...archived, id] }),
    unarchiveSession: vi.fn(async (id: ReturnType<typeof SessionId>) => { archived = archived.filter(item => item !== id) }),
  }
  const reminderCatalog = vi.fn(async () => ({ ok: true as const, value: [{ sessionId: currentId, status: 'active' }] }))
  const client = { key: ref.host, sessions, workspaces, state: { getSnapshot: () => ({ status: 'connected', generation }), subscribe: subscribe(connectionListeners) }, remote: { schedule: { catalog: reminderCatalog } } } as unknown as HostClient
  let current: RemoteFeatureSelection | undefined = options.sessionless ? undefined : { ref, client, binding: {} as never }
  let active: HostClient | undefined = client
  let attached = [client]
  const hosts = { current: () => current, active: () => active, list: () => attached, subscribe: subscribe(topologyListeners) }
  const openChild = vi.fn(async (_client: HostClient, _address: unknown, _signal: AbortSignal) => {})
  const notice = { set: vi.fn() }
  let controller!: RemoteSessionsBrowserController
  const owner = await ctx.plugin({ name: 'sessions-browser-owner', apply(owner: Context) {
    controller = new RemoteSessionsBrowserController({ ctx: owner, hosts, notice, subscribeLocale: listener => locale.subscribe(listener) }, {
      ...options.noPaths ? {} : { home: () => '/host', directory: () => '/host/repo' },
      ...options.noOpenChild ? {} : { openChild },
    })
    owner.effect(() => () => { controller.dispose() })
  } })
  const onSelect = vi.fn()
  const open = () => { controller.open(client, current?.ref, onSelect) }
  const latest = () => overlays.list().find(entry => entry.id === 'mayfly.sessions')!
  const text = () => JSON.stringify(latest()?.node)
  const event = async (event: MayflyUiEvent, signal = new AbortController().signal) => {
    const entry = latest()
    const prepared = await entry.events.prepare(event, { surfaceId: entry.id, source: entry.source, revision: entry.revision, operationId: 'sessions-test', signal, report: vi.fn() })
    prepared.publish()
    return prepared.reply
  }
  const flush = async () => { for (let index = 0; index < 5; index += 1) await new Promise<void>(resolve => { setImmediate(resolve) }) }
  const emit = (listeners: Set<() => void>) => { for (const listener of listeners) listener() }
  return { ctx, owner, overlays, locale, client, hosts, controller, sessions, workspaces, reminderCatalog, onSelect, openChild, open, latest, text, event, flush, sessionListeners, workspaceListeners, connectionListeners, topologyListeners,
    setRows(next: SessionSummary[]) { rows = next; emit(sessionListeners) },
    setProjections(next: typeof projections) { projections = next; emit(sessionListeners) },
    setWorkspaces(next: readonly WorkspaceView[]) { workspaceRows = next; emit(workspaceListeners) },
    setArchived(next: typeof archived) { archived = next; emit(workspaceListeners) },
    missingRow(id: string) { missingId = SessionId(id); emit(sessionListeners) },
    workspaceFailure(error: unknown) { workspaceState = 'error'; workspaceError = error; emit(workspaceListeners) },
    reconnect() { generation += 1; emit(connectionListeners) },
    changeSelection(next: RemoteFeatureSelection | undefined) { current = next; emit(topologyListeners) },
    detach() { attached = []; active = undefined; current = undefined; emit(topologyListeners) },
  }
}

describe('RemoteSessionsBrowserController', () => {
  it('keeps a live panel on pre-aborted invocation and retires reads/actions on caller abort', async () => {
    for (const fails of [false, true]) {
      const f = await fixture()
      const caller = new AbortController()
      f.controller.open(f.client, f.hosts.current()?.ref, f.onSelect, caller.signal)
      await f.flush()
      const original = f.latest()
      const preAborted = new AbortController(); preAborted.abort()
      f.controller.open(f.client, f.hosts.current()?.ref, f.onSelect, preAborted.signal)
      expect(f.latest()).toBe(original)
      const gate = deferred<Awaited<ReturnType<HostClient['sessions']['search']>>>()
      f.sessions.search.mockReturnValueOnce(gate.promise as never)
      const pending = f.event(search('retired query'))
      await vi.waitFor(() => { expect(f.sessions.search).toHaveBeenCalled() })
      const queued = f.latest()
      caller.abort()
      expect(f.overlays.list()).toEqual([])
      expect(f.sessionListeners.size).toBe(0)
      expect(f.workspaceListeners.size).toBe(0)
      expect(f.connectionListeners.size).toBe(0)
      if (fails) gate.reject(new Error('late search failure'))
      else gate.resolve({ ok: true, value: { items: [], hasMore: false } })
      expect(await pending).toBeUndefined()
      expect(f.overlays.list()).toEqual([])
      expect(f.onSelect).not.toHaveBeenCalled()
      const context = { surfaceId: queued.id, source: [], signal: new AbortController().signal, revision: queued.revision, operationId: 'late-select', report: vi.fn() }
      expect(await queued.definition.onEvent!.action!(select('other') as never, context)).toMatchObject({ kind: 'cancelled' })
    }
  })

  it('refocuses the original detail, workspace, search and renderer state without replacing its caller', async () => {
    const f = await fixture()
    const caller = new AbortController()
    f.controller.open(f.client, f.hosts.current()?.ref, f.onSelect, caller.signal)
    await f.flush()
    await f.event(action('search-all'))
    f.sessions.search.mockResolvedValueOnce({ ok: true, value: { items: [{ sessionId: SessionId('other'), snippet: 'retained search selection' }], hasMore: false } })
    await f.event(search('retained'))
    await f.event(select('other'))
    const original = f.latest()
    const reads = f.sessions.refresh.mock.calls.length
    const later = new AbortController()
    const laterSelect = vi.fn()
    f.controller.open(f.client, f.hosts.current()?.ref, laterSelect, later.signal)
    const focused = f.latest()
    expect(focused.events).toBe(original.events)
    expect(focused.node).toBe(original.node)
    expect(focused.revision).toBe(original.revision)
    expect(focused.focusRevision).toBe(original.focusRevision + 1)
    expect(f.sessions.refresh).toHaveBeenCalledTimes(reads)
    expect(f.sessions.refreshProjections).toHaveBeenCalledOnce()
    expect(f.reminderCatalog).toHaveBeenCalledOnce()
    expect(f.sessionListeners.size).toBe(1)
    expect(f.workspaceListeners.size).toBe(1)
    expect(f.connectionListeners.size).toBe(1)
    later.abort()
    f.controller.open(f.client, f.hosts.current()?.ref, laterSelect, AbortSignal.abort())
    expect(f.latest()).toBe(focused)
    await f.event({ kind: 'dismiss', pagePath: [] })
    expect(f.text()).toContain('retained search selection')
    expect(f.text()).toContain('All workspaces')
    await f.event(select('other'))
    await f.event(action('open'))
    expect(f.onSelect).toHaveBeenCalledExactlyOnceWith('other')
    expect(laterSelect).not.toHaveBeenCalled()
    expect(f.overlays.list()).toEqual([])
    f.controller.open(f.client, f.hosts.current()?.ref, f.onSelect, caller.signal)
    await f.flush()
    expect(f.overlays.list()).toHaveLength(1)
    caller.abort()
    expect(f.overlays.list()).toEqual([])
    expect(f.sessionListeners.size + f.workspaceListeners.size + f.connectionListeners.size).toBe(0)
  })

  it('retains an original pending search across refocus and fences it when its original caller aborts', async () => {
    const f = await fixture()
    const caller = new AbortController()
    f.controller.open(f.client, f.hosts.current()?.ref, f.onSelect, caller.signal)
    await f.flush()
    const gate = deferred<Awaited<ReturnType<HostClient['sessions']['search']>>>()
    f.sessions.search.mockReturnValueOnce(gate.promise)
    const pending = f.event(search('pending original query'))
    await f.flush()
    const original = f.latest()
    const later = new AbortController()
    f.controller.open(f.client, f.hosts.current()?.ref, vi.fn(), later.signal)
    expect(f.latest().events).toBe(original.events)
    expect(f.latest().focusRevision).toBe(original.focusRevision + 1)
    expect(f.sessions.search).toHaveBeenCalledOnce()
    later.abort()
    caller.abort()
    gate.resolve({ ok: true, value: { items: [{ sessionId: SessionId('current'), snippet: 'retired original search' }], hasMore: false } })
    expect(await pending).toBeUndefined()
    expect(f.overlays.list()).toEqual([])
    f.open(); await f.flush()
    expect(f.sessions.refresh).toHaveBeenCalledTimes(2)
    expect(f.text()).not.toContain('retired original search')
  })
  it('keeps incomplete Host locations readable during sessionless search', async () => {
    const f = await fixture({ sessionless: true, noPaths: true })
    const { cwd: _cwd, ...orphan } = summary('orphan')
    f.setRows([orphan])
    f.open(); await f.flush()
    await f.event(tab('workspace:unregistered'))
    f.sessions.search.mockResolvedValueOnce({ ok: true, value: { items: [{ sessionId: SessionId('orphan'), snippet: 'without a recorded cwd' }], hasMore: false } })
    await f.event(search('cwd'))
    expect(f.text()).toContain('without a recorded cwd')
    expect(f.sessions.retain).not.toHaveBeenCalled()
  })

  it('ignores field observations, retired workspace tabs and actions left behind by a detail page', async () => {
    const f = await fixture()
    f.open(); await f.flush()
    expect(await f.event({ kind: 'value-change', pagePath: [], controlId: 'query', formId: 'content-search', value: 'draft', draftRevision: 1 })).toBeUndefined()
    await f.event({ kind: 'tab-change', pagePath: [], controlId: 'another-rail', tabId: 'workspace:repo' })
    await f.event(tab('workspace:removed'))
    expect(f.text()).toContain('Current')
    await f.event(select('current'))
    await f.event(tab('workspace:unregistered'))
    expect(await f.event(action('open'))).toMatchObject({ kind: 'completed' })
    expect(await f.event({ kind: 'completion-dismiss', pagePath: [], controlId: 'query' })).toMatchObject({ kind: 'completed' })
    expect(f.onSelect).not.toHaveBeenCalled()
  })

  it('keeps live connection notifications and retires native callbacks already queued before close', async () => {
    const f = await fixture()
    f.open(); await f.flush()
    const queued = [...f.sessionListeners, ...f.workspaceListeners]
    for (const listener of f.connectionListeners) listener()
    expect(f.overlays.list()).toHaveLength(1)
    f.controller.dispose()
    for (const listener of queued) listener()
    expect(f.overlays.list()).toEqual([])
  })

  it('does not clear a replacement opened synchronously during old-panel retirement', async () => {
    const f = await fixture()
    let reopen = true
    const off = f.overlays.subscribe(delta => {
      if (delta.kind === 'remove' && reopen) { reopen = false; f.open() }
    })
    f.open(); await f.flush()
    f.reconnect()
    expect(f.overlays.list()).toHaveLength(1)
    off()
    f.controller.dispose()
    expect(f.overlays.list()).toEqual([])
  })

  it('drops a successful older search when a newer search has already published', async () => {
    const f = await fixture()
    f.open(); await f.flush()
    const result = deferred<Awaited<ReturnType<typeof f.sessions.search>>>()
    f.sessions.search.mockReturnValueOnce(result.promise)
    const old = f.event(search('old'))
    await f.flush()
    await f.event(search('new'))
    result.resolve({ ok: true, value: { items: [{ sessionId: SessionId('current'), snippet: 'obsolete result' }], hasMore: false } })
    expect(await old).toMatchObject({ kind: 'cancelled' })
    expect(f.text()).not.toContain('obsolete result')
  })

  it('retires search results whose missing catalog refresh outlives the caller', async () => {
    const f = await fixture()
    f.open(); await f.flush()
    const refreshing = deferred<void>()
    f.sessions.refresh.mockReturnValueOnce(refreshing.promise)
    f.sessions.search.mockResolvedValueOnce({ ok: true, value: { items: [{ sessionId: SessionId('missing'), snippet: 'late catalog result' }], hasMore: false } })
    const caller = new AbortController()
    const pending = f.event(search('late'), caller.signal)
    await f.flush()
    caller.abort()
    refreshing.resolve()
    expect(await pending).toBeUndefined()
    expect(f.text()).not.toContain('late catalog result')
  })

  it('cancels an archive acknowledgement when the follow-up refresh outlives the caller', async () => {
    const f = await fixture()
    f.open(); await f.flush(); await f.event(select('current'))
    const refreshing = deferred<void>()
    f.sessions.refresh.mockReturnValueOnce(refreshing.promise)
    const caller = new AbortController()
    const pending = f.event(action('archive'), caller.signal)
    await f.flush()
    caller.abort()
    refreshing.resolve()
    expect(await pending).toBeUndefined()
    expect(f.workspaces.archiveSession).toHaveBeenCalledOnce()
  })

  it('uses the rc.2 workspace rail, scoped catalog, native detail values, locale, and width renderer', async () => {
    const f = await fixture()
    f.open(); await f.flush()
    expect(f.text()).toContain('session-rail')
    expect(f.text()).toContain('Repo')
    expect(f.text()).toContain('Other sessions')
    expect(f.text()).toContain('Current')
    expect(f.text()).toContain('reminders')
    expect(f.text()).not.toContain('elsewhere')
    f.setProjections({ current: { state: 'ready', error: null, values: { title: 'Exact title', tokenUsage: { uncachedInputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 0, outputTokens: 20 } } as never } })
    expect(await f.event(select('current'))).toEqual({ kind: 'completed' })
    expect(f.sessions.refreshProjections).toHaveBeenCalledWith('current')
    expect(f.text()).toContain('Exact title')
    expect(f.text()).toContain('170')
    expect(f.text()).toContain('Archive this session?')
    const components = fakeMayflyComponents()
    for (const width of [1, 2, 8, 12, 30, 60, 100, 160]) {
      const compiled = compileMayflyUiNode(f.latest().node, { components, colors: plainColors(), getViewport: () => ({ columns: width, rows: 30 }), screenMode: 'alternate', emit() {} })
      expect(compiled.ok).toBe(true)
      const rendered = (compiled.ok ? compiled.value.component : compiled.errorComponent).render(width)
      for (const row of rendered) expect(components.visibleWidth(row), `${width}: ${row}`).toBeLessThanOrEqual(width)
    }
    f.locale.setPreference('zh')
    expect(f.text()).toContain('名称')
    await f.event({ kind: 'dismiss', pagePath: [] })
    expect(f.text()).toContain('content-search')
    await f.event({ kind: 'dismiss', pagePath: [] })
    expect(f.overlays.list()).toEqual([])
    expect(f.sessionListeners.size + f.workspaceListeners.size + f.connectionListeners.size).toBe(0)
    expect(f.sessions.retain).not.toHaveBeenCalled()
  })

  it('searches workspace contents, switches to global search, and handles missing catalog rows and failures', async () => {
    const f = await fixture()
    f.open(); await f.flush()
    expect(await f.event(search(' '))).toMatchObject({ kind: 'failed', message: 'Enter search text' })
    f.sessions.search.mockResolvedValueOnce({ ok: true, value: { items: [{ sessionId: SessionId('other'), snippet: 'match outside workspace' }, { sessionId: SessionId('current'), snippet: 'exact phrase' }], hasMore: true } })
    await f.event(search(' phrase '))
    expect(f.text()).toContain('exact phrase')
    expect(f.text()).not.toContain('match outside workspace')
    expect(f.text()).toContain('More matches exist')
    await f.event(action('search-all'))
    expect(f.text()).toContain('Enter text to search all workspaces')
    f.sessions.search.mockResolvedValueOnce({ ok: true, value: { items: [{ sessionId: SessionId('other'), snippet: 'global match' }, { sessionId: SessionId('unknown'), snippet: 'unknown' }], hasMore: false } })
    await f.event(search('global'))
    expect(f.text()).toContain('global match')
    expect(f.sessions.refresh).toHaveBeenCalledTimes(2)
    f.sessions.search.mockResolvedValueOnce({ ok: false, error: { code: 'offline', message: 'offline' } } as never)
    expect(await f.event(search('global'))).toMatchObject({ kind: 'failed', message: 'offline' })
    await f.event(tab('workspace:unregistered'))
    expect(f.text()).toContain('other')
    await f.event(action('refresh'))
    expect(f.text()).not.toContain('global match')
  })

  it('shows migration-safe details and applies archive, active-work confirmation, forced archive, and restore', async () => {
    const f = await fixture()
    f.open(); await f.flush()
    f.setProjections({ current: { state: 'migration-required', values: { title: 'Old title' } as never, error: null } })
    await f.event(select('current'))
    expect(f.text()).toContain('older saved format')
    const active = { rpcError: { code: 'workspace/session-active', details: { activity: [{ kind: 'jobs', items: ['build'] }, { kind: 'agent' }] } } }
    f.workspaces.archiveSession.mockRejectedValueOnce(active)
    expect(await f.event(action('archive'))).toMatchObject({ kind: 'accepted' })
    expect(f.text()).toContain('Stop activity and archive')
    expect(f.text()).toContain('build')
    await f.event(action('stop-archive'))
    expect(f.workspaces.archiveSession).toHaveBeenLastCalledWith('current', { stopActivity: true })
    await f.event(select('current'))
    expect(await f.event(action('open'))).toMatchObject({ kind: 'failed', message: 'Restore the session first' })
    await f.event(action('restore'))
    expect(f.workspaces.unarchiveSession).toHaveBeenCalledWith('current')
    await f.event(select('current'))
    await f.event(action('open'))
    expect(f.onSelect).toHaveBeenCalledWith('current')
    expect(f.overlays.list()).toEqual([])
  })

  it('fences late detail/search results, connection replacement, same-id selection, and owner unload', async () => {
    const f = await fixture()
    f.open(); await f.flush()
    const detail = deferred<void>()
    f.sessions.refreshProjections.mockReturnValueOnce(detail.promise)
    const pendingDetail = f.event(select('current'))
    await f.flush()
    await f.event(tab('workspace:unregistered'))
    detail.resolve()
    expect(await pendingDetail).toMatchObject({ kind: 'cancelled' })
    expect(f.text()).not.toContain('session-detail-actions')
    const result = deferred<Awaited<ReturnType<typeof f.sessions.search>>>()
    f.sessions.search.mockReturnValueOnce(result.promise)
    const pendingSearch = f.event(search('late'))
    await f.flush()
    f.reconnect()
    expect(f.overlays.list()).toEqual([])
    result.resolve({ ok: true, value: { items: [{ sessionId: SessionId('other'), snippet: 'late match' }], hasMore: false } })
    await pendingSearch
    f.open(); await f.flush()
    f.changeSelection({ client: { ...f.client }, ref: { host: f.client.key, sessionId: SessionId('current') }, binding: {} as never })
    expect(f.overlays.list()).toEqual([])
    f.changeSelection(undefined)
    f.open(); await f.flush()
    await f.owner.dispose()
    expect(f.overlays.list()).toEqual([])
    expect(f.sessionListeners.size + f.workspaceListeners.size + f.connectionListeners.size + f.topologyListeners.size).toBe(0)
    f.controller.dispose()
    f.open()
    expect(f.overlays.list()).toEqual([])
  })

  it('opens native addressed children without changing the primary and rejects unrelated children', async () => {
    const f = await fixture()
    f.open(); await f.flush()
    await f.event(select('child'))
    await f.event(action('open'))
    expect(f.openChild).toHaveBeenCalledWith(f.client, { parentSessionId: 'current', childSessionId: 'child', mode: 'continuable' }, expect.any(AbortSignal))
    expect(f.onSelect).not.toHaveBeenCalled()
    f.setRows([summary('current'), summary('child', { origin: 'subagent', parentId: SessionId('unrelated') })])
    f.open(); await f.flush()
    await f.event(select('child'))
    expect(await f.event(action('open'))).toMatchObject({ kind: 'failed', message: 'Open this child’s lead session first' })
  })

  it('supports a sessionless empty Host and failure recovery without inventing a Session', async () => {
    const f = await fixture({ sessionless: true, noPaths: true })
    f.setRows([]); f.setWorkspaces([])
    f.reminderCatalog.mockRejectedValueOnce(new Error('not composed'))
    f.sessions.refresh.mockRejectedValueOnce(new Error('offline'))
    f.open(); await f.flush()
    expect(f.text()).toContain('All workspaces')
    expect(f.text()).toContain('Could not load workspaces')
    expect(await f.event(select('missing'))).toMatchObject({ kind: 'failed' })
    await f.event(action('reload'))
    expect(f.text()).not.toContain('offline')
    f.detach()
    expect(f.overlays.list()).toEqual([])
    f.open()
    expect(f.overlays.list()).toEqual([])
  })

  it('uses authoritative workspace membership before cwd fallback and ignores incomplete native rows', async () => {
    const f = await fixture({ noPaths: true })
    f.setRows([summary('current', { cwd: '/host/unregistered' }), summary('child'), Object.fromEntries(Object.entries(summary('orphan')).filter(([key]) => key !== 'cwd')) as unknown as SessionSummary])
    f.missingRow('loading-row')
    f.open(); await f.flush()
    expect(f.text()).toContain('current')
    expect(f.text()).not.toContain('orphan')
    f.setWorkspaces([{ workspaceId: 'canonical' as WorkspaceView['workspaceId'], path: '/host/repo', title: 'Canonical', sessionIds: [], createdAt: '', updatedAt: '' }])
    await f.event(tab('workspace:unregistered'))
    expect(f.text()).toContain('orphan')
    await f.event(tab('workspace:canonical'))
    expect(f.text()).toContain('child')
    f.workspaceFailure(new Error('workspace offline'))
    await f.event(action('reload'))
    expect(f.text()).toContain('workspace offline')
    f.overlays.close('mayfly.sessions')
    f.controller.open({ ...f.client }, undefined, f.onSelect)
    expect(f.overlays.list()).toEqual([])
  })

  it('reports native detail failures and retires a deleted or superseded detail read', async () => {
    const f = await fixture()
    f.open(); await f.flush()
    expect(await f.event({ kind: 'selection-accept', pagePath: [], controlId: 'other', selectedIds: [] })).toMatchObject({ kind: 'completed' })
    f.sessions.refreshProjections.mockRejectedValueOnce(new Error('projection unavailable'))
    expect(await f.event(select('current'))).toMatchObject({ kind: 'failed', message: 'Could not read session details: projection unavailable' })
    f.setProjections({ current: { state: 'error', values: {}, error: 'invalid journal' } as never })
    expect(await f.event(select('current'))).toMatchObject({ kind: 'failed', message: 'Could not read session details: invalid journal' })
    const reading = deferred<void>()
    f.sessions.refreshProjections.mockReturnValueOnce(reading.promise)
    const missing = f.event(select('current'))
    await f.flush()
    f.setRows([summary('child')]); reading.resolve()
    expect(await missing).toMatchObject({ kind: 'failed', message: 'Session is no longer available; refresh the catalog.' })
    const rejected = deferred<void>()
    f.sessions.refreshProjections.mockReturnValueOnce(rejected.promise)
    const stale = f.event(select('child'))
    await f.flush()
    await f.event(action('search-all'))
    rejected.reject(new Error('old detail'))
    expect(await stale).toMatchObject({ kind: 'cancelled' })
    f.controller.dispose()
  })

  it('cancels old searches, propagates current search failures, and ignores reminder results after unload', async () => {
    const f = await fixture()
    const reminders = deferred<Awaited<ReturnType<typeof f.reminderCatalog>>>()
    f.reminderCatalog.mockReturnValueOnce(reminders.promise)
    f.open(); await f.flush()
    const old = deferred<Awaited<ReturnType<typeof f.sessions.search>>>()
    f.sessions.search.mockReturnValueOnce(old.promise)
    const pending = f.event(search('old'))
    await f.flush()
    await f.event(search('new'))
    old.reject(new Error('old search failed'))
    expect(await pending).toMatchObject({ kind: 'cancelled' })
    f.sessions.search.mockRejectedValueOnce(new Error('search offline'))
    await expect(f.event(search('failure'))).rejects.toThrow('search offline')
    await f.owner.dispose()
    reminders.resolve({ ok: true, value: [{ sessionId: SessionId('current'), status: 'active' }] })
    await f.flush()
    expect(f.overlays.list()).toEqual([])
  })

  it('keeps the lead selection when child access is unavailable or the lead is not open', async () => {
    const f = await fixture({ sessionless: true })
    f.open(); await f.flush(); await f.event(select('child'))
    expect(await f.event(action('open'))).toMatchObject({ kind: 'failed', message: 'Open the lead session first' })
    f.controller.dispose()
    const unavailable = await fixture({ noOpenChild: true })
    unavailable.open(); await unavailable.flush(); await unavailable.event(select('child'))
    expect(await unavailable.event(action('open'))).toMatchObject({ kind: 'failed', message: 'Opening child conversations is unavailable in this composition' })
    unavailable.sessions.subagentAddress.mockReturnValueOnce(undefined)
    expect(await unavailable.event(action('open'))).toMatchObject({ kind: 'failed', message: 'Open this child’s lead session first' })
    expect(unavailable.onSelect).not.toHaveBeenCalled()
    unavailable.controller.dispose()
  })

  it('fences an opening child and archive changes after the active detail or Host generation changes', async () => {
    const f = await fixture()
    f.open(); await f.flush(); await f.event(select('child'))
    const opening = deferred<void>()
    f.openChild.mockReturnValueOnce(opening.promise)
    const pendingChild = f.event(action('open'))
    await f.flush()
    await f.event(select('current'))
    opening.resolve()
    expect(await pendingChild).toMatchObject({ kind: 'cancelled' })
    const archiving = deferred<void>()
    f.workspaces.archiveSession.mockReturnValueOnce(archiving.promise)
    const pendingArchive = f.event(action('archive'))
    await f.flush()
    await f.event(tab('workspace:unregistered'))
    archiving.resolve()
    expect(await pendingArchive).toMatchObject({ kind: 'cancelled' })
    await f.event(select('other'))
    const failed = deferred<void>()
    f.workspaces.archiveSession.mockReturnValueOnce(failed.promise)
    const pendingFailure = f.event(action('archive'))
    await f.flush()
    f.reconnect(); failed.reject(new Error('stale archive'))
    expect(await pendingFailure).toBeUndefined()
    expect(f.overlays.list()).toEqual([])
  })

  it('rejects a current archive failure and retires catalog refreshes after cancellation', async () => {
    const f = await fixture()
    f.open(); await f.flush(); await f.event(select('current'))
    f.workspaces.archiveSession.mockRejectedValueOnce(new Error('archive offline'))
    await expect(f.event(action('archive'))).rejects.toThrow('archive offline')
    expect(await f.event(action('unrecognized'))).toMatchObject({ kind: 'completed' })
    const refreshing = deferred<void>()
    f.sessions.refresh.mockReturnValueOnce(refreshing.promise)
    const pending = f.event(action('reload'))
    await f.flush()
    f.reconnect(); refreshing.resolve()
    expect(await pending).toBeUndefined()
    expect(f.overlays.list()).toEqual([])
    f.open(); await f.flush()
    const rejected = deferred<void>()
    f.sessions.refresh.mockReturnValueOnce(rejected.promise)
    const old = f.event(action('reload'))
    await f.flush()
    f.reconnect(); rejected.reject(new Error('old refresh'))
    expect(await old).toBeUndefined()
    expect(f.overlays.list()).toEqual([])
  })
})

describe('remoteSessionListFacts', () => {
  it('pairs the listing model/effort and age fallbacks while preserving missing metadata', () => {
    const { title: _title, cwd: _cwd, ...row } = summary('bare', { running: true })
    expect(remoteSessionListFacts(row, { current: false, archived: false, reminders: new Set(), now: 5000 })).toMatchObject({ id: 'bare', lastActiveAt: 5000 })
    const facts = remoteSessionListFacts({ ...row, running: false }, { current: false, archived: true, reminders: new Set(['bare']), now: 5000, values: {
      title: '  ', agentPreset: 'coder', sessionStats: { turns: 1 }, modelSelection: { next: { provider: 'p', model: 'm', reasoningEffort: 'max' } },
    } })
    expect(facts).toMatchObject({ lastActiveAt: 1000, preset: 'coder', reminders: true, archived: true, model: { provider: 'p', model: 'm', reasoningEffort: 'max' } })
    expect(facts.title).toBeUndefined()
  })
})
