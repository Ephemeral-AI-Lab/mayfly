/**
 * Phase transitions and output measurements through projections and real renderers.
 *
 * @module @ephemeral-ai/mayfly/tests/transcript/output-progress
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { textOf, type MayflyListItem } from '@ephemeral-ai/mayfly-ui'
import type { AssistantStreamRecord, StreamChunk } from '@deepseek-ai/dsh-llm'
import { appendOutputProgress, outputProgressSchema } from '../../src/conversation/output-progress.ts'
import { foldConversationFacts, initialConversationFacts, conversationFactsSchema } from '../../src/conversation/facts.ts'
import { foldConversationProjection, initialConversationState, conversationProjectionStateSchema } from '../../src/conversation/projection.ts'
import { conversationTranscriptModel } from '../../src/transcript/official-model.ts'
import { TranscriptPresentationPolicy } from '../../src/transcript/presentation-policy.ts'
import { StreamFacts } from '../../src/transcript/stream-facts.ts'
import { TranscriptView } from '../../src/components/transcript-view.ts'
import { outputRate } from '../../src/transcript/output-rate.ts'
import * as activity from '../../src/transcript/pane-activity.ts'
import { BRAILLE_SPINNER_FRAMES, BRAILLE_SPINNER_INTERVAL_MS } from '../../src/transcript/spinners.ts'
import { bootPanePlugin } from './pane-fakes.ts'
import { fakeAgent } from './status-fakes.ts'
import { assistantEvent, event, resetSeq, turnEnd, turnStart } from './helpers.ts'
import { expectLinesFit, SCAN_WIDTHS } from '../core/width-scan.ts'

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

/** A stream item as text: its label, or its lead and the text of its body. */
const rowText = (item: MayflyListItem): string => {
  if (item.label !== '' || item.body === undefined || typeof item.body === 'string') return item.label
  const body = item.body.kind === 'text' ? textOf(item.body.content) : item.body.kind === 'markdown' ? textOf(item.body.source) : ''
  return `${item.bodyLead?.map(span => span.text).join('') ?? ''}${body}`
}

describe('phase-local output', () => {
  it('measures event-time rates without first-chunk latency, clock reversal, or stale rates', () => {
    const first = appendOutputProgress(undefined, 4, 1_000)
    expect(outputRate(undefined, 1_000)).toBe('')
    expect(outputRate(first, 1_000)).toBe('')
    const next = appendOutputProgress(first, 168, 2_000)
    expect(outputRate(next, 2_000)).toBe('≈42 tok/s')
    expect(outputRate(next, 4_001)).toBe('')
    expect(appendOutputProgress(next, 4, 500)).toMatchObject({ chars: 176, updatedAt: 2_000 })
    expect(outputProgressSchema.safeParse(next).success).toBe(true)
    expect(outputProgressSchema.safeParse({ ...next, chars: -1 }).success).toBe(false)
  })

  it('keeps the activity row the sole live status from thinking to writing, then settles and ignores late chunks', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    vi.setSystemTime(1_000)
    const agent = fakeAgent([])
    agent.status = 'running'
    const harness = await bootPanePlugin(activity, agent)
    let state = initialConversationState()
    const presentation = new TranscriptPresentationPolicy()
    presentation.apply({ transcriptView: 'verbose' })
    const facts = new StreamFacts()
    // The stream's rows as text: what the transcript shows of the live turn, with the activity row apart from it.
    const streamText = (): string => TranscriptView(facts.build(conversationTranscriptModel(
      { entries: state.entries, streaming: state.active, settledSteps: state.finalizedSteps, turns: [] }, { get: () => undefined },
    ), { policy: presentation.snapshot(), expanded: false, liveTurnHeader: false, t: key => key, queued: [] })).items.map(rowText).join('\n')
    const send = (next: SessionEvent): void => {
      state = foldConversationProjection(state, next)
      harness.ctx.emit('session/event', agent.session as never, next)
    }
    // Rebuild each observed prefix from one complete compact attempt. A
    // separate assistant/attempt never represents the next token of a retry.
    const records: AssistantStreamRecord[] = []
    const replay = (next: SessionEvent<'assistant/attempt'>): void => {
      records.push(...next.data.stream)
      const events = [event('turn/start', { turn: 1 }, 1_000), attempt([...records], next.time, 1, 1)]
      state = events.reduce(foldConversationProjection, initialConversationState())
      agent.session.events.splice(0, agent.session.events.length, ...events)
      harness.ctx.emit('test/session-changed', agent as never)
    }
    try {
      replay(reasoning('seed', 1_000))
      // The activity row owns the phase, time, and throughput; the live
      // reasoning block is a `Thinking` header and its text, with no counters.
      expect(streamText()).toContain('✻ ')
      expect(streamText()).not.toMatch(/↓|tok\/s/u)
      // Thinking keeps the activity row: the dock never collapses mid-turn.
      expect(harness.screen.paneLines()[0]).toContain('Thinking · 0s · ↓1 · seed')
      vi.setSystemTime(2_000)
      replay(reasoning('x'.repeat(168), 2_000))
      expect(streamText()).toContain('✻ ')
      expect(streamText()).not.toMatch(/↓|tok\/s/u)
      expect(harness.screen.paneLines()[0]).toContain('Thinking · 1s · ↓43 · ≈42 tok/s')
      replay(answer('', 2_010))
      replay(reasoning('\n', 2_020))
      expect(streamText()).toContain('✻ ')
      vi.setSystemTime(3_000)
      replay(answer('seed', 3_000))
      // The reasoning settles in place into its whole text under a label.
      expect(streamText()).toContain('✻ Thinking')
      expect(harness.screen.paneLines()[0]).toContain('Writing · 2s · ↓1')
      expect(harness.screen.paneLines()[0]).not.toContain('tok/s')
      vi.setSystemTime(4_000)
      replay(answer('y'.repeat(80), 4_000))
      // Streamed counters repaint on the running spinner's next frame.
      vi.advanceTimersByTime(BRAILLE_SPINNER_INTERVAL_MS)
      expect(harness.screen.paneLines()[0]).toContain('Writing · 3s · ↓21 · ≈20 tok/s')
      for (const width of SCAN_WIDTHS) expectLinesFit('Activity/TPS', harness.screen.paneLines(width), width)
      expect(harness.screen.paneLines(40)[0]).toContain('≈20 tok/s')
      expect(harness.screen.paneLines(40)[0]).not.toContain('Tip:')
      expect(harness.screen.paneLines(20)[0]).toContain('↓21')
      expect(harness.screen.paneLines(20)[0]).not.toContain('tok/s')
      expect(harness.screen.paneLines(12)[0]).toBe(`${BRAILLE_SPINNER_FRAMES[1]!} Writing`)

      vi.advanceTimersByTime(2_100)
      expect(harness.screen.paneLines()[0]).not.toContain('tok/s')

      const final = { ...assistantEvent(1, 1, [{ type: 'reasoning', text: 'corrected thought' }, { type: 'text', text: 'final answer' }]), surfaceOp: 'append' as const }
      send(final)
      expect(streamText()).toContain('corrected thought')
      expect(harness.screen.paneLines().join('\n')).not.toContain('Writing')
      send(reasoning('late', 7_000))
      expect(streamText()).not.toContain('late')
      expect(harness.screen.paneLines().join('\n')).not.toContain('tok/s')
      send(turnEnd(1))
      send(answer('late', 8_000))
      expect(harness.screen.paneLines()).toEqual([''])
    } finally {
      await harness.dispose()
    }
    expect(vi.getTimerCount()).toBe(0)
  })

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
