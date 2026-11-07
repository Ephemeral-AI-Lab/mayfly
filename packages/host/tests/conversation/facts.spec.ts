/**
 * Decision tests for the renderer-neutral facts fold: the phase machine, the
 * per-step usage ledger, in-flight tool calls, retry marks, and the state
 * invariants the projection cache depends on.
 * @module
 */
import { describe, expect, it } from 'vitest'
import {
  conversationFactsProjectionDefinition,
  foldConversationFacts,
  initialConversationFacts,
} from '../../src/conversation/facts.ts'
import type { ConversationFactsState } from '../../src/conversation/types.ts'

/** One committed session event, typed as the union the fold reads. */
function event(type: string, data: object, time = 1, seq = 1): never {
  return { type, data, time, seq } as never
}

/** A user-authored message event. */
function userMessage(text: string): never {
  return event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] })
}

/** Fold a sequence of events over the initial state. */
function run(events: readonly never[]): ConversationFactsState {
  return events.reduce((state, item) => foldConversationFacts(state, item), initialConversationFacts())
}

describe('foldConversationFacts', () => {
  it('declares the pinned state version and the facts key', () => {
    // A semantics change must bump the version with its fold change.
    expect(conversationFactsProjectionDefinition.stateVersion).toBe(14)
    expect(conversationFactsProjectionDefinition.key).toBe('mayflyConversationFacts')
  })

  it('returns the same reference for events it does not own', () => {
    const initial = initialConversationFacts()
    expect(foldConversationFacts(initial, event('session', {}))).toBe(initial)
    expect(foldConversationFacts(initial, event('request/header', {}))).toBe(initial)
  })

  it('resets the epoch at turn start and clears the previous run', () => {
    let state = run([
      event('turn/start', { turn: 1 }),
      event('tool/call', { turn: 1, step: 0, callId: 1, name: 'bash', arguments: '{}' }),
    ])
    expect(state.epochToolCount).toBe(1)
    state = foldConversationFacts(state, event('turn/start', { turn: 2 }, 2) as never)
    expect(state.epochToolCount).toBe(0)
    expect(state.phase).toBe('waiting')
    expect(state.active).toBe(true)
    expect(state.runOutcome).toBeUndefined()
  })

  it('records the prompt text once per user message and ignores other sources', () => {
    let state = foldConversationFacts(initialConversationFacts(), userMessage('do the thing') as never)
    expect(state.promptText).toBe('do the thing')
    // The same text again is not a change.
    state = foldConversationFacts(state, userMessage('do the thing') as never)
    expect(state.promptText).toBe('do the thing')
    // An agent-authored echo never overwrites the user's prompt.
    state = foldConversationFacts(state, event('user/message', { source: { kind: 'agent' }, content: [{ type: 'text', text: 'echo' }] }) as never)
    expect(state.promptText).toBe('do the thing')
  })

  it('accumulates per-step usage and keeps the epoch totals consistent', () => {
    const usage = (input: number, output: number): object => ({ inputTokens: input, outputTokens: output })
    const state = run([
      event('turn/start', { turn: 3 }),
      event('assistant/message', { turn: 3, step: 0, stream: [], usage: usage(100, 20) }),
      event('assistant/message', { turn: 3, step: 1, stream: [], usage: usage(200, 30) }),
    ])
    expect(state.usageByStep).toEqual({ '3/0': 120, '3/1': 230 })
    expect(state.epochTokens).toBe(350)
    expect(state.outputByStep).toEqual({ '3/0': 20, '3/1': 30 })
    expect(state.epochOutputTokens).toBe(50)
  })

  it('tracks an in-flight call with when it started and retires it on result', () => {
    let state = run([
      event('turn/start', { turn: 1 }),
      event('tool/call', { turn: 1, step: 0, callId: 'c1', name: 'edit', arguments: '{"file_path":"/w/a.ts"}' }),
    ])
    expect(state.inFlight).toEqual([{ callId: 'c1', name: 'edit', startedAt: expect.any(Number) as number }])
    state = foldConversationFacts(state, event('tool/result', { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } }) as never)
    expect(state.inFlight).toEqual([])
  })

  it('marks a completed run and its outcome, and a stopped run separately', () => {
    const completed = run([
      event('turn/start', { turn: 1 }),
      event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
    ])
    expect(completed.phase).toBe('idle')
    expect(completed.active).toBe(false)
    expect(completed.runOutcome).toBe('completed')
    expect(completed.runStopped).toBeUndefined()
    const interrupted = run([
      event('turn/start', { turn: 1 }),
      event('turn/end', { turn: 1, reason: { kind: 'interrupted' } }, 5),
    ])
    expect(interrupted.runOutcome).toBe('failed')
    expect(interrupted.runStopped).toBe(true)
  })

  it('records a retry with its bounded reason and clears it when the retry starts', () => {
    let state = foldConversationFacts(initialConversationFacts(),
      event('llm/retry', { retry: 1, maxRetries: 3, delayMs: 500, failure: { code: 'rate-limited', message: 'too many\nrequests' } }) as never)
    expect(state.retrying).toMatchObject({ retry: 1, maxRetries: 3, delayMs: 500, reason: 'rate-limited' })
    state = foldConversationFacts(state, event('llm/retry-started', {}) as never)
    expect(state.retrying).toBeUndefined()
  })

  it('never keeps a cleared field as undefined in the persisted state', () => {
    // The projection cache refuses a checkpoint holding undefined, so a field
    // the fold clears must be deleted, not written as undefined.
    const state = run([
      event('turn/start', { turn: 1 }),
      event('llm/retry', { retry: 1, maxRetries: 3, delayMs: 0, failure: undefined }),
      event('llm/retry-started', {}),
    ])
    for (const [key, value] of Object.entries(state)) {
      expect(value, `state.${key} must not be undefined`).not.toBeUndefined()
    }
    expect(state).not.toHaveProperty('retrying')
  })

  it('ignores an attempt from a turn the state has already moved past', () => {
    const state = run([
      event('turn/start', { turn: 4 }),
      event('assistant/message', { turn: 4, step: 2, stream: [], usage: { inputTokens: 10, outputTokens: 1 } }),
      event('turn/end', { turn: 4, reason: { kind: 'completed' } }, 9),
      event('assistant/attempt', { turn: 4, step: 1, stream: [] }, 10),
    ])
    // The run ended; a late replayed attempt must not resurrect it.
    expect(state.runOutcome).toBe('completed')
    expect(state.phase).toBe('idle')
  })

  it('keeps approval marks bounded and applies a decision only to a known mark', () => {
    let state = initialConversationFacts()
    for (let index = 0; index < 40; index += 1) {
      state = foldConversationFacts(state, event('approval/asked', { id: index }) as never)
    }
    expect(state.approvals).toHaveLength(32)
    state = foldConversationFacts(state, event('approval/decided', { id: 39, outcome: 'allowed-once' }) as never)
    expect(state.approvals?.at(-1)).toMatchObject({ id: '39', outcome: 'allowed-once' })
    // A decision for an unknown approval is not a change.
    const before = state
    state = foldConversationFacts(state, event('approval/decided', { id: 'no-such', outcome: 'rejected' }) as never)
    expect(state).toBe(before)
  })
})
