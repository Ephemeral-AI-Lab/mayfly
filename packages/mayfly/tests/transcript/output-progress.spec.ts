/**
 * Phase transitions and output measurements through projections and real renderers.
 *
 * @module @ephemeral-ai/mayfly/tests/transcript/output-progress
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantStreamRecord, StreamChunk } from '@deepseek-ai/dsh-llm'
import { foldConversationFacts, initialConversationFacts, conversationFactsSchema } from '../../../host/src/conversation/facts.ts'
import { foldConversationProjection, initialConversationState, conversationProjectionStateSchema } from '../../../host/src/conversation/projection.ts'
import { assistantEvent, event, resetSeq, turnStart } from './helpers.ts'

afterEach(() => {
  vi.useRealTimers()
  resetSeq()
})

/** One attempt event carrying a raw (non-delta) stream record. */
function chunk(value: StreamChunk, time: number, step = 1, turn = 1): SessionEvent<'assistant/attempt'> {
  return attempt([{ type: 'chunk', time, chunk: value }], time, step, turn)
}

/** One attempt event carrying a packed reasoning run at an explicit time. */
function reasoning(text: string, time: number, step = 1, turn = 1): SessionEvent<'assistant/attempt'> {
  return attempt([{ type: 'reasoning-chunks', time0: time, index: 0, dt: [], texts: [text] }], time, step, turn)
}

/** One attempt event carrying a packed text run at an explicit time. */
function answer(text: string, time: number, step = 1, turn = 1): SessionEvent<'assistant/attempt'> {
  return attempt([{ type: 'text-chunks', time0: time, index: 0, dt: [], texts: [text] }], time, step, turn)
}

function attempt(stream: readonly AssistantStreamRecord[], time: number, step: number, turn: number): SessionEvent<'assistant/attempt'> {
  return event('assistant/attempt', { turn, step, stream: [...stream] }, time)
}

describe('phase-local output', () => {

  it('replays metrics deterministically, resets per phase/step/turn, and rejects aborted or older output', () => {
    const events = [turnStart(1), reasoning('seed', 1_000), reasoning('x'.repeat(168), 2_000)]
    let facts = events.reduce(foldConversationFacts, initialConversationFacts())
    let state = events.reduce(foldConversationProjection, initialConversationState())
    expect(conversationFactsSchema.parse(facts).outputProgress).toEqual(facts.outputProgress)
    expect(conversationProjectionStateSchema.parse(state)).toEqual(state)
    const serializedFacts = conversationFactsSchema.parse(JSON.parse(JSON.stringify(facts)))
    const serializedState = conversationProjectionStateSchema.parse(JSON.parse(JSON.stringify(state)))
    const next = reasoning('more', 3_000)
    expect(foldConversationFacts(serializedFacts, next)).toEqual(foldConversationFacts(facts, next))
    expect(foldConversationProjection(serializedState, next)).toEqual(foldConversationProjection(state, next))
    facts = foldConversationFacts(facts, answer('answer', 4_000))
    state = foldConversationProjection(state, answer('answer', 4_000))
    facts = foldConversationFacts(facts, reasoning('again', 5_000))
    state = foldConversationProjection(state, reasoning('again', 5_000))
    expect(facts.outputProgress).toMatchObject({ chars: 5, startedAt: 5_000 })
    expect(state.entries.find(entry => entry.kind === 'thinking')).toMatchObject({ streaming: true, outputProgress: { chars: 5, startedAt: 5_000 } })
    facts = foldConversationFacts(facts, event('step/start', { turn: 1, step: 2 }))
    expect(facts.outputProgress).toBeUndefined()
    facts = foldConversationFacts(facts, answer('next', 6_000, 2))
    expect(facts.outputProgress).toMatchObject({ chars: 4, startedAt: 6_000 })
    const abort = event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })
    facts = foldConversationFacts(facts, abort)
    state = foldConversationProjection(state, abort)
    expect(facts.outputProgress).toBeUndefined()
    expect(foldConversationFacts(facts, reasoning('late', 7_000))).toBe(facts)
    expect(foldConversationProjection(state, reasoning('late', 7_000))).toBe(state)
    facts = foldConversationFacts(facts, turnStart(2))
    expect(foldConversationFacts(facts, answer('older turn', 8_000))).toBe(facts)
    facts = foldConversationFacts(facts, answer('new turn', 9_000, 1, 2))
    expect(facts.outputProgress).toMatchObject({ chars: 8, startedAt: 9_000 })
  })

  it.each<StreamChunk>([
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'done' } },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'block-start', index: 1, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 1, id: 'call' as never, name: 'read', argumentsDelta: '{}' },
    { type: 'finish', reason: { kind: 'stop' } },
  ])('ends thinking on $type and preserves final correction', value => {
    const boundary = attempt([...reasoning('seed', 1_000).data.stream, ...chunk(value, 2_000).data.stream], 2_000, 1, 1)
    let state = foldConversationProjection(initialConversationState(), boundary)
    const facts = foldConversationFacts(initialConversationFacts(), boundary)
    expect(state.entries[0]).toMatchObject({ streaming: false })
    expect(facts).toMatchObject({ phase: 'waiting' })
    expect(facts).not.toHaveProperty('outputProgress')
    const final = { ...assistantEvent(1, 1, [{ type: 'reasoning', text: 'corrected' }]), surfaceOp: 'append' as const }
    state = foldConversationProjection(state, final)
    expect(state.entries).toHaveLength(1)
    expect(state.entries[0]).toMatchObject({ text: 'corrected', streaming: false })
  })

  it('parks independent empty attempts and ends a complete text stream without retaining its speed', () => {
    let facts = initialConversationFacts()
    for (const empty of [reasoning('', 1_000), answer('', 1_000)]) {
      expect(foldConversationFacts(facts, empty)).toMatchObject({ phase: 'waiting', flowDownChars: 0 })
      expect(foldConversationFacts(facts, empty)).not.toHaveProperty('outputProgress')
    }
    facts = foldConversationFacts(facts, reasoning('thought', 1_000))
    for (const empty of [reasoning('', 2_000), chunk({ type: 'block-start', index: 0, blockType: 'reasoning' }, 2_000), chunk({ type: 'block-end', index: 1, block: { type: 'text', text: '' } }, 2_000)]) {
      expect(foldConversationFacts(facts, empty)).toMatchObject({ phase: 'waiting' })
      expect(foldConversationFacts(facts, empty)).not.toHaveProperty('outputProgress')
    }
    facts = foldConversationFacts(facts, attempt([
      ...answer('answer', 3_000).data.stream,
      ...chunk({ type: 'block-end', index: 1, block: { type: 'text', text: 'answer' } }, 4_000).data.stream,
    ], 4_000, 1, 1))
    expect(facts).toMatchObject({ phase: 'waiting' })
    expect(facts).not.toHaveProperty('outputProgress')
  })

  it('keeps current metrics when an older step message or chunk arrives late', () => {
    let facts = foldConversationFacts(initialConversationFacts(), reasoning('current', 1_000, 2))
    const progress = facts.outputProgress
    facts = foldConversationFacts(facts, assistantEvent(1, 1, [{ type: 'text', text: 'old answer' }]))
    expect(facts).toMatchObject({ phase: 'thinking', currentStep: 2, outputProgress: progress })
    expect(foldConversationFacts(facts, reasoning('late old step', 2_000, 1))).toBe(facts)
    facts = foldConversationFacts(facts, turnStart(2))
    facts = foldConversationFacts(facts, answer('new turn', 3_000, 1, 2))
    expect(foldConversationFacts(facts, assistantEvent(1, 1, [{ type: 'text', text: 'older turn' }]))).toBe(facts)
  })
})
