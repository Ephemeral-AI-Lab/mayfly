/** Display recency and bounded native view residency over actual transcript sources. @module remote/tests/side-views */
import { describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { TranscriptController, createTranscriptModel } from '@ephemeral-ai/mayfly/transcript'
import type { MayflyScreenService } from '@ephemeral-ai/mayfly/core'
import { HostKey, type SessionRef } from '../../src/client/types.ts'
import { RemoteSideViews, type RemoteSideViewOptions } from '../../src/remote/side-views.ts'

function binding(id: string) {
  const listeners = new Set<() => void>()
  let title = id
  const observable = { getSnapshot: () => undefined, subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } } }
  const source = { ...observable, getSnapshot: () => ({ entries: [], revision: 0, hasMore: false, change: { kind: 'replace', entries: [] } }) }
  const face = {
    sessionId: SessionId(id), eventSource: source,
    session: { ...observable, getSnapshot: () => ({ running: false }), projections: { faceOf: (key: string) => ({ ...observable, getSnapshot: () => key === 'title' ? title : undefined }) } },
  } as unknown as SessionBinding
  return { face, listeners, title(next: string) { title = next; for (const listener of [...listeners]) listener() } }
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
  const notice = { set: vi.fn() }
  const side = new RemoteSideViews(transcript, { get: () => undefined }, screen as unknown as MayflyScreenService, notice, options)
  return { side, transcript, show, refresh, screen, notice }
}

describe('RemoteSideViews', () => {
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
