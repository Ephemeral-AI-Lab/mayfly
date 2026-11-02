/** Passive native journal pagination, cancellation and malformed wire boundaries. @module */
import { describe, expect, it, vi } from 'vitest'
import type { HostClient } from '../../src/client/types.ts'
import { collectRemoteSessionEvents, remoteReadNumber, remoteReadString } from '../../src/remote/operations/support.ts'
import { wire } from './export-fixture.ts'

const address = { sessionId: 'session' } as Parameters<typeof collectRemoteSessionEvents>[1]['address']
const page = (sequences: readonly number[], hasMore = false) => ({ ok: true, value: { records: sequences.map(seq => ({ type: 'event', event: wire('turn/start', { turn: seq }, seq) })), hasMore } })
function fixture() {
  const events = vi.fn(async (..._args: unknown[]): Promise<unknown> => page([]))
  const client = { remote: { session: { events } } } as unknown as HostClient
  return { events, client }
}

describe('passive remote journal walk', () => {
  it('preserves exact address and page options and returns canonical event order across native pages', async () => {
    const f = fixture()
    f.events.mockResolvedValueOnce(page([9, 8], true)).mockResolvedValueOnce(page([6, 5], true)).mockResolvedValueOnce(page([2, 1]))
    const result = await collectRemoteSessionEvents(f.client, { address, maxMessages: 2 })
    expect(result.map(event => event.seq)).toEqual([1, 2, 5, 6, 8, 9])
    expect(f.events.mock.calls.map(call => call[0])).toEqual([{ address, maxMessages: 2 }, { address, maxMessages: 2, beforeSeq: 8 }, { address, maxMessages: 2, beforeSeq: 5 }])
  })

  it('bounds uncooperative pagination by minimum events, page count and decreasing native floor', async () => {
    const f = fixture()
    f.events.mockResolvedValue(page([10, 9], true))
    expect(await collectRemoteSessionEvents(f.client, { address, maxPages: 0 })).toEqual([])
    expect(f.events).not.toHaveBeenCalled()
    expect(await collectRemoteSessionEvents(f.client, { address, minEvents: 1 })).toHaveLength(2)
    expect(f.events).toHaveBeenCalledOnce()
    f.events.mockClear()
    expect(await collectRemoteSessionEvents(f.client, { address, maxPages: 1 })).toHaveLength(2)
    expect(f.events).toHaveBeenCalledOnce()
    f.events.mockClear()
    expect(await collectRemoteSessionEvents(f.client, { address })).toHaveLength(4)
    expect(f.events).toHaveBeenCalledTimes(2)
  })

  it('stops at native pages without durable events and preserves structured read failures', async () => {
    const f = fixture()
    f.events.mockResolvedValueOnce({ ok: true, value: { records: [{ type: 'assistant-settlement' }], hasMore: true } })
    expect(await collectRemoteSessionEvents(f.client, { address })).toEqual([])
    expect(f.events).toHaveBeenCalledOnce()
    f.events.mockResolvedValueOnce({ ok: false, error: { code: 'session-not-found', message: 'Native Session is unavailable' } })
    await expect(collectRemoteSessionEvents(f.client, { address })).rejects.toThrow('Native Session is unavailable')
  })

  it('cancels before admission and after a late native page without sending another read', async () => {
    const f = fixture()
    const controller = new AbortController()
    controller.abort(new Error('cancelled before read'))
    await expect(collectRemoteSessionEvents(f.client, { address, signal: controller.signal })).rejects.toThrow('cancelled before read')
    expect(f.events).not.toHaveBeenCalled()
    const live = new AbortController()
    const ready = Promise.withResolvers<unknown>()
    f.events.mockReturnValueOnce(ready.promise)
    const pending = collectRemoteSessionEvents(f.client, { address, signal: live.signal })
    live.abort(new Error('cancelled during read'))
    ready.resolve(page([1], true))
    await expect(pending).rejects.toThrow('cancelled during read')
    expect(f.events).toHaveBeenCalledOnce()
    const valid = new AbortController()
    expect(await collectRemoteSessionEvents(f.client, { address, signal: valid.signal })).toEqual([])
  })

  it('reads only genuine string properties at projection boundaries', () => {
    expect(remoteReadString({ value: 'native' }, 'value')).toBe('native')
    for (const value of [undefined, null, [], 12, {}, { value: 1 }]) expect(remoteReadString(value, 'value')).toBeUndefined()
    expect(remoteReadNumber({ value: 12 }, 'value')).toBe(12)
    for (const value of [null, {}, { value: '12' }, { value: Infinity }, { value: NaN }]) expect(remoteReadNumber(value, 'value')).toBeUndefined()
  })
})
