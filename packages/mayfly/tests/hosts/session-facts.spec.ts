/** Exact binding snapshots and native Inbox display without a second event fold. @module */
import { describe, expect, it, vi } from 'vitest'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { HostKey } from '../../src/client/types.ts'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  RemoteSessionFactsSource, REMOTE_SESSION_PROJECTION_KEYS, sameSessionSnapshot, subscribeSessionChanges,
} from '../../src/hosts/session-facts.ts'
import { projection } from '../app/approval-feature-fixture.ts'

function binding() {
  const faces = new Map(REMOTE_SESSION_PROJECTION_KEYS.map(key => [key, projection<unknown>(undefined)]))
  const status = projection({ running: false })
  return {
    faces, status,
    binding: { session: { getSnapshot: status.getSnapshot, subscribe: status.subscribe, projections: { faceOf: (key: typeof REMOTE_SESSION_PROJECTION_KEYS[number]) => faces.get(key)! } } } as unknown as SessionBinding,
  }
}

describe('native selected Session facts', () => {
  it('shares one snapshot, notifies only native updates, and releases every exact binding observer', () => {
    const source = new RemoteSessionFactsSource()
    const change = vi.fn()
    const off = source.subscribe(change)
    expect(source.getSnapshot()).toBe(source.snapshot())
    expect(source.projection('title')).toBeUndefined()
    const f = binding()
    const ref = { host: HostKey('first'), sessionId: SessionId('same') }
    source.attach(f.binding, { ref, cwd: '/catalog' })
    expect(source.snapshot()).toMatchObject({ ref, cwd: '/catalog', session: { running: false }, queue: [] })
    f.faces.get('title')!.set('Native title')
    expect(source.projection('title')).toBe('Native title')
    f.faces.get('workingDirectory')!.set('/native')
    expect(source.snapshot().cwd).toBe('/native')
    f.status.set({ running: true })
    expect(source.snapshot().session).toMatchObject({ running: true })
    const queued = [...f.status.listeners][0]!
    const other = binding()
    const next = { host: HostKey('second'), sessionId: ref.sessionId }
    source.attach(other.binding, { ref: next, cwd: '/other' })
    const snapshot = source.snapshot()
    queued()
    expect(source.snapshot()).toBe(snapshot)
    expect(f.status.listeners.size + [...f.faces.values()].reduce((n, face) => n + face.listeners.size, 0)).toBe(0)
    const calls = change.mock.calls.length
    off()
    source.attach(null)
    expect(change).toHaveBeenCalledTimes(calls)
    expect(source.snapshot()).toEqual({ ref: undefined, cwd: '', session: undefined, values: {}, queue: [] })
    source.attach(other.binding)
    expect(source.snapshot().cwd).toBe('')
    const late = [...other.status.listeners][0]!
    source.dispose(); late()
    expect(source.snapshot().session).toBeUndefined()
    expect(other.status.listeners.size + [...other.faces.values()].reduce((n, face) => n + face.listeners.size, 0)).toBe(0)
  })

  it('maps only native human Inbox occurrences and readable attachment descriptions in lane order', () => {
    const source = new RemoteSessionFactsSource()
    const f = binding()
    f.faces.get('inbox')!.set({
      'next-step': [null, [], {}, { id: 1 }, { id: 'bad-source', source: null }, { id: 'agent', source: { kind: 'agent' } },
        { id: 'steer', source: { kind: 'user' }, content: [null, [], { type: 'text', text: 'hello' }, { type: 'text', text: '' }, { type: 'text', text: 1 }, { type: 'image' }, { type: 'file', attachment: { name: '文档.md' } }, { type: 'file' }, { type: 'file', attachment: { name: 12 } }, { type: 'unknown' }] }],
      'next-turn': [{ id: 'queued', source: { kind: 'user' }, content: undefined }],
    })
    source.attach(f.binding)
    expect(source.snapshot().queue).toEqual([
      { id: 'steer', lane: 'step', text: 'hello\n[image]\n[file: 文档.md]\n[file: attachment]\n[file: attachment]' },
      { id: 'queued', lane: 'turn', text: '' },
    ])
    f.faces.get('inbox')!.set({ 'next-step': 12 })
    expect(source.snapshot().queue).toEqual([])
    f.faces.get('inbox')!.set([])
    expect(source.snapshot().queue).toEqual([])
    source.dispose()
  })

  it('drops the field-identical Session snapshot the Client republishes with every streamed chunk', () => {
    const source = new RemoteSessionFactsSource()
    const change = vi.fn()
    source.subscribe(change)
    const f = binding()
    source.attach(f.binding)
    const attached = source.snapshot()
    change.mockClear()
    for (let chunk = 0; chunk < 50; chunk += 1) f.status.set({ running: false })
    expect(change).not.toHaveBeenCalled()
    expect(source.snapshot()).toBe(attached)
    f.status.set({ running: true })
    expect(change).toHaveBeenCalledOnce()
    expect(source.snapshot().session).toMatchObject({ running: true })
    // A projection change still reads the Session snapshot it observes.
    f.faces.get('title')!.set('Native title')
    expect(change).toHaveBeenCalledTimes(2)
    source.dispose()
  })
})

describe('Session snapshot changes', () => {
  const snapshot = (fields: Readonly<Record<string, unknown>>) => fields as unknown as SessionSnapshot

  it('compares every field by identity', () => {
    const submissions: unknown[] = []
    const base = snapshot({ running: true, pendingSubmissions: submissions, openError: null })
    expect(sameSessionSnapshot(base, base)).toBe(true)
    expect(sameSessionSnapshot(base, snapshot({ running: true, pendingSubmissions: submissions, openError: null }))).toBe(true)
    expect(sameSessionSnapshot(base, snapshot({ running: false, pendingSubmissions: submissions, openError: null }))).toBe(false)
    expect(sameSessionSnapshot(base, snapshot({ running: true, pendingSubmissions: [], openError: null }))).toBe(false)
    expect(sameSessionSnapshot(base, snapshot({ running: true, pendingSubmissions: submissions }))).toBe(false)
    expect(sameSessionSnapshot(base, snapshot({ running: true, pendingSubmissions: submissions, openError: null, removed: false }))).toBe(false)
  })

  it('forwards only a changed snapshot and releases the Client subscription', () => {
    const session = projection(snapshot({ running: false }))
    const listener = vi.fn()
    const off = subscribeSessionChanges(session, listener)
    session.set(snapshot({ running: false }))
    expect(listener).not.toHaveBeenCalled()
    session.set(snapshot({ running: true }))
    session.set(snapshot({ running: true }))
    expect(listener).toHaveBeenCalledOnce()
    session.set(snapshot({ running: false }))
    expect(listener).toHaveBeenCalledTimes(2)
    off()
    expect(session.listeners.size).toBe(0)
  })
})
