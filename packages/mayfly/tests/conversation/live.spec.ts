/** Incremental current-attempt overlay over the official Client event window. @module */
import { describe, expect, it } from 'vitest'
import type {
  SessionEventChange,
  SessionEventLikeEntry,
  SessionEventWindow,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { LlmAttemptId } from '@deepseek-ai/dsh-llm/brand'
import { SessionSeq } from '@deepseek-ai/dsh-session/types'
import { LiveConversationFold } from '../../src/conversation/live.ts'

function chunk(text: string, seq: number, options: { readonly attempt?: string, readonly kind?: 'text-delta' | 'reasoning-delta', readonly turn?: number } = {}): SessionEventLikeEntry {
  return {
    type: 'transient',
    event: {
      type: 'assistant/live-chunk',
      seq,
      time: seq * 10,
      data: {
        attemptId: (options.attempt ?? 'attempt-1') as LlmAttemptId,
        turn: options.turn ?? 1,
        step: 0,
        chunk: { type: options.kind ?? 'text-delta', index: 0, text },
      },
    },
  }
}

function durable(seq: number): SessionEventLikeEntry {
  return { type: 'event', event: { type: 'turn/start', seq: SessionSeq(seq), time: seq * 10, data: { turn: 1 } } } as SessionEventLikeEntry
}

/** A window snapshot; `sealed` makes reading its entries fail, proving an append never materializes the window. */
function windowOf(entries: readonly SessionEventLikeEntry[], revision: number, change: SessionEventChange, sealed = false): SessionEventWindow {
  return {
    get entries() {
      if (sealed) throw new Error('the append path materialized the whole window')
      return entries
    },
    hasMore: false,
    revision,
    change,
  }
}

/** Feed entries one append at a time, as MutableSessionEventSource publishes them. */
function stream(fold: LiveConversationFold, entries: readonly SessionEventLikeEntry[], start = 0) {
  let result = fold.reset(windowOf([], start, { kind: 'replace', entries: [] }))
  entries.forEach((entry, index) => {
    result = fold.advance(windowOf(entries.slice(0, index + 1), start + index + 1, { kind: 'append', entries: [entry] }, index > 0))
  })
  return result
}

function texts(value: ReturnType<LiveConversationFold['reset']>) {
  return value?.projection.entries.map(entry => ({ kind: entry.kind, text: 'text' in entry ? entry.text : undefined, seq: entry.seq }))
}

describe('LiveConversationFold', () => {
  it('folds appended chunks onto the retained attempt and matches a whole-window refold', () => {
    const entries = [chunk('think', 1, { kind: 'reasoning-delta' }), durable(2), chunk('Hel', 3), chunk('lo', 4)]
    const incremental = stream(new LiveConversationFold(), entries)
    const refolded = new LiveConversationFold().reset(windowOf(entries, 9, { kind: 'replace', entries }))
    expect(incremental).toEqual(refolded)
    expect(incremental).toMatchObject({ attemptId: 'attempt-1', turn: 1, step: 0 })
    expect(texts(incremental)).toEqual([
      { kind: 'thinking', text: 'think', seq: 4 },
      { kind: 'assistant', text: 'Hello', seq: 4 },
    ])
  })

  it('keeps the same overlay across a durable append and an already observed revision', () => {
    const fold = new LiveConversationFold()
    const before = stream(fold, [chunk('answer', 1)])
    const entries = [chunk('answer', 1), durable(2)]
    const after = fold.advance(windowOf(entries, 2, { kind: 'append', entries: [durable(2)] }, true))
    expect(after).toBe(before)
    expect(fold.advance(windowOf(entries, 2, { kind: 'append', entries: [durable(2)] }, true))).toBe(before)
  })

  it('refolds the window for a non-append change, a skipped revision, or a new attempt', () => {
    const fold = new LiveConversationFold()
    stream(fold, [chunk('first', 1)])
    expect(fold.advance(windowOf([durable(2)], 2, { kind: 'settle-assistant', attemptId: 'attempt-1' as LlmAttemptId }))).toBeUndefined()

    const gap = [chunk('a', 3), chunk('b', 4)]
    expect(texts(fold.advance(windowOf(gap, 5, { kind: 'append', entries: [gap[1]!] })))).toEqual([{ kind: 'assistant', text: 'ab', seq: 4 }])

    const next = [...gap, chunk('fresh', 5, { attempt: 'attempt-2', turn: 2 })]
    const value = fold.advance(windowOf(next, 6, { kind: 'append', entries: [next[2]!] }))
    expect(value).toMatchObject({ attemptId: 'attempt-2', turn: 2 })
    expect(texts(value)).toEqual([{ kind: 'assistant', text: 'fresh', seq: 5 }])
  })

  it('starts from the whole window when no revision has been observed', () => {
    const fold = new LiveConversationFold()
    const entries = [chunk('a', 1), chunk('b', 2)]
    expect(texts(fold.advance(windowOf(entries, 4, { kind: 'append', entries: [entries[1]!] })))).toEqual([{ kind: 'assistant', text: 'ab', seq: 2 }])
    fold.clear()
    expect(texts(fold.advance(windowOf(entries, 5, { kind: 'append', entries: [entries[1]!] })))).toEqual([{ kind: 'assistant', text: 'ab', seq: 2 }])
  })

  it('has no overlay for a window without transient chunks', () => {
    const fold = new LiveConversationFold()
    expect(fold.reset(windowOf([durable(1)], 1, { kind: 'replace', entries: [durable(1)] }))).toBeUndefined()
    expect(fold.advance(windowOf([durable(1), durable(2)], 2, { kind: 'append', entries: [durable(2)] }, true))).toBeUndefined()
  })

  it('drops an invalid chunk identically whether it is appended or refolded', () => {
    const invalid = { ...chunk('', 2), event: { ...(chunk('', 2).event as object), data: { attemptId: 'attempt-1', turn: 1, step: 0, chunk: { index: 0 } } } } as unknown as SessionEventLikeEntry
    const entries = [chunk('kept', 1), invalid, chunk(' too', 3)]
    const incremental = stream(new LiveConversationFold(), entries)
    expect(texts(incremental)).toEqual([{ kind: 'assistant', text: 'kept too', seq: 3 }])
    expect(new LiveConversationFold().reset(windowOf(entries, 1, { kind: 'replace', entries }))).toEqual(incremental)
  })
})
