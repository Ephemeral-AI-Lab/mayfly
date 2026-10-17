/** Native session browsing through the Session Controller and Workspace registry.
 * @module @ephemeral-ai/mayfly/tests/interaction/native-sessions
 */
import { Context } from '@deepseek-ai/cordis'
import type { SessionListValue, SessionProjectionsValue, SessionProjectionValues, SessionSearchValue, SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, it, vi } from 'vitest'
import { informationFixture } from './information-fixture.ts'
import { flushRequests } from './request-fixture.ts'
import { nativeAction, select as selection } from './native-action-fixture.ts'
import { createSessionListCache } from '../../src/interaction/session-list-reads.ts'
import { openSessionWorkspace } from '../../src/interaction/session-workspace-panel.ts'
import { openSessions } from '../../src/interaction/native-sessions.ts'
import { interactionTranslator } from '../../src/interaction/locale.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

const now = Date.now()

function workspace(id: string, path: string, title: string): Workspace {
  return { id: id as WorkspaceId, path, title, sessionIds: [], createdAt: '', updatedAt: '' } as unknown as Workspace
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
    list: vi.fn(async (): Promise<SessionListValue> => ({ items: summaries })),
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
  const rootModel = () => ctx.mayflyUiInteraction.get('overlay', 'mayfly.sessions')!
  const model = (id = 'mayfly.sessions.workspace') => ctx.mayflyUiInteraction.get('overlay', id)!
  const rootText = () => JSON.stringify(rootModel().node)
  const text = () => JSON.stringify(model().node)
  const openRoot = async (signal = new AbortController().signal) => {
    const result = await openSessions(ctx, signal, interactionTranslator(ctx), cache)
    await flushRequests()
    await vi.waitFor(() => { expect(rootText()).toContain('workspace:alpha') })
    return result
  }
  const choose = async (rowId: string) => {
    await nativeAction(rootModel(), selection('workspaces', rowId))
    await vi.waitFor(() => { expect(ctx.mayflyOverlays.list().map(item => item.id)).toContain('mayfly.sessions.workspace') })
    await vi.waitFor(() => { expect(model().node).not.toBeNull() })
  }
  const open = async (rowId = 'workspace:alpha') => { const result = await openRoot(); await choose(rowId); return result }
  const chooseSession = async (id: string) => { await nativeAction(model(), selection('sessions', id)); await flushRequests() }
  const detail = () => model('mayfly.sessions.detail')
  const act = async (id: string, modelId = 'mayfly.sessions.detail') => { model(modelId).invoke(id); await flushRequests() }
  return { ...bench, controller, registry, subagents, schedule, workspaces, alpha, beta, summaries, values, cache, rootModel, model, rootText, text, openRoot, choose, open, chooseSession, detail, act }
}

it('groups native workspaces and unowned sessions without reading projections', async () => {
  const bench = await setup()
  expect(await bench.openRoot()).toEqual({ kind: 'success' })
  const node = bench.rootText()
  expect(node).toContain('Alpha')
  expect(node).toContain('Beta')
  expect(node).toContain('2 sessions')
  expect(node).toContain('1 session')
  expect(node).toContain('Other sessions')
  expect(bench.controller.list).toHaveBeenCalledOnce()
  expect(bench.controller.projections).not.toHaveBeenCalled()
})

it('opens one workspace scope and lists only its native summaries', async () => {
  const bench = await setup()
  await bench.open('workspace:alpha')
  await vi.waitFor(() => { expect(bench.text()).toContain('Current') })
  const node = bench.text()
  expect(node).toContain('Current')
  expect(node).toContain('Untitled · child')
  expect(node).not.toContain('Other')
  expect(node).not.toContain('bare')
  expect(bench.controller.list).toHaveBeenCalledOnce()
  expect(bench.controller.projections).not.toHaveBeenCalled()
})

it('reads one exact projection set for the detail sheet and never activates the Session', async () => {
  const bench = await setup()
  const sessionsBefore = bench.ctx.sessions.list()
  await bench.open('workspace:alpha')
  bench.controller.projections.mockResolvedValueOnce({
    kind: 'sequenced', asOfSeq: 25,
    values: { ...CURRENT_VALUES, title: 'Fresh native title', agentPreset: 'standard' } as SessionProjectionValues,
  })
  await bench.chooseSession('current')
  const node = JSON.stringify(bench.detail().node)
  expect(bench.controller.projections).toHaveBeenCalledWith({ sessionId: 'current' }, expect.any(AbortSignal))
  expect(node).toContain('Fresh native title')
  expect(node).toContain('standard')
  expect(node).toContain('2k (input 1.2k')
  expect(node).toContain('deepseek-chat (deepseek)')
  expect(node).toContain('3 turns · 5 steps')
  expect(bench.ctx.sessions.list()).toEqual(sessionsBefore)
})

it('shows cached values and a localized notice when migration is required', async () => {
  const bench = await setup()
  await bench.open('workspace:unregistered')
  await vi.waitFor(() => { expect(bench.text()).toContain('Old format') })
  bench.controller.projections.mockResolvedValueOnce({
    kind: 'migration-required',
    values: { title: 'Cached title', tokenUsage: { uncachedInputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 } } as SessionProjectionValues,
  })
  await bench.chooseSession('old')
  const node = JSON.stringify(bench.detail().node)
  expect(node).toContain('Cached title')
  expect(node).toContain('migration required')
  expect(node).toContain('This session uses an older saved format; its details show the last saved values. Open it to finish the migration.')
})

it('filters content search to the open scope and reports more matches', async () => {
  const bench = await setup()
  await bench.open('workspace:alpha')
  await vi.waitFor(() => { expect(bench.text()).toContain('Current') })
  bench.controller.search.mockResolvedValueOnce({
    items: [{ sessionId: SessionId('current'), snippet: 'needle in current' }, { sessionId: SessionId('other'), snippet: 'needle outside' }],
    hasMore: true,
  })
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'needle')
  await bench.act('search', 'mayfly.sessions.workspace')
  await vi.waitFor(() => { expect(bench.text()).toContain('needle in current') })
  expect(bench.text()).not.toContain('needle outside')
  expect(bench.controller.search).toHaveBeenCalledWith({ query: 'needle' }, expect.any(AbortSignal))
})

it('searches every workspace from the explicit global scope', async () => {
  const bench = await setup()
  await bench.openRoot()
  await bench.rootModel().invoke('search-all')
  await vi.waitFor(() => { expect(bench.text()).toContain('All workspaces') })
  await vi.waitFor(() => { expect(bench.text()).not.toContain('Loading workspace sessions…') })
  bench.controller.search.mockResolvedValueOnce({
    items: [{ sessionId: SessionId('current'), snippet: 'global current' }, { sessionId: SessionId('other'), snippet: 'global other' }],
    hasMore: false,
  })
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'global')
  await bench.act('search', 'mayfly.sessions.workspace')
  await vi.waitFor(() => { expect(bench.text()).toContain('global current') })
  expect(bench.text()).toContain('global other')
})

it('preserves native archive admission and stop-and-archive', async () => {
  const bench = await setup()
  await bench.open('workspace:beta')
  await bench.chooseSession('other')
  bench.registry.archiveSession.mockRejectedValueOnce(new WorkspaceActiveSessionError('other' as never, [{ kind: 'turn' }]))
  await bench.act('archive')
  await bench.detail().answerDecision(true)
  await flushRequests()
  expect(JSON.stringify(bench.detail().node)).toContain('Stop activity and archive')
  await bench.act('stop-archive')
  await bench.detail().answerDecision(true)
  await flushRequests()
  expect(bench.registry.archiveSession).toHaveBeenLastCalledWith('other', { stopActivity: true })
  await bench.chooseSession('other')
  expect(JSON.stringify(bench.detail().node)).toContain('Restore the session first')
  await bench.act('restore')
  await bench.detail().answerDecision(true)
  await flushRequests()
  expect(bench.registry.unarchiveSession).toHaveBeenCalledWith('other')
})

it('opens root sessions by resume and subagent children by address', async () => {
  const bench = await setup()
  const resume = vi.fn(); bench.ctx.on('mayfly/request-resume', resume)
  await bench.open('workspace:alpha')
  await bench.chooseSession('current')
  await bench.act('open')
  expect(resume).toHaveBeenCalledWith('current')
  await bench.open('workspace:alpha')
  await bench.chooseSession('child')
  await bench.act('open')
  expect(bench.ctx.mayflyConversations.displayed()).toMatchObject({ kind: 'subagent', sessionId: 'child', parentSessionId: 'current', access: 'resumable' })
  bench.subagents.listDescendants.mockResolvedValueOnce([])
  await bench.open('workspace:alpha')
  await bench.chooseSession('child')
  await bench.act('open')
  expect(bench.detail().feedbackSnapshot().some(item => item.message.includes('lead session'))).toBe(true)
})

it('contains catalog failures and discards a late listing after closing', async () => {
  const bench = await setup()
  const gate = Promise.withResolvers<SessionListValue>()
  bench.controller.list.mockReturnValueOnce(gate.promise)
  expect(await openSessions(bench.ctx, new AbortController().signal, interactionTranslator(bench.ctx), bench.cache)).toEqual({ kind: 'success' })
  expect(bench.rootText()).toContain('Loading workspaces')
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  gate.reject(new Error('disk unavailable'))
  await flushRequests()
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
  bench.controller.list.mockRejectedValueOnce(new Error('disk unavailable'))
  expect(await openSessions(bench.ctx, new AbortController().signal, interactionTranslator(bench.ctx), bench.cache)).toEqual({ kind: 'success' })
  await vi.waitFor(() => { expect(bench.rootText()).toContain('disk unavailable') })
})

it('shows reminder badges and degrades when the Host catalog fails', async () => {
  const bench = await setup()
  const warn = vi.spyOn(bench.ctx.logger, 'warn').mockImplementation(() => {})
  const schedule = bench.ctx.get('schedule') as unknown as { catalog: ReturnType<typeof vi.fn> }
  schedule.catalog.mockRejectedValueOnce(new Error('catalog down'))
  await bench.open('workspace:beta')
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('catalog down'))
  await vi.waitFor(() => { expect(bench.text()).toContain('Other') })
  expect(bench.text()).not.toContain('reminders')
  await bench.open('workspace:beta')
  await vi.waitFor(() => { expect(bench.text()).toContain('reminders') })
})

it('refuses an empty search and stale selections', async () => {
  const bench = await setup()
  await bench.open('workspace:alpha')
  await vi.waitFor(() => { expect(bench.text()).toContain('Current') })
  bench.model().invoke('search')
  await flushRequests()
  expect(bench.controller.search).not.toHaveBeenCalled()
  expect(bench.model().feedbackSnapshot().some(item => item.message === 'Enter search text')).toBe(true)
  expect(await nativeAction(bench.model(), selection('sessions', 'missing'))).toMatchObject({ kind: 'failed' })
  expect(await nativeAction(bench.rootModel(), selection('workspaces', 'missing'))).toMatchObject({ kind: 'failed' })
})

it('does not open a detail for an absent projection and contains a read failure', async () => {
  const bench = await setup()
  await bench.open('workspace:beta')
  bench.controller.projections.mockResolvedValueOnce(null)
  expect(await nativeAction(bench.model(), selection('sessions', 'other'))).toMatchObject({ kind: 'failed', message: expect.stringContaining('no longer available') })
  bench.controller.projections.mockRejectedValueOnce(new Error('corrupt log'))
  expect(await nativeAction(bench.model(), selection('sessions', 'other'))).toMatchObject({ kind: 'failed', message: expect.stringContaining('corrupt log') })
})

it('focuses an existing catalog without repeating reads and ignores an aborted invocation', async () => {
  const bench = await setup()
  const aborted = new AbortController(); aborted.abort()
  expect(await openSessions(bench.ctx, aborted.signal, interactionTranslator(bench.ctx), bench.cache)).toEqual({ kind: 'success' })
  expect(bench.controller.list).not.toHaveBeenCalled()
  await bench.openRoot()
  await openSessions(bench.ctx, new AbortController().signal, interactionTranslator(bench.ctx), bench.cache)
  expect(bench.controller.list).toHaveBeenCalledOnce()
})

it('finds sessions without cwd in the fallback scope', async () => {
  const bench = await setup()
  bench.summaries.push({ ...summary({ sessionId: SessionId('cwdless') }), cwd: undefined } as unknown as SessionSummary)
  await bench.openRoot()
  expect(bench.rootText()).toContain('3 sessions')
  await bench.choose('workspace:unregistered')
  await vi.waitFor(() => { expect(bench.text()).toContain('Untitled · cwdless') })
})

it('cleans up a failed workspace opening and ignores updates after closing', async () => {
  const bench = await setup()
  await bench.openRoot()
  const options = {
    scope: { kind: 'workspace' as const, workspaceId: 'alpha' as WorkspaceId, path: '/repo/current', title: 'Alpha' },
    loading: () => false, refresh: async () => {}, changed: vi.fn(), closeAll: vi.fn(), onClosed: vi.fn(),
  }
  const panel = openSessionWorkspace(bench.ctx, new AbortController().signal, interactionTranslator(bench.ctx), bench.cache, options)
  panel.handle.close()
  panel.catalogChanged('late update')
  await flushRequests()
  expect(bench.ctx.mayflyOverlays.list().map(item => item.id)).toEqual(['mayfly.sessions'])
})
