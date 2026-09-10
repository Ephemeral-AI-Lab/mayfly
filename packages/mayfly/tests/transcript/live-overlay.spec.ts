/** Live assistant-stream draft overlays over the transcript source and facts.
 * @module @ephemeral-ai/mayfly/tests/transcript/live-overlay
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { LiveAssistantStreamService } from '../../src/conversation/live-stream.ts'
import { initialConversationFacts } from '../../src/conversation/facts.ts'
import { liveDraftsOf, OfficialConversationModelSource, type LiveDraftSource } from '../../src/transcript/official-model.ts'
import { SessionFactsService } from '../../src/transcript/session-facts.ts'
import type { ConversationProjection } from '../../src/conversation/types.ts'
import { fakeAgent } from './status-fakes.ts'

class ProjectionFake {
  private readonly values = new Map<Session, Record<string, unknown>>()
  private readonly listeners = new Set<(session: Session, key: string, value: unknown, seq: number) => void>()

  set(session: Session, values: Record<string, unknown>): void { this.values.set(session, values) }

  snapshot(session: Session, keys?: readonly string[]): { readonly asOfSeq: number, readonly values: Record<string, unknown> } {
    const source = this.values.get(session) ?? {}
    return { asOfSeq: 5, values: keys === undefined ? { ...source } : Object.fromEntries(keys.map(key => [key, source[key]])) }
  }

  onChanged(listener: (session: Session, key: string, value: unknown, seq: number) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  emit(session: Session, key: string, value: unknown, seq = 6): void {
    const prior = this.values.get(session)
    this.values.set(session, prior === undefined ? { [key]: value } : { ...prior, [key]: value })
    for (const listener of this.listeners) listener(session, key, value, seq)
  }
}

/** An agent whose session carries an id the draft store keys on, with a
 * switchable current-Agent slot the test can null out. */
function liveAgent(ctx: Context, id: string): { agent: Agent, session: Session, detach: () => void } {
  const base = fakeAgent([])
  const session = { ...base.session, id } as unknown as Session
  const agent = { ...base, session } as unknown as Agent
  let current: Agent | null = agent
  let delivered: ((agent: Agent | null) => void) | undefined
  ctx.provide('mayflyCurrentAgent', { subscribe: (listener: (agent: Agent | null) => void) => {
    delivered = listener
    listener(current)
    return () => {}
  } })
  return { agent, session, detach: () => { current = null; delivered?.(null) } }
}

function projection(entries: ConversationProjection['entries'], streaming = false): ConversationProjection {
  return { entries, streaming }
}

describe('live draft overlays', () => {
  it('overlays streaming draft entries onto the transcript model and clears them on settlement', () => {
    const ctx = new Context()
    const live = new LiveAssistantStreamService(ctx)
    const drafts: LiveDraftSource = { subscribe: listener => live.subscribe(listener), get: id => live.get(id) }
    const projections = new ProjectionFake()
    const tools = { get: () => undefined }
    const publish = vi.fn()
    const { agent, session } = liveAgent(ctx, 'overlay-transcript')
    projections.set(session, {})
    const source = new OfficialConversationModelSource(projections as never, tools, publish, drafts)
    source.attach(session)
    expect(publish).toHaveBeenCalled()

    // A baseline settled entry and the live draft for the SAME step: the
    // settled entry wins and the draft is dropped.
    projections.emit(session, 'mayflyConversation', projection([
      { kind: 'user', id: 'user:2', seq: 2, updatedSeq: 2, turn: 1, text: 'question', images: [] },
      { kind: 'assistant', id: 'assistant:1:0', seq: 3, updatedSeq: 3, turn: 1, step: 0, text: 'settled', streaming: false },
    ]))
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'a' as never, revision: 1, turn: 1, step: 0 } } as never)
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'a' as never, revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'draft' } } } as never)
    let model = source.snapshot()
    expect(model.entries.map(entry => entry.kind)).toEqual(['transcript-user', 'transcript-assistant'])
    expect(JSON.stringify(model.entries)).toContain('settled')

    // A draft for a NEW step overlays streaming entries after the baseline.
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'b' as never, revision: 2, turn: 1, step: 1 } } as never)
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'b' as never, revision: 2, index: 0, time: 2, chunk: { type: 'reasoning-delta', index: 0, text: 'thinking now' } } } as never)
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'b' as never, revision: 2, index: 1, time: 3, chunk: { type: 'text-delta', index: 1, text: 'answer' } } } as never)
    model = source.snapshot()
    expect(model.entries.map(entry => entry.kind)).toEqual(['transcript-user', 'transcript-assistant', 'transcript-thinking', 'transcript-assistant'])
    expect(JSON.stringify(model.entries)).toContain('thinking now')

    // A reasoning-only draft overlays just the thinking entry.
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'b' as never, revision: 2, index: 2, outcome: { kind: 'abandoned' } } } as never)
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'c' as never, revision: 3, turn: 1, step: 2 } } as never)
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'c' as never, revision: 3, index: 0, time: 4, chunk: { type: 'reasoning-delta', index: 0, text: 'quiet thought' } } } as never)
    model = source.snapshot()
    expect(model.entries.filter(entry => entry.kind === 'transcript-assistant')).toHaveLength(1)
    expect(JSON.stringify(model.entries)).toContain('quiet thought')

    // The end frame clears the draft; the model falls back to the projection.
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'c' as never, revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 as never } } } as never)
    model = source.snapshot()
    expect(model.entries.map(entry => entry.kind)).toEqual(['transcript-user', 'transcript-assistant'])
    source.dispose()
    // Late draft activity after dispose never republishes.
    const calls = publish.mock.calls.length
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'c' as never, revision: 3, turn: 2, step: 0 } } as never)
    expect(publish).toHaveBeenCalledTimes(calls)
    // Dispose replaces the model with a fresh empty one; late frames never
    // rebuild it.
    expect(source.snapshot().entries).toEqual([])
    live.dispose()
  })

  it('drops superseded projection streaming entries when the draft takes over the step', () => {
    const ctx = new Context()
    const live = new LiveAssistantStreamService(ctx)
    const projections = new ProjectionFake()
    const { agent, session } = liveAgent(ctx, 'overlay-supersede')
    projections.set(session, {})
    const source = new OfficialConversationModelSource(projections as never, { get: () => undefined }, () => {}, {
      subscribe: listener => live.subscribe(listener),
      get: id => live.get(id),
    })
    source.attach(session)
    // A durable failed attempt left a streaming entry for step 0.
    projections.emit(session, 'mayflyConversation', projection([
      { kind: 'assistant', id: 'assistant:1:0', seq: 2, updatedSeq: 2, turn: 1, step: 0, text: 'abandoned prefix', streaming: true },
    ], true))
    // The live retry replaces it for the same step id.
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'r' as never, revision: 1, turn: 1, step: 0 } } as never)
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'r' as never, revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'retry draft' } } } as never)
    const model = source.snapshot()
    expect(model.entries.filter(entry => entry.kind === 'transcript-assistant')).toHaveLength(1)
    expect(JSON.stringify(model.entries)).toContain('retry draft')
    source.dispose()
    live.dispose()
  })

  it('overlays the current Agent draft onto the session facts phase', () => {
    const ctx = new Context()
    const live = new LiveAssistantStreamService(ctx)
    const projections = new ProjectionFake()
    const foreign = { ...fakeAgent([]).session, id: 'overlay-other' } as unknown as Session
    const foreignAgent = { ...fakeAgent([]), session: foreign } as unknown as Agent
    const holder = liveAgent(ctx, 'overlay-facts')
    const { agent, session } = holder
    projections.set(session, {})
    ctx.provide('sessionProjections', projections as never)
    ctx.provide('sessions', { list: () => [] })
    const service = new SessionFactsService(ctx, live)
    const observed: string[] = []
    const off = service.subscribe(facts => observed.push(`${facts.phase}:${facts.active}`))
    // Baseline durable facts arrive while nothing streams; re-emitting the
    // identical value republishes nothing.
    const baseline = { ...initialConversationFacts(), phase: 'waiting', active: true, turn: 1 }
    projections.emit(session, 'mayflyConversationFacts', baseline)
    expect(observed.at(-1)).toBe('waiting:true')
    const settledEmits = observed.length
    projections.emit(session, 'mayflyConversationFacts', baseline)
    expect(observed).toHaveLength(settledEmits)

    // The current Agent's draft overlays the streaming phase.
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'a' as never, revision: 1, turn: 1, step: 0 } } as never)
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'a' as never, revision: 1, index: 0, time: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'think' } } } as never)
    expect(service.current).toMatchObject({ phase: 'thinking', active: true, activity: { kind: 'reasoning' } })
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'a' as never, revision: 1, index: 1, time: 2, chunk: { type: 'text-delta', index: 1, text: 'answering' } } } as never)
    expect(service.current).toMatchObject({ phase: 'composing', activity: { kind: 'text' }, outputProgress: { chars: 9 } })

    // A boundary parks the phase back onto the durable facts.
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'a' as never, revision: 1, index: 2, time: 3, chunk: { type: 'finish', index: 2 } } } as never)
    expect(service.current.phase).toBe('waiting')
    // The end frame drops the overlay entirely.
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'a' as never, revision: 1, index: 3, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 as never } } } as never)
    expect(service.current).toMatchObject({ phase: 'waiting' })
    expect(service.current.outputProgress).toBeUndefined()

    // A draft of ANOTHER session never leaks into the current Agent's facts.
    ctx.emit('agent/assistant-stream', { agent: foreignAgent, frame: { type: 'start', attemptId: 'x' as never, revision: 1, turn: 9, step: 0 } } as never)
    expect(service.current.phase).toBe('waiting')

    // With no current Agent at all, live frames fold nothing and the facts
    // reset to their initial idle value.
    const { detach } = holder
    detach()
    ctx.emit('agent/assistant-stream', { agent: foreignAgent, frame: { type: 'chunk', attemptId: 'x' as never, revision: 1, index: 0, time: 10, chunk: { type: 'text-delta', index: 0, text: 'nowhere' } } } as never)
    expect(service.current).toMatchObject({ phase: 'idle', active: false })
    off()
    service.dispose()
    live.dispose()
  })

  it('adapts the optional ctx live-stream service into a draft source', () => {
    const bare = new Context()
    expect(liveDraftsOf(bare as never)).toBeUndefined()
    const ctx = new Context()
    const live = new LiveAssistantStreamService(ctx)
    const { agent } = liveAgent(ctx, 'overlay-adapter')
    const drafts = liveDraftsOf(ctx)
    expect(drafts).toBeDefined()
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId: 'a' as never, revision: 1, turn: 1, step: 0 } } as never)
    expect(drafts!.get('overlay-adapter')).toMatchObject({ turn: 1, step: 0 })
    const listener = vi.fn()
    const off = drafts!.subscribe(listener)
    ctx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'a' as never, revision: 1, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text: 'x' } } } as never)
    expect(listener).toHaveBeenCalled()
    off()
    live.dispose()
  })
})
