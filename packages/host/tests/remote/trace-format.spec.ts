/** Native trace labels and semantic extraction retain the reference output. @module */
/** Tests for the official session-query event presentation and clipboard format. */

import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { attemptStreamText, traceSummary, traceTitle } from '../../src/remote/trace-format.ts'

const event = (type: string, data: unknown): SessionEvent => ({ type, seq: 3, time: 1000, data } as SessionEvent)

describe('trace-format', () => {
  it('labels known and unknown event types', () => {
    expect(traceTitle('user/message')).toBe('User request')
    expect(traceTitle('assistant/attempt')).toBe('Assistant attempt')
    expect(traceTitle('assistant/message')).toBe('Assistant answer')
    expect(traceTitle('tool/call')).toBe('Tool call')
    expect(traceTitle('tool/result')).toBe('Tool result')
    expect(traceTitle('turn/start')).toBe('Turn started')
    expect(traceTitle('turn/end')).toBe('Turn ended')
    expect(traceTitle('request/header')).toBe('Model configuration')
    expect(traceTitle('subagent/descriptor')).toBe('Subagent')
    expect(traceTitle('custom/event')).toBe('custom/event')
  })

  it('extracts semantic text, falls back to data, and handles empty data', () => {
    expect(traceSummary(event('user/message', { content: [{ type: 'text', text: ' hello  world ' }] }))).toBe('hello world')
    expect(traceSummary(event('custom/event', 'raw text'))).toBe('raw text')
    expect(traceSummary(event('custom/event', { value: 1 }))).toBe('{"value":1}')
    expect(traceSummary(event('custom/event', null))).toBe('')
    expect(traceSummary(event('custom/event', undefined))).toBe('')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(traceSummary(event('custom/event', cyclic))).toBe('[unserializable event payload]')
    expect(traceSummary(event('assistant/attempt', { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }] }))).toContain('block-start')
  })

  it('concatenates every record shape an attempt stream may embed', () => {
    const stream: AssistantStreamRecord[] = [
      { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['packed'] },
      { type: 'reasoning-chunks', time0: 2, index: 1, dt: [1], texts: ['deep ', 'thought'] },
      { type: 'tool-call-chunks', time0: 3, index: 2, dt: [], id: ToolCallId('c'), name: 'read', args: ['{}'] },
      { type: 'chunk', time: 4, chunk: { type: 'reasoning-delta', index: 2, text: ' raw-r' } },
      { type: 'chunk', time: 5, chunk: { type: 'text-delta', index: 3, text: ' raw-t' } },
      { type: 'chunk', time: 6, chunk: { type: 'finish', reason: { kind: 'stop' } } },
    ]
    expect(attemptStreamText(stream)).toEqual({ reasoning: 'deep thought raw-r', text: 'packed raw-t' })
    expect(traceSummary(event('assistant/attempt', { turn: 1, step: 1, stream }))).toContain('packed raw-t')
  })

})
