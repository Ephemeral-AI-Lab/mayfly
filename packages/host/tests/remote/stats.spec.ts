/** Passive statistics, immutable reference digests, bounded scans and retirement. @module */
import { readFileSync } from 'node:fs'
import { Context, symbols } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { statsDigest } from '../../src/remote/stats-digest.ts'
import type { MayflyStatsHistory } from '../../src/remote/stats-contract.ts'
import { StatsHistory, statsSession } from '../../src/remote/stats.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose(); vi.unstubAllEnvs() })
const id = SessionId('current')
const event = (type: string, time: number, data: unknown = {}): SessionEvent => ({ seq: 0, type, time, data }) as SessionEvent
const turn = (time = Date.parse('2026-10-05T01:00:00Z')) => event('turn/start', time)
const message = (provider: string, time: number, usage: unknown = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 }) => event('assistant/message', time, { message: { source: { provider, model: 'm' } }, usage })
const decode = (value: NonNullable<ReturnType<typeof statsDigest>>) => ({ ...value, days: new Map(value.days.map(day => [day.key, { turns: day.turns, models: new Map(day.models.map(model => [`${model.provider}\0${model.model}`, model])) }])) })
function fixture(count = 2) {
  const ctx = new Context(); contexts.push(ctx)
  const records = Array.from({ length: count }, (_value, index) => ({ header: { id: SessionId(String(index)), createdAt: index, cwd: index % 2 === 0 ? '/work' : '/other' } }))
  const dispose = vi.fn()
  const observe = vi.fn(async (sessionId: string, ..._args: unknown[]) => ({ source: 'prepared' as 'live' | 'prepared', header: { id: sessionId, createdAt: 100, cwd: '/work' }, events: [turn()], revision: 'r1' as string | undefined, [Symbol.dispose]: dispose }))
  const list = vi.fn(async (..._args: unknown[]) => records)
  const query = { observeSession: observe, listSessions: list }
  ctx.provide('sessionQuery', query)
  ctx.provide('agents', { get: vi.fn(() => undefined) })
  const index = new StatsHistory(ctx)
  const request = { sessionId: id, allWorkspaces: true }
  const read = async (allWorkspaces = true, signal = new AbortController().signal) => { const frames: MayflyStatsHistory[] = []; for await (const frame of index.read({ ...request, allWorkspaces }, signal)) frames.push(frame); return frames }
  return { ctx, index, records, query, observe, list, dispose, request, read }
}

describe('Host rc.2 statistics digests', () => {
  it('keeps the rc.2 digest for complete logs and preserves zero, invalid and missing usage semantics', () => {
    // The immutable digest below uses Los Angeles local days. Peak pricing
    // remains Beijing-based regardless of the Host's local calendar.
    vi.stubEnv('TZ', 'America/Los_Angeles')
    const monday = Date.parse('2026-10-05T00:00:00Z')
    const hours = [0, 1, 3, 4, 5, 6, 9, 10, 11]
    const events = [event('custom/test', monday), ...hours.flatMap(hour => [message('deepseek', monday + hour * 3_600_000), message('deepseek-official', monday + hour * 3_600_000)]),
      message('other', monday), message('deepseek', monday + 5 * 86_400_000), message('deepseek', monday + 6 * 86_400_000),
      message('other', monday, { inputTokens: -1, outputTokens: Infinity, cacheReadTokens: '12', cacheWriteTokens: 0 }), message('other', monday, undefined), turn(monday), turn(monday), turn(monday + 86_400_000)]
    // An explicit missing usage is distinct from the fixture's default argument.
    events.push(event('assistant/message', monday, { message: { source: { provider: 'other', model: 'm' } } }))
    const digest = statsDigest('s', '/work', events)!
    expect(JSON.stringify(decode(digest), (_key, value: unknown) => value instanceof Map ? [...value] : value, 2)).toMatchInlineSnapshot(`
      "{
        "id": "s",
        "cwd": "/work",
        "firstAt": 1791158400000,
        "lastAt": 1791676800000,
        "days": [
          [
            "2026-10-04",
            {
              "turns": 2,
              "models": [
                [
                  "deepseek\\u0000m",
                  {
                    "provider": "deepseek",
                    "model": "m",
                    "peak": {
                      "input": 30,
                      "output": 15,
                      "cacheRead": 6,
                      "cacheWrite": 3
                    },
                    "offPeak": {
                      "input": 30,
                      "output": 15,
                      "cacheRead": 6,
                      "cacheWrite": 3
                    }
                  }
                ],
                [
                  "deepseek-official\\u0000m",
                  {
                    "provider": "deepseek-official",
                    "model": "m",
                    "peak": {
                      "input": 30,
                      "output": 15,
                      "cacheRead": 6,
                      "cacheWrite": 3
                    },
                    "offPeak": {
                      "input": 30,
                      "output": 15,
                      "cacheRead": 6,
                      "cacheWrite": 3
                    }
                  }
                ],
                [
                  "other\\u0000m",
                  {
                    "provider": "other",
                    "model": "m",
                    "peak": {
                      "input": 0,
                      "output": 0,
                      "cacheRead": 0,
                      "cacheWrite": 0
                    },
                    "offPeak": {
                      "input": 20,
                      "output": 10,
                      "cacheRead": 4,
                      "cacheWrite": 2
                    }
                  }
                ]
              ]
            }
          ],
          [
            "2026-10-05",
            {
              "turns": 1,
              "models": [
                [
                  "deepseek\\u0000m",
                  {
                    "provider": "deepseek",
                    "model": "m",
                    "peak": {
                      "input": 10,
                      "output": 5,
                      "cacheRead": 2,
                      "cacheWrite": 1
                    },
                    "offPeak": {
                      "input": 20,
                      "output": 10,
                      "cacheRead": 4,
                      "cacheWrite": 2
                    }
                  }
                ],
                [
                  "deepseek-official\\u0000m",
                  {
                    "provider": "deepseek-official",
                    "model": "m",
                    "peak": {
                      "input": 10,
                      "output": 5,
                      "cacheRead": 2,
                      "cacheWrite": 1
                    },
                    "offPeak": {
                      "input": 20,
                      "output": 10,
                      "cacheRead": 4,
                      "cacheWrite": 2
                    }
                  }
                ]
              ]
            }
          ],
          [
            "2026-10-09",
            {
              "turns": 0,
              "models": [
                [
                  "deepseek\\u0000m",
                  {
                    "provider": "deepseek",
                    "model": "m",
                    "peak": {
                      "input": 0,
                      "output": 0,
                      "cacheRead": 0,
                      "cacheWrite": 0
                    },
                    "offPeak": {
                      "input": 10,
                      "output": 5,
                      "cacheRead": 2,
                      "cacheWrite": 1
                    }
                  }
                ]
              ]
            }
          ],
          [
            "2026-10-10",
            {
              "turns": 0,
              "models": [
                [
                  "deepseek\\u0000m",
                  {
                    "provider": "deepseek",
                    "model": "m",
                    "peak": {
                      "input": 0,
                      "output": 0,
                      "cacheRead": 0,
                      "cacheWrite": 0
                    },
                    "offPeak": {
                      "input": 10,
                      "output": 5,
                      "cacheRead": 2,
                      "cacheWrite": 1
                    }
                  }
                ]
              ]
            }
          ]
        ]
      }"
    `)
    expect(Object.isFrozen(digest.days[0]!.models[0]!.peak)).toBe(true)
    expect(statsDigest('empty', undefined, [event('custom/test', monday)])).toBeUndefined()
  })

  it.each([
    ['UTC', '2026-10-05'],
    ['America/Los_Angeles', '2026-10-04'],
    ['Asia/Shanghai', '2026-10-05'],
  ])('uses %s local days without changing Beijing peak pricing', (zone, key) => {
    vi.stubEnv('TZ', zone)
    const at = Date.parse('2026-10-05T01:00:00Z')
    const digest = statsDigest('s', undefined, [turn(at), message('deepseek', at)])!
    expect(digest.days).toEqual([{ key, turns: 1, models: [{ provider: 'deepseek', model: 'm',
      peak: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1 },
      offPeak: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }] }])
  })

  it('reads a passive current Session and releases the observation at success and late cancellation', async () => {
    const f = fixture()
    const result = await statsSession(f.ctx, f.request, new AbortController().signal)
    expect(result).toMatchObject({ createdAt: 100, cwd: '/work', status: 'idle', harnessVersion: JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).peerDependencies['@deepseek-ai/dsh-session'] })
    expect(f.dispose).toHaveBeenCalledTimes(1)
    expect(f.observe).toHaveBeenCalledWith(id, expect.objectContaining({ projectionMode: 'none' }))
    f.ctx.set('agents', { get: () => ({ status: 'running' }) })
    expect((await statsSession(f.ctx, f.request, new AbortController().signal)).status).toBe('running')
    await expect(statsSession(f.ctx, f.request, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    const stop = new AbortController()
    const observation = await f.query.observeSession(id)
    f.observe.mockImplementationOnce(async () => { stop.abort(); return observation })
    await expect(statsSession(f.ctx, f.request, stop.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('publishes complete newest-first snapshots and reuses only unchanged cold revisions', async () => {
    const f = fixture(5)
    const frames = await f.read()
    expect(frames[0]).toMatchObject({ running: true, done: 0, total: 5 })
    expect(frames.at(-1)).toMatchObject({ running: false, done: 5, failed: 0, skipped: 0 })
    expect(frames.at(-1)!.digests.map(item => item.id)).toEqual(['4', '3', '2', '1', '0'])
    expect(f.dispose).toHaveBeenCalledTimes(6)
    const old = frames.at(-1)!.digests[0]
    const again = await f.read()
    expect(again[0]!.digests).toEqual([])
    expect(again.at(-1)!.digests[0]).toBe(old)
    f.records.splice(0, 1)
    const scoped = await f.read(false)
    expect(scoped.at(-1)!.total).toBe(2)
    expect(scoped.at(-1)!.digests.map(item => item.id)).toEqual(['4', '2'])
  })

  it('never publishes unverified cached digests when a later observation fails', async () => {
    const f = fixture(2)
    await f.read()
    const original = f.observe.getMockImplementation()!
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof original>>>()
    f.observe.mockImplementation(async (sessionId, ...args) => {
      if (sessionId === id) return original(sessionId, ...args)
      if (sessionId === '0') throw new Error('cold source unreadable')
      return pending.promise
    })
    const iterator = f.index.read(f.request, new AbortController().signal)[Symbol.asyncIterator]()
    expect((await iterator.next()).value).toMatchObject({ running: true, done: 0, digests: [] })
    expect((await iterator.next()).value).toMatchObject({ running: true, done: 1, failed: 1, digests: [] })
    pending.resolve({ ...await original('1'), revision: 'r2', events: [turn(), turn()] })
    const remaining = []
    for (;;) { const next = await iterator.next(); if (next.done) break; remaining.push(next.value) }
    expect(remaining.at(-1)).toMatchObject({ running: false, failed: 1, digests: [{ id: '1', days: [{ turns: 2 }] }] })
    expect(remaining.every(frame => frame.digests.every(digest => digest.id !== '0'))).toBe(true)
  })

  it('recomputes live observations even if they carry the same durable revision', async () => {
    const f = fixture(1)
    await f.read()
    const original = f.observe.getMockImplementation()!
    f.observe.mockImplementation(async (sessionId, ...args) => ({ ...await original(sessionId, ...args), source: 'live', events: [turn(), turn()] }))
    expect((await f.read()).at(-1)).toMatchObject({ digests: [{ days: [{ turns: 2 }] }] })
    f.observe.mockImplementation(async (sessionId, ...args) => ({ ...await original(sessionId, ...args), source: 'live', events: [turn(), turn(), turn()] }))
    expect((await f.read()).at(-1)).toMatchObject({ digests: [{ days: [{ turns: 3 }] }] })
  })

  it('refreshes live and revised records, removes newly empty digests, and accounts for unreadable logs', async () => {
    const f = fixture(1)
    await f.read()
    const original = f.observe.getMockImplementation()!
    f.observe.mockImplementation(async (sessionId, ...args) => ({ ...await original(sessionId, ...args), revision: undefined, events: [] }))
    expect((await f.read()).at(-1)!.digests).toEqual([])
    f.observe.mockImplementation(async (sessionId, ...args) => {
      if (sessionId !== id) throw new Error('cold read failed')
      return original(sessionId, ...args)
    })
    expect((await f.read()).at(-1)).toMatchObject({ failed: 1, done: 1 })
    f.observe.mockImplementation(async (sessionId, ...args) => ({ ...await original(sessionId, ...args), revision: 'r2' }))
    expect((await f.read()).at(-1)!.digests).toHaveLength(1)
  })

  it('caps the newest 300 records, reports skips and handles an empty corpus', async () => {
    const f = fixture(303)
    const last = (await f.read()).at(-1)!
    expect(last).toMatchObject({ total: 300, skipped: 3, done: 300 })
    expect(last.digests[0]!.id).toBe('302')
    f.records.length = 0
    expect((await f.read()).at(-1)).toMatchObject({ total: 0, digests: [] })
  })

  it('fences service replacement, native listing errors, unload and cancellation before and after awaits', async () => {
    const f = fixture()
    await expect(f.read(true, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
    f.list.mockRejectedValueOnce(new Error('list unavailable'))
    await expect(f.read()).rejects.toThrow('list unavailable')
    f.list.mockImplementationOnce(async () => { f.ctx.set('sessionQuery', { ...f.query }); return f.records })
    await expect(f.read()).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
    // Cordis proxies with the same original service must preserve the memo.
    const wrapped = { ...f.query, [symbols.original]: f.query }
    f.ctx.set('sessionQuery', wrapped)
    expect((await f.read()).at(-1)!.done).toBe(2)
    const original = f.observe.getMockImplementation()!
    const stop = new AbortController()
    f.observe.mockImplementationOnce(async (sessionId, ...args) => { const observation = await original(sessionId, ...args); stop.abort(); return observation })
    await expect(f.read(true, stop.signal)).rejects.toMatchObject({ name: 'AbortError' })
    f.observe.mockImplementationOnce(async (sessionId, ...args) => { const observation = await original(sessionId, ...args); await f.ctx.fiber.dispose(); return observation })
    await expect(f.read()).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
  })

  it('retires workers when the caller closes a stream or cancels an active observation', async () => {
    const f = fixture(1)
    const original = f.observe.getMockImplementation()!
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof original>>>()
    f.observe.mockImplementation(async (sessionId, ...args) => sessionId === id ? original(sessionId, ...args) : pending.promise)
    const stream = f.index.read(f.request, new AbortController().signal)[Symbol.asyncIterator]()
    expect((await stream.next()).value).toMatchObject({ done: 0 })
    await stream.return!(undefined)
    pending.resolve(await original('0'))
    await new Promise<void>(resolve => setImmediate(resolve))
    const controller = new AbortController()
    const wait = Promise.withResolvers<Awaited<ReturnType<typeof original>>>()
    f.observe.mockImplementation(async (sessionId, ...args) => sessionId === id ? original(sessionId, ...args) : wait.promise)
    const frames = f.read(true, controller.signal)
    await new Promise<void>(resolve => setImmediate(resolve))
    controller.abort(); wait.resolve(await original('0'))
    await expect(frames).rejects.toMatchObject({ name: 'AbortError' })
  })
})
