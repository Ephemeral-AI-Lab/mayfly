/**
 * Registry-driven transcript views: residency, native bindings, rebuilds, and
 * renderer wake-ups for displayed versus hidden conversations.
 * @module @ephemeral-ai/mayfly/tests/transcript/conversation-slots
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import type { MayflyConversationsSnapshot, MayflyConversationView } from '../../src/app/conversation-views.ts'
import { AddressConversationFeed } from '../../src/transcript/conversation-feed.ts'
import { ConversationSlots } from '../../src/transcript/conversation-slots.ts'
import type { OfficialConversationModelSource } from '../../src/transcript/official-model.ts'
import type { TranscriptController } from '../../src/transcript/transcript-model.ts'

function agent(id: string): Agent {
  return { id: SessionId(id), session: { id: SessionId(id) } as unknown as Session } as unknown as Agent
}

interface FakeSource {
  readonly agent: Agent | undefined
  readonly publish: () => void
  readonly attach: ReturnType<typeof vi.fn>
  readonly attachFeed: ReturnType<typeof vi.fn>
  readonly snapshot: ReturnType<typeof vi.fn>
  readonly invalidateTools: ReturnType<typeof vi.fn>
  readonly dispose: ReturnType<typeof vi.fn>
}

function bench() {
  const ctx = new Context()
  const agents = new Map<string, Agent>()
  const sessions: Session[] = []
  let primary: Agent | null = null
  ctx.provide('mayflyConversations', { primary: () => primary } as never)
  ctx.provide('agents', { get: (id: unknown) => agents.get(String(id)) } as never)
  ctx.provide('sessions', { list: () => sessions } as never)
  const release = vi.fn()
  const watch = vi.fn(() => release)
  ctx.provide('mayflyLiveAssistantStream', { watch } as never)
  ctx.provide('sessionController', { follow: () => (async function* () {})() } as never)
  const transcript = { setView: vi.fn(), show: vi.fn(), dropView: vi.fn(), refresh: vi.fn() }
  const sources: FakeSource[] = []
  const headed = { liveTurnHeader: true }
  const slots = new ConversationSlots(ctx, transcript as unknown as TranscriptController, {
    source: (sourceAgent, publish) => {
      const source: FakeSource = {
        agent: sourceAgent, publish,
        attach: vi.fn(), attachFeed: vi.fn(), snapshot: vi.fn(() => 'model'), invalidateTools: vi.fn(), dispose: vi.fn(),
      }
      sources.push(source)
      return source as unknown as OfficialConversationModelSource
    },
    headed,
    history: () => ctx.get('sessionController'),
  })
  return {
    ctx, agents, sessions, transcript, sources, slots, headed, watch, release,
    setPrimary(next: Agent) { primary = next; agents.set(String(next.id), next) },
  }
}

const primaryView = (residency: MayflyConversationView['residency'] = 'displayed'): MayflyConversationView => ({
  kind: 'primary', id: 'session:main', sessionId: 'main', access: 'interactive', residency,
})

function child(sessionId: string, options: Partial<{ access: MayflyConversationView['access'], residency: MayflyConversationView['residency'], mode: 'one-shot' | 'continuable' }> = {}): MayflyConversationView {
  return {
    kind: 'subagent', id: `session:${sessionId}`, sessionId, parentSessionId: 'main', label: sessionId,
    mode: options.mode ?? 'one-shot', access: options.access ?? 'readonly', residency: options.residency ?? 'displayed',
  }
}

function snapshot(views: readonly MayflyConversationView[]): MayflyConversationsSnapshot {
  const displayed = views.find(view => view.residency === 'displayed')
  return { primaryId: 'session:main', displayedId: displayed?.id ?? null, recent: views.map(view => view.id), views, revision: 1 }
}

describe('ConversationSlots', () => {
  it('holds sources for displayed and retained views only and wakes the renderer only for the displayed one', () => {
    const test = bench()
    const main = agent('main')
    const once = agent('once')
    test.setPrimary(main)
    test.agents.set('once', once)
    test.slots.sync(snapshot([primaryView('retained'), child('once'), child('hidden', { residency: 'listed' })]))
    expect(test.sources).toHaveLength(2)
    const [mainSource, onceSource] = test.sources
    expect(mainSource!.attach).toHaveBeenCalledWith(main.session, undefined, main)
    expect(onceSource!.attach).toHaveBeenCalledWith(once.session, undefined, once)
    expect(test.transcript.setView).toHaveBeenCalledWith('session:main', expect.any(Function), undefined)
    // A readonly child has no activity row, so it ticks its own running header.
    expect(test.transcript.setView).toHaveBeenCalledWith('session:once', expect.any(Function), test.headed)
    expect(test.transcript.setView.mock.calls[1]![1]()).toBe('model')
    expect(test.transcript.show).toHaveBeenLastCalledWith('session:once')
    expect(test.watch).toHaveBeenCalledTimes(2)

    mainSource!.publish()
    expect(test.transcript.refresh).not.toHaveBeenCalled()
    onceSource!.publish()
    expect(test.transcript.refresh).toHaveBeenCalledOnce()

    // An unchanged binding keeps its source and rows.
    test.slots.sync(snapshot([primaryView(), child('once', { residency: 'retained' })]))
    expect(test.sources).toHaveLength(2)
    expect(test.transcript.show).toHaveBeenLastCalledWith('session:main')
    test.slots.invalidateTools()
    expect(mainSource!.invalidateTools).toHaveBeenCalledOnce()
    expect(onceSource!.invalidateTools).toHaveBeenCalledOnce()

    // Demoted to listed: the view and its lease go away.
    test.slots.sync(snapshot([primaryView(), child('once', { residency: 'listed' })]))
    expect(test.transcript.dropView).toHaveBeenCalledWith('session:once')
    expect(onceSource!.dispose).toHaveBeenCalledOnce()
    expect(test.release).toHaveBeenCalledOnce()
    test.slots.dispose()
    expect(mainSource!.dispose).toHaveBeenCalledOnce()
  })

  it('reads a stored child through its address and rebinds when it resumes live', () => {
    const test = bench()
    test.setPrimary(agent('main'))
    test.slots.sync(snapshot([primaryView('retained'), child('cold', { mode: 'continuable', access: 'resumable' })]))
    const cold = test.sources[1]!
    expect(cold.agent).toBeUndefined()
    expect(cold.attachFeed).toHaveBeenCalledWith(expect.any(AddressConversationFeed), undefined)
    const feed = cold.attachFeed.mock.calls[0]![0] as AddressConversationFeed
    expect(feed.state()).toEqual({ kind: 'loading' })
    expect(test.watch).toHaveBeenCalledOnce()

    const resumed = agent('cold')
    test.agents.set('cold', resumed)
    test.slots.sync(snapshot([primaryView('retained'), child('cold', { mode: 'continuable', access: 'interactive' })]))
    expect(cold.dispose).toHaveBeenCalledOnce()
    const live = test.sources[2]!
    expect(live.attach).toHaveBeenCalledWith(resumed.session, undefined, resumed)
    expect(test.transcript.setView).toHaveBeenLastCalledWith('session:cold', expect.any(Function), undefined)
  })

  it('wakes the renderer when a displayed stored read lands', async () => {
    const test = bench()
    test.setPrimary(agent('main'))
    test.ctx.set('sessionController', {
      follow: () => (async function* () {
        yield { type: 'snapshot', projections: { asOfSeq: 1, values: { mayflyConversation: { entries: [], streaming: false, settledSteps: [], turns: [] } } } }
      })(),
    } as never)
    test.slots.sync(snapshot([primaryView('retained'), child('cold', { mode: 'continuable', access: 'resumable' })]))
    await vi.waitFor(() => expect(test.transcript.refresh).toHaveBeenCalledOnce())
    test.slots.sync(snapshot([primaryView(), child('stored', { residency: 'retained', mode: 'continuable', access: 'resumable' })]))
    await new Promise<void>(resolve => { setImmediate(resolve) })
    expect(test.transcript.refresh).toHaveBeenCalledOnce()
  })

  it('binds a live Session without an Agent, a BTW without either, and rebuilds on a new floor', () => {
    const test = bench()
    test.setPrimary(agent('main'))
    const orphan = { id: SessionId('orphan') } as unknown as Session
    test.sessions.push(orphan)
    const btw = (floor?: number): MayflyConversationView => ({
      kind: 'btw', id: 'session:btw', sessionId: 'btw', parentSessionId: 'main', label: 'side',
      ...(floor === undefined ? {} : { historyFloorSeq: floor }), access: 'readonly', residency: 'retained',
    })
    test.slots.sync(snapshot([primaryView(), child('orphan', { residency: 'retained' }), btw(4)]))
    expect(test.sources[1]!.attach).toHaveBeenCalledWith(orphan, undefined, undefined)
    expect(test.sources[2]!.attach).toHaveBeenCalledWith(null)
    test.slots.sync(snapshot([primaryView(), child('orphan', { residency: 'retained' }), btw(7)]))
    expect(test.sources[2]!.dispose).toHaveBeenCalledOnce()
    expect(test.sources).toHaveLength(4)
    test.slots.sync({ primaryId: null, displayedId: null, recent: [], views: [], revision: 2 })
    expect(test.transcript.show).toHaveBeenLastCalledWith(undefined)
    expect(test.sources.every(source => source.dispose.mock.calls.length === 1)).toBe(true)
  })
})
