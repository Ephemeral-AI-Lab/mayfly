/** Display recency and bounded native view residency over actual transcript sources. @module remote/tests/side-views */
import { describe, expect, it, vi } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { SessionBinding, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import type { SubagentAddress } from '@deepseek-ai/dsh-subagent/client'
import { TranscriptController, createTranscriptModel } from '../../src/transcript.ts'
import type { MayflyScreenService } from '../../src/core.ts'
import { HostKey, type HostClient, type HostConnectionState, type SessionRef } from '../../src/client/types.ts'
import { RemoteSideViews, type RemoteSideViewOptions } from '../../src/app/side-views.ts'
import { RemoteConversationModelSource } from '../../src/transcript/remote-model.ts'

function binding(id: string, values: Record<string, unknown> = {}) {
  const listeners = new Set<() => void>()
  let title = id
  const observable = { getSnapshot: () => undefined, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } } }
  let entries: readonly SessionEventLikeEntry[] = []
  let revision = 0
  let change = { kind: 'replace', entries } as { kind: 'replace' | 'append', entries: readonly SessionEventLikeEntry[] }
  const source = { ...observable, getSnapshot: () => ({ entries, revision, hasMore: false, change }) }
  const face = {
    sessionId: SessionId(id), eventSource: source,
    session: { ...observable, getSnapshot: () => ({ running: false }), projections: { faceOf: (key: string) => ({ ...observable, getSnapshot: () => key === 'title' ? title : values[key] }) } },
  } as unknown as SessionBinding
  return { face, listeners, title(next: string) { title = next; for (const listener of [...listeners]) listener() },
    append(entry: SessionEventLikeEntry) {
      entries = [...entries, entry]; revision += 1; change = { kind: 'append', entries: [entry] }
      for (const listener of [...listeners]) listener()
    },
  }
}
const ref = (id: string, host = 'host-a'): SessionRef => ({ host: HostKey(host), sessionId: SessionId(id) })
const facts = { kind: 'subagent', access: 'resumable', cwd: '/host/work', label: 'Child' } as const
const flush = async () => { for (let index = 0; index < 4; index += 1) await new Promise<void>(resolve => { setImmediate(resolve) }) }

function availability(host = 'host-a') {
  const catalogListeners = new Set<() => void>()
  const connectionListeners = new Set<() => void>()
  const available = new Map<string, boolean>()
  let generation = 1
  let connected = true
  const list = vi.fn(async (_request: object, _signal?: AbortSignal): ReturnType<HostClient['remote']['session']['list']> => ({ ok: true, value: { items: [...available].map(([id, agentAvailable]) => ({ sessionId: SessionId(id), agentAvailable, blank: false, running: false, updatedAt: 1 })) } }))
  const subscribe = (listeners: Set<() => void>) => (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
  const subagentAddress = vi.fn((id: ReturnType<typeof SessionId>): SubagentAddress | undefined => ({ parentSessionId: SessionId('lead'), childSessionId: id, mode: 'continuable' }))
  const client = { key: HostKey(host), remote: { session: { list } }, sessions: { list: { subscribe: subscribe(catalogListeners) }, subagentAddress }, state: { getSnapshot: (): HostConnectionState => ({ status: connected ? 'connected' : 'connecting', generation }), subscribe: subscribe(connectionListeners) } } as unknown as HostClient
  const emit = (listeners: Set<() => void>) => { for (const listener of [...listeners]) listener() }
  return { client, list, available, subagentAddress, catalogListeners, connectionListeners,
    catalog: () => { emit(catalogListeners) },
    reconnect: () => { generation += 1; emit(connectionListeners) },
    connected: (next: boolean) => { connected = next; emit(connectionListeners) },
  }
}

function mount(options: RemoteSideViewOptions = {}) {
  const transcript = new TranscriptController({ t: key => key, queued: () => [] })
  const show = vi.spyOn(transcript, 'show')
  const refresh = vi.spyOn(transcript, 'refresh')
  transcript.setView('remote', createTranscriptModel('main', []))
  transcript.show('remote')
  const screen = { requestRender: vi.fn() }
  const side = new RemoteSideViews(transcript, { get: () => undefined }, screen as unknown as MayflyScreenService, options)
  return { side, transcript, show, refresh, screen }
}

describe('RemoteSideViews', () => {
  it('updates retained child access from whole native Agent availability without replacing bindings or descriptors', async () => {
    const native = availability()
    const changed = vi.fn()
    const { side, transcript } = mount({ client: () => native.client })
    side.subscribe(changed)
    const child = binding('a')
    native.available.set('a', false)
    side.present(child.face, { ref: ref('a'), cwd: '' }, facts)
    await flush()
    expect(side.selected()).toMatchObject({ binding: child.face, facts: { access: 'resumable' } })
    changed.mockClear()
    native.available.set('a', true); native.catalog(); await flush()
    expect(side.selected()).toMatchObject({ binding: child.face, facts: { access: 'interactive' } })
    expect(changed).toHaveBeenCalledOnce()
    side.showPrimary()
    native.available.set('a', false); native.catalog(); await flush()
    expect(side.references()).toEqual([ref('a')])
    expect(side.navigation()).toEqual({ counterpart: 'subagent', close: 'subagent' })
    expect(side.back()).toBe(true)
    expect(side.selected()).toMatchObject({ binding: child.face, facts: { access: 'resumable' } })
    expect(native.list).toHaveBeenCalledWith({}, expect.any(AbortSignal))
    side.dispose(); transcript.dispose()
    expect(native.catalogListeners.size + native.connectionListeners.size).toBe(0)
  })

  it('coalesces overlapping native reads and never publishes a stale baseline before the latest catalog settles', async () => {
    const native = availability()
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof native.list>>>()
    native.list.mockReturnValueOnce(gate.promise)
    native.available.set('a', false)
    const changed = vi.fn()
    const { side, transcript } = mount({ client: () => native.client })
    side.subscribe(changed)
    side.present(binding('a').face, { ref: ref('a'), cwd: '' }, facts)
    changed.mockClear()
    native.catalog(); native.catalog()
    expect(native.list).toHaveBeenCalledOnce()
    gate.resolve({ ok: true, value: { items: [{ sessionId: SessionId('a'), agentAvailable: true, blank: false, running: false, updatedAt: 1 }] } })
    await flush()
    expect(native.list).toHaveBeenCalledTimes(2)
    expect(side.selected()?.facts.access).toBe('resumable')
    expect(changed).not.toHaveBeenCalled()
    side.dispose(); transcript.dispose()
  })

  it('preserves known access after refused reads and unknown addresses, and keeps one-shot views readonly even while live', async () => {
    const native = availability()
    native.available.set('a', true)
    native.list.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'denied', {}) })
    const { side, transcript } = mount({ client: () => native.client })
    side.present(binding('a').face, { ref: ref('a'), cwd: '' }, { ...facts, access: 'interactive' })
    await flush()
    expect(side.selected()?.facts.access).toBe('interactive')
    native.list.mockRejectedValueOnce(new Error('offline'))
    native.catalog(); await flush()
    expect(side.selected()?.facts.access).toBe('interactive')
    native.subagentAddress.mockReturnValue(undefined)
    native.catalog(); await flush()
    expect(side.selected()?.facts.access).toBe('interactive')
    native.subagentAddress.mockReturnValue({ parentSessionId: SessionId('lead'), childSessionId: SessionId('a'), mode: 'unknown' })
    native.catalog(); await flush()
    expect(side.selected()?.facts.access).toBe('interactive')
    native.subagentAddress.mockReturnValue({ parentSessionId: SessionId('lead'), childSessionId: SessionId('a'), mode: 'one-shot' })
    native.catalog(); await flush()
    expect(side.selected()?.facts.access).toBe('readonly')
    native.catalog(); await flush()
    expect(side.selected()?.facts.access).toBe('readonly')
    side.dispose(); transcript.dispose()
  })

  it('uses recorded native addresses when absent from the current Client catalog and ignores other Session identities', async () => {
    const native = availability()
    native.subagentAddress.mockReturnValue(undefined)
    native.available.set('another', true)
    const { side, transcript } = mount({ client: () => native.client })
    side.present(binding('a').face, { ref: ref('a'), cwd: '' }, { ...facts, access: 'interactive', address: { parentSessionId: SessionId('lead'), childSessionId: SessionId('a'), mode: 'continuable' } })
    await flush()
    expect(side.selected()?.facts.access).toBe('resumable')
    side.dispose(); transcript.dispose()
  })

  it('observes only displayed and F7 bindings and releases parked or ordinary BTW availability watches', async () => {
    const native = availability()
    const reopen = vi.fn()
    const { side, transcript } = mount({ client: target => target.host === native.client.key ? native.client : undefined, reopen })
    for (const id of ['a', 'b', 'c']) side.present(binding(id).face, { ref: ref(id), cwd: '' }, facts)
    await flush()
    expect(side.references()).toHaveLength(3)
    expect(native.catalogListeners.size).toBe(2)
    expect(native.connectionListeners.size).toBe(2)
    const before = native.list.mock.calls.length
    native.catalog(); await flush()
    expect(native.list).toHaveBeenCalledTimes(before + 2)
    side.close(ref('c'))
    side.back()
    expect(reopen).toHaveBeenCalledWith(ref('a'), facts)
    side.present(binding('btw').face, { ref: ref('btw'), cwd: '' }, { kind: 'btw', access: 'interactive' })
    expect(native.catalogListeners.size).toBe(1)
    side.present(binding('foreign').face, { ref: ref('foreign', 'host-b'), cwd: '' }, facts)
    expect(native.catalogListeners.size).toBe(0)
    side.dispose(); transcript.dispose()
  })

  it.each([false, true])('retires old connection reads and admits a fresh native baseline after reconnect (reject old=%s)', async rejected => {
    const native = availability()
    native.available.set('a', true)
    const old = Promise.withResolvers<Awaited<ReturnType<typeof native.list>>>()
    native.list.mockReturnValueOnce(old.promise)
    const { side, transcript } = mount({ client: () => native.client })
    side.present(binding('a').face, { ref: ref('a'), cwd: '' }, facts)
    const signal = native.list.mock.calls[0]![1]!
    native.reconnect(); await flush()
    expect(signal.aborted).toBe(true)
    expect(side.selected()?.facts.access).toBe('interactive')
    if (rejected) old.reject(new Error('retired connection'))
    else old.resolve({ ok: true, value: { items: [] } })
    await flush()
    expect(side.selected()?.facts.access).toBe('interactive')
    const blocked = Promise.withResolvers<Awaited<ReturnType<typeof native.list>>>()
    native.list.mockReturnValueOnce(blocked.promise)
    native.catalog()
    const disconnectedSignal = native.list.mock.calls.at(-1)![1]!
    native.connected(false)
    expect(disconnectedSignal.aborted).toBe(true)
    const before = native.list.mock.calls.length
    native.catalog()
    expect(native.list).toHaveBeenCalledTimes(before)
    blocked.resolve({ ok: true, value: { items: [] } })
    await flush()
    native.available.set('a', false)
    native.connected(true); await flush()
    expect(side.selected()?.facts.access).toBe('resumable')
    side.dispose(); transcript.dispose()
  })

  it.each(['close', 'dispose', 'replace', 'park', 'client'] as const)('fences late native availability and queued callbacks on %s', async retirement => {
    const native = availability()
    const gate = Promise.withResolvers<Awaited<ReturnType<typeof native.list>>>()
    native.list.mockReturnValueOnce(gate.promise)
    let client = native.client
    const { side, transcript, screen } = mount({ client: () => client })
    side.present(binding('a').face, { ref: ref('a'), cwd: '' }, facts)
    const callbacks = [...native.catalogListeners, ...native.connectionListeners]
    const signal = native.list.mock.calls[0]![1]!
    if (retirement === 'close') side.close(ref('a'))
    else if (retirement === 'dispose') side.dispose()
    else if (retirement === 'replace') side.present(binding('a').face, { ref: ref('a'), cwd: '' }, facts)
    else if (retirement === 'park') for (const id of ['b', 'c']) side.present(binding(id).face, { ref: ref(id), cwd: '' }, facts)
    else client = { ...native.client }
    screen.requestRender.mockClear()
    for (const callback of callbacks) callback()
    gate.resolve({ ok: true, value: { items: [{ sessionId: SessionId('a'), agentAvailable: true, blank: false, running: false, updatedAt: 1 }] } })
    await flush()
    expect(signal.aborted).toBe(true)
    expect(side.selected()?.facts.access).not.toBe('interactive')
    expect(screen.requestRender).not.toHaveBeenCalled()
    side.dispose(); transcript.dispose()
    expect(native.catalogListeners.size + native.connectionListeners.size).toBe(0)
  })

  it('publishes the displayed source without replaying command feedback and keeps primary navigation stable', () => {
    const { side, transcript } = mount()
    const setView = vi.spyOn(transcript, 'setView')
    const a = binding('a'), b = binding('b')
    side.showPrimary()
    expect(side.closeTarget()).toBeUndefined()
    side.present(a.face, { ref: ref('a'), cwd: '' })
    const source = setView.mock.lastCall?.[1]
    expect(typeof source).toBe('function')
    if (typeof source !== 'function') throw new Error('The side view must borrow its live source')
    expect(source()).toMatchObject({ kind: 'transcript' })
    expect(side.navigation()).toEqual({ counterpart: 'primary', close: 'subagent' })
    const done = (seq: number, text?: string): SessionEventLikeEntry => ({ type: 'event', event: {
      type: 'command/done', seq: SessionSeq(seq), time: seq, data: { commandId: 'command', kind: 'success', ...text === undefined ? {} : { text } },
    } } as unknown as SessionEventLikeEntry)
    a.append(done(1, 'visible command'))
    expect(JSON.stringify(source())).not.toContain('visible command')
    a.append(done(2))
    expect(JSON.stringify(source())).not.toContain('command/done')
    side.present(b.face, { ref: ref('b'), cwd: '' }, facts)
    a.append(done(3, 'hidden command'))
    expect(JSON.stringify(source())).not.toContain('hidden command')
    side.showPrimary()
    expect(side.navigation()).toEqual({ counterpart: 'subagent', close: 'subagent' })
    side.dispose(); transcript.dispose()
  })

  it('refuses a parked counterpart when no external reopen owner is installed', () => {
    const { side, transcript } = mount()
    for (const id of ['a', 'b', 'c']) side.present(binding(id).face, { ref: ref(id), cwd: '' }, facts)
    side.close(ref('c'))
    expect(side.back()).toBe(false)
    expect(side.current()).toEqual(ref('b'))
    side.dispose(); transcript.dispose()
  })

  it('borrows current exact Host metadata for cold children without copying it, and loses it on owner removal', () => {
    const primary = new RemoteConversationModelSource({ get: () => undefined }, vi.fn())
    const catalog = (effort: string): ModelCatalog => ({
      default: { provider: 'provider', model: 'model' }, failures: [], routableProviders: ['provider'],
      groups: [{ id: 'provider', name: 'Provider', models: [{ id: 'model', name: 'Model', reasoning: { efforts: [], defaultEffort: effort } }] }],
    } as unknown as ModelCatalog)
    const route = { provider: 'provider', model: 'model' }
    const values: Record<string, unknown> = { modelSelection: { next: route, lastUsed: route } }
    const { side, transcript } = mount({ modelCatalog: host => primary.getModelCatalog(host) })
    primary.setModelCatalog(HostKey('host-a'), catalog('high'))
    const child = binding('same', values)
    side.present(child.face, { ref: ref('same'), cwd: '' }, facts)
    expect(side.presentation()?.reasoningEffort).toBe('high')
    primary.setModelCatalog(HostKey('host-a'), catalog('low'))
    expect(side.presentation()?.reasoningEffort).toBe('low')
    const other = binding('same', values)
    side.present(other.face, { ref: ref('same', 'host-b'), cwd: '' }, facts)
    expect(side.presentation()?.reasoningEffort).toBeUndefined()
    side.back()
    primary.setModelCatalog(HostKey('host-a'), undefined)
    expect(side.presentation()?.reasoningEffort).toBeUndefined()
    primary.setModelCatalog(HostKey('host-a'), catalog('max'))
    values['modelSelection'] = { next: { ...route, model: 'pending' }, lastUsed: route }
    child.title('pending selection')
    expect(side.presentation()?.reasoningEffort).toBeUndefined()
    values['modelSelection'] = { next: route, lastUsed: { ...route, reasoningEffort: 'high' } }
    child.title('default selection')
    expect(side.presentation()?.reasoningEffort).toBeUndefined()
    primary.dispose()
    expect(primary.getModelCatalog(HostKey('host-a'))).toBeUndefined()
    side.dispose(); transcript.dispose()
    expect(side.presentation()).toBeUndefined()
    expect(child.listeners.size).toBe(0)
    expect(other.listeners.size).toBe(0)
  })

  it('borrows exact bindings and keeps same SessionId on separate Hosts distinct', () => {
    const { side, transcript } = mount()
    const a = binding('same'), b = binding('same')
    side.present(a.face, { ref: ref('same'), cwd: '/a' }, facts)
    side.present(b.face, { ref: ref('same', 'host-b'), cwd: '/b' }, { kind: 'btw', access: 'interactive', historyFloorSeq: 10 })
    expect(side.references()).toEqual([ref('same'), ref('same', 'host-b')])
    expect(side.selected()).toMatchObject({ ref: ref('same', 'host-b'), binding: b.face, facts: { kind: 'btw' } })
    expect(side.kind()).toBe('btw')
    expect(side.navigation()).toEqual({ counterpart: 'subagent', close: 'btw' })
    expect(side.back()).toBe(true)
    expect(side.selected()?.binding).toBe(a.face)
    expect(side.presentation()?.title).toBe('same')
    expect(side.sessionFacts()?.ref).toEqual(ref('same'))
    expect(side.imageAttachment('absent')).toBeUndefined()
    side.close(ref('same', 'host-b'))
    expect(side.selected()?.binding).toBe(a.face)
    side.dispose(); transcript.dispose()
    expect(a.listeners.size).toBe(0)
    expect(b.listeners.size).toBe(0)
  })

  it('retains only displayed and F7 sources, deferring hidden presentation updates', () => {
    const retainOnly = vi.fn(), primaryVisible = vi.fn()
    const { side, refresh, screen, transcript } = mount({ retainOnly, primaryVisible })
    const a = binding('a'), b = binding('b'), c = binding('c')
    side.present(a.face, { ref: ref('a'), cwd: '' }, facts)
    side.present(b.face, { ref: ref('b'), cwd: '' }, facts)
    expect(primaryVisible).toHaveBeenLastCalledWith(false)
    refresh.mockClear(); screen.requestRender.mockClear()
    a.title('unread title')
    expect(refresh).not.toHaveBeenCalled()
    expect(screen.requestRender).not.toHaveBeenCalled()
    side.back()
    expect(side.presentation()?.title).toBe('unread title')
    side.present(c.face, { ref: ref('c'), cwd: '' }, facts)
    expect(b.listeners.size).toBe(0)
    expect(a.listeners.size).toBeGreaterThan(0)
    expect(c.listeners.size).toBeGreaterThan(0)
    expect(retainOnly.mock.lastCall?.[0]).toEqual([ref('a'), ref('c')])
    side.showPrimary()
    expect(primaryVisible).toHaveBeenLastCalledWith(true)
    expect(side.current()).toBeUndefined()
    expect(side.kind()).toBe('primary')
    expect(side.closeTarget()).toEqual(ref('c'))
    expect(a.listeners.size).toBe(0)
    expect(side.references()).toHaveLength(3)
    side.dispose(); transcript.dispose()
  })

  it('reopens a parked counterpart through the external owner before changing selection', () => {
    const reopen = vi.fn()
    const { side, transcript } = mount({ reopen })
    const a = binding('a'), b = binding('b'), c = binding('c')
    side.present(a.face, { ref: ref('a'), cwd: '' }, facts)
    side.present(b.face, { ref: ref('b'), cwd: '' }, facts)
    side.present(c.face, { ref: ref('c'), cwd: '' }, facts)
    side.close(ref('c'))
    expect(side.current()).toEqual(ref('b'))
    expect(side.closeTarget()).toEqual(ref('b'))
    expect(side.back()).toBe(true)
    expect(reopen).toHaveBeenCalledWith(ref('a'), facts)
    expect(side.current()).toEqual(ref('b'))
    const reopened = binding('a')
    side.present(reopened.face, { ref: ref('a'), cwd: '' }, facts)
    expect(side.selected()?.binding).toBe(reopened.face)
    side.dispose(); transcript.dispose()
  })

  it('evicts the oldest descriptor at the cap and has no surviving local subscriptions', () => {
    const evicted = vi.fn(), changed = vi.fn()
    const { side, transcript, screen } = mount({ evicted })
    const off = side.subscribe(changed)
    const bindings = Array.from({ length: 33 }, (_, index) => binding(String(index)))
    for (const [index, native] of bindings.entries()) side.present(native.face, { ref: ref(String(index)), cwd: '' }, facts)
    expect(side.references()).toHaveLength(32)
    expect(evicted).toHaveBeenCalledExactlyOnceWith(ref('0'))
    expect(bindings.filter(native => native.listeners.size > 0)).toHaveLength(2)
    off()
    const before = changed.mock.calls.length
    side.close(ref('missing'))
    side.close()
    expect(changed).toHaveBeenCalledTimes(before)
    expect(side.back()).toBe(false)
    expect(side.navigation()).toBeUndefined()
    expect(side.kind()).toBeUndefined()
    side.dispose(); side.dispose()
    screen.requestRender.mockClear()
    side.present(bindings[0]!.face, { ref: ref('late'), cwd: '' }, facts)
    expect(screen.requestRender).not.toHaveBeenCalled()
    expect(bindings.every(native => native.listeners.size === 0)).toBe(true)
    transcript.dispose()
  })
})
