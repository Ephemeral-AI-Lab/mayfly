/** Tests for transcript-compatible grouping of embedded assistant attempt streams. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionEventRecord } from '@deepseek-ai/dsh-session-query'
import { aggregateTraceItems } from '../../src/interaction/trace-aggregate.ts'

const sessionId = 'trace' as never

function record(seq: number, type: string): SessionEventRecord {
  return { sessionId, seq, time: seq, type, surface: 'current' }
}

function event(seq: number, type: string, data: unknown): SessionEvent {
  return { seq, time: seq, type, data } as unknown as SessionEvent
}

/** One attempt event whose compact stream holds a single packed run. */
function attempt(seq: number, kind: 'text-chunks' | 'reasoning-chunks', text: string): SessionEvent {
  return event(seq, 'assistant/attempt', { turn: 1, step: 1, stream: [{ type: kind, time0: seq, index: 0, dt: [], texts: [text] }] })
}

describe('aggregateTraceItems', () => {
  it('merges reasoning and text runs per turn and step', () => {
    const records = [
      record(1, 'assistant/attempt'), record(2, 'assistant/attempt'),
      record(3, 'assistant/attempt'), record(4, 'assistant/attempt'),
      record(5, 'assistant/message'), record(6, 'assistant/attempt'),
    ]
    const events = [
      attempt(1, 'reasoning-chunks', 'No'),
      attempt(2, 'reasoning-chunks', ' need'),
      attempt(3, 'text-chunks', 'answer'),
      attempt(4, 'text-chunks', ' now'),
      event(5, 'assistant/message', { turn: 1, step: 1, message: { content: [] }, stream: [] }),
      attempt(6, 'reasoning-chunks', 'ignored'),
    ]
    expect(aggregateTraceItems(records, events)).toMatchObject([
      { seq: 1, lastSeq: 2, eventSeqs: [1, 2], title: 'Thinking', summary: 'No need' },
      { seq: 3, lastSeq: 4, eventSeqs: [3, 4], title: 'Assistant draft', summary: 'answer now' },
      { seq: 5, lastSeq: 5, eventSeqs: [5] },
    ])
  })

  it('keeps unknown and unpaired records as individual items', () => {
    const records = [record(1, 'custom/event'), record(2, 'assistant/attempt')]
    const events = [event(1, 'custom/event', { value: 1 })]
    const items = aggregateTraceItems(records, events)
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ seq: 1, summary: '{"value":1}' })
    expect(items[1]).toMatchObject({ seq: 2, summary: '' })
  })

  it('ignores attempt records without delta runs', () => {
    const records = [record(1, 'assistant/attempt')]
    const events = [event(1, 'assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }] })]
    expect(aggregateTraceItems(records, events)).toEqual([])
  })
})

