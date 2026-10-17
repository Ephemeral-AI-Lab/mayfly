/** Cross-session `/stats` indexing through the native Session Query service.
 * @module @ephemeral-ai/mayfly/tests/interaction/stats-index
 */
import { Context } from '@deepseek-ai/cordis'
import type { SessionObservation, SessionRecord } from '@deepseek-ai/dsh-session-query'
import { afterEach, expect, it, vi } from 'vitest'
import { dayKey } from '../../src/interaction/stats-index/digest.ts'
import { createStatsIndex, INDEX_SESSION_LIMIT, readDigests, refreshStatsIndex } from '../../src/interaction/stats-index/index.ts'

const roots: Context[] = []
afterEach(async () => { for (const ctx of roots.splice(0)) await ctx.fiber.dispose() })
const signal = () => new AbortController().signal
const DAY = 1_800_000_000_000

function record(id: string, cwd = '/repo', createdAt = DAY): SessionRecord {
  return { header: { id, cwd, createdAt } as never, live: false, persisted: true }
}

function event(type: string, time: number) {
  return type === 'turn/start'
    ? { type, seq: 1, time, data: {} }
    : { type, seq: 2, time, data: { usage: { inputTokens: 100, cacheReadTokens: 10, cacheWriteTokens: 5, outputTokens: 20 }, message: { source: { provider: 'deepseek', model: 'deepseek-chat' } } } }
}

function observation(header: SessionRecord['header'], revision: string | undefined, events = [event('turn/start', DAY)]) {
  return {
    header, source: 'prepared', inheritedEventCount: 0, events, cursor: 2,
    ...(revision === undefined ? {} : { revision }),
    [Symbol.dispose]: vi.fn(),
  } as unknown as SessionObservation
}

function setup(records: readonly SessionRecord[] = [record('a'), record('b')]) {
  const ctx = new Context(); roots.push(ctx)
  const query = {
    listSessions: vi.fn(async () => [...records]),
    observeSession: vi.fn(async (id: string) => observation(records.find(item => String(item.header.id) === id)?.header ?? record(id).header, 'r1')),
  }
  ctx.provide('sessionQuery', query as never)
  const index = createStatsIndex(ctx)
  return { ctx, query, index }
}

it('lists once, observes each wanted session, and keeps the folded digests newest first', async () => {
  const bench = setup([record('a', '/repo', DAY - 10), record('b', '/repo', DAY)])
  const progress: unknown[] = []
  await refreshStatsIndex(bench.ctx, bench.index, undefined, signal(), state => progress.push(state))
  expect(bench.query.listSessions).toHaveBeenCalledOnce()
  expect(bench.query.observeSession).toHaveBeenCalledTimes(2)
  expect(progress.at(-1)).toMatchObject({ done: 2, total: 2, skipped: 0, failed: 0 })
  expect(readDigests(bench.index, undefined).map(digest => digest.id)).toEqual(['b', 'a'])
  expect(readDigests(bench.index, '/repo')).toHaveLength(2)
  expect(readDigests(bench.index, '/elsewhere')).toEqual([])
})

it('refolds a cold log only when its durable revision moves', async () => {
  const bench = setup([record('a')])
  bench.query.observeSession.mockResolvedValueOnce(observation(record('a').header, 'r1', [event('turn/start', DAY), event('assistant/message', DAY)]))
  await refreshStatsIndex(bench.ctx, bench.index, undefined, signal(), () => {})
  const first = readDigests(bench.index, undefined)[0]!
  expect(first.days.get(dayKey(DAY))?.turns).toBe(1)
  bench.query.observeSession.mockResolvedValueOnce(observation(record('a').header, 'r1', [event('turn/start', DAY), event('turn/start', DAY), event('assistant/message', DAY)]))
  await refreshStatsIndex(bench.ctx, bench.index, undefined, signal(), () => {})
  expect(readDigests(bench.index, undefined)[0]).toBe(first)
  bench.query.observeSession.mockResolvedValueOnce(observation(record('a').header, 'r2', [event('turn/start', DAY), event('turn/start', DAY), event('assistant/message', DAY)]))
  await refreshStatsIndex(bench.ctx, bench.index, undefined, signal(), () => {})
  expect(readDigests(bench.index, undefined)[0]).not.toBe(first)
  expect(readDigests(bench.index, undefined)[0]!.days.get(dayKey(DAY))?.turns).toBe(2)
})

it('filters the workspace before the cap and counts the sessions it does not read', async () => {
  const records = Array.from({ length: INDEX_SESSION_LIMIT + 5 }, (_unused, index) => record(`s-${String(index)}`, index < 3 ? '/wanted' : '/other', DAY + index))
  const bench = setup(records)
  const progress: { skipped: number }[] = []
  await refreshStatsIndex(bench.ctx, bench.index, '/wanted', signal(), state => progress.push(state))
  expect(bench.query.observeSession).toHaveBeenCalledTimes(3)
  expect(progress.at(-1)?.skipped).toBe(0)
  const all = setup(records)
  await refreshStatsIndex(all.ctx, all.index, undefined, signal(), state => progress.push(state))
  expect(all.query.observeSession).toHaveBeenCalledTimes(INDEX_SESSION_LIMIT)
  expect(progress.at(-1)?.skipped).toBe(5)
})

it('keeps the previous digest when one observation fails', async () => {
  const bench = setup([record('a'), record('b')])
  await refreshStatsIndex(bench.ctx, bench.index, undefined, signal(), () => {})
  bench.query.observeSession.mockRejectedValueOnce(new Error('corrupt log'))
  const warn = vi.spyOn(bench.ctx.logger, 'warn').mockImplementation(() => {})
  const progress: { failed: number }[] = []
  await refreshStatsIndex(bench.ctx, bench.index, undefined, signal(), state => progress.push(state))
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('corrupt log'))
  expect(progress.at(-1)?.failed).toBe(1)
  expect(readDigests(bench.index, undefined).map(digest => digest.id).sort()).toEqual(['a', 'b'])
})

it('retires the index when the query service is replaced and keeps it without one', async () => {
  const bench = setup([record('a')])
  await refreshStatsIndex(bench.ctx, bench.index, undefined, signal(), () => {})
  expect(readDigests(bench.index, undefined)).toHaveLength(1)
  bench.ctx.set('sessionQuery', undefined as never)
  const other = setup([record('b')])
  bench.ctx.set('sessionQuery', other.query as never)
  await refreshStatsIndex(bench.ctx, bench.index, undefined, signal(), () => {})
  expect(readDigests(bench.index, undefined).map(digest => digest.id)).toEqual(['b'])
  bench.ctx.set('sessionQuery', undefined as never)
  await refreshStatsIndex(bench.ctx, bench.index, undefined, signal(), () => {})
  expect(bench.index.listed).toBeDefined()
})

it('is a no-op without a query service and drops digests for sessions that disappeared', async () => {
  const ctx = new Context(); roots.push(ctx)
  const index = createStatsIndex(ctx)
  await expect(refreshStatsIndex(ctx, index, undefined, signal(), () => {})).resolves.toBeUndefined()
  expect(index.listed).toBeUndefined()
  const bench = setup([record('a'), record('b')])
  await refreshStatsIndex(bench.ctx, bench.index, undefined, signal(), () => {})
  bench.query.listSessions.mockResolvedValueOnce([record('b')])
  bench.query.observeSession.mockResolvedValueOnce(observation(record('b').header, 'r1'))
  await refreshStatsIndex(bench.ctx, bench.index, undefined, signal(), () => {})
  expect(bench.index.digests.has('a')).toBe(false)
})
