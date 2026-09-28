/** Revision, service lifetime, and bounded native metadata reads for `/sessions`.
 * @module @ephemeral-ai/mayfly/tests/interaction/session-list-reads
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import { afterEach, expect, it, vi } from 'vitest'
import { informationFixture } from './information-fixture.ts'
import { cachedSessionTitle, createSessionListCache, readSessionListTitle, refreshSessionList, sessionListRows } from '../../src/interaction/session-list-reads.ts'

const roots: Context[] = []
afterEach(async () => { for (const ctx of roots.splice(0)) await ctx.fiber.dispose() })
const signal = () => new AbortController().signal
async function setup() {
  const ctx = new Context(); roots.push(ctx)
  const bench = await informationFixture(ctx)
  const header = { ...bench.session.header, id: SessionId('cold'), cwd: '/cold', createdAt: 1 }
  const stored = { header, revision: 'r1' }
  const persistence = { identity: Symbol('persistence'), list: vi.fn(async () => [stored]) }
  const observation = (title: string | null = 'Cold title', revision = 'r1') => ({
    header, source: 'prepared', revision,
    events: title === null ? [] : [{ type: 'session/title', seq: 0, time: 100, data: { title, messageSeqs: [], source: { kind: 'user' } } }],
    [Symbol.dispose]: vi.fn(),
  }) as unknown as SessionObservation
  const query = { observeSession: vi.fn(async () => observation()) }
  Object.assign(persistence, { open: vi.fn(async (id: string, access: string, options: { signal: AbortSignal }) => {
    expect(access).toBe('read')
    const read = await query.observeSession(id, { signal: options.signal, projectionMode: 'none' })
    return { header: read.header, inheritedEventCount: 0, read: async () => ({ events: read.events, eventState: 'shared-frozen' }), close: read[Symbol.dispose] }
  }) })
  const nativeCache = {
    cachedSnapshot: vi.fn(() => ({ asOfSeq: 0, values: { title: 'Stale', sessionListMetadata: { blank: false, lastPromptAt: 20 } } })),
    cachedPredecessorTitle: vi.fn(() => undefined),
  }
  ctx.provide('sessionPersistence', persistence as never)
  ctx.provide('sessionQuery', query as never)
  ctx.provide('sessionProjectionCache', nativeCache as never)
  const cache = createSessionListCache(ctx)
  const row = () => sessionListRows(ctx, cache).find(row => row.header.id === 'cold')!
  return { ...bench, header, stored, persistence, query, nativeCache, cache, row, observation }
}

it('lists storage once, uses only requested projection fields, and retains no logs', async () => {
  const bench = await setup()
  await refreshSessionList(bench.ctx, bench.cache, signal())
  const row = bench.row()
  expect(row.summary).toMatchObject({ sessionId: 'cold', updatedAt: 20, agentAvailable: false, running: false, projections: { values: { title: 'Stale' } } })
  expect(bench.nativeCache.cachedSnapshot).toHaveBeenCalledWith(bench.header, ['title', 'sessionListMetadata', 'mayflyConversationFacts', 'tokenUsage', 'sessionStats', 'modelSelection'])
  expect(cachedSessionTitle(bench.cache, row)).toBeUndefined()
  const result = bench.observation()
  bench.query.observeSession.mockResolvedValueOnce(result)
  expect(await readSessionListTitle(bench.ctx, bench.cache, row, signal())).toBe('Cold title')
  expect(result[Symbol.dispose]).toHaveBeenCalledOnce()
  expect(bench.cache.titles.get('cold')).toEqual({ revision: 'r1', title: 'Cold title' })
  expect(cachedSessionTitle(bench.cache, row)).toBe('Cold title')
  expect(bench.persistence.list).toHaveBeenCalledTimes(1)
})

it('invalidates changed or deleted revisions and remembers truly untitled sessions', async () => {
  const bench = await setup()
  await refreshSessionList(bench.ctx, bench.cache, signal())
  bench.query.observeSession.mockResolvedValueOnce(bench.observation(null))
  await readSessionListTitle(bench.ctx, bench.cache, bench.row(), signal())
  expect(cachedSessionTitle(bench.cache, bench.row())).toBeNull()
  await refreshSessionList(bench.ctx, bench.cache, signal())
  expect(cachedSessionTitle(bench.cache, bench.row())).toBeNull()
  bench.stored.revision = 'r2'
  expect(cachedSessionTitle(bench.cache, bench.row())).toBeUndefined()
  await refreshSessionList(bench.ctx, bench.cache, signal())
  expect(bench.cache.titles.size).toBe(0)
  bench.query.observeSession.mockResolvedValueOnce(bench.observation('New title', 'r2'))
  await readSessionListTitle(bench.ctx, bench.cache, bench.row(), signal())
  bench.persistence.list.mockResolvedValueOnce([])
  await refreshSessionList(bench.ctx, bench.cache, signal())
  expect(bench.cache.titles.size).toBe(0)
})

it('retires retained headers and titles when native storage is replaced', async () => {
  const bench = await setup()
  await refreshSessionList(bench.ctx, bench.cache, signal())
  await readSessionListTitle(bench.ctx, bench.cache, bench.row(), signal())
  bench.ctx.set('sessionPersistence', { ...bench.persistence, identity: Symbol('replacement') } as never)
  expect(bench.row()).toBeUndefined()
  expect(bench.cache.titles.size).toBe(0)
  await refreshSessionList(bench.ctx, bench.cache, signal())
  expect(bench.row()).toBeDefined()
})

it.each(['storage', 'unload'])('rejects a late title observation after %s changes', async change => {
  const bench = await setup()
  await refreshSessionList(bench.ctx, bench.cache, signal())
  const row = bench.row()
  const gate = Promise.withResolvers<SessionObservation>()
  bench.query.observeSession.mockReturnValueOnce(gate.promise)
  const reading = readSessionListTitle(bench.ctx, bench.cache, row, signal())
  if (change === 'storage') bench.ctx.set('sessionPersistence', { ...bench.persistence, identity: Symbol('new') } as never)
  else await bench.ctx.fiber.dispose()
  const result = bench.observation()
  gate.resolve(result)
  expect(await reading).toBeUndefined()
  expect(bench.cache.titles.size).toBe(0)
  expect(result[Symbol.dispose]).toHaveBeenCalledOnce()
})

it.each(['storage', 'unload'])('rejects a late catalog after %s changes', async change => {
  const bench = await setup()
  const gate = Promise.withResolvers<typeof bench.stored[]>()
  bench.persistence.list.mockReturnValueOnce(gate.promise)
  const reading = refreshSessionList(bench.ctx, bench.cache, signal())
  if (change === 'storage') bench.ctx.set('sessionPersistence', { ...bench.persistence, identity: Symbol('new') } as never)
  else await bench.ctx.fiber.dispose()
  gate.resolve([bench.stored])
  await reading
  expect(bench.cache.stored).toBeUndefined()
})

it('releases a late aborted observation, and never reuses a live title as a persisted revision', async () => {
  const bench = await setup()
  await refreshSessionList(bench.ctx, bench.cache, signal())
  const row = bench.row()
  const aborted = new AbortController()
  const result = bench.observation()
  bench.query.observeSession.mockImplementationOnce(async () => { aborted.abort(); return result })
  await expect(readSessionListTitle(bench.ctx, bench.cache, row, aborted.signal)).rejects.toThrow()
  expect(result[Symbol.dispose]).toHaveBeenCalledOnce()
  expect(await readSessionListTitle(bench.ctx, bench.cache, { ...row, revision: undefined }, signal())).toBe('Cold title')
  expect(bench.cache.titles.size).toBe(0)
  bench.ctx.sessions.create(row.header.id, { meta: row.header })
  expect(await readSessionListTitle(bench.ctx, bench.cache, row, signal())).toBeNull()
  expect(bench.cache.titles.size).toBe(0)
})

it('contains broken cache views, serves predecessors, and keeps source/header identity strict', async () => {
  const bench = await setup()
  const warn = vi.spyOn(bench.ctx.logger, 'warn').mockImplementation(() => {})
  await refreshSessionList(bench.ctx, bench.cache, signal())
  bench.nativeCache.cachedSnapshot.mockImplementationOnce(() => { throw new Error('cache fault') })
  expect(bench.row().summary.projections).toBeUndefined()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('cache fault'))
  bench.nativeCache.cachedSnapshot.mockReturnValue(undefined as never)
  bench.nativeCache.cachedPredecessorTitle.mockReturnValueOnce({ asOfSeq: 0, values: { title: 'Previous format' } } as never)
  expect(bench.row().summary.projections?.values.title).toBe('Previous format')
  const row = bench.row()
  bench.query.observeSession.mockResolvedValueOnce({ ...bench.observation(), header: { ...bench.header, cwd: '/elsewhere' } })
  await expect(readSessionListTitle(bench.ctx, bench.cache, row, signal())).rejects.toThrow()
  bench.ctx.sessions.create(bench.header.id, { meta: { ...bench.header, cwd: '/elsewhere' } })
  expect(() => bench.row()).toThrow()
})

it('handles absent optional services and omits cold non-conversations', async () => {
  const bench = await setup()
  bench.ctx.set('sessionPersistence', undefined as never)
  bench.ctx.set('sessionQuery', undefined as never)
  bench.ctx.set('sessionProjectionCache', undefined as never)
  await refreshSessionList(bench.ctx, bench.cache, signal())
  expect(sessionListRows(bench.ctx, bench.cache)).toHaveLength(2)
  const live = sessionListRows(bench.ctx, bench.cache)[0]!
  expect(cachedSessionTitle(bench.cache, live)).toBeUndefined()
  expect(await readSessionListTitle(bench.ctx, bench.cache, live, signal())).toBeUndefined()
  bench.cache.stored = [{ header: { ...bench.header, cwd: undefined }, revision: 'r1' } as never]
  expect(sessionListRows(bench.ctx, bench.cache)).toHaveLength(2)
  bench.cache.stored = [bench.stored as never]
  expect(bench.row().summary.projections).toBeUndefined()
})

it('distinguishes an empty live session from one containing events without list metadata', async () => {
  const bench = await setup()
  bench.session.append('session/title', { title: 'Live title', messageSeqs: [], source: { kind: 'user' } })
  expect(sessionListRows(bench.ctx, bench.cache).find(row => row.header.id === 'current')!.summary.blank).toBe(false)
})

it('keeps an attached session without a working directory visible', async () => {
  const bench = await setup()
  bench.ctx.sessions.create(SessionId('cwdless'))
  const row = sessionListRows(bench.ctx, bench.cache).find(row => row.header.id === 'cwdless')!
  expect(row.live).toBe(true)
  expect(row.summary.cwd).toBeUndefined()
})

it.each(['storage', 'unload'])('does not start queued reads belonging to a retired %s scope', async change => {
  const bench = await setup()
  let cache!: ReturnType<typeof createSessionListCache>
  const owner = await bench.ctx.plugin({ name: 'catalog-owner', apply(ctx: Context) { cache = createSessionListCache(ctx) } })
  await refreshSessionList(bench.ctx, cache, signal())
  const row = sessionListRows(bench.ctx, cache).find(row => row.header.id === 'cold')!
  if (change === 'storage') bench.ctx.set('sessionPersistence', { ...bench.persistence, identity: Symbol('new') } as never)
  else await owner.dispose()
  expect(await readSessionListTitle(bench.ctx, cache, row, signal())).toBeUndefined()
  expect(bench.query.observeSession).not.toHaveBeenCalled()
})

it('does not publish a read into a cache rebound to another source generation', async () => {
  const bench = await setup()
  await refreshSessionList(bench.ctx, bench.cache, signal())
  const row = bench.row()
  const gate = Promise.withResolvers<SessionObservation>()
  bench.query.observeSession.mockReturnValueOnce(gate.promise)
  const reading = readSessionListTitle(bench.ctx, bench.cache, row, signal())
  bench.ctx.set('sessionPersistence', { ...bench.persistence, identity: Symbol('new') } as never)
  sessionListRows(bench.ctx, bench.cache)
  bench.ctx.set('sessionPersistence', bench.persistence as never)
  gate.resolve(bench.observation())
  expect(await reading).toBeUndefined()
  expect(bench.cache.titles.size).toBe(0)
})

it('does not read projections for a workspace directory listing or for unselected sessions', async () => {
  const bench = await setup()
  await refreshSessionList(bench.ctx, bench.cache, signal())
  const { sessionListHeaders } = await import('../../src/interaction/session-list-reads.ts')
  const snapshot = vi.spyOn(bench.ctx.sessionProjections, 'snapshot')
  expect(sessionListHeaders(bench.ctx, bench.cache)).toHaveLength(3)
  expect(bench.nativeCache.cachedSnapshot).not.toHaveBeenCalled()
  expect(snapshot).not.toHaveBeenCalled()
  expect(sessionListRows(bench.ctx, bench.cache, { cwd: '/repo/current' }).map(row => row.header.id)).toEqual(['current'])
  expect(bench.nativeCache.cachedSnapshot).not.toHaveBeenCalled()
  expect(sessionListRows(bench.ctx, bench.cache, { ids: new Set(['cold']) }).map(row => row.header.id)).toEqual(['cold'])
  expect(bench.nativeCache.cachedSnapshot).toHaveBeenCalledOnce()
  expect(sessionListRows(bench.ctx, bench.cache, { cwd: '/cold', ids: new Set(['current']) })).toEqual([])
})
