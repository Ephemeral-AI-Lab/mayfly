/** Transient-only public assistant presentation without a native Session service. @module */
import { describe, expect, it } from 'vitest'
import { transientAssistantConversation } from '../../src/conversation/transient.ts'

describe('transient assistant conversation', () => {
  it('keeps reasoning/text ordering and never admits durable history', () => {
    const projection = transientAssistantConversation([
      { type: 'chunk', time: 10, chunk: { type: 'reasoning-delta', index: 0, text: 'inspect' } },
      { type: 'chunk', time: 20, chunk: { type: 'text-delta', index: 1, text: 'answer' } },
    ], { seq: 7, time: 20, turn: 2, step: 3 })
    expect(projection.entries.map(entry => ({ kind: entry.kind, text: 'text' in entry ? entry.text : undefined, turn: entry.turn }))).toEqual([
      { kind: 'thinking', text: 'inspect', turn: 2 },
      { kind: 'assistant', text: 'answer', turn: 2 },
    ])
    expect(projection.streaming).toBe(true)
    expect(projection.settledSteps).toEqual([])
  })

  it('keeps an empty transient window empty', () => {
    expect(transientAssistantConversation([], { seq: 1, time: 1, turn: 1, step: 1 }).entries).toEqual([])
  })
})
