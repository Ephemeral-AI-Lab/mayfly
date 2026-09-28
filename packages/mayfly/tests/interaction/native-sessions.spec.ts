import { nativeAction, activate, select as selection } from './native-action-fixture.ts'
/** Native session management preserves archive admission and child ownership.
 * @module @ephemeral-ai/mayfly/tests/interaction/native-sessions
 */
import { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryEngine } from '@deepseek-ai/dsh-session-query'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { titleProjectionDefinition } from '@deepseek-ai/dsh-session-title'
import { mkdtempTracked, registerTempDirCleanup } from '../core/temp-dir.ts'
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, it, vi } from 'vitest'
import { informationFixture } from './information-fixture.ts'
import { flushRequests as flushOneRequest } from './request-fixture.ts'
import { openSessions } from '../../src/interaction/native-sessions.ts'
import { interactionTranslator } from '../../src/interaction/locale.ts'

const flushRequests = async () => { await flushOneRequest(); await flushOneRequest() }
registerTempDirCleanup()
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup(withQuery = true) {
  const ctx = new Context(); contexts.push(ctx)
  const bench = await informationFixture(ctx)
  const start = Date.now()
  const controller = {
    list: vi.fn(async () => ({ items: [
      { sessionId: 'current', cwd: '/repo', running: false, updatedAt: start - 60_000, projections: { values: {
        title: 'Current',
        sessionListMetadata: { blank: false, lastPromptAt: start - 60_000 },
        tokenUsage: { uncachedInputTokens: 1200, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0 },
        sessionStats: { turns: 3, steps: 5, llmMs: 12_000, toolMs: 3_000, ttftMs: 800, ttftSteps: 3, decodeMs: 9_000, decodeTokens: 800 },
        modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-chat' } },
      } } },
      { sessionId: 'other', running: true, updatedAt: start - 30_000 },
      { sessionId: 'child', origin: 'subagent', parentSessionId: 'current', running: false, updatedAt: start - 20_000 },
    ] })),
    projections: vi.fn(async ({ sessionId }: { sessionId: string }): Promise<import('@deepseek-ai/dsh-api-session-controller').SessionProjectionsValue> => ({ asOfSeq: 10, values: sessionId === 'current' ? (await controller.list()).items[0]!.projections!.values : {} })),
    search: vi.fn(async () => ({ items: [{ sessionId: 'other', snippet: 'matching text' }], hasMore: true })),
  }
  const query = { readTitleSnapshots: vi.fn(async (_ids: readonly string[], _signal: AbortSignal) => [] as import('@deepseek-ai/dsh-session-query').SessionTitleObservationResult[]), listSessions: vi.fn(async () => [
    { header: { id: 'current', createdAt: start - 3_600_000, cwd: '/repo', agentPreset: 'standard' } },
    { header: { id: 'other', createdAt: start - 7_200_000, cwd: '/repo/other' } },
    { header: { id: 'child', createdAt: start - 900_000 } },
  ]) }
  const registry = { archivedSessionIds: [] as string[], archiveSession: vi.fn(async (id: string, _options: unknown) => { registry.archivedSessionIds.push(id) }), unarchiveSession: vi.fn(async (id: string) => { registry.archivedSessionIds = registry.archivedSessionIds.filter(item => item !== id) }) }
  const subagents = { listDescendants: vi.fn(async () => [{ kind: 'child', id: 'child', parentId: 'current', mode: 'continuable', label: 'Worker' }]) }
  const schedule = { catalog: vi.fn(async () => [{ sessionId: 'other', status: 'active' }] as never) }
  ctx.provide('sessionController', controller as never)
  if (withQuery) ctx.provide('sessionQuery', query as never)
  ctx.provide('workspaceRegistry', registry as never)
  ctx.provide('subagents', subagents as never)
  ctx.provide('schedule', schedule as never)
  const open = () => openSessions(ctx, new AbortController().signal, interactionTranslator(ctx))
  const model = (id = 'mayfly.sessions') => ctx.mayflyUiInteraction.get('overlay', id)!
  const select = async (id: string) => { model().emit({ kind: 'selection-accept', pagePath: [], controlId: 'sessions', selectedIds: [id] }); await flushRequests() }
  const act = async (id: string, detail = true) => { model(detail ? 'mayfly.sessions.detail' : 'mayfly.sessions').invoke(id); await flushRequests() }
  const confirm = async () => { model('mayfly.sessions.detail').answerDecision(true); await flushRequests() }
  return { ...bench, controller, query, registry, subagents, open, model, select, act, confirm }
}
it('lists native summaries, searches explicitly, and preserves title filtering on search refusal', async () => {
  const bench = await setup()
  expect(await bench.open()).toEqual({ kind: 'success' })
  expect(JSON.stringify(bench.model().node)).toContain('Current')
  expect(JSON.stringify(bench.model().node)).toContain('Reminders')
  expect(bench.controller.search).not.toHaveBeenCalled()
  await bench.act('search', false)
  expect(bench.controller.search).not.toHaveBeenCalled()
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'needle')
  await bench.act('search', false)
  expect(bench.controller.search).toHaveBeenCalledWith({ query: 'needle' }, expect.any(AbortSignal))
  expect(JSON.stringify(bench.model().node)).toContain('matching text')
  await bench.act('refresh', false)
  bench.controller.search.mockRejectedValueOnce(new Error('SESSION_QUERY_SEARCH_DISABLED'))
  await bench.act('search', false)
  expect(bench.model().feedbackSnapshot().some(item => item.message.includes('SESSION_QUERY_SEARCH_DISABLED'))).toBe(true)
  expect(JSON.stringify(bench.model().node)).toContain('Current')
})
it('uses native archive admission before offering explicit stop-and-archive', async () => {
  const bench = await setup()
  await bench.open(); await bench.select('other')
  bench.registry.archiveSession.mockRejectedValueOnce(new WorkspaceActiveSessionError('other' as never, [{ kind: 'turn' }]))
  await bench.act('archive'); await bench.confirm()
  expect(JSON.stringify(bench.model('mayfly.sessions.detail').node)).toContain('Stop activity and archive')
  await bench.act('stop-archive'); await bench.confirm()
  expect(bench.registry.archiveSession).toHaveBeenLastCalledWith('other', { stopActivity: true })
  await bench.select('other')
  expect(JSON.stringify(bench.model('mayfly.sessions.detail').node)).toContain('Restore the session first')
  await bench.act('restore'); await bench.confirm()
  expect(bench.registry.unarchiveSession).toHaveBeenCalledWith('other')
})
it('opens roots by native resume and children through descendant addresses', async () => {
  const bench = await setup()
  const resume = vi.fn(); bench.ctx.on('mayfly/request-resume', resume)
  await bench.open(); await bench.select('current'); await bench.act('open')
  expect(resume).toHaveBeenCalledWith('current')
  await bench.open(); await bench.select('child'); await bench.act('open')
  expect(bench.ctx.mayflyCurrentAgent.view().auxiliary).toMatchObject({ sessionId: 'child', parentSessionId: 'current', access: 'resumable' })
  bench.subagents.listDescendants.mockResolvedValueOnce([])
  await bench.open(); await bench.select('child'); await bench.act('open')
  expect(bench.model('mayfly.sessions.detail').feedbackSnapshot().some(item => item.message.includes('lead session'))).toBe(true)
})
it('contains read failures and cancels a late opening', async () => {
  const bench = await setup()
  bench.controller.list.mockRejectedValueOnce(new Error('disk unavailable'))
  expect(await bench.open()).toMatchObject({ kind: 'error', text: expect.stringContaining('disk unavailable') })
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof bench.controller.list>>>()
  bench.controller.list.mockReturnValueOnce(gate.promise)
  const abort = new AbortController()
  const opening = openSessions(bench.ctx, abort.signal, interactionTranslator(bench.ctx))
  abort.abort(); gate.resolve({ items: [] })
  await opening
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it('contains stale selections, unknown actions, and archive failures without redirecting a child', async () => {
  const bench = await setup()
  await bench.open()
  expect(await nativeAction(bench.model(), selection('sessions', 'missing'))).toMatchObject({ kind: 'failed' })
  expect(await nativeAction(bench.model(), { kind: 'dismiss', pagePath: [] } as never)).toMatchObject({ kind: 'completed' })
  await nativeAction(bench.model(), activate('unknown'))
  await bench.select('other')
  let detail = bench.model('mayfly.sessions.detail')
  expect(await nativeAction(detail, selection('none'))).toMatchObject({ kind: 'completed' })
  expect(await nativeAction(detail, activate('unknown'))).toMatchObject({ kind: 'completed' })
  bench.registry.archivedSessionIds.push('other')
  expect(await nativeAction(detail, activate('open'))).toMatchObject({ kind: 'failed' })
  bench.registry.archiveSession.mockRejectedValueOnce(new Error('persistence failed'))
  await expect(nativeAction(detail, activate('archive'))).rejects.toThrow('persistence failed')
  bench.ctx.mayflyOverlays.close('mayfly.sessions.detail')
  await bench.select('child')
  detail = bench.model('mayfly.sessions.detail')
  bench.ctx.mayflyCurrentAgent.select(null)
  expect(await nativeAction(detail, activate('open'))).toMatchObject({ kind: 'failed' })
})
it('shows complete search results and ignores a late archive repaint after closing', async () => {
  const bench = await setup()
  bench.controller.search.mockResolvedValueOnce({ items: [{ sessionId: 'current', snippet: 'hit' }, { sessionId: 'gone', snippet: 'orphan' }], hasMore: false })
  await bench.open()
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'text')
  await bench.act('search', false)
  expect(JSON.stringify(bench.model().node)).toContain('Current')
  expect(JSON.stringify(bench.model().node)).toContain('gone')
  await bench.act('refresh', false)
  const gate = Promise.withResolvers<void>()
  bench.registry.archiveSession.mockReturnValueOnce(gate.promise)
  await bench.select('other')
  const call = nativeAction(bench.model('mayfly.sessions.detail'), activate('archive'))
  await flushRequests()
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  gate.resolve(); await call
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it('uses the native child id when no label is available', async () => {
  const bench = await setup()
  bench.subagents.listDescendants.mockResolvedValueOnce([{ kind: 'child', id: 'child', parentId: 'current', mode: 'continuable' }] as never)
  await bench.open(); await bench.select('child'); await bench.act('open')
  expect(bench.ctx.mayflyCurrentAgent.view().auxiliary?.label).toBe('child')
})

it('renders the title, span, token total, status, and path in rows and detail', async () => {
  const bench = await setup()
  expect(await bench.open()).toEqual({ kind: 'success' })
  const node = JSON.stringify(bench.model().node)
  expect(node).toContain('Current')
  expect(node).toContain('59m')
  expect(node).toContain('2k tok')
  expect(node).toContain('/repo')
  expect(node).toContain('current')
  expect(node).toContain('running')
  expect(node).toContain('Untitled · other')
  expect(bench.query.listSessions).toHaveBeenCalledWith(expect.any(AbortSignal))
  await bench.select('current')
  const detail = JSON.stringify(bench.model('mayfly.sessions.detail').node)
  expect(detail).toContain('Current')
  expect(detail).toContain('/repo')
  expect(detail).toContain('inactive · current')
  expect(detail).toContain('standard')
  expect(detail).toContain('59m')
  expect(detail).toContain('model 12s')
  expect(detail).toContain('tools 3s')
  expect(detail).toContain('3 turns · 5 steps')
  expect(detail).toContain('2k (input 1.2k')
  expect(detail).toContain('deepseek-chat (deepseek)')
})

it('renders placeholders without headers or projections and tolerates a query listing failure', async () => {
  const bench = await setup()
  bench.controller.list.mockResolvedValueOnce({ items: [{ sessionId: 'bare', running: false, updatedAt: Date.now() - 1_000 }] })
  bench.query.listSessions.mockRejectedValueOnce(new Error('corpus unavailable'))
  expect(await bench.open()).toEqual({ kind: 'success' })
  const node = JSON.stringify(bench.model().node)
  expect(node).toContain('Untitled · bare')
  expect(node).not.toContain('tok')
  await bench.select('bare')
  const detail = JSON.stringify(bench.model('mayfly.sessions.detail').node)
  expect(detail).toContain('inactive')
  expect(detail).toContain('—')
})

it('stays quiet when the header listing fails after the signal aborted', async () => {
  const bench = await setup()
  const warn = vi.spyOn(bench.ctx.logger, 'warn').mockImplementation(() => {})
  const caller = new AbortController()
  bench.query.listSessions.mockImplementationOnce(async () => { caller.abort(); throw new Error('late failure') })
  expect(await openSessions(bench.ctx, caller.signal, interactionTranslator(bench.ctx))).toEqual({ kind: 'success' })
  expect(warn).not.toHaveBeenCalled()
})

it('lists sessions without reminder badges when the Host schedule service is absent', async () => {
  const bench = await setup()
  bench.ctx.set('schedule', undefined as never)
  expect(await bench.open()).toEqual({ kind: 'success' })
  expect(JSON.stringify(bench.model().node)).not.toContain('Reminders')
})

it('lists sessions without headers when the query service is absent', async () => {
  const bench = await setup()
  bench.ctx.set('sessionQuery', undefined as never)
  expect(await bench.open()).toEqual({ kind: 'success' })
  const node = JSON.stringify(bench.model().node)
  expect(node).toContain('Untitled')
})

it('degrades reminder badges when the Host catalog fails', async () => {
  const bench = await setup()
  const warn = vi.spyOn(bench.ctx.logger, 'warn').mockImplementation(() => {})
  const schedule = bench.ctx.get('schedule') as { catalog: ReturnType<typeof vi.fn> }
  schedule.catalog.mockRejectedValueOnce(new Error('catalog down'))
  expect(await bench.open()).toEqual({ kind: 'success' })
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('catalog down'))
  expect(JSON.stringify(bench.model().node)).not.toContain('Reminders')
})

it('stays quiet when the reminder catalog fails after the signal aborted', async () => {
  const bench = await setup()
  const warn = vi.spyOn(bench.ctx.logger, 'warn').mockImplementation(() => {})
  const caller = new AbortController()
  const schedule = bench.ctx.get('schedule') as { catalog: ReturnType<typeof vi.fn> }
  schedule.catalog.mockImplementationOnce(async () => { caller.abort(); throw new Error('late catalog failure') })
  expect(await openSessions(bench.ctx, caller.signal, interactionTranslator(bench.ctx))).toEqual({ kind: 'success' })
  expect(warn).not.toHaveBeenCalled()
})

it('recovers missing titles in bounded batches without delaying the catalog or replacing drafts', async () => {
  const bench = await setup()
  const sessions = Array.from({ length: 65 }, (_, index) => ({ sessionId: `session-${index.toString().padStart(8, '0')}`, running: false, updatedAt: Date.now() }))
  bench.controller.list.mockResolvedValue({ items: sessions })
  const gate = Promise.withResolvers<import('@deepseek-ai/dsh-session-query').SessionTitleObservationResult[]>()
  bench.query.readTitleSnapshots.mockReturnValueOnce(gate.promise)
  await bench.open()
  expect(JSON.stringify(bench.model().node)).toContain('Untitled · 00000000')
  expect(bench.query.readTitleSnapshots.mock.calls[0]![0]).toHaveLength(32)
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'draft')
  gate.resolve([
    { sessionId: sessions[0]!.sessionId, status: 'fulfilled', value: { title: { title: 'Repair compiler' } } },
    { sessionId: sessions[1]!.sessionId, status: 'fulfilled', value: {} },
    { sessionId: sessions[2]!.sessionId, status: 'rejected', reason: new Error('corrupt') },
  ] as never)
  await vi.waitFor(() => { expect(JSON.stringify(bench.model().node)).toContain('Repair compiler') })
  expect(bench.query.readTitleSnapshots.mock.calls.map(call => call[0].length)).toEqual([32, 32, 1])
  await bench.act('search', false)
  expect(bench.controller.search).toHaveBeenLastCalledWith({ query: 'draft' }, expect.any(AbortSignal))
})

it('discards old title reads after refresh or closure and contains title read failures', async () => {
  const bench = await setup()
  const old = Promise.withResolvers<import('@deepseek-ai/dsh-session-query').SessionTitleObservationResult[]>()
  bench.query.readTitleSnapshots.mockReturnValueOnce(old.promise)
  await bench.open()
  await bench.act('refresh', false)
  expect(bench.query.readTitleSnapshots.mock.calls[0]![1].aborted).toBe(true)
  old.resolve([{ sessionId: 'other', status: 'fulfilled', value: { title: { title: 'Obsolete' } } }] as never)
  await flushRequests()
  expect(JSON.stringify(bench.model().node)).not.toContain('Obsolete')
  bench.query.readTitleSnapshots.mockRejectedValueOnce(new Error('title store unavailable'))
  const warn = vi.spyOn(bench.ctx.logger, 'warn').mockImplementation(() => {})
  await bench.act('refresh', false)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('title store unavailable'))
  const late = Promise.withResolvers<import('@deepseek-ai/dsh-session-query').SessionTitleObservationResult[]>()
  bench.query.readTitleSnapshots.mockReturnValueOnce(late.promise)
  await bench.act('refresh', false)
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  late.reject(new Error('closed'))
  await flushRequests()
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('closed'))
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it('reads complete native projections only for the selected detail and fences a late result', async () => {
  const bench = await setup()
  await bench.open()
  expect(bench.controller.projections).not.toHaveBeenCalled()
  bench.controller.projections.mockResolvedValueOnce({ asOfSeq: 25, values: {
    title: 'Fresh native title', sessionListMetadata: { blank: false, lastPromptAt: Date.now() },
  } })
  await bench.select('other')
  expect(JSON.stringify(bench.model('mayfly.sessions.detail').node)).toContain('Fresh native title')
  bench.ctx.mayflyOverlays.close('mayfly.sessions.detail')
  const gate = Promise.withResolvers<import('@deepseek-ai/dsh-api-session-controller').SessionProjectionsValue>()
  bench.controller.projections.mockReturnValueOnce(gate.promise)
  const pending = nativeAction(bench.model(), selection('sessions', 'other'))
  await flushRequests()
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  gate.resolve({ asOfSeq: 0, values: {} })
  await pending
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it('reports missing or unreadable detail data without activating a session', async () => {
  const bench = await setup()
  await bench.open()
  bench.controller.projections.mockResolvedValueOnce(null)
  expect(await nativeAction(bench.model(), selection('sessions', 'other'))).toMatchObject({ kind: 'failed', message: expect.stringContaining('no longer available') })
  bench.controller.projections.mockRejectedValueOnce(new Error('corrupt log'))
  expect(await nativeAction(bench.model(), selection('sessions', 'other'))).toMatchObject({ kind: 'failed', message: expect.stringContaining('corrupt log') })
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(1)
  const gate = Promise.withResolvers<never>()
  bench.controller.projections.mockReturnValueOnce(gate.promise)
  const pending = nativeAction(bench.model(), selection('sessions', 'other'))
  await flushRequests()
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  gate.reject(new Error('cancelled read'))
  await pending
})

it('does not navigate after a child detail closes or the exact lead Agent changes', async () => {
  const bench = await setup()
  await bench.open(); await bench.select('child')
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof bench.subagents.listDescendants>>>()
  bench.subagents.listDescendants.mockReturnValueOnce(gate.promise)
  const pending = nativeAction(bench.model('mayfly.sessions.detail'), activate('open'))
  await flushRequests()
  bench.ctx.mayflyOverlays.close('mayfly.sessions.detail')
  gate.resolve([{ kind: 'child', id: 'child', parentId: 'current', mode: 'continuable', label: 'Worker' }])
  await pending
  expect(bench.ctx.mayflyCurrentAgent.view().auxiliary).toBeNull()
  await bench.select('child')
  bench.subagents.listDescendants.mockImplementationOnce(async () => {
    const replacement = { ...bench.agent }
    bench.agents.set(bench.agent.id, replacement)
    bench.ctx.mayflyCurrentAgent.select(replacement)
    return [{ kind: 'child', id: 'child', parentId: 'current', mode: 'continuable', label: 'Worker' }]
  })
  expect(await nativeAction(bench.model('mayfly.sessions.detail'), activate('open'))).toMatchObject({ kind: 'failed', message: expect.stringContaining('lead session changed') })
  expect(bench.ctx.mayflyCurrentAgent.view().auxiliary).toBeNull()
})

it('does not publish recovered titles over a pending content search or retain cancelled search results', async () => {
  const bench = await setup()
  const titles = Promise.withResolvers<import('@deepseek-ai/dsh-session-query').SessionTitleObservationResult[]>()
  bench.query.readTitleSnapshots.mockReturnValueOnce(titles.promise)
  await bench.open()
  const search = Promise.withResolvers<Awaited<ReturnType<typeof bench.controller.search>>>()
  bench.controller.search.mockReturnValueOnce(search.promise)
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'needle')
  bench.model().invoke('search')
  await flushRequests()
  titles.resolve([{ sessionId: 'other', status: 'fulfilled', value: { title: { title: 'Recovered other' } } }] as never)
  await flushRequests()
  expect(JSON.stringify(bench.model().node)).not.toContain('Recovered other')
  search.resolve({ items: [{ sessionId: 'other', snippet: 'needle match' }], hasMore: false })
  await vi.waitFor(() => { expect(JSON.stringify(bench.model().node)).toContain('needle match') })
  expect(JSON.stringify(bench.model().node)).toContain('Recovered other')
  const late = Promise.withResolvers<Awaited<ReturnType<typeof bench.controller.search>>>()
  bench.controller.search.mockReturnValueOnce(late.promise)
  bench.model().invoke('search')
  await flushRequests()
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  late.resolve({ items: [], hasMore: false })
  await flushRequests()
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it.each(['search', 'refresh'])('cancels a catalog refresh triggered by %s before replacing rows', async action => {
  const bench = await setup()
  await bench.open()
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof bench.controller.list>>>()
  bench.controller.list.mockReturnValueOnce(gate.promise)
  if (action === 'search') {
    bench.controller.search.mockResolvedValueOnce({ items: [{ sessionId: 'new', snippet: 'new conversation' }], hasMore: false })
    bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'needle')
  }
  bench.model().invoke(action)
  await flushRequests()
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  gate.resolve({ items: [] })
  await flushRequests()
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it('ignores an archive catalog read after its detail closes', async () => {
  const bench = await setup()
  await bench.open(); await bench.select('other')
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof bench.controller.list>>>()
  bench.controller.list.mockReturnValueOnce(gate.promise)
  const pending = nativeAction(bench.model('mayfly.sessions.detail'), activate('archive'))
  await flushRequests()
  bench.ctx.mayflyOverlays.close('mayfly.sessions.detail')
  gate.resolve({ items: [] })
  await pending
  expect(JSON.stringify(bench.model().node)).toContain('Current')
})


it.each([undefined, null, '', 'Old cached name'])('recovers the cold stored title before opening details when the cached title is %s', async cachedTitle => {
  const bench = await setup(false)
  class Query extends SessionQueryEngine {
    async searchSessions(): Promise<never> { throw new Error('unused') }
    async searchEvents(): Promise<never> { throw new Error('unused') }
  }
  await bench.ctx.plugin(JsonlSessionPersistence, { root: mkdtempTracked('mayfly-session-catalog-') })
  const query = new Query(bench.ctx)
  bench.ctx.sessionProjections.register(titleProjectionDefinition)
  const session = bench.ctx.sessions.prepare(SessionId('session-12345678-cold'), { meta: { cwd: '/repo/cold', createdAt: 1_000 } })
  session.append('session/title', { title: 'Investigate compiler crash', messageSeqs: [], source: { kind: 'user' } })
  const stored = await bench.ctx.sessionPersistence.create(session.header)
  await stored.append(session.snapshotEvents())
  await stored.close()
  bench.controller.list.mockResolvedValue({ items: [{ sessionId: session.id, cwd: '/repo/cold', running: false, updatedAt: 1_000,
    ...(cachedTitle === undefined ? {} : { projections: { kind: 'cached', asOfSeq: 0, values: { title: cachedTitle } } }),
  }] } as never)
  bench.controller.projections.mockImplementation(async ({ sessionId }) => {
    using observation = await query.observeSession(SessionId(sessionId))
    return { asOfSeq: observation.cursor, values: observation.projections!.values }
  })
  const sessionsBefore = bench.ctx.sessions.list()
  const agentsBefore = [...bench.agents.values()]
  await bench.open()
  await vi.waitFor(() => { expect(JSON.stringify(bench.model().node)).toContain('Investigate compiler crash') })
  expect(bench.controller.projections).not.toHaveBeenCalled()
  expect(JSON.stringify(bench.model().node)).not.toContain('0s')
  expect(await nativeAction(bench.model(), selection('sessions', session.id))).toMatchObject({ kind: 'completed' })
  expect(JSON.stringify(bench.model('mayfly.sessions.detail').node)).toContain('Investigate compiler crash')
  expect(bench.ctx.sessions.list()).toEqual(sessionsBefore)
  expect([...bench.agents.values()]).toEqual(agentsBefore)
})

it('marks the displayed Agent current and avoids reading titles already present in native hints', async () => {
  const bench = await setup()
  bench.ctx.mayflyCurrentAgent.select(bench.other)
  await bench.open()
  expect(JSON.stringify(bench.model().node)).toContain('current · running · Reminders')
  expect(bench.query.readTitleSnapshots.mock.calls[0]![0]).toEqual(['other', 'child'])
})
