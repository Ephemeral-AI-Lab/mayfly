/** Passive child reads retire on exact displayed selection, Host and connection changes. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { HostKey, type HostClient, type HostConnectionState } from '../../src/client/types.ts'
import { RemoteTranscriptContextSource } from '../../src/transcript/context-source.ts'
import { catalog, facts, ref, summary } from './context-fixture.ts'

function observable<T>(value: T) {
  const listeners = new Set<() => void>()
  const off = vi.fn()
  const source = {
    immediate: undefined as (() => void) | undefined,
    listeners, off,
    getSnapshot: () => value,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      source.immediate?.()
      return () => { off(); listeners.delete(listener) }
    },
    set(next: T) { value = next; for (const listener of Array.from(listeners)) listener() },
  }
  return source
}

type Result = Awaited<ReturnType<HostClient['remote']['session']['projections']>>
type Request = { readonly sessionId: SessionId, readonly signal: AbortSignal, readonly resolve: (value: Result) => void, readonly reject: (error: unknown) => void }

function native(values: Readonly<Record<string, unknown>>, kind: 'sequenced' | 'migration-required' = 'sequenced'): Result {
  return { ok: true, value: { kind, asOfSeq: 42, values } } as Result
}

function fixture() {
  const requests: Request[] = []
  const state = observable<HostConnectionState>({ status: 'connected', generation: 1 })
  const list = observable<SessionListState>(catalog([summary('child')]))
  const projections = vi.fn(({ sessionId }: { sessionId: SessionId }, signal: AbortSignal) => new Promise<Result>((resolve, reject) => { requests.push({ sessionId, signal, resolve, reject }) }))
  const client = { key: ref.host, state, sessions: { list }, remote: { session: { projections } } } as unknown as HostClient
  let selected = { facts: facts({ subagentCatalog: [{ id: 'child' }] }), client: client as HostClient | undefined }
  const changed = vi.fn()
  const source = new RemoteTranscriptContextSource({ read: () => selected, changed })
  return {
    source, client, state, list, requests, projections, changed,
    selection: () => selected,
    select: (next: typeof selected) => { selected = next },
    settle: async (index: number, value: Result) => { requests[index]!.resolve(value); await flush() },
  }
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) await Promise.resolve()
}

afterEach(() => { vi.useRealTimers() })

describe('transcript child whole-snapshot owner', () => {
  it('reads parent context while disconnected and never subscribes or reads a mismatched Client', () => {
    const f = fixture()
    f.select({ facts: { ...facts(), ref: undefined }, client: undefined })
    expect(f.source.snapshot()).toBeUndefined()
    f.select({ facts: facts({ contextPressure: { pressureTokens: 5 } }), client: undefined })
    expect(f.source.snapshot()!.tokens).toBe(5)
    f.select({ facts: facts(), client: { ...f.client, key: HostKey('other') } })
    expect(f.source.snapshot()!.children!.byId.size).toBe(0)
    f.select({ facts: facts(), client: f.client })
    f.state.set({ status: 'connecting', generation: 1 })
    f.source.snapshot()
    expect(f.state.listeners.size + f.list.listeners.size).toBe(0)
    expect(f.projections).not.toHaveBeenCalled()
    f.source.dispose()
    expect(f.source.snapshot()).toBeUndefined()
    f.source.dispose()
  })

  it('publishes whole child facts and replacement absences without retaining a child or causing read loops', async () => {
    const f = fixture()
    expect(f.source.snapshot()!.children!.byId.size).toBe(0)
    expect(f.requests.map(request => request.sessionId)).toEqual(['child'])
    const late = [...f.list.listeners][0]!
    await f.settle(0, native({ mayflyConversationFacts: { active: false, runOutcome: 'completed', promptText: 'native child', endedAt: 100 } }))
    expect(f.changed).toHaveBeenCalledOnce()
    expect(f.source.snapshot()!.children!.byId.get('child')).toEqual({ state: 'settled', failed: false, endedAt: 100 })
    f.list.set({ ...f.list.getSnapshot(), projectionsBySession: {} })
    f.source.snapshot()
    expect(f.projections).toHaveBeenCalledOnce()
    f.list.set(catalog([summary('child', { running: true, updatedAt: 2 })]))
    expect(f.requests).toHaveLength(2)
    expect(f.source.snapshot()!.children!.byId.get('child')).toEqual({ state: 'running' })
    await f.settle(1, native({}, 'migration-required'))
    f.list.set(catalog([summary('child', { updatedAt: 3 })]))
    await f.settle(2, native({ mayflyConversationFacts: { active: false, runOutcome: 'failed', runStopped: true, endedAt: 200 } }))
    expect(f.source.snapshot()!.children!.byId.get('child')).toEqual({ state: 'settled', failed: true, stopped: true, endedAt: 200 })
    f.select({ ...f.selection(), facts: facts({}) })
    expect(f.source.snapshot()!.children!.byId.size).toBe(0)
    f.select({ ...f.selection(), facts: facts({ subagentCatalog: [{ id: 'child' }] }) })
    f.source.snapshot()
    await f.settle(3, native({}))
    expect(f.source.snapshot()!.children!.byId.size).toBe(0)
    f.source.dispose()
    const calls = f.changed.mock.calls.length
    late()
    expect(f.changed).toHaveBeenCalledTimes(calls)
    expect(f.state.listeners.size + f.list.listeners.size).toBe(0)
  })

  it('coalesces newer native running/activity keys and ignores stale read success or failure', async () => {
    const f = fixture()
    f.source.snapshot()
    f.list.set(catalog([summary('child', { running: true, updatedAt: 2 })]))
    f.list.set(catalog([summary('child', { updatedAt: 3 })]))
    expect(f.requests).toHaveLength(1)
    const changed = f.changed.mock.calls.length
    await f.settle(0, native({ mayflyConversationFacts: { active: false, runOutcome: 'failed' } }))
    expect(f.changed).toHaveBeenCalledTimes(changed)
    expect(f.requests).toHaveLength(2)
    f.list.set(catalog([summary('child', { updatedAt: 4 })]))
    f.requests[1]!.reject(new Error('old activity read failed'))
    await flush()
    expect(f.requests).toHaveLength(3)
    await f.settle(2, native({ mayflyConversationFacts: { active: false, runOutcome: 'completed' } }))
    expect(f.source.snapshot()!.children!.byId.get('child')).toEqual({ state: 'settled', failed: false })
    f.source.dispose()
  })

  it('lets fresh whole facts outrank a delayed running summary and never revives the previous run from native cached values', async () => {
    const f = fixture()
    f.list.set({
      ...catalog([summary('child', { running: true })]),
      projectionsBySession: { [SessionId('child')]: { state: 'ready', error: null, values: { subagentTiming: { settledMs: 1, lastTurnCompleted: false } } } },
    })
    expect(f.source.snapshot()!.children!.byId.get('child')).toEqual({ state: 'running' })
    await f.settle(0, native({ mayflyConversationFacts: { active: false, runOutcome: 'completed', endedAt: 100 } }))
    expect(f.source.snapshot()!.children!.byId.get('child')).toEqual({ state: 'settled', failed: false, endedAt: 100 })
    f.list.set(catalog([summary('child', { running: true, updatedAt: 2 })]))
    expect(f.source.snapshot()!.children!.byId.get('child')).toEqual({ state: 'running' })
    await f.settle(1, native({ mayflyConversationFacts: { active: false, runOutcome: 'failed', runStopped: true, endedAt: 200 } }))
    expect(f.source.snapshot()!.children!.byId.get('child')).toEqual({ state: 'settled', failed: true, stopped: true, endedAt: 200 })
    f.list.set(catalog([summary('child', { running: false, updatedAt: 3 })]))
    expect(f.source.snapshot()!.children!.byId.has('child')).toBe(false)
    await f.settle(2, native({ mayflyConversationFacts: { active: true, phase: 'tool' } }))
    expect(f.source.snapshot()!.children!.byId.get('child')).toEqual({ state: 'running' })
    f.source.dispose()
  })

  it('bounds native absence and transient failures to one retry per activity key, then resumes on fresh native activity', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.source.snapshot()
    await f.settle(0, { ok: true, value: null })
    expect(f.source.snapshot()!.children!.byId.size).toBe(0)
    await vi.advanceTimersByTimeAsync(250)
    expect(f.requests).toHaveLength(2)
    f.requests[1]!.reject(new Error('network unavailable'))
    await flush()
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.requests).toHaveLength(2)
    f.list.set(catalog([summary('child', { updatedAt: 2 })]))
    await f.settle(2, { ok: false, error: new RemoteError('gateway/internal', 'transient', {}) })
    f.list.set(catalog([summary('child', { updatedAt: 3 })]))
    expect(f.requests).toHaveLength(4)
    await f.settle(3, native({ subagentTiming: { settledMs: 1, lastTurnCompleted: true } }))
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.requests).toHaveLength(4)
    expect(f.source.snapshot()!.children!.byId.get('child')).toEqual({ state: 'settled', failed: false })
    f.source.dispose()
  })

  it('aborts removed children and keeps their late successes and rejections out of a readded child', async () => {
    const f = fixture()
    f.source.snapshot()
    f.select({ ...f.selection(), facts: facts({ subagentCatalog: [] }) })
    f.source.snapshot()
    expect(f.requests[0]!.signal.aborted).toBe(true)
    const calls = f.changed.mock.calls.length
    await f.settle(0, native({ mayflyConversationFacts: { active: false, runOutcome: 'failed' } }))
    expect(f.changed).toHaveBeenCalledTimes(calls)
    f.select({ ...f.selection(), facts: facts({ subagentCatalog: [{ id: 'child' }] }) })
    f.source.snapshot()
    f.select({ ...f.selection(), facts: facts({ subagentCatalog: [] }) })
    f.source.snapshot()
    f.requests[1]!.reject(new Error('removed child'))
    await flush()
    expect(f.source.snapshot()!.children!.byId.size).toBe(0)
    f.source.dispose()
  })

  it('fences exact ref identity, same SessionId on another Host, Client replacement, clear and reconnect generations', async () => {
    const f = fixture()
    f.source.snapshot()
    const first = f.requests[0]!
    f.select({ ...f.selection(), facts: facts({ subagentCatalog: [{ id: 'child' }] }, { ...ref }) })
    f.source.snapshot()
    expect(first.signal.aborted).toBe(true)
    const second = f.requests[1]!
    const other = { ...ref, host: HostKey('host-two') }
    const nextClient = { ...f.client, key: other.host }
    f.select({ client: nextClient, facts: facts({ subagentCatalog: [{ id: 'child' }] }, other) })
    f.source.snapshot()
    expect(second.signal.aborted).toBe(true)
    const third = f.requests[2]!
    f.select({ ...f.selection(), client: { ...nextClient } })
    f.source.snapshot()
    expect(third.signal.aborted).toBe(true)
    f.state.set({ status: 'connected', generation: 2 })
    expect(f.requests[3]!.signal.aborted).toBe(true)
    expect(f.requests).toHaveLength(5)
    f.state.set({ status: 'detached', generation: 2 })
    expect(f.requests[4]!.signal.aborted).toBe(true)
    expect(f.state.listeners.size + f.list.listeners.size).toBe(0)
    const notifications = f.changed.mock.calls.length
    for (let index = 0; index < 5; index += 1) await f.settle(index, native({ mayflyConversationFacts: { active: false, runOutcome: 'failed' } }))
    expect(f.changed).toHaveBeenCalledTimes(notifications)
    f.state.set({ status: 'connected', generation: 3 })
    f.source.snapshot()
    expect(f.requests).toHaveLength(6)
    f.select({ facts: { ...facts(), ref: undefined }, client: f.client })
    expect(f.source.snapshot()).toBeUndefined()
    expect(f.requests[5]!.signal.aborted).toBe(true)
    f.source.dispose()
  })

  it('retires a read whose displayed parent changes before the next presentation invalidation', async () => {
    const f = fixture()
    f.source.snapshot()
    f.select({ ...f.selection(), facts: facts({ subagentCatalog: [{ id: 'child' }] }, { ...ref, sessionId: SessionId('side-view') }) })
    await f.settle(0, native({ mayflyConversationFacts: { active: false, runOutcome: 'failed' } }))
    expect(f.requests[0]!.signal.aborted).toBe(true)
    expect(f.changed).not.toHaveBeenCalled()
    expect(f.state.listeners.size + f.list.listeners.size).toBe(0)
    f.source.snapshot()
    expect(f.requests).toHaveLength(1) // native row belongs to the former parent
    f.source.dispose()
  })

  it('releases a retry on dispose and refuses queued retry work after a silent selection change', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.source.snapshot()
    f.requests[0]!.reject(new Error('transient'))
    await flush()
    f.select({ ...f.selection(), facts: facts({}, { ...ref }) })
    await vi.advanceTimersByTimeAsync(250)
    expect(f.requests).toHaveLength(1)
    f.source.snapshot()
    f.select({ ...f.selection(), facts: facts({ subagentCatalog: [{ id: 'child' }] }, f.selection().facts.ref) })
    f.source.snapshot()
    await f.settle(1, { ok: false, error: new RemoteError('gateway/internal', 'transient', {}) })
    f.source.dispose()
    await vi.advanceTimersByTimeAsync(250)
    expect(f.requests).toHaveLength(2)
    expect(f.state.listeners.size + f.list.listeners.size).toBe(0)
  })

  it('cleans subscriptions installed across synchronous dispose or selection replacement', () => {
    const f = fixture()
    f.state.immediate = () => { f.source.dispose() }
    expect(f.source.snapshot()).toBeUndefined()
    expect(f.state.listeners.size + f.list.listeners.size).toBe(0)
    expect(f.state.off).toHaveBeenCalledOnce()
    expect(f.projections).not.toHaveBeenCalled()

    const g = fixture()
    g.state.immediate = () => {
      g.state.immediate = undefined
      g.select({ ...g.selection(), facts: facts({ contextPressure: { pressureTokens: 99 } }, { ...ref }) })
      for (const listener of g.state.listeners) listener()
    }
    expect(g.source.snapshot()!.tokens).toBe(99)
    expect(g.state.listeners.size).toBe(1)
    expect(g.list.listeners.size).toBe(1)
    expect(g.projections).not.toHaveBeenCalled()
    g.source.dispose()
  })

  it('never starts a later child after a synchronous native call replaces the displayed selection', async () => {
    const f = fixture()
    f.select({ ...f.selection(), facts: facts({ subagentCatalog: [{ id: 'child' }, { id: 'second' }] }) })
    f.projections.mockImplementationOnce(() => {
      f.select({ facts: { ...facts(), ref: undefined }, client: f.client })
      throw new Error('synchronous transport refusal')
    })
    expect(f.source.snapshot()).toBeUndefined()
    expect(f.projections).toHaveBeenCalledOnce()
    await flush()
    expect(f.state.listeners.size + f.list.listeners.size).toBe(0)
    f.source.dispose()
  })

  it('clears a scope replaced synchronously during a passive read and skips notifications after synchronous disposal', async () => {
    const f = fixture()
    f.projections.mockImplementationOnce(() => {
      f.select({ facts: { ...facts(), ref: undefined }, client: f.client })
      return Promise.resolve(native({}))
    })
    expect(f.source.snapshot()).toBeUndefined()
    await flush()
    expect(f.changed).not.toHaveBeenCalled()
    expect(f.state.listeners.size + f.list.listeners.size).toBe(0)
    f.source.dispose()

    const g = fixture()
    g.select({ ...g.selection(), facts: facts({}) })
    g.source.snapshot()
    g.select({ ...g.selection(), facts: facts({ subagentCatalog: [{ id: 'child' }] }) })
    g.projections.mockImplementationOnce(() => { g.source.dispose(); return Promise.resolve(native({})) })
    g.list.set({ ...g.list.getSnapshot() })
    await flush()
    expect(g.changed).not.toHaveBeenCalled()
    expect(g.state.listeners.size + g.list.listeners.size).toBe(0)
  })
})
