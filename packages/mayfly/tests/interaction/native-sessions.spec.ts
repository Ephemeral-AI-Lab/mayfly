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
import { createSessionListCache } from '../../src/interaction/session-list-reads.ts'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { sessionWorkspaceId } from '../../src/interaction/session-workspaces-model.ts'
import { openSessionWorkspace } from '../../src/interaction/session-workspace-panel.ts'
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
  Object.assign(bench.other, { status: 'running' })
  const values = {
    title: 'Current', sessionListMetadata: { blank: false, lastPromptAt: start - 60_000 },
    tokenUsage: { uncachedInputTokens: 1200, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0 },
    sessionStats: { turns: 3, steps: 5, llmMs: 12_000, toolMs: 3_000, ttftMs: 800, ttftSteps: 3, decodeMs: 9_000, decodeTokens: 800 },
    modelSelection: { lastUsed: { provider: 'deepseek', model: 'deepseek-chat' } },
  }
  const snapshot = vi.spyOn(ctx.sessionProjections, 'snapshot').mockImplementation(session => ({ asOfSeq: 10, values: session.id === 'current' ? values : {} }) as never)
  const headers = new Map([
    ['current', bench.session.header], ['other', bench.otherSession.header],
    ['child', { ...bench.session.header, id: SessionId('child'), createdAt: start - 900_000, parentSession: SessionId('current'), origin: 'subagent' as const }],
  ])
  const persistence = { identity: Symbol('storage'), list: vi.fn(async () => [...headers.values()].map(header => ({ header, revision: 'r1' }))) }
  const controller = {
    list: vi.fn(async () => { throw new Error('catalog must not call controller.list') }),
    projections: vi.fn(async ({ sessionId }: { sessionId: string }): Promise<import('@deepseek-ai/dsh-api-session-controller').SessionProjectionsValue> => ({ asOfSeq: 10, values: sessionId === 'current' ? values : {} })),
    search: vi.fn(async () => ({ items: [{ sessionId: 'child', snippet: 'matching text' }], hasMore: true })),
  }
  const observation = (id = 'child', title?: string, revision = 'r1'): SessionObservation => ({
    header: headers.get(id) ?? { ...bench.session.header, id: SessionId(id) }, source: 'prepared', revision,
    events: title === undefined ? [] : [{ type: 'session/title', seq: 0, time: start, data: { title, messageSeqs: [], source: { kind: 'user' } } }],
    [Symbol.dispose]: vi.fn(),
  } as never)
  const query = {
    observeSession: vi.fn(async (id: string, _options: { signal: AbortSignal, projectionMode: string }) => observation(id)),
    searchSessions: vi.fn(async (request: { query: string }, options: { signal: AbortSignal }) => {
      const result = await controller.search({ query: request.query }, options.signal)
      return { items: result.items.map(item => ({ header: headers.get(item.sessionId) ?? { ...bench.session.header, id: SessionId(item.sessionId) }, bestMatch: { sessionId: item.sessionId, snippet: item.snippet } })), ...(result.hasMore ? { nextCursor: 'next' } : {}) }
    }),
  }
  Object.assign(persistence, { open: vi.fn(async (id: string, access: string, options: { signal: AbortSignal }) => {
    expect(access).toBe('read')
    const read = await query.observeSession(id, { signal: options.signal, projectionMode: 'none' })
    return { header: read.header, inheritedEventCount: 0, read: async () => ({ events: read.events, eventState: 'shared-frozen' }), close: read[Symbol.dispose] }
  }) })
  const registry = { archivedSessionIds: [] as string[], archiveSession: vi.fn(async (id: string, _options: unknown) => { registry.archivedSessionIds.push(id) }), unarchiveSession: vi.fn(async (id: string) => { registry.archivedSessionIds = registry.archivedSessionIds.filter(item => item !== id) }) }
  const subagents = { listDescendants: vi.fn(async () => [{ kind: 'child', id: 'child', parentId: 'current', mode: 'continuable', label: 'Worker' }]) }
  const schedule = { catalog: vi.fn(async () => [{ sessionId: 'other', status: 'active' }, { sessionId: 'child', status: 'active' }] as never) }
  ctx.provide('sessionController', controller as never)
  if (withQuery) {
    ctx.provide('sessionQuery', query as never)
    ctx.provide('sessionPersistence', persistence as never)
  }
  ctx.provide('workspaceRegistry', registry as never)
  ctx.provide('subagents', subagents as never)
  ctx.provide('schedule', schedule as never)
  const cache = createSessionListCache(ctx)
  const rootModel = () => ctx.mayflyUiInteraction.get('overlay', 'mayfly.sessions')!
  const model = (id = 'mayfly.sessions.workspace') => ctx.mayflyUiInteraction.get('overlay', id)!
  let workspace: string | undefined
  const openRoot = async () => {
    const result = await openSessions(ctx, new AbortController().signal, interactionTranslator(ctx), cache)
    await flushRequests()
    return result
  }
  const chooseWorkspace = async (cwd: string | undefined) => {
    ctx.mayflyOverlays.close('mayfly.sessions.workspace')
    const id = sessionWorkspaceId(cwd)
    await vi.waitFor(() => { expect(JSON.stringify(rootModel().node)).toContain(JSON.stringify(id)) })
    rootModel().emit({ kind: 'selection-accept', pagePath: [], controlId: 'workspaces', selectedIds: [id] })
    workspace = cwd
    await flushRequests()
  }
  const open = async (cwd = ctx.mayflyCurrentAgent.current()?.session.header.cwd) => {
    const result = await openRoot()
    if (result.kind === 'success') await chooseWorkspace(cwd)
    return result
  }
  const select = async (id: string) => {
    const header = headers.get(id)
    if (header !== undefined && header.cwd !== workspace) await chooseWorkspace(header.cwd)
    model().emit({ kind: 'selection-accept', pagePath: [], controlId: 'sessions', selectedIds: [id] }); await flushRequests()
  }
  const act = async (id: string, detail = true) => { model(detail ? 'mayfly.sessions.detail' : 'mayfly.sessions.workspace').invoke(id); await flushRequests() }
  const confirm = async () => { model('mayfly.sessions.detail').answerDecision(true); await flushRequests() }
  return { ...bench, controller, query, registry, subagents, persistence, headers, snapshot, observation, cache, open, openRoot, chooseWorkspace, rootModel, model, select, act, confirm }
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
it('opens immediately, contains catalog failures, and cancels a late listing', async () => {
  const bench = await setup()
  bench.persistence.list.mockRejectedValueOnce(new Error('disk unavailable'))
  expect(await bench.openRoot()).toEqual({ kind: 'success' })
  expect(JSON.stringify(bench.rootModel().node)).toContain('disk unavailable')
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof bench.persistence.list>>>()
  bench.persistence.list.mockReturnValueOnce(gate.promise)
  const abort = new AbortController()
  expect(await openSessions(bench.ctx, abort.signal, interactionTranslator(bench.ctx), bench.cache)).toEqual({ kind: 'success' })
  expect(JSON.stringify(bench.rootModel().node)).toContain('Loading workspaces')
  abort.abort(); gate.resolve([])
  await flushRequests()
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
  expect(node).toContain('2k tok')
  expect(node).toContain('/repo')
  expect(node).toContain('current')
  expect(node).toContain('Untitled · child')
  expect(bench.persistence.list).toHaveBeenCalledWith({ signal: expect.any(AbortSignal) })
  await bench.select('current')
  const detail = JSON.stringify(bench.model('mayfly.sessions.detail').node)
  expect(detail).toContain('Current')
  expect(detail).toContain('/repo')
  expect(detail).toContain('inactive · current')
  expect(detail).toContain('model 12s')
  expect(detail).toContain('tools 3s')
  expect(detail).toContain('3 turns · 5 steps')
  expect(detail).toContain('2k (input 1.2k')
  expect(detail).toContain('deepseek-chat (deepseek)')
})

it('renders a sparse cold row with its header and unknown projection fields', async () => {
  const bench = await setup()
  bench.headers.set('bare', { ...bench.session.header, id: SessionId('bare'), createdAt: Date.now() - 1000 })
  expect(await bench.open()).toEqual({ kind: 'success' })
  expect(JSON.stringify(bench.model().node)).toContain('Untitled · bare')
  await bench.select('bare')
  const detail = JSON.stringify(bench.model('mayfly.sessions.detail').node)
  expect(detail).toContain('inactive')
  expect(detail).toContain('—')
})

it('stays quiet when the listing fails after cancellation', async () => {
  const bench = await setup()
  const warn = vi.spyOn(bench.ctx.logger, 'warn').mockImplementation(() => {})
  const caller = new AbortController()
  bench.persistence.list.mockImplementationOnce(async () => { caller.abort(); throw new Error('late failure') })
  expect(await openSessions(bench.ctx, caller.signal, interactionTranslator(bench.ctx), bench.cache)).toEqual({ kind: 'success' })
  await flushRequests()
  expect(warn).not.toHaveBeenCalled()
})

it('lists sessions without reminder badges when the Host schedule service is absent', async () => {
  const bench = await setup()
  bench.ctx.set('schedule', undefined as never)
  expect(await bench.open()).toEqual({ kind: 'success' })
  expect(JSON.stringify(bench.model().node)).not.toContain('Reminders')
})

it('keeps native persistence headers when the query service is absent', async () => {
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
  await flushRequests()
  await bench.chooseWorkspace('/repo/current')
  expect(schedule.catalog).toHaveBeenCalledOnce()
  expect(warn).not.toHaveBeenCalled()
})

it('limits cold reads to four, avoids repeated listings, and preserves drafts', async () => {
  const bench = await setup()
  for (let i = 0; i < 65; i++) bench.headers.set(`session-${i}`, { ...bench.session.header, id: SessionId(`session-${i}`) })
  const gates = Array.from({ length: 4 }, () => Promise.withResolvers<SessionObservation>())
  for (const gate of gates) bench.query.observeSession.mockReturnValueOnce(gate.promise)
  await bench.open()
  expect(bench.query.observeSession).toHaveBeenCalledTimes(4)
  expect(bench.persistence.list).toHaveBeenCalledTimes(1)
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'draft')
  for (const [index, gate] of gates.entries()) gate.resolve(bench.observation(bench.query.observeSession.mock.calls[index]![0], 'Recovered title'))
  await vi.waitFor(() => { expect(bench.query.observeSession).toHaveBeenCalledTimes(66) })
  expect(bench.persistence.list).toHaveBeenCalledTimes(1)
  expect(bench.controller.list).not.toHaveBeenCalled()
  await bench.act('search', false)
  expect(bench.controller.search).toHaveBeenLastCalledWith({ query: 'draft' }, expect.any(AbortSignal))
})

it('discards old title reads after refresh or closure and contains read failures', async () => {
  const bench = await setup()
  const old = Promise.withResolvers<SessionObservation>()
  bench.query.observeSession.mockReturnValueOnce(old.promise)
  await bench.open()
  await bench.act('refresh', false)
  expect(bench.query.observeSession.mock.calls[0]![1].signal.aborted).toBe(true)
  const observation = bench.observation('child', 'Obsolete')
  old.resolve(observation)
  await flushRequests()
  expect(observation[Symbol.dispose]).toHaveBeenCalled()
  expect(JSON.stringify(bench.model().node)).not.toContain('Obsolete')
  bench.cache.titles.clear()
  bench.query.observeSession.mockRejectedValueOnce(new Error('title store unavailable'))
  const warn = vi.spyOn(bench.ctx.logger, 'warn').mockImplementation(() => {})
  await bench.act('refresh', false)
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('title store unavailable'))
  const late = Promise.withResolvers<SessionObservation>()
  bench.query.observeSession.mockReturnValueOnce(late.promise)
  await bench.act('refresh', false)
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  late.reject(new Error('closed'))
  await flushRequests()
  expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('closed'))
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
  await bench.open('/repo/other')
  bench.controller.projections.mockResolvedValueOnce(null)
  expect(await nativeAction(bench.model(), selection('sessions', 'other'))).toMatchObject({ kind: 'failed', message: expect.stringContaining('no longer available') })
  bench.controller.projections.mockRejectedValueOnce(new Error('corrupt log'))
  expect(await nativeAction(bench.model(), selection('sessions', 'other'))).toMatchObject({ kind: 'failed', message: expect.stringContaining('corrupt log') })
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(2)
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
  const titles = Promise.withResolvers<SessionObservation>()
  bench.query.observeSession.mockReturnValueOnce(titles.promise)
  await bench.open()
  const search = Promise.withResolvers<Awaited<ReturnType<typeof bench.controller.search>>>()
  bench.controller.search.mockReturnValueOnce(search.promise)
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'needle')
  bench.model().invoke('search')
  await flushRequests()
  titles.resolve(bench.observation('child', 'Recovered child'))
  await flushRequests()
  expect(JSON.stringify(bench.model().node)).not.toContain('Recovered child')
  search.resolve({ items: [{ sessionId: 'child', snippet: 'needle match' }], hasMore: false })
  await vi.waitFor(() => { expect(JSON.stringify(bench.model().node)).toContain('needle match') })
  expect(JSON.stringify(bench.model().node)).toContain('Recovered child')
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
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof bench.persistence.list>>>()
  bench.persistence.list.mockReturnValueOnce(gate.promise)
  if (action === 'search') {
    bench.controller.search.mockResolvedValueOnce({ items: [{ sessionId: 'new', snippet: 'new conversation' }], hasMore: false })
    bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'needle')
  }
  bench.model().invoke(action)
  await flushRequests()
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  gate.resolve([])
  await flushRequests()
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it('updates archive badges without rescanning the catalog', async () => {
  const bench = await setup()
  await bench.open(); await bench.select('other')
  expect(bench.persistence.list).toHaveBeenCalledTimes(1)
  await bench.act('archive'); await bench.confirm()
  expect(bench.persistence.list).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(bench.model().node)).toContain('archived')
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
  bench.snapshot.mockRestore()
  Object.assign(bench.other, { status: 'idle' })
  bench.ctx.provide('sessionProjectionCache', {
    cachedSnapshot: () => cachedTitle === undefined ? undefined : { asOfSeq: 0, values: { title: cachedTitle } },
    cachedPredecessorTitle: () => undefined,
    hydratePrepared: (session: typeof bench.session) => bench.ctx.sessionProjections.snapshot(session),
  } as never)
  bench.controller.projections.mockImplementation(async ({ sessionId }) => {
    using observation = await query.observeSession(SessionId(sessionId))
    return { asOfSeq: observation.cursor, values: observation.projections!.values }
  })
  const sessionsBefore = bench.ctx.sessions.list()
  const agentsBefore = [...bench.agents.values()]
  await bench.open('/repo/cold')
  await vi.waitFor(() => { expect(JSON.stringify(bench.model().node)).toContain('Investigate compiler crash') })
  expect(bench.controller.projections).not.toHaveBeenCalled()
  expect(JSON.stringify(bench.model().node)).not.toContain('0s')
  expect(await nativeAction(bench.model(), selection('sessions', session.id))).toMatchObject({ kind: 'completed' })
  expect(JSON.stringify(bench.model('mayfly.sessions.detail').node)).toContain('Investigate compiler crash')
  expect(bench.ctx.sessions.list()).toEqual(sessionsBefore)
  expect([...bench.agents.values()]).toEqual(agentsBefore)
})

it('marks the displayed Agent current and reads live titles through native projections', async () => {
  const bench = await setup()
  bench.ctx.mayflyCurrentAgent.select(bench.other)
  await bench.open()
  expect(JSON.stringify(bench.model().node)).toContain('current · running · Reminders')
  expect(bench.query.observeSession.mock.calls.map(call => call[0])).toEqual([])
})

it('reopens retained rows before validation and rereads only changed native revisions', async () => {
  const bench = await setup()
  bench.query.observeSession.mockResolvedValueOnce(bench.observation('child', 'Saved title'))
  await bench.open()
  expect(JSON.stringify(bench.model().node)).toContain('Saved title')
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof bench.persistence.list>>>()
  bench.persistence.list.mockReturnValueOnce(gate.promise)
  expect(await openSessions(bench.ctx, new AbortController().signal, interactionTranslator(bench.ctx), bench.cache)).toEqual({ kind: 'success' })
  await bench.chooseWorkspace('/repo/current')
  expect(JSON.stringify(bench.model().node)).toContain('Saved title')
  expect(bench.query.observeSession).toHaveBeenCalledTimes(1)
  gate.resolve([...bench.headers.values()].map(header => ({ header, revision: 'r1' })))
  await flushRequests()
  expect(bench.query.observeSession).toHaveBeenCalledTimes(1)
  bench.persistence.list.mockResolvedValueOnce([...bench.headers.values()].map(header => ({ header, revision: header.id === 'child' ? 'r2' : 'r1' })))
  bench.query.observeSession.mockResolvedValueOnce(bench.observation('child', 'Renamed title'))
  await bench.act('refresh', false)
  expect(bench.query.observeSession).toHaveBeenCalledTimes(2)
  expect(JSON.stringify(bench.model().node)).toContain('Renamed title')
})

it('focuses an existing catalog without repeating reads and ignores an aborted invocation', async () => {
  const bench = await setup()
  const aborted = new AbortController(); aborted.abort()
  expect(await openSessions(bench.ctx, aborted.signal, interactionTranslator(bench.ctx), bench.cache)).toEqual({ kind: 'success' })
  expect(bench.persistence.list).not.toHaveBeenCalled()
  await bench.open(); await bench.open()
  expect(bench.persistence.list).toHaveBeenCalledTimes(1)
})

it('reports incompatible retained headers without leaking the opening lifetime', async () => {
  const bench = await setup()
  await bench.open(); bench.ctx.mayflyOverlays.close('mayfly.sessions')
  bench.cache.stored = [{ header: { ...bench.session.header, cwd: '/recreated' }, revision: 'changed' } as never]
  expect(await bench.open()).toMatchObject({ kind: 'error' })
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it('closes a workspace while reminder metadata is pending', async () => {
  const bench = await setup()
  const gate = Promise.withResolvers<never[]>()
  const schedule = bench.ctx.get('schedule') as { catalog: ReturnType<typeof vi.fn> }
  schedule.catalog.mockReturnValueOnce(gate.promise)
  await bench.open()
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  gate.resolve([])
  await flushRequests()
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it('does not publish a title from a replaced storage service', async () => {
  const bench = await setup()
  const gate = Promise.withResolvers<SessionObservation>()
  bench.query.observeSession.mockReturnValueOnce(gate.promise)
  await bench.open()
  bench.ctx.set('sessionPersistence', { ...bench.persistence, identity: Symbol('replacement') } as never)
  gate.resolve(bench.observation('child', 'Wrong storage'))
  await flushRequests()
  expect(JSON.stringify(bench.model().node)).not.toContain('Wrong storage')
})

it('updates live titles from native projections without reading history and releases the listener', async () => {
  const bench = await setup()
  const listeners: Parameters<typeof bench.ctx.sessionProjections.onChanged>[0][] = []
  const off = vi.fn()
  vi.spyOn(bench.ctx.sessionProjections, 'onChanged').mockImplementation(listener => { listeners.push(listener); return off })
  await bench.open()
  const notify = listeners.at(-1)!
  notify(bench.session, 'tokenUsage', {}, 2 as never)
  notify(bench.session, 'title', 123, 2 as never)
  notify({ ...bench.session, header: {} } as never, 'title', 'Wrong header', 2 as never)
  notify(bench.session, 'title', 'A new live title', 2 as never)
  await vi.waitFor(() => { expect(JSON.stringify(bench.model().node)).toContain('A new live title') })
  expect(bench.query.observeSession.mock.calls.map(call => call[0])).toEqual(['child'])
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  expect(off).toHaveBeenCalledOnce()
  notify(bench.session, 'title', 'After close', 3 as never)
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it('lists live sessions when persistence is absent and rejects an empty selection', async () => {
  const bench = await setup()
  bench.ctx.set('sessionPersistence', undefined as never)
  await bench.open()
  expect(JSON.stringify(bench.model().node)).toContain('Current')
  expect(bench.query.observeSession).not.toHaveBeenCalled()
  expect(await nativeAction(bench.model(), selection('sessions'))).toMatchObject({ kind: 'failed' })
})



it('fences cancellation between retaining a completed read and publishing it', async () => {
  const bench = await setup()
  const retain = bench.cache.titles.set.bind(bench.cache.titles)
  vi.spyOn(bench.cache.titles, 'set').mockImplementationOnce((id, title) => {
    retain(id, title)
    bench.ctx.mayflyOverlays.close('mayfly.sessions')
    return bench.cache.titles
  })
  await bench.open()
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it('starts with workspace counts and performs no title or projection reads until a workspace opens', async () => {
  const bench = await setup()
  bench.snapshot.mockClear()
  await bench.openRoot()
  const text = JSON.stringify(bench.rootModel().node)
  expect(text).toContain('/repo/current')
  expect(text).toContain('/repo/other')
  expect(text.indexOf('/repo/current')).toBeLessThan(text.indexOf('/repo/other'))
  expect(text).toContain('2 sessions')
  expect(text).toContain('1 session')
  expect(bench.snapshot).not.toHaveBeenCalled()
  expect(bench.query.observeSession).not.toHaveBeenCalled()
  expect(bench.persistence.list).toHaveBeenCalledOnce()
  await bench.chooseWorkspace('/repo/other')
  expect(JSON.stringify(bench.model().node)).not.toContain('Current')
  expect(bench.query.observeSession).not.toHaveBeenCalled()
  await bench.chooseWorkspace('/repo/current')
  expect(bench.query.observeSession.mock.calls.map(call => call[0])).toEqual(['child'])
  expect(bench.persistence.list).toHaveBeenCalledOnce()
})

it('shows workspace loading immediately, then numeric progress only for the opened workspace', async () => {
  const bench = await setup()
  const listing = Promise.withResolvers<Awaited<ReturnType<typeof bench.persistence.list>>>()
  bench.persistence.list.mockReturnValueOnce(listing.promise)
  await bench.openRoot()
  expect(JSON.stringify(bench.rootModel().node)).toContain('Loading workspaces…')
  expect(bench.query.observeSession).not.toHaveBeenCalled()
  await bench.chooseWorkspace('/repo/current')
  expect(JSON.stringify(bench.model().node)).toContain('Loading workspace sessions…')
  const title = Promise.withResolvers<SessionObservation>()
  bench.query.observeSession.mockReturnValueOnce(title.promise)
  listing.resolve([...bench.headers.values()].map(header => ({ header, revision: 'r1' })))
  await vi.waitFor(() => { expect(JSON.stringify(bench.model().node)).toContain('Loading session names… 0/1') })
  expect(JSON.stringify(bench.rootModel().node)).not.toContain('Loading workspaces…')
  title.resolve(bench.observation('child', 'Recovered child'))
  await vi.waitFor(() => { expect(JSON.stringify(bench.model().node)).toContain('Recovered child') })
  expect(JSON.stringify(bench.model().node)).not.toContain('Loading session names')
})

it('cancels a previous workspace read on navigation and ignores its late result', async () => {
  const bench = await setup()
  const late = Promise.withResolvers<SessionObservation>()
  bench.query.observeSession.mockReturnValueOnce(late.promise)
  await bench.open()
  await bench.chooseWorkspace('/repo/other')
  expect(bench.query.observeSession.mock.calls[0]![1].signal.aborted).toBe(true)
  late.resolve(bench.observation('child', 'Wrong workspace title'))
  await flushRequests()
  expect(JSON.stringify(bench.model().node)).not.toContain('Wrong workspace title')
})

it('scopes content search before pagination and excludes mismatched workspace results', async () => {
  const bench = await setup()
  await bench.open()
  bench.query.searchSessions.mockResolvedValueOnce({ items: [
    { header: bench.headers.get('child')!, bestMatch: { sessionId: 'child', snippet: 'in this workspace' } },
    { header: bench.headers.get('other')!, bestMatch: { sessionId: 'other', snippet: 'outside workspace' } },
  ] } as never)
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'needle')
  await bench.act('search', false)
  expect(bench.query.searchSessions).toHaveBeenCalledWith({
    query: 'needle', sessionFilters: [{ kind: 'cwd', values: ['/repo/current'] }],
    eventFilters: [{ kind: 'type', values: ['user/message', 'assistant/message'] }, { kind: 'surface', values: ['current'] }],
  }, { signal: expect.any(AbortSignal) })
  expect(JSON.stringify(bench.model().node)).toContain('in this workspace')
  expect(JSON.stringify(bench.model().node)).not.toContain('outside workspace')
})

it('preserves global content search without warming unrelated workspaces', async () => {
  const bench = await setup()
  await bench.openRoot()
  bench.rootModel().invoke('search-all')
  await flushRequests()
  expect(JSON.stringify(bench.model().node)).toContain('All workspaces')
  expect(bench.query.observeSession).not.toHaveBeenCalled()
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'needle')
  await bench.act('search', false)
  expect(bench.controller.search).toHaveBeenCalledWith({ query: 'needle' }, expect.any(AbortSignal))
  expect(bench.query.searchSessions).not.toHaveBeenCalled()
  expect(JSON.stringify(bench.model().node)).toContain('matching text')
  expect(bench.query.observeSession.mock.calls.map(call => call[0])).toEqual(['child'])
})

it('keeps name-read errors visible after progress completes', async () => {
  const bench = await setup()
  bench.query.observeSession.mockRejectedValueOnce(new Error('unreadable log'))
  await bench.open()
  expect(JSON.stringify(bench.model().node)).toContain('1 session name could not be loaded. Refresh to retry.')
  expect(JSON.stringify(bench.model().node)).not.toContain('Loading session names')
})

it('refreshes and validates workspace selections, and ignores unrelated events', async () => {
  const bench = await setup()
  await bench.openRoot()
  expect(await nativeAction(bench.rootModel(), selection('workspaces', 'missing'))).toMatchObject({ kind: 'failed' })
  expect(await nativeAction(bench.rootModel(), selection('unrelated'))).toMatchObject({ kind: 'completed' })
  expect(await nativeAction(bench.rootModel(), activate('unknown'))).toMatchObject({ kind: 'completed' })
  expect(await nativeAction(bench.rootModel(), { kind: 'dismiss', pagePath: [] })).toMatchObject({ kind: 'completed' })
  await bench.chooseWorkspace('/repo/current')
  expect(await nativeAction(bench.rootModel(), activate('refresh'))).toMatchObject({ kind: 'accepted' })
  expect(bench.persistence.list).toHaveBeenCalledTimes(2)
})

it('shows loading and empty states when no workspace is available', async () => {
  const bench = await setup()
  bench.ctx.mayflyCurrentAgent.select(null)
  vi.spyOn(bench.ctx.sessions, 'list').mockReturnValue([])
  const gate = Promise.withResolvers<never[]>()
  bench.persistence.list.mockReturnValueOnce(gate.promise)
  await bench.openRoot()
  expect(JSON.stringify(bench.rootModel().node)).toContain('Loading workspaces…')
  expect(JSON.stringify(bench.rootModel().node)).not.toContain('No workspaces')
  gate.resolve([])
  await flushRequests()
  expect(JSON.stringify(bench.rootModel().node)).toContain('No workspaces')
})

it('contains catalog failures while an early workspace view is open', async () => {
  const bench = await setup()
  const gate = Promise.withResolvers<never[]>()
  bench.persistence.list.mockReturnValueOnce(gate.promise)
  await bench.open()
  gate.reject(new Error('disk unavailable'))
  await vi.waitFor(() => { expect(JSON.stringify(bench.model().node)).toContain('disk unavailable') })
  expect(JSON.stringify(bench.model().node)).not.toContain('Loading workspace sessions')
})

it('ignores a catalog completion after its publication closes the picker', async () => {
  const bench = await setup()
  const gate = Promise.withResolvers<never[]>()
  bench.persistence.list.mockReturnValueOnce(gate.promise)
  await bench.openRoot()
  let armed = false
  const off = bench.ctx.mayflyOverlays.subscribe(delta => {
    if (armed && delta.kind === 'upsert' && delta.entry.id === 'mayfly.sessions') bench.ctx.mayflyOverlays.close('mayfly.sessions')
  })
  armed = true
  gate.resolve([])
  await flushRequests()
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
  off()
})

it('fences cancellation between a workspace refresh and its action acknowledgement', async () => {
  const bench = await setup()
  await bench.openRoot()
  const list = bench.ctx.sessions.list.bind(bench.ctx.sessions)
  vi.spyOn(bench.ctx.sessions, 'list').mockImplementationOnce(() => {
    queueMicrotask(() => bench.ctx.mayflyOverlays.close('mayfly.sessions'))
    return list()
  })
  await nativeAction(bench.rootModel(), activate('refresh'))
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it.each(['search', 'refresh'])('retires %s when a parent update closes its workspace', async action => {
  const bench = await setup()
  await bench.open()
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof bench.persistence.list>>>()
  bench.persistence.list.mockReturnValueOnce(gate.promise)
  if (action === 'search') {
    bench.controller.search.mockResolvedValueOnce({ items: [{ sessionId: 'new', snippet: 'new' }], hasMore: false })
    bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'needle')
  }
  bench.model().invoke(action)
  await flushRequests()
  let armed = false
  const off = bench.ctx.mayflyOverlays.subscribe(delta => {
    if (armed && delta.kind === 'upsert' && delta.entry.id === 'mayfly.sessions') bench.ctx.mayflyOverlays.close('mayfly.sessions.workspace')
  })
  armed = true
  gate.resolve([...bench.headers.values()].map(header => ({ header, revision: 'r1' })))
  await flushRequests()
  expect(bench.ctx.mayflyOverlays.list().map(item => item.id)).toEqual(['mayfly.sessions'])
  off()
})

it('handles a workspace without cwd and missing content-search capability', async () => {
  const bench = await setup()
  bench.ctx.sessions.create(SessionId('without-cwd'))
  await bench.openRoot()
  await bench.chooseWorkspace(undefined)
  bench.query.searchSessions.mockResolvedValueOnce({ items: [] } as never)
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'needle')
  await bench.act('search', false)
  expect(bench.query.searchSessions.mock.calls[0]![0]).toMatchObject({ sessionFilters: [{ kind: 'cwd', values: [null] }] })
  bench.ctx.set('sessionQuery', undefined as never)
  await bench.act('search', false)
  expect(bench.model().feedbackSnapshot().some(item => item.message === 'Content search is unavailable')).toBe(true)
})

it('keeps cross-workspace ancestors out of the local tree and reports multiple failed names', async () => {
  const bench = await setup()
  bench.headers.set('child', { ...bench.headers.get('child')!, parentSession: SessionId('other') })
  bench.headers.set('child-2', { ...bench.headers.get('child')!, id: SessionId('child-2') })
  bench.query.observeSession.mockRejectedValue(new Error('unreadable'))
  await bench.open()
  const node = JSON.stringify(bench.model().node)
  expect(node).not.toContain('"parentId":"other"')
  expect(node).toContain('2 session names could not be loaded')
})

it('cleans up a failed workspace opening and ignores updates after closing', async () => {
  const bench = await setup()
  await bench.openRoot()
  const options = {
    scope: { kind: 'workspace' as const, cwd: '/repo/current' }, loading: () => false,
    refresh: async () => {}, changed: vi.fn(), closeAll: vi.fn(), onClosed: vi.fn(),
  }
  const panel = openSessionWorkspace(bench.ctx, new AbortController().signal, interactionTranslator(bench.ctx), bench.cache, options)
  panel.handle.close()
  panel.catalogChanged('late update')
  expect(bench.ctx.mayflyOverlays.list().map(item => item.id)).toEqual(['mayfly.sessions'])
  bench.cache.stored = [{ header: { ...bench.session.header, cwd: '/conflict' }, revision: 'other' } as never]
  expect(() => openSessionWorkspace(bench.ctx, new AbortController().signal, interactionTranslator(bench.ctx), bench.cache, options)).toThrow()
  expect(bench.ctx.mayflyOverlays.list().map(item => item.id)).toEqual(['mayfly.sessions'])
})
