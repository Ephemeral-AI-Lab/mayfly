/** Passive native trace snapshots, exact immutable raw identities and cancellation boundaries. @module */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { traceCatalog, traceDetail } from '../../src/remote/trace-catalog.ts'

const sessionId = SessionId('trace-session')
const event = (seq: number, type: string, data: unknown): SessionEvent => ({ seq, time: 1_000 + seq, type, data }) as unknown as SessionEvent
const sample = () => [event(0, 'custom/event', { value: 'one' }), event(1, 'custom/event', { value: 'two' })]
function fixture(events = sample()) {
  const readSession = vi.fn(async () => ({ events }))
  const relation = { replacedBy: 3, replacementChain: [3, 4], replacedEventSeqs: [0], sourceEventSeqs: [1], derivedEventSeqs: [5] }
  const traceEvent = vi.fn(async (..._args: unknown[]) => relation)
  const activate = vi.fn()
  const ctx = { sessionQuery: { readSession, traceEvent }, agents: { activate } } as unknown as Context
  return { ctx, readSession, traceEvent, relation, activate, events }
}
const request = { sessionId, seq: 0, eventSeqs: [0, 1] }

describe('native passive Session trace', () => {
  it('uses the whole native log and surface records with the rc.2 grouping and frozen output', async () => {
    const f = fixture()
    const rows = await traceCatalog(f.ctx, { sessionId }, new AbortController().signal)
    expect(rows).toMatchInlineSnapshot(`
      [
        {
          "eventSeqs": [
            0,
          ],
          "lastSeq": 0,
          "seq": 0,
          "summary": "{"value":"one"}",
          "surface": "log-only",
          "time": 1000,
          "title": "custom/event",
          "type": "custom/event",
        },
        {
          "eventSeqs": [
            1,
          ],
          "lastSeq": 1,
          "seq": 1,
          "summary": "{"value":"two"}",
          "surface": "log-only",
          "time": 1001,
          "title": "custom/event",
          "type": "custom/event",
        },
      ]
    `)
    expect(f.readSession).toHaveBeenCalledWith(sessionId); expect(f.activate).not.toHaveBeenCalled()
    expect(Object.isFrozen(rows)).toBe(true); expect(Object.isFrozen(rows[0])).toBe(true)
  })

  it('returns detached raw events and every native direct relationship, preserving the catalog selection order', async () => {
    const f = fixture()
    const signal = new AbortController().signal
    const detail = await traceDetail(f.ctx, { ...request, eventSeqs: [1, 0, 0] }, signal)
    expect(detail).toEqual({ rawEvents: f.events, relation: f.relation })
    expect(f.traceEvent).toHaveBeenCalledWith({ sessionId, seq: 0 }, signal)
    expect(detail.rawEvents).not.toBe(f.events)
    expect(Object.isFrozen(detail.rawEvents[0])).toBe(true)
    Reflect.set(f.events[0]!.data as object, 'value', 'changed')
    expect(detail.rawEvents[0]!.data).toEqual({ value: 'one' })
    const withoutReplacement = fixture(); Reflect.deleteProperty(withoutReplacement.relation, 'replacedBy')
    expect((await traceDetail(withoutReplacement.ctx, request, signal)).relation).not.toHaveProperty('replacedBy')
    expect(f.activate).not.toHaveBeenCalled()
  })

  it('refuses missing or non-JSON raw observations before requesting a native relationship', async () => {
    const f = fixture()
    for (const eventSeqs of [[], [1], [0, 3]]) {
      await expect(traceDetail(f.ctx, { ...request, eventSeqs }, new AbortController().signal)).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
    }
    const invalid = fixture([event(0, 'custom/event', { invalid: () => {} })])
    await expect(traceDetail(invalid.ctx, { ...request, eventSeqs: [0] }, new AbortController().signal)).rejects.toMatchObject({ code: 'mayflyHost/session-stale' })
    expect(f.traceEvent).not.toHaveBeenCalled(); expect(invalid.traceEvent).not.toHaveBeenCalled()
  })

  it('does not start after cancellation and rejects late log or relation results without activating an Agent', async () => {
    for (const read of [traceCatalog, traceDetail]) {
      const f = fixture()
      await expect(read(f.ctx, request, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
      expect(f.readSession).not.toHaveBeenCalled()
      const pending = Promise.withResolvers<{ events: SessionEvent[] }>()
      f.readSession.mockReturnValueOnce(pending.promise)
      const cancellation = new AbortController()
      const operation = read(f.ctx, request, cancellation.signal)
      cancellation.abort(); pending.resolve({ events: f.events })
      await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
      expect(f.traceEvent).not.toHaveBeenCalled(); expect(f.activate).not.toHaveBeenCalled()
    }
    const f = fixture(); const pending = Promise.withResolvers<typeof f.relation>()
    f.traceEvent.mockReturnValueOnce(pending.promise)
    const cancellation = new AbortController(); const operation = traceDetail(f.ctx, request, cancellation.signal)
    await Promise.resolve(); cancellation.abort(); pending.resolve(f.relation)
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' })
  })
})
