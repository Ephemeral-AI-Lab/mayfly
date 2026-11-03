/** Display recency and bounded native view residency over actual transcript sources. @module remote/tests/side-views */
import { describe, expect, it, vi } from 'vitest'
import { SessionId, SessionSeq } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { TranscriptController, createTranscriptModel } from '@ephemeral-ai/mayfly/transcript'
import type { MayflyScreenService } from '@ephemeral-ai/mayfly/core'
import { HostKey, type SessionRef } from '../../src/client/types.ts'
import { RemoteSideViews, type RemoteSideViewOptions } from '../../src/remote/side-views.ts'
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
