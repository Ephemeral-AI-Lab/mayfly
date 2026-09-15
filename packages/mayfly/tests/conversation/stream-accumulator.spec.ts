import { describe, expect, it } from 'vitest'
import type { AssistantStreamRecord, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  foldAssistantStreamChunk,
  foldAssistantStreamRecords,
  initialAssistantStream,
} from '../../src/conversation/stream-accumulator.ts'

function chunk(value: StreamChunk, time = 10): AssistantStreamRecord {
  return { type: 'chunk', time, chunk: value }
}

describe('assistant stream accumulator', () => {
  it('folds reasoning and text phases and resets progress at boundaries', () => {
    let state = initialAssistantStream()
    state = foldAssistantStreamChunk(state, { type: 'reasoning-delta', index: 0, text: 'think' }, 100)
    expect(state).toMatchObject({ phase: 'thinking', reasoning: 'think', chars: 5, outputProgress: { initialChars: 5 } })
    state = foldAssistantStreamChunk(state, { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } }, 110)
    expect(state).toMatchObject({ phase: 'waiting', outputProgress: undefined })
    state = foldAssistantStreamChunk(state, { type: 'text-delta', index: 1, text: 'answer' }, 120)
    expect(state).toMatchObject({ phase: 'composing', text: 'answer', chars: 11, outputProgress: { initialChars: 6 } })
    state = foldAssistantStreamChunk(state, { type: 'finish', reason: 'stop' }, 130)
    expect(state).toMatchObject({ phase: 'waiting', outputProgress: undefined, updatedAt: 130 })
  })

  it('ignores empty and unrelated chunks while preserving malformed streams', () => {
    const state = initialAssistantStream()
    expect(foldAssistantStreamChunk(state, { type: 'text-delta', index: 0, text: '' }, 1)).toBe(state)
    expect(foldAssistantStreamChunk(state, { type: 'usage', usage: { inputTokens: 1, outputTokens: 2 } }, 1)).toBe(state)
    expect(foldAssistantStreamChunk(state, { type: 'block-start', index: 0, blockType: 'reasoning' }, 1)).toBe(state)
    expect(foldAssistantStreamRecords(state, undefined)).toBe(state)
    expect(foldAssistantStreamRecords(state, [{ type: 'text-chunks', time0: 1, index: 0, dt: ['bad'] as never, texts: ['bad'] }])).toBe(state)
  })

  it('replays compact records without copying each intermediate history', () => {
    const state = foldAssistantStreamRecords(initialAssistantStream(), [
      chunk({ type: 'reasoning-delta', index: 0, text: 'a' }, 1),
      chunk({ type: 'reasoning-delta', index: 0, text: 'b' }, 2),
      chunk({ type: 'text-delta', index: 1, text: 'c' }, 3),
    ])
    expect(state).toMatchObject({ reasoning: 'ab', text: 'c', phase: 'composing', chars: 3 })
  })
})
