/** Native Session Controller catalog retention and scope filtering.
 * @module @ephemeral-ai/mayfly/tests/interaction/session-list-reads
 */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSessionListCache, refreshSessionList, sessionListRows, sessionListTitle } from '../../src/interaction/session-list-reads.ts'

const roots: Context[] = []
afterEach(async () => { for (const ctx of roots.splice(0)) await ctx.fiber.dispose() })
const signal = () => new AbortController().signal

function summary(over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: SessionId('session-one'),
    updatedAt: 10,
    running: false,
    blank: false,
    cwd: '/repo/one',
    agentAvailable: false,
    ...over,
  } as SessionSummary
}

function controllerOf(items: readonly SessionSummary[] = []) {
  return { list: vi.fn(async () => ({ items })) }
}

async function setup(items: readonly SessionSummary[] = [summary()]) {
  const ctx = new Context()
  roots.push(ctx)
  const controller = controllerOf(items)
  ctx.provide('sessionController', controller as never)
  const cache = createSessionListCache(ctx)
  return { ctx, controller, cache }
}

describe('refreshSessionList', () => {
  it('reads the native catalog once and retains its rows in controller order', async () => {
    const rows = [summary({ sessionId: SessionId('session-two'), updatedAt: 20 }), summary()]
    const bench = await setup(rows)
    await refreshSessionList(bench.ctx, bench.cache, signal())
    expect(bench.controller.list).toHaveBeenCalledOnce()
    expect(bench.controller.list).toHaveBeenCalledWith({}, expect.any(AbortSignal))
    expect(bench.cache.stored).toBe(rows)
    expect(sessionListRows(bench.ctx, bench.cache).map(row => String(row.sessionId))).toEqual(['session-two', 'session-one'])
  })

  it('filters by exact cwd and explicit ids without a second read', async () => {
    const bench = await setup([
      summary({ sessionId: SessionId('session-a'), cwd: '/repo/a' }),
      summary({ sessionId: SessionId('session-b'), cwd: '/repo/b' }),
      summary({ sessionId: SessionId('session-c'), cwd: undefined } as never),
    ])
    await refreshSessionList(bench.ctx, bench.cache, signal())
    expect(sessionListRows(bench.ctx, bench.cache, { cwd: '/repo/a' }).map(row => row.sessionId)).toEqual(['session-a'])
    expect(sessionListRows(bench.ctx, bench.cache, { ids: new Set(['session-b', 'session-c']) }).map(row => row.sessionId)).toEqual(['session-b', 'session-c'])
    expect(sessionListRows(bench.ctx, bench.cache, { cwd: '/repo/a', ids: new Set(['session-b']) })).toEqual([])
    expect(bench.controller.list).toHaveBeenCalledOnce()
  })

  it('lets the newest listing win over a slower earlier one', async () => {
    const bench = await setup()
    const first = Promise.withResolvers<{ items: readonly SessionSummary[] }>()
    bench.controller.list.mockReturnValueOnce(first.promise)
    const older = refreshSessionList(bench.ctx, bench.cache, signal())
    const newer = summary({ sessionId: SessionId('session-new') })
    bench.controller.list.mockResolvedValueOnce({ items: [newer] })
    await refreshSessionList(bench.ctx, bench.cache, signal())
    first.resolve({ items: [summary({ sessionId: SessionId('session-old') })] })
    await older
    expect(sessionListRows(bench.ctx, bench.cache).map(row => row.sessionId)).toEqual(['session-new'])
  })

  it('retires retained rows when the controller service is replaced', async () => {
    const bench = await setup()
    await refreshSessionList(bench.ctx, bench.cache, signal())
    expect(sessionListRows(bench.ctx, bench.cache)).toHaveLength(1)
    const replacement = controllerOf([summary({ sessionId: SessionId('session-new') })])
    bench.ctx.set('sessionController', replacement as never)
    expect(sessionListRows(bench.ctx, bench.cache)).toEqual([])
    await refreshSessionList(bench.ctx, bench.cache, signal())
    expect(replacement.list).toHaveBeenCalledOnce()
    expect(sessionListRows(bench.ctx, bench.cache).map(row => row.sessionId)).toEqual(['session-new'])
  })

  it('discards a late listing from a replaced controller', async () => {
    const bench = await setup()
    const gate = Promise.withResolvers<{ items: readonly SessionSummary[] }>()
    bench.controller.list.mockReturnValueOnce(gate.promise)
    const reading = refreshSessionList(bench.ctx, bench.cache, signal())
    bench.ctx.set('sessionController', controllerOf() as never)
    gate.resolve({ items: [summary()] })
    await reading
    expect(bench.cache.stored).toBeUndefined()
  })

  it('retires retained rows when the owning Fiber unloads and ignores its late read', async () => {
    const ctx = new Context()
    roots.push(ctx)
    const controller = controllerOf()
    ctx.provide('sessionController', controller as never)
    let cache!: ReturnType<typeof createSessionListCache>
    const owner = await ctx.plugin({ name: 'catalog-owner', apply(scope: Context) { cache = createSessionListCache(scope) } })
    const gate = Promise.withResolvers<{ items: readonly SessionSummary[] }>()
    controller.list.mockReturnValueOnce(gate.promise)
    const reading = refreshSessionList(ctx, cache, signal())
    await owner.dispose()
    gate.resolve({ items: [summary()] })
    await reading
    expect(cache.stored).toBeUndefined()
    expect(cache.active).toBe(false)
  })

  it('is a no-op without a controller and rejects an aborted listing', async () => {
    const ctx = new Context()
    roots.push(ctx)
    const cache = createSessionListCache(ctx)
    await expect(refreshSessionList(ctx, cache, signal())).resolves.toBeUndefined()
    expect(cache.stored).toBeUndefined()
    const controller = controllerOf()
    ctx.provide('sessionController', controller as never)
    const aborted = new AbortController()
    aborted.abort()
    controller.list.mockRejectedValueOnce(new Error('cancelled'))
    await expect(refreshSessionList(ctx, cache, aborted.signal)).rejects.toThrow('cancelled')
    expect(cache.stored).toBeUndefined()
  })
})

describe('sessionListTitle', () => {
  it('reads only the cached title hint and trims it', () => {
    expect(sessionListTitle(summary())).toBeUndefined()
    expect(sessionListTitle(summary({ projections: { kind: 'cached', asOfSeq: 1, values: { title: '  Named  ' } } as never }))).toBe('Named')
    expect(sessionListTitle(summary({ projections: { kind: 'cached', asOfSeq: 1, values: { title: '   ' } } as never }))).toBeUndefined()
    expect(sessionListTitle(summary({ projections: { kind: 'cached', asOfSeq: 1, values: { title: null } } as never }))).toBeUndefined()
  })
})
