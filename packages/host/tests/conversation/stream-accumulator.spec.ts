/**
 * Decision tests for the assistant stream fold: phase transitions, tool-call
 * argument accumulation, and the output-progress ledger.
 * @module
 */
import { describe, expect, it } from 'vitest'
import {
  foldAssistantStreamChunk,
  foldAssistantStreamRecords,
  initialAssistantStream,
  type AssistantStreamState,
} from '../../src/conversation/stream-accumulator.ts'

/** A reasoning delta with only the fields the fold reads. */
function reasoning(text: string): { type: 'reasoning-delta', text: string } {
  return { type: 'reasoning-delta', text }
}

/** A text delta with only the fields the fold reads. */
function text(text: string): { type: 'text-delta', text: string } {
  return { type: 'text-delta', text }
}

/** One tool-call argument delta as the fold reads it. */
function delta(id: string, argumentsDelta: string, name?: string): {
  type: 'tool-call-delta', id: string, argumentsDelta: string, name?: string
} {
  return { type: 'tool-call-delta', id, argumentsDelta, ...(name === undefined ? {} : { name }) }
}

describe('foldAssistantStreamChunk', () => {
  it('starts waiting and empty', () => {
    const initial = initialAssistantStream()
    expect(initial.phase).toBe('waiting')
    expect(initial.reasoning).toBe('')
    expect(initial.text).toBe('')
    expect(initial.chars).toBe(0)
    expect(initial.outputProgress).toBeUndefined()
  })

  it('keeps reasoning and text in separate buffers with separate phases', () => {
    let state = foldAssistantStreamChunk(initialAssistantStream(), reasoning('think '), 1)
    expect(state.phase).toBe('thinking')
    expect(state.reasoning).toBe('think ')
    state = foldAssistantStreamChunk(state, text('answer'), 2)
    expect(state.phase).toBe('composing')
    expect(state.text).toBe('answer')
    // Earlier reasoning survives the transition to composing.
    expect(state.reasoning).toBe('think ')
  })

  it('ignores empty deltas rather than recording zero-length progress', () => {
    const initial = initialAssistantStream()
    const state = foldAssistantStreamChunk(initial, text(''), 5)
    expect(state).toBe(initial)
  })

  it('accumulates tool-call arguments per id and starts each timer once', () => {
    let state = foldAssistantStreamChunk(initialAssistantStream(), delta('t1', '{"a"', 'bash'), 10)
    state = foldAssistantStreamChunk(state, delta('t1', ':"b"}'), 12)
    state = foldAssistantStreamChunk(state, delta('t2', '[]', 'grep'), 14)
    expect(state.preparing).toEqual([
      { id: 't1', name: 'bash', characters: 9, arguments: '{"a":"b"}', startedAt: 10 },
      { id: 't2', name: 'grep', characters: 2, arguments: '[]', startedAt: 14 },
    ])
    // A tool call holds the fold in waiting with no output progress.
    expect(state.phase).toBe('waiting')
    expect(state.outputProgress).toBeUndefined()
  })

  it('refuses a tool-call delta whose name arrives on no delta', () => {
    const initial = initialAssistantStream()
    // No name here and no previous call carried one: nothing can be recorded.
    const state = foldAssistantStreamChunk(initial, delta('t1', '{}'), 10)
    expect(state).toBe(initial)
  })

  it('seals the phase on finish and clears the progress ledger', () => {
    let state = foldAssistantStreamChunk(initialAssistantStream(), text('hello'), 20)
    expect(state.phase).toBe('composing')
    expect(state.outputProgress).not.toBeUndefined()
    state = foldAssistantStreamChunk(state, { type: 'finish' }, 21)
    expect(state.phase).toBe('waiting')
    expect(state.outputProgress).toBeUndefined()
    // The visible text survives the seal.
    expect(state.text).toBe('hello')
  })

  it('excludes the first chunk of a phase from timed output', () => {
    let state = foldAssistantStreamChunk(initialAssistantStream(), text('first'), 30)
    // The first chunk's generation began off-wire: it seeds the ledger but is
    // not added again as progress.
    expect(state.outputProgress).toEqual({ chars: 5, initialChars: 5, startedAt: 30, updatedAt: 30 })
    state = foldAssistantStreamChunk(state, text('more'), 31)
    // chars is the running total; initialChars keeps the size of the first,
    // off-wire chunk so a rate can exclude it.
    expect(state.outputProgress?.chars).toBe(9)
    expect(state.outputProgress?.initialChars).toBe(5)
  })

  it('records the first visible reasoning delta time only once', () => {
    let state = foldAssistantStreamChunk(initialAssistantStream(), reasoning('a'), 40)
    expect(state.reasoningStartedAt).toBe(40)
    state = foldAssistantStreamChunk(state, reasoning('b'), 41)
    expect(state.reasoningStartedAt).toBe(40)
    expect(state.reasoningEndedAt).toBe(41)
  })

  it('never moves the clock backwards', () => {
    let state = foldAssistantStreamChunk(initialAssistantStream(), text('a'), 100)
    state = foldAssistantStreamChunk(state, text('b'), 50)
    expect(state.updatedAt).toBe(100)
  })
})

describe('foldAssistantStreamRecords', () => {
  it('folds a complete durable attempt through the same decisions', () => {
    // Durable attempts store the compact packed form; the expander turns them
    // back into timed chunks and the fold sees the same stream as live.
    const state = foldAssistantStreamRecords(initialAssistantStream(), [
      { type: 'reasoning-chunks', time0: 1, index: 0, dt: [], texts: ['why'] },
      { type: 'text-chunks', time0: 2, index: 0, dt: [], texts: ['because'] },
    ] as never)
    expect(state.reasoning).toBe('why')
    expect(state.text).toBe('because')
    expect(state.phase).toBe('composing')
  })

  it('leaves the state untouched for a missing stream and a malformed one', () => {
    const initial: AssistantStreamState = initialAssistantStream()
    expect(foldAssistantStreamRecords(initial, undefined)).toBe(initial)
    // A record array the expander cannot read must not corrupt the fold.
    expect(foldAssistantStreamRecords(initial, ['not a record'] as never)).toBe(initial)
  })
})
