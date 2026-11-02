/** The workspace session panel: catalog and placement adoption, content
 * search, reminders, detail admission, and every archive/restore/open route.
 * @module @ephemeral-ai/mayfly/tests/interaction/session-workspace-panel
 */
import { Context } from '@deepseek-ai/cordis'
import type { SessionListValue, SessionProjectionsValue, SessionProjectionValues, SessionSearchValue, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import type { MayflyUiActionEvent } from '../../../ui/src/index.ts'
import { afterEach, expect, it, vi } from 'vitest'
import { createSessionListCache, refreshSessionList } from '../../src/interaction/session-list-reads.ts'
import { openSessionsPanel, type SessionWorkspaceScope } from '../../src/interaction/session-workspace-panel.ts'
import { interactionTranslator } from '../../src/interaction/locale.ts'
import type { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { flushRequests } from './request-fixture.ts'
import { informationFixture } from './information-fixture.ts'
import { nativeAction, select as selection } from './native-action-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

const now = Date.now()

function workspace(id: string, path: string, title: string, sessionIds: readonly string[] = []): Workspace {
  return { id: id as WorkspaceId, path, title, sessionIds, createdAt: '', updatedAt: '' } as unknown as Workspace
}

function summary(over: Partial<SessionSummary> & { readonly values?: Readonly<Record<string, unknown>> } = {}): SessionSummary {
  const { values, ...rest } = over
  return {
    sessionId: SessionId('current'), updatedAt: now - 60_000, running: false, blank: false,
    agentAvailable: false, cwd: '/repo/current',
    ...(values === undefined ? {} : { projections: { kind: 'cached', asOfSeq: 4, values: values as never } }),
    ...rest,
  } as SessionSummary
}

const CURRENT_VALUES = {
  title: 'Current',
  sessionListMetadata: { blank: false, lastPromptAt: now - 60_000 },
  tokenUsage: { uncachedInputTokens: 1200, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0 },
  sessionStats: { turns: 3, steps: 5, llmMs: 12_000, toolMs: 3_000, ttftMs: 800, ttftSteps: 3, decodeMs: 9_000, decodeTokens: 800 },
  modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-chat' }, next: { provider: 'deepseek', model: 'deepseek-chat' } },
}

async function setup() {
  const ctx = new Context(); contexts.push(ctx)
  const bench = await informationFixture(ctx)
  const alpha = workspace('alpha', '/repo/current', 'Alpha')
  const beta = workspace('beta', '/repo/other', 'Beta')
  const workspaces = [alpha, beta]
  const values: Record<string, Readonly<Record<string, unknown>>> = {
    current: CURRENT_VALUES,
    other: { title: 'Other' },
  }
  const summaries: SessionSummary[] = [
    summary({ sessionId: SessionId('current'), values: CURRENT_VALUES }),
    summary({ sessionId: SessionId('other'), cwd: '/repo/other', running: true, values: { title: 'Other' } }),
    summary({ sessionId: SessionId('child'), parentSessionId: SessionId('current'), origin: 'subagent' }),
    summary({ sessionId: SessionId('bare'), cwd: '/repo/bare' }),
    summary({ sessionId: SessionId('old'), cwd: '/repo/old', formatStatus: 'migration-required', projections: { kind: 'cached', asOfSeq: 2, values: { title: 'Old format' } } }),
  ]
  const controller = {
    list: vi.fn(async (): Promise<SessionListValue> => ({ items: [...summaries] })),
    search: vi.fn(async (): Promise<SessionSearchValue> => ({ items: [], hasMore: false })),
    projections: vi.fn(async ({ sessionId }: { sessionId: string }): Promise<SessionProjectionsValue> => ({
      kind: 'sequenced', asOfSeq: 10, values: (values[sessionId] ?? {}) as SessionProjectionValues,
    })),
  }
  const registry = {
    list: () => workspaces,
    get: (id: WorkspaceId) => workspaces.find(item => item.id === id),
    resolveByPath: vi.fn(async (path: string) => workspaces.find(item => item.path === path)),
    archivedSessionIds: [] as string[],
    archiveSession: vi.fn(async (id: string) => { registry.archivedSessionIds.push(id) }),
    unarchiveSession: vi.fn(async (id: string) => { registry.archivedSessionIds = registry.archivedSessionIds.filter(item => item !== id) }),
  }
  const subagents = { listDescendants: vi.fn(async () => [{ kind: 'child', id: 'child', parentId: 'current', mode: 'continuable', label: 'Worker' }]) }
  const schedule = { catalog: vi.fn(async () => [{ sessionId: 'other', status: 'active' }, { sessionId: 'child', status: 'active' }] as never) }
  ctx.provide('sessionController', controller as never)
  ctx.provide('workspaceRegistry', registry as never)
  ctx.provide('subagents', subagents as never)
  ctx.provide('schedule', schedule as never)
  const cache = createSessionListCache(ctx)
  await refreshSessionList(ctx, cache, new AbortController().signal)
  const t = interactionTranslator(ctx)
  const model = (): UiSurfaceModel => ctx.mayflyUiInteraction.get('overlay', 'mayfly.sessions')!
  const text = (): string => JSON.stringify(model().node)
  const detail = model
  const closers: Array<() => void> = []
  const open = async (_scope: SessionWorkspaceScope = { kind: 'workspace', workspaceId: 'alpha' as WorkspaceId, path: '/repo/current', title: 'Alpha' }): Promise<{ panel: ReturnType<typeof openSessionsPanel>, signal: AbortController }> => {
    const signal = new AbortController()
    const panel = openSessionsPanel(ctx, signal.signal, t, cache)
    closers.push(() => signal.abort())
    await flushRequests()
    await vi.waitFor(() => { expect(benchText()).toMatch(/Alpha|Could not load workspaces|Loading workspace sessions/) })
    const railId = _scope.kind === 'workspace' ? `workspace:${String(_scope.workspaceId)}` : _scope.kind === 'search' ? 'search:all' : 'workspace:unregistered'
    if (railId !== '') {
      model().emit({ kind: 'tab-change', pagePath: [], controlId: 'session-rail', tabId: railId })
      await flushRequests()
    }
    return { panel, signal }
  }
  const benchText = (): string => JSON.stringify(model().node)
  const chooseSession = async (id: string, signal?: AbortSignal) => nativeAction(model(), selection('sessions', id), signal)
  const act = async (actionId: string) => { detail().invoke(actionId); await flushRequests() }
  return {
    ...bench, controller, registry, subagents, schedule, workspaces, alpha, beta, summaries, values, cache, t, model, text, detail, open, chooseSession, act,
  }
}

it('refuses an already-aborted opening signal', async () => {
  const bench = await setup()
  const signal = new AbortController(); signal.abort()
  expect(() => openSessionsPanel(bench.ctx, signal.signal, bench.t, bench.cache)).toThrow()
})

it('adopts one workspace, filters its rows, and keeps the current badge and parent link', async () => {
  const bench = await setup()
  const { panel } = await bench.open()
  await vi.waitFor(() => { expect(bench.text()).toContain('Current') })
  expect(bench.text()).toContain('Alpha')
  expect(bench.text()).toContain('Untitled · child')
  expect(bench.text()).not.toContain('"id":"other"')
  expect(bench.text()).not.toContain('"id":"bare"')
  expect(bench.text()).toContain('current')
  expect(bench.text()).toContain('"parentId":"current"')
  await vi.waitFor(() => { expect(bench.text()).not.toContain('Loading workspace sessions…') })
  expect(panel.handle.closed).toBe(false)
})

it('opens the other and search scopes with their own titles and prompts', async () => {
  const other = await setup()
  await other.open({ kind: 'other' })
  await vi.waitFor(() => { expect(other.text()).toContain('Other sessions') })
  expect(other.text()).toContain('Untitled · bare')

  const search = await setup()
  await search.open({ kind: 'search' })
  await vi.waitFor(() => { expect(search.text()).toContain('All workspaces') })
  expect(search.text()).toContain('Enter text to search all workspaces')
})

it('searches conversation contents inside the scope and reports more matches', async () => {
  const bench = await setup()
  const { panel } = await bench.open()
  await vi.waitFor(() => { expect(bench.text()).toContain('Current') })
  bench.controller.search.mockResolvedValueOnce({
    items: [{ sessionId: SessionId('current'), snippet: 'needle in current' }, { sessionId: SessionId('other'), snippet: 'needle outside' }],
    hasMore: true,
  })
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'needle')
  bench.model().invoke('search')
  await vi.waitFor(() => { expect(bench.text()).toContain('needle in current') })
  expect(bench.text()).not.toContain('needle outside')
  expect(bench.text()).toContain('More matches exist; narrow the search.')
  expect(bench.controller.search).toHaveBeenCalledWith({ query: 'needle' }, expect.any(AbortSignal))

  bench.controller.search.mockResolvedValueOnce({ items: [], hasMore: false })
  bench.model().invoke('search')
  await flushRequests()
  expect(panel.handle.closed).toBe(false)
})

it('resumes one exact projection set for the detail sheet and shows cached migration values', async () => {
  const bench = await setup()
  await bench.open()
  await vi.waitFor(() => { expect(bench.text()).toContain('Current') })
  bench.controller.projections.mockResolvedValueOnce({
    kind: 'sequenced', asOfSeq: 25,
    values: { ...CURRENT_VALUES, title: 'Fresh native title', agentPreset: 'standard' } as SessionProjectionValues,
  })
  await bench.chooseSession('current')
  expect(bench.controller.projections).toHaveBeenCalledWith({ sessionId: 'current' }, expect.any(AbortSignal))
  const node = JSON.stringify(bench.detail().node)
  expect(node).toContain('Fresh native title')
  expect(node).toContain('standard')
  expect(node).toContain('deepseek-chat (deepseek)')
  expect(node).toContain('3 turns · 5 steps')

  await bench.open({ kind: 'other' })
  await vi.waitFor(() => { expect(bench.text()).toContain('Old format') })
  bench.controller.projections.mockResolvedValueOnce({
    kind: 'migration-required',
    values: { title: 'Cached title', tokenUsage: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } } as SessionProjectionValues,
  })
  await bench.chooseSession('old')
  const old = JSON.stringify(bench.detail().node)
  expect(old).toContain('Cached title')
  expect(old).toContain('migration required')
  expect(old).toContain('This session uses an older saved format; its details show the last saved values. Open it to finish the migration.')
})

it('refuses empty, stale, aborted, absent, and failed detail reads', async () => {
  const bench = await setup()
  await bench.open()
  await vi.waitFor(() => { expect(bench.text()).toContain('Current') })
  bench.model().invoke('search')
  await flushRequests()
  expect(bench.controller.search).not.toHaveBeenCalled()
  expect(bench.model().feedbackSnapshot().some(item => item.message === 'Enter search text')).toBe(true)
  expect(await nativeAction(bench.model(), selection('sessions', 'missing'))).toMatchObject({ kind: 'failed' })

  const aborted = new AbortController(); aborted.abort()
  expect(await bench.chooseSession('current', aborted.signal)).toBeUndefined()

  const during = new AbortController()
  const read = Promise.withResolvers<SessionProjectionsValue>()
  bench.controller.projections.mockReturnValueOnce(read.promise)
  const pending = bench.chooseSession('current', during.signal)
  await vi.waitFor(() => { expect(bench.controller.projections).toHaveBeenCalled() })
  during.abort()
  read.resolve({ kind: 'sequenced', asOfSeq: 1, values: {} })
  expect(await pending).toBeUndefined()

  bench.controller.projections.mockResolvedValueOnce(null)
  expect(await bench.chooseSession('current')).toMatchObject({ kind: 'failed', message: expect.stringContaining('no longer available') })
  bench.controller.projections.mockRejectedValueOnce(new Error('corrupt log'))
  expect(await bench.chooseSession('current')).toMatchObject({ kind: 'failed', message: expect.stringContaining('corrupt log') })

})

it('opens root sessions by resume and every continuable child by address', async () => {
  const bench = await setup()
  const resume = vi.fn(); bench.ctx.on('mayfly/request-resume', resume)
  await bench.open()
  await bench.chooseSession('current')
  await bench.act('open')
  expect(resume).toHaveBeenCalledWith('current')

  await bench.open()
  await vi.waitFor(() => { expect(bench.text()).toContain('Untitled · child') })
  await bench.chooseSession('child')
  await bench.act('open')
  expect(bench.ctx.mayflyConversations.displayed()).toMatchObject({ kind: 'subagent', sessionId: 'child', parentSessionId: 'current' })
})

it('explains every refused subagent open: no lead, changed lead, missing child, external child', async () => {
  const bench = await setup()
  vi.spyOn(bench.ctx.mayflyCurrentAgent, 'primary').mockReturnValue(null)
  await bench.open()
  await bench.chooseSession('child')
  await bench.act('open')
  expect(bench.detail().feedbackSnapshot().map(item => item.message).join('\n')).toContain('Open the lead session first')

  vi.restoreAllMocks()
  const changed = await setup()
  await changed.open()
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof changed.subagents.listDescendants>>>()
  changed.subagents.listDescendants.mockReturnValueOnce(gate.promise)
  await changed.chooseSession('child')
  changed.detail().invoke('open')
  await vi.waitFor(() => { expect(changed.subagents.listDescendants).toHaveBeenCalled() })
  vi.spyOn(changed.ctx.mayflyCurrentAgent, 'primary').mockReturnValue({ id: 'other' } as never)
  gate.resolve([{ kind: 'child', id: 'child', parentId: 'current', mode: 'continuable' }] as never)
  await vi.waitFor(() => { expect(changed.detail().feedbackSnapshot().map(item => item.message).join('\n')).toContain('The lead session changed') })

  const missing = await setup()
  await missing.open()
  missing.subagents.listDescendants.mockResolvedValueOnce([])
  await missing.chooseSession('child')
  await missing.act('open')
  expect(missing.detail().feedbackSnapshot().map(item => item.message).join('\n')).toContain('Open this child’s lead session first')

  const external = await setup()
  await external.open()
  external.subagents.listDescendants.mockResolvedValueOnce([{ kind: 'child', id: 'child', parentId: 'current', mode: 'external' }] as never)
  await external.chooseSession('child')
  await external.act('open')
  expect(external.detail().feedbackSnapshot().map(item => item.message).join('\n')).toContain('External subagents have no local conversation')
})

it('cancels a subagent open when its lifetime aborts during the descendant read', async () => {
  const bench = await setup()
  await bench.open()
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof bench.subagents.listDescendants>>>()
  bench.subagents.listDescendants.mockReturnValueOnce(gate.promise)
  const signal = new AbortController()
  await bench.chooseSession('child')
  const pending = bench.detail().endpoint.prepare({ kind: 'activate', pagePath: [], controlId: 'session-detail-actions', actionId: 'open' }, {
    surfaceId: bench.detail().id, operationId: 'open-child', source: [], revision: bench.detail().revision, signal: signal.signal, report: vi.fn(),
  })
  await vi.waitFor(() => { expect(bench.subagents.listDescendants).toHaveBeenCalled() })
  signal.abort()
  gate.resolve([])
  expect(await pending).toMatchObject({ reply: undefined })
})

it('refuses Open on an archived session and surfaces active-session archive admission', async () => {
  const archived = await setup()
  archived.registry.archivedSessionIds = ['current']
  await archived.open()
  await archived.chooseSession('current')
  expect(JSON.stringify(archived.detail().node)).toContain('Restore the session first')

  const active = await setup()
  await active.open({ kind: 'workspace', workspaceId: 'beta' as WorkspaceId, path: '/repo/other', title: 'Beta' })
  await active.chooseSession('other')
  active.registry.archiveSession.mockRejectedValueOnce(new WorkspaceActiveSessionError('other' as never, [{ kind: 'turn', items: [{ text: 'working' }] }] as never))
  active.detail().invoke('archive')
  active.detail().answerDecision(true)
  await flushRequests()
  await vi.waitFor(() => { expect(JSON.stringify(active.detail().node)).toContain('Stop activity and archive') })
  expect(JSON.stringify(active.detail().node)).toContain('turn:')
  expect(JSON.stringify(active.detail().node)).toContain('working')
  active.detail().invoke('stop-archive')
  active.detail().answerDecision(true)
  await vi.waitFor(() => { expect(active.registry.archiveSession).toHaveBeenLastCalledWith('other', { stopActivity: true }) })
  expect(active.ctx.mayflyUiInteraction.get('overlay', 'mayfly.sessions.detail')).toBeUndefined()

  const restore = await setup()
  restore.registry.archivedSessionIds = ['other']
  await restore.open({ kind: 'workspace', workspaceId: 'beta' as WorkspaceId, path: '/repo/other', title: 'Beta' })
  await restore.chooseSession('other')
  restore.detail().invoke('restore')
  restore.detail().answerDecision(true)
  await vi.waitFor(() => { expect(restore.registry.unarchiveSession).toHaveBeenCalledWith('other') })
})

it('rejects an unexpected archive failure and honours a plain close action', async () => {
  const bench = await setup()
  await bench.open({ kind: 'workspace', workspaceId: 'beta' as WorkspaceId, path: '/repo/other', title: 'Beta' })
  await bench.chooseSession('other')
  bench.registry.archiveSession.mockRejectedValueOnce(new Error('disk unavailable'))
  const action = bench.detail().endpoint.prepare({ kind: 'activate', pagePath: [], controlId: 'session-detail-actions', actionId: 'archive' }, {
    surfaceId: bench.detail().id, operationId: 'archive', source: [], revision: bench.detail().revision, signal: new AbortController().signal, report: vi.fn(),
  })
  bench.detail().answerDecision(true)
  await expect(action).rejects.toThrow('disk unavailable')
})

it('shows reminder badges, degrades a failing Host catalog, and works without Schedule', async () => {
  const bench = await setup()
  const warn = vi.spyOn(bench.ctx.logger, 'warn').mockImplementation(() => {})
  bench.schedule.catalog.mockRejectedValueOnce(new Error('catalog down'))
  await bench.open()
  await vi.waitFor(() => { expect(bench.text()).toContain('Current') })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('catalog down'))
  expect(bench.text()).not.toContain('reminders')

  const healthy = await setup()
  await healthy.open()
  await vi.waitFor(() => { expect(healthy.text()).toContain('reminders') })

  const absent = await setup()
  absent.ctx.set('schedule', undefined)
  await absent.open()
  await vi.waitFor(() => { expect(absent.text()).toContain('Current') })
  expect(absent.text()).not.toContain('reminders')
})

it('reports a failed initial catalog and a failed catalog refresh', async () => {
  const bench = await setup()
  vi.spyOn(bench.registry, 'list').mockImplementation(() => { throw new Error('disk unavailable') })
  const { panel } = await bench.open()
  await vi.waitFor(() => { expect(bench.text()).toContain('Could not load workspaces: Error: disk unavailable') })
  expect(panel.handle.closed).toBe(false)
  expect(bench.text()).toContain('No sessions')
})

it('searches every workspace from the explicit global scope', async () => {
  const bench = await setup()
  bench.summaries.push(summary({ sessionId: SessionId('free'), cwd: '/repo/free', values: { title: 'Free' } }))
  await bench.open({ kind: 'search' })
  bench.controller.search.mockResolvedValueOnce({
    items: [{ sessionId: SessionId('current'), snippet: 'global current' }, { sessionId: SessionId('free'), snippet: 'global free' }],
    hasMore: false,
  })
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'global')
  bench.model().invoke('search')
  await vi.waitFor(() => { expect(bench.text()).toContain('global current') })
  expect(bench.text()).toContain('global free')
})

it('cleans up and rethrows when the overlay registry cannot open', async () => {
  const bench = await setup()
  vi.spyOn(bench.ctx.mayflyOverlays, 'open').mockImplementation(() => { throw new Error('registry down') })
  expect(() => openSessionsPanel(bench.ctx, new AbortController().signal, bench.t, bench.cache)).toThrow()
  await flushRequests()
  expect(bench.ctx.mayflyOverlays.list()).toEqual([])
})

it('answers non-activate and unknown detail events and refuses an archived open directly', async () => {
  const bench = await setup()
  await bench.open()
  await bench.chooseSession('current')
  const detail = bench.detail()
  const context = { surfaceId: detail.id, operationId: 'detail', source: [], revision: detail.revision, signal: new AbortController().signal, report: vi.fn() }
  expect(await detail.endpoint.prepare({ kind: 'dismiss', pagePath: [] }, context)).toMatchObject({ reply: { kind: 'completed' } })
  const workspaceContext = { surfaceId: bench.model().id, operationId: 'workspace', source: [], revision: bench.model().revision, signal: new AbortController().signal, report: vi.fn() }
  expect(await bench.model().endpoint.prepare({ kind: 'dismiss', pagePath: [] }, workspaceContext)).toMatchObject({ reply: { kind: 'completed' } })
  expect(await detail.endpoint.prepare({ kind: 'activate', pagePath: [], controlId: 'session-detail-actions', actionId: 'close' }, context)).toMatchObject({ reply: { kind: 'completed' } })

  const archived = await setup()
  archived.registry.archivedSessionIds = ['current']
  await archived.open()
  await archived.chooseSession('current')
  const archivedDetail = archived.detail()
  const refused = await archivedDetail.endpoint.prepare(
    { kind: 'activate', pagePath: [], controlId: 'session-detail-actions', actionId: 'open' },
    { surfaceId: archivedDetail.id, operationId: 'open', source: [], revision: archivedDetail.revision, signal: new AbortController().signal, report: vi.fn() },
  )
  expect(refused).toMatchObject({ reply: { kind: 'failed', message: 'Restore the session first' } })
})

it('cancels a detail read rejected after its signal aborts', async () => {
  const bench = await setup()
  await bench.open()
  await vi.waitFor(() => { expect(bench.text()).toContain('Current') })
  const read = Promise.withResolvers<SessionProjectionsValue>()
  bench.controller.projections.mockReturnValueOnce(read.promise)
  const signal = new AbortController()
  const pending = bench.chooseSession('current', signal.signal)
  await vi.waitFor(() => { expect(bench.controller.projections).toHaveBeenCalled() })
  signal.abort()
  read.reject(new Error('late read failure'))
  expect(await pending).toBeUndefined()
})

it('cancels an archive after its signal aborts during the native write', async () => {
  const bench = await setup()
  await bench.open({ kind: 'workspace', workspaceId: 'beta' as WorkspaceId, path: '/repo/other', title: 'Beta' })
  await bench.chooseSession('other')
  const gate = Promise.withResolvers<void>()
  bench.registry.archiveSession.mockReturnValueOnce(gate.promise)
  const signal = new AbortController()
  const detail = bench.detail()
  const pending = detail.endpoint.prepare(
    { kind: 'activate', pagePath: [], controlId: 'session-detail-actions', actionId: 'archive' },
    { surfaceId: detail.id, operationId: 'archive', source: [], revision: detail.revision, signal: signal.signal, report: vi.fn() },
  )
  await vi.waitFor(() => { expect(bench.registry.archiveSession).toHaveBeenCalled() })
  signal.abort()
  gate.resolve()
  expect(await pending).toMatchObject({ reply: undefined })
})

it('keeps a search row badge and answers a no-op action and an empty selection', async () => {
  const bench = await setup()
  await bench.open({ kind: 'workspace', workspaceId: 'beta' as WorkspaceId, path: '/repo/other', title: 'Beta' })
  await vi.waitFor(() => { expect(bench.text()).toContain('Other') })
  bench.controller.search.mockResolvedValueOnce({ items: [{ sessionId: SessionId('other'), snippet: 'running hit' }], hasMore: false })
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'running')
  bench.model().invoke('search')
  await vi.waitFor(() => { expect(bench.text()).toContain('running hit') })
  expect(bench.text()).toContain('"badge":"running · reminders"')
  await expect(nativeAction(bench.model(), { kind: 'activate', pagePath: [], controlId: 'session-actions', actionId: 'not-an-action' })).resolves.toMatchObject({ kind: 'completed' })
  await expect(nativeAction(bench.model(), selection('sessions'))).resolves.toMatchObject({ kind: 'failed', message: 'Session is no longer listed; refresh the catalog.' })
})

it('opens a child with no native label under its id', async () => {
  const bench = await setup()
  bench.subagents.listDescendants.mockResolvedValueOnce([{ kind: 'child', id: 'child', parentId: 'current', mode: 'continuable' }] as never)
  await bench.open()
  await bench.chooseSession('child')
  await bench.act('open')
  expect(bench.ctx.mayflyConversations.displayed()).toMatchObject({ kind: 'subagent', sessionId: 'child', label: 'child' })
})

it('renders an active-session error whose activity items are absent', async () => {
  const bench = await setup()
  await bench.open({ kind: 'workspace', workspaceId: 'beta' as WorkspaceId, path: '/repo/other', title: 'Beta' })
  await bench.chooseSession('other')
  bench.registry.archiveSession.mockRejectedValueOnce(new WorkspaceActiveSessionError('other' as never, [{ kind: 'turn' }] as never))
  bench.detail().invoke('archive')
  bench.detail().answerDecision(true)
  await flushRequests()
  await vi.waitFor(() => { expect(JSON.stringify(bench.detail().node)).toContain('turn: []') })
})

it('cancels a detail action whose panel signal aborted while the projection was read', async () => {
  const bench = await setup()
  const { signal } = await bench.open()
  await vi.waitFor(() => { expect(bench.text()).toContain('Current') })
  const read = Promise.withResolvers<SessionProjectionsValue>()
  bench.controller.projections.mockReturnValueOnce(read.promise)
  const pending = bench.chooseSession('current', signal.signal)
  await vi.waitFor(() => { expect(bench.controller.projections).toHaveBeenCalled() })
  signal.abort()
  read.resolve({ kind: 'sequenced', asOfSeq: 1, values: {} })
  await expect(pending).resolves.toBeUndefined()
})

it('drops the cwd segment of a search row whose summary has none', async () => {
  const bench = await setup()
  bench.summaries.push(summary({ sessionId: SessionId('nocwd'), cwd: undefined as never, values: { title: 'No cwd' } }))
  await bench.open({ kind: 'search' })
  bench.controller.search.mockResolvedValueOnce({ items: [{ sessionId: SessionId('nocwd'), snippet: 'no cwd hit' }], hasMore: false })
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'nocwd')
  bench.model().invoke('search')
  await vi.waitFor(() => { expect(bench.text()).toContain('no cwd hit') })
  expect(bench.text()).toContain('"searchText":"No cwd nocwd  no cwd hit"')
})

it('contains an initial catalog failure after the opening signal aborted', async () => {
  const bench = await setup()
  vi.spyOn(bench.registry, 'list').mockImplementation(() => { throw new Error('placement list failed') })
  const signal = new AbortController()
  const panel = openSessionsPanel(bench.ctx, signal.signal, bench.t, bench.cache)
  expect(panel.handle).toBeDefined()
  signal.abort()
  await flushRequests()
})

function callbacks(bench: Awaited<ReturnType<typeof setup>>) {
  const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === 'mayfly.sessions')!
  const context = (signal = new AbortController().signal) => ({ surfaceId: entry.id, source: entry.source, revision: entry.revision, operationId: 'workspace-queued', signal, report: vi.fn() })
  const action = (event: MayflyUiActionEvent, signal?: AbortSignal) => entry.definition.onEvent!.action!(event, context(signal))
  const activate = (actionId: string, signal?: AbortSignal) => action({ kind: 'activate', pagePath: [], controlId: 'session-actions', actionId }, signal)
  const search = (signal?: AbortSignal) => action({ kind: 'activate', pagePath: [], controlId: 'session-search', actionId: 'search', inputs: {
    actionId: 'search', source: entry.source, draftRevision: 0,
    forms: [{ pagePath: [], formId: 'content-search', draftRevision: 0, fields: [{ id: 'query', change: 'set', value: 'native match' }] }],
  } }, signal)
  return { entry, context, action, activate, search }
}

it('ignores unrelated rail observations and queued actions, and clears details removed by a native refresh', async () => {
  const bench = await setup()
  await bench.open()
  const f = callbacks(bench)
  await f.entry.definition.onEvent!.observe!({ kind: 'focus-change', pagePath: [], controlId: 'session-rail' }, f.context())
  await f.entry.definition.onEvent!.observe!({ kind: 'tab-change', pagePath: [], controlId: 'foreign', tabId: 'search:all' }, f.context())
  await f.entry.definition.onEvent!.observe!({ kind: 'tab-change', pagePath: [], controlId: 'session-rail', tabId: 'workspace:missing' }, f.context())
  expect(await f.action({ kind: 'token-remove', pagePath: [], controlId: 'foreign', tokenId: 'queued' })).toMatchObject({ kind: 'completed' })
  await bench.chooseSession('current')
  expect(await f.activate('unrelated')).toMatchObject({ kind: 'completed' })
  bench.summaries.splice(bench.summaries.findIndex(item => item.sessionId === 'current'), 1)
  expect(await f.activate('reload')).toMatchObject({ kind: 'completed' })
  expect(bench.text()).not.toContain('3 turns · 5 steps')
  expect(bench.text()).not.toContain('"id":"current"')
})

it('uses the native empty workspace title path and keeps global search through reload', async () => {
  const bench = await setup()
  bench.workspaces[0] = workspace('alpha', '/repo/current', '')
  openSessionsPanel(bench.ctx, new AbortController().signal, bench.t, bench.cache)
  await flushRequests()
  expect(bench.text()).toContain('"title":"/repo/current"')
  const f = callbacks(bench)
  await f.activate('search-all')
  await f.activate('reload')
  expect(bench.text()).toContain('Enter text to search all workspaces')
})

it.each(['count', 'first', 'empty', 'other removed'] as const)('chooses a valid remaining rail after %s', async kind => {
  const bench = await setup()
  if (kind === 'other removed') {
    await bench.open({ kind: 'other' })
    bench.summaries.splice(0, bench.summaries.length, summary({ sessionId: SessionId('other'), cwd: '/repo/other' }))
    await callbacks(bench).activate('reload')
    expect(bench.text()).toContain('"activeId":"workspace:alpha"')
    return
  }
  vi.spyOn(bench.ctx.mayflyConversations, 'primary').mockReturnValue(null)
  bench.registry.resolveByPath.mockResolvedValue(undefined)
  bench.summaries.splice(0, bench.summaries.length, ...(kind === 'count' ? [summary({ cwd: '/repo/other' })] : []))
  if (kind === 'empty') bench.workspaces.splice(0)
  const panel = openSessionsPanel(bench.ctx, new AbortController().signal, bench.t, bench.cache)
  await flushRequests()
  expect(panel.handle.closed).toBe(false)
  expect(bench.text()).toContain(kind === 'count' ? '"activeId":"workspace:beta"' : kind === 'first' ? '"activeId":"workspace:alpha"' : 'Enter text to search all workspaces')
})

it.each(['/repo/bare', '/repo/current'])('fences both placement adoption boundaries at %s', async path => {
  for (const ended of ['generation', 'caller', 'closure'] as const) {
    const bench = await setup()
    const { panel } = await bench.open()
    const original = bench.registry.resolveByPath.getMockImplementation()!
    const gate = Promise.withResolvers<Workspace | undefined>()
    let held = false
    bench.registry.resolveByPath.mockImplementation(async value => {
      if (!held && value === path) { held = true; return gate.promise }
      return original(value)
    })
    const f = callbacks(bench)
    const caller = new AbortController()
    const pending = f.activate('refresh', caller.signal)
    await vi.waitFor(() => expect(held).toBe(true))
    if (ended === 'generation') {
      bench.summaries.splice(0, 1, summary({ values: { title: 'New catalog generation' } }))
      await f.activate('refresh')
    } else if (ended === 'caller') caller.abort()
    else panel.handle.close()
    gate.resolve(bench.workspaces.find(item => item.path === path))
    expect(await pending).toMatchObject({ kind: ended === 'generation' ? 'completed' : 'cancelled' })
    if (ended === 'generation') expect(bench.text()).toContain('New catalog generation')
    if (ended === 'closure') expect(bench.model()).toBeUndefined()
  }
})

it('contains reminder refusals after the panel closes and tolerates a failed current-workspace resolution', async () => {
  const bench = await setup()
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof bench.schedule.catalog>>>()
  bench.schedule.catalog.mockReturnValueOnce(gate.promise)
  bench.registry.resolveByPath.mockRejectedValue(new Error('canonical path unavailable'))
  const warn = vi.spyOn(bench.ctx.logger, 'warn').mockImplementation(() => {})
  const { panel } = await bench.open()
  panel.handle.close()
  gate.reject(new Error('late reminder catalog refusal'))
  await flushRequests()
  expect(warn).not.toHaveBeenCalled()
})

it('admits an initial native tab observation before its overlay handle is returned', async () => {
  const bench = await setup()
  let observed = false
  const off = bench.ctx.mayflyOverlays.subscribe(delta => {
    if (observed || delta.kind !== 'upsert' || delta.entry.id !== 'mayfly.sessions') return
    observed = true
    void delta.entry.definition.onEvent!.observe!({ kind: 'tab-change', pagePath: [], controlId: 'session-rail', tabId: 'search:all' }, {
      surfaceId: delta.entry.id, source: delta.entry.source, revision: delta.entry.revision, operationId: 'initial-tab', signal: new AbortController().signal, report: vi.fn(),
    })
  })
  const panel = openSessionsPanel(bench.ctx, new AbortController().signal, bench.t, bench.cache)
  off()
  await flushRequests()
  expect(panel.handle.closed).toBe(false)
  expect(bench.text()).toContain('Enter text to search all workspaces')
})

it('refreshes newly discovered native search matches and filters missing search rows through the new catalog', async () => {
  const bench = await setup()
  await bench.open({ kind: 'search' })
  bench.summaries.push(summary({ sessionId: SessionId('found'), values: { title: 'Newly indexed conversation' } }))
  bench.controller.search.mockResolvedValueOnce({ items: [{ sessionId: SessionId('found'), snippet: 'new native match' }, { sessionId: SessionId('gone'), snippet: 'removed native match' }], hasMore: false })
  expect(await callbacks(bench).search()).toMatchObject({ kind: 'completed' })
  expect(bench.text()).toContain('Newly indexed conversation')
  expect(bench.text()).toContain('new native match')
  expect(bench.text()).not.toContain('removed native match')
})

it.each(['search', 'search refresh', 'reload', 'archive refresh'] as const)('retires a cancelled %s continuation', async kind => {
  const bench = await setup()
  await bench.open()
  const f = callbacks(bench)
  const caller = new AbortController()
  let pending: ReturnType<typeof f.action>
  const settle: (() => void)[] = []
  if (kind === 'search') {
    const gate = Promise.withResolvers<SessionSearchValue>()
    bench.controller.search.mockReturnValueOnce(gate.promise)
    pending = f.search(caller.signal)
    settle.push(() => gate.resolve({ items: [], hasMore: false }))
  } else {
    if (kind === 'archive refresh') await bench.chooseSession('current')
    const gate = Promise.withResolvers<SessionListValue>()
    bench.controller.list.mockReturnValueOnce(gate.promise)
    if (kind === 'search refresh') {
      bench.controller.search.mockResolvedValueOnce({ items: [{ sessionId: SessionId('new'), snippet: 'late match' }], hasMore: false })
      pending = f.search(caller.signal)
    } else pending = f.activate(kind === 'reload' ? 'reload' : 'archive', caller.signal)
    await vi.waitFor(() => expect(bench.controller.list).toHaveBeenCalledTimes(3))
    settle.push(() => gate.resolve({ items: [...bench.summaries] }))
  }
  caller.abort()
  for (const resolve of settle) resolve()
  expect(await pending).toMatchObject({ kind: 'cancelled' })
})

