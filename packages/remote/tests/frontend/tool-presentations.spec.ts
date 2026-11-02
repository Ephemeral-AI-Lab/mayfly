/** Exact native call identities, immutable result transport, incremental batches and lifecycle fences. @module */
import { describe, expect, it, vi } from 'vitest'
import type { ConversationProjection, ConversationToolEntry } from '@ephemeral-ai/mayfly/conversation'
import type { HostClient, SessionRef } from '../../src/client/types.ts'
import { HostKey } from '../../src/client/types.ts'
import { RemoteToolPresentationCache, createMayflyToolPresentationResolver, remoteToolPresentationKey, type RemoteToolPresentationRequest, type RemoteToolPresentationGeneration } from '../../src/frontend/tool-presentations.ts'
import { good, bad, tick } from '../remote/task-feature-fixture.ts'

const ref = (host = 'host', sessionId = 'session') => ({ host: HostKey(host), sessionId: sessionId as SessionRef['sessionId'] })
const entry = (callId = 'one', updatedSeq = 1, extra: Partial<ConversationToolEntry> = {}): ConversationToolEntry => ({ id: `tool:${callId}`, seq: 0, updatedSeq, turn: 1, step: 1, kind: 'tool', channel: 'transcript', callId, name: 'read', arguments: '{"file_path":"same.txt"}', startedAt: 0, result: { content: [{ type: 'text', text: 'native' }], text: 'native', isError: false, endedAt: 1, meta: { path: 'same.txt' } }, ...extra })
const projection = (...entries: ConversationProjection['entries']): ConversationProjection => ({ entries, streaming: false, settledSteps: [], turns: [] })
const answer = (request: RemoteToolPresentationRequest) => good({ presentations: Object.fromEntries([...new Set(request.entries.map(entry => String(entry.sessionId)))].map(sessionId => [sessionId, Object.fromEntries(request.entries.filter(entry => String(entry.sessionId) === sessionId).map(entry => [entry.callId, { updatedSeq: entry.updatedSeq, call: { card: 'generic' as const, title: `call ${entry.callId}` }, result: { card: 'generic' as const, text: `result ${entry.callId}` } }]))])) })
function fixture() {
  const present = vi.fn(async (request: RemoteToolPresentationRequest, _signal: AbortSignal): Promise<unknown> => answer(request))
  let revision = 'native:1'
  const resolve = vi.fn(() => ({ presentationRevision: revision, present } as unknown as RemoteToolPresentationGeneration))
  const cache = new RemoteToolPresentationCache(resolve)
  return { cache, present, resolve, revision: (next: string) => { revision = next } }
}

describe('exact call presentation cache', () => {
  it('returns both phases of the same call independently of lookup count, with repeated names and identical arguments', async () => {
    const f = fixture()
    const input = projection(entry('one'), entry('two'), entry('pending', 1, { result: undefined }))
    const changed = vi.fn(); const off = f.cache.subscribe(changed)
    f.cache.source(ref(), input); f.cache.source(ref(), input)
    await tick()
    expect(f.present).toHaveBeenCalledOnce(); expect(changed).toHaveBeenCalledOnce(); expect(f.cache.get()).toBeUndefined()
    const source = f.cache.source(ref(), input)
    for (const callId of ['two', 'one', 'two', 'pending']) {
      expect(source.get('read', callId)?.presentCall?.({})).toEqual({ card: 'generic', title: `call ${callId}` })
      expect(source.get('read', callId)?.presentResult?.({}, { content: [], isError: false })).toEqual({ card: 'generic', text: `result ${callId}` })
    }
    expect(source.get('read')).toBeUndefined(); expect(source.get('read', 'missing')).toBeUndefined(); expect(source.get('edit', 'one')).toBeUndefined()
    off(); await f.cache.dispose(); await f.cache.dispose()
    expect(f.cache.source(ref(), input).get('read', 'one')).toBeUndefined()
  })

  it('queues only changed revisions, detaches result payloads, and omits absent call/result phases', async () => {
    const f = fixture()
    const first = entry('one'), second = entry('two', 1, { result: { content: [], text: '', endedAt: 1, isError: false } })
    f.cache.source(ref(), projection({ kind: 'interrupted', id: 'marker', seq: 0, updatedSeq: 0, turn: 1 }, first, second, entry('pending', 1, { result: undefined })))
    await tick()
    const request = f.present.mock.calls[0]![0]
    expect(request.entries).toHaveLength(3)
    expect(request.entries[0]!.result).toEqual({ content: first.result!.content, isError: false, meta: { path: 'same.txt' } })
    expect(request.entries[0]!.result!.content).not.toBe(first.result!.content)
    expect(request.entries[0]!.result!.meta).not.toBe(first.result!.meta)
    expect(request.entries[1]!.result).not.toHaveProperty('meta'); expect(request.entries[2]).not.toHaveProperty('result')
    f.present.mockResolvedValueOnce(good({ presentations: { session: { one: { updatedSeq: 2, result: { card: 'generic', text: 'result only' } } } } }))
    f.cache.source(ref(), projection(entry('one', 2), second)); await tick()
    expect(f.present.mock.calls[1]![0].entries).toHaveLength(1)
    const source = f.cache.source(ref(), projection(entry('one', 2)))
    expect(source.get('read', 'one')?.presentCall).toBeUndefined()
    expect(source.get('read', 'one')?.presentResult?.({}, { content: [], isError: false })).toEqual({ card: 'generic', text: 'result only' })
    f.present.mockResolvedValueOnce(good({ presentations: { session: { one: { updatedSeq: 3, call: { card: 'generic', title: 'call only' } } } } }))
    f.cache.source(ref(), projection(entry('one', 3))); await tick()
    expect(f.cache.source(ref(), projection(entry('one', 3))).get('read', 'one')?.presentResult).toBeUndefined()
    await f.cache.dispose()
  })

  it('keeps safe native failures for their exact key without replaying failed presentation batches', async () => {
    for (const reject of [false, true]) {
      const f = fixture()
      const failure = new Error('native presentation refused')
      if (reject) f.present.mockRejectedValueOnce(failure)
      else f.present.mockResolvedValueOnce(bad('native presentation refused'))
      const changed = vi.fn(); f.cache.subscribe(changed)
      f.cache.source(ref(), projection(entry())); await tick()
      expect(f.cache.error(ref(), entry(), 'native:1')).toEqual(reject ? failure : { code: 'denied', message: 'native presentation refused' })
      expect(f.cache.source(ref(), projection(entry())).get('read', 'one')).toBeUndefined()
      await tick(); expect(f.present).toHaveBeenCalledOnce(); expect(changed).not.toHaveBeenCalled()
      f.cache.source(ref(), projection(entry('one', 2))); await tick(); expect(f.present).toHaveBeenCalledTimes(2)
      expect(f.cache.error(ref(), entry('one', 2), 'native:1')).toBeUndefined()
      await f.cache.dispose()
    }
  })

  it('refuses missing or stale response entries while retaining healthy siblings', async () => {
    const f = fixture()
    f.present.mockResolvedValueOnce(good({ presentations: { session: { one: { updatedSeq: 99 }, two: { updatedSeq: 1 } } } }))
    const changed = vi.fn(); f.cache.subscribe(changed)
    f.cache.source(ref(), projection(entry('one'), entry('two'), entry('three'))); await tick()
    expect(f.cache.error(ref(), entry('one'), 'native:1')).toEqual(new Error('Host returned no current presentation for "session/one"'))
    expect(f.cache.error(ref(), entry('three'), 'native:1')).toEqual(new Error('Host returned no current presentation for "session/three"'))
    expect(f.cache.source(ref(), projection(entry('two'))).get('read', 'two')).toEqual({})
    expect(changed).toHaveBeenCalledOnce(); await f.cache.dispose()
    const absent = fixture(); absent.present.mockResolvedValueOnce(good({ presentations: {} }))
    absent.cache.source(ref(), projection(entry())); await tick(); expect(absent.cache.error(ref(), entry(), 'native:1')).toBeInstanceOf(Error)
    await absent.cache.dispose()
  })

  it('serializes pending revisions behind one batch and drains queued work when the first batch settles', async () => {
    const f = fixture(); const pending = Promise.withResolvers<unknown>()
    f.present.mockReturnValueOnce(pending.promise)
    f.cache.source(ref(), projection(entry())); await tick()
    f.cache.source(ref(), projection(entry('one', 2))); f.cache.source(ref(), projection(entry('one', 2)))
    expect(f.present).toHaveBeenCalledOnce()
    pending.resolve(answer(f.present.mock.calls[0]![0])); await tick()
    expect(f.present).toHaveBeenCalledTimes(2)
    expect(f.present.mock.calls[1]![0].entries[0]!.updatedSeq).toBe(2)
    await f.cache.dispose()
  })

  it('invalidates old Host/Session/presenter generations and ignores their late success or failure', async () => {
    for (const replacement of ['host', 'session', 'revision', 'presenter', 'invalidate'] as const) for (const reject of [false, true]) {
      const f = fixture(); const pending = Promise.withResolvers<unknown>()
      f.present.mockReturnValueOnce(pending.promise)
      f.cache.source(ref(), projection(entry())); await tick()
      const oldSignal = f.present.mock.calls[0]![1]
      let selected = ref()
      if (replacement === 'host') selected = ref('other')
      else if (replacement === 'session') selected = ref('host', 'other')
      else if (replacement === 'revision') f.revision('native:2')
      else if (replacement === 'presenter') f.resolve.mockReturnValue({ presentationRevision: 'native:1', present: vi.fn(async request => answer(request)) })
      else f.cache.invalidate()
      f.cache.source(selected, projection(entry())); await tick()
      if (reject) pending.reject('retired presentation failure')
      else pending.resolve(answer({ entries: [{ sessionId: ref().sessionId, callId: 'one', updatedSeq: 1, name: 'read', arguments: '{}' }] }))
      await tick()
      expect(oldSignal.aborted).toBe(true)
      expect(f.cache.error(selected, entry(), replacement === 'revision' ? 'native:2' : 'native:1')).toBeUndefined()
      expect(f.cache.source(selected, projection(entry())).get('read', 'one')?.presentCall?.({})).toEqual({ card: 'generic', title: 'call one' })
      await f.cache.dispose()
    }
  })

  it('retires queued microtasks, aborts active reads and waits for their owner before disposing', async () => {
    const queued = fixture(); queued.cache.source(ref(), projection(entry())); await queued.cache.dispose(); await tick(); expect(queued.present).not.toHaveBeenCalled()
    const invalidated = fixture(); invalidated.cache.source(ref(), projection(entry())); invalidated.cache.invalidate(); await tick(); expect(invalidated.present).not.toHaveBeenCalled(); await invalidated.cache.dispose()
    for (const reject of [false, true]) {
      const f = fixture(); const pending = Promise.withResolvers<unknown>(); f.present.mockReturnValueOnce(pending.promise)
      const changed = vi.fn(); f.cache.subscribe(changed)
      f.cache.source(ref(), projection(entry())); await tick()
      const stop = f.cache.dispose(); expect(f.present.mock.calls[0]![1].aborted).toBe(true)
      if (reject) pending.reject('retired owner failure'); else pending.resolve(answer(f.present.mock.calls[0]![0]))
      await stop; expect(changed).not.toHaveBeenCalled(); expect(f.cache.error(ref(), entry(), 'native:1')).toBeUndefined()
    }
  })

  it('preserves every key dimension and routes the generated adapter only to its exact Host', async () => {
    const key = remoteToolPresentationKey({ ref: ref(), callId: 'one', updatedSeq: 1, presentationRevision: 'v1' })
    expect(key).toBe('["host","session","one",1,"v1"]')
    for (const keyInput of [{ ref: ref('other'), callId: 'one', updatedSeq: 1, presentationRevision: 'v1' }, { ref: ref('host', 'other'), callId: 'one', updatedSeq: 1, presentationRevision: 'v1' }, { ref: ref(), callId: 'two', updatedSeq: 1, presentationRevision: 'v1' }, { ref: ref(), callId: 'one', updatedSeq: 2, presentationRevision: 'v1' }, { ref: ref(), callId: 'one', updatedSeq: 1, presentationRevision: 'v2' }]) expect(remoteToolPresentationKey(keyInput)).not.toBe(key)
    const presentTools = vi.fn(async () => good({ presentations: {} }))
    const client = { key: HostKey('host'), remote: { mayflyHost: { presentTools } } } as unknown as HostClient
    const resolve = createMayflyToolPresentationResolver(client, 'native:1')
    const selected = resolve(ref()); expect(resolve(ref())).toBe(selected)
    const signal = new AbortController().signal
    await selected.present({ entries: [] }, signal)
    expect(presentTools).toHaveBeenCalledWith({ entries: [] }, signal)
    expect(() => resolve(ref('other'))).toThrow('same Host')
  })
})
