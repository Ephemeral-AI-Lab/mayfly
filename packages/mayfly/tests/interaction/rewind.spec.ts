/** Tests for the pure single-level rewind projection. */

import { describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { rewindCandidates } from '../../src/interaction/rewind.ts'

function event(type: string, seq: number, data: unknown): SessionEvent {
  return { type, seq, time: 1_700_000_000_000 + seq, data } as SessionEvent
}

function user(seq: number, text: string | undefined, kind = 'user'): SessionEvent {
  return event('user/message', seq, {
    id: MessageId(`user-${String(seq)}`),
    role: 'user',
    source: { kind },
    ...(text === undefined ? {} : { content: [{ type: 'image' }, { type: 'text', text }] }),
  })
}

function assistant(seq: number, text: string | undefined): SessionEvent {
  return event('assistant/message', seq, {
    turn: 1,
    step: 0,
    message: {
      id: MessageId(`assistant-${String(seq)}`),
      role: 'assistant',
      source: { kind: 'model', provider: 'mock', model: 'mock' },
      content: text === undefined ? [{ type: 'image' }] : [{ type: 'text', text }],
    },
  })
}

describe('rewindCandidates', () => {
  it('returns newest-first direct-user boundaries with response previews', () => {
    const events = [
      undefined,
      user(0, 'plugin context', 'plugin'),
      event('turn/start', 1, { turn: 1 }),
      user(2, undefined),
      assistant(3, 'first\nresponse'),
      event('tool/call', 4, {}),
      user(5, 'second\tprompt'),
      assistant(6, undefined),
      assistant(7, 'second response'),
      user(8, undefined),
      event('turn/start', 9, { turn: 2 }),
      user(10, 'latest prompt'),
    ] as unknown as SessionEvent[]

    expect(rewindCandidates(events)).toEqual([
      { turn: 2, boundarySeq: 9, prompt: 'latest prompt', discarded: 1 },
      { turn: 1, boundarySeq: 1, prompt: '(empty prompt) / second prompt / (empty prompt)', response: 'second response', discarded: 7 },
    ])
  })

  it('handles logs without message content', () => {
    expect(rewindCandidates([
      event('turn/start', 0, { turn: 1 }),
      user(1, undefined),
    ])).toEqual([{ turn: 1, boundarySeq: 0, prompt: '(empty prompt)', discarded: 1 }])
  })
})
