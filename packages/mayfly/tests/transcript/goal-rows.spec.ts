/**
 * Decision tests of the goal rows of the stream: the projection folding a durable `goal/change` event into one row whoever
 * made it, and a goal-sourced `user/message` into a round marker (`── goal round N ──`) instead of a message the person
 * wrote; the transcript model, the row's text, and the stream row each operation draws (mark, tone, words); and the painted
 * items (a wrapped line, and a rule across the stream between the margins).
 * @module transcript-goal-rows
 */

import { describe, expect, it } from 'vitest'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TranscriptView, type StreamRow } from '../../src/components/transcript-view.ts'
import { foldConversationProjection, initialConversationState } from '../../src/conversation/projection.ts'
import type { ConversationGoalChangeEntry, ConversationGoalRoundEntry, ConversationProjection, ConversationProjectionState } from '../../src/conversation/types.ts'
import type { TranscriptEntryModel } from '../../src/frontend/models.ts'
import { conversationTranscriptModel } from '../../src/transcript/official-model.ts'
import { NO_DISCLOSURE } from '../../src/transcript/disclosure.ts'
import { DEFAULT_TRANSCRIPT_PRESENTATION } from '../../src/transcript/presentation-policy.ts'
import { StreamFacts, type StreamInputs } from '../../src/transcript/stream-facts.ts'
import { createTranscriptModel } from '../../src/transcript/transcript-model.ts'
import { transcriptTranslatorFake as t } from './notices-fakes.ts'

let seq = 0
/** A session event the way the log writes it: a message with an append surface, or a plain fact. */
function event<T extends SessionEvent['type']>(type: T, data: SessionEvent<T>['data'], options: { readonly append?: boolean } = {}): SessionEvent<T> {
  seq += 1
  return { type, seq, time: 1_700_000_000_000 + seq, data, ...options.append === true ? { surfaceOp: 'append' } : {} } as unknown as SessionEvent<T>
}

const goalMessage = (round: number, text = 'continue the goal') => ({
  id: MessageId(`goal-${String(seq)}`), role: 'user' as const, content: [{ type: 'text' as const, text }], source: { kind: 'goal' as const, round },
})

const view = (extra: Record<string, unknown> = {}) => ({ id: 'g1', revision: 1, objective: 'ship the footer', phase: 'active', maxGoalRounds: 8, ...extra })
const change = (operation: string, goal: Record<string, unknown> = view(), extra: Record<string, unknown> = {}) =>
  event('goal/change', { operation, goal, roundsStarted: 2, createdAt: 1_000, updatedAt: 61_000, ...extra } as never)

function fold(events: readonly SessionEvent[], from: ConversationProjectionState = initialConversationState()): ConversationProjectionState {
  return events.reduce((state, next) => foldConversationProjection(state, next), from)
}
const entriesOf = (state: ConversationProjectionState) => state.entries.filter(entry => entry.kind === 'goal-change' || entry.kind === 'goal-round') as (ConversationGoalChangeEntry | ConversationGoalRoundEntry)[]

describe('the goal entries of the projection', () => {
  it('folds each goal/change into one row with the post-change snapshot, whoever made it', () => {
    const state = fold([
      change('create'),
      change('pause', view({ phase: 'paused' })),
      change('block', view({ phase: 'blocked', blockedReason: { code: 'tests-red', message: 'the suite fails', extra: 'ignored' } })),
      change('complete', view({ phase: 'complete' })),
    ])
    const rows = entriesOf(state) as ConversationGoalChangeEntry[]
    expect(rows.map(row => row.operation)).toEqual(['create', 'pause', 'block', 'complete'])
    expect(rows[0]).toMatchObject({ kind: 'goal-change', objective: 'ship the footer', roundsStarted: 2, createdAt: 1_000, updatedAt: 61_000 })
    expect(rows[0]).not.toHaveProperty('blockedReason')
    // Only the code and the message of a block reason are kept.
    expect(rows[2]!.blockedReason).toEqual({ code: 'tests-red', message: 'the suite fails' })
    expect(new Set(rows.map(row => row.id)).size).toBe(4)
  })

  it('folds a clear as the operation alone, with no snapshot', () => {
    const [row] = entriesOf(fold([event('goal/change', { operation: 'clear' } as never)])) as ConversationGoalChangeEntry[]
    expect(row).toMatchObject({ kind: 'goal-change', operation: 'clear' })
    expect(row).not.toHaveProperty('objective')
    expect(row).not.toHaveProperty('roundsStarted')
  })

  it('shows a goal-sourced user message as a round marker, not as a message the person wrote', () => {
    const state = fold([event('user/message', goalMessage(3) as never, { append: true })])
    expect(state.entries.some(entry => entry.kind === 'user')).toBe(false)
    expect(entriesOf(state)).toEqual([expect.objectContaining({ kind: 'goal-round', round: 3 })])
    // A marker for a round below one, or one the log does not append to the surface, is not drawn.
    expect(entriesOf(fold([event('user/message', goalMessage(0) as never, { append: true })]))).toEqual([])
    expect(entriesOf(fold([event('user/message', goalMessage(2) as never)]))).toEqual([])
  })

  it('ignores a goal change or a goal round inside a retracted turn', () => {
    const retracted = { ...initialConversationState(), currentTurn: 4, retractedTurns: [4] }
    expect(entriesOf(fold([change('create'), event('user/message', goalMessage(1) as never, { append: true })], retracted))).toEqual([])
  })
})

describe('the goal rows of the stream', () => {
  const NOW = 1_700_000_100_000
  const model = (entries: readonly TranscriptEntryModel[]) => createTranscriptModel('spec', [...entries], false, 0, [{ turn: 1, startedAt: NOW }])
  const inputs = (): StreamInputs => ({ policy: DEFAULT_TRANSCRIPT_PRESENTATION, disclosure: NO_DISCLOSURE, liveTurnHeader: false, t, queued: [], now: NOW })
  const rowsOf = (entries: readonly TranscriptEntryModel[]): StreamRow[] => new StreamFacts().build(model(entries), inputs()).turns.flatMap(turn => [...turn.rows])
  const goal = (operation: string, extra: Partial<Extract<TranscriptEntryModel, { kind: 'transcript-goal-change' }>> = {}): TranscriptEntryModel => {
    seq += 1
    return { kind: 'transcript-goal-change', id: `goal:${String(seq)}`, seq, updatedSeq: seq, turn: 1, operation, ...extra } as TranscriptEntryModel
  }

  it('says each operation by its mark, its tone, and its words', () => {
    const words = (entry: TranscriptEntryModel) => (rowsOf([entry])[0] as Extract<StreamRow, { kind: 'goal-change' }>)
    expect(words(goal('create', { objective: 'ship the footer' }))).toMatchObject({ mark: '●', tone: 'accent', text: 'Goal set · ship the footer' })
    expect(words(goal('edit', { objective: 'ship the footer and the views' }))).toMatchObject({ mark: '●', tone: 'accent', text: 'Goal edited · ship the footer and the views' })
    expect(words(goal('pause'))).toMatchObject({ mark: '⏸', tone: 'muted', text: 'Goal paused' })
    expect(words(goal('resume'))).toMatchObject({ mark: '●', tone: 'accent', text: 'Goal resumed' })
    expect(words(goal('clear'))).toMatchObject({ mark: '', tone: 'muted', text: 'Goal cleared' })
    expect(words(goal('block', { blockedReason: { code: 'tests-red', message: 'the suite fails' } }))).toMatchObject({ mark: '✕', tone: 'danger', text: 'Goal blocked · tests-red: the suite fails' })
    expect(words(goal('block'))).toMatchObject({ text: 'Goal blocked' })
  })

  it('closes a completed goal with its rounds and how long it took, and cuts a long objective', () => {
    const done = (extra: Partial<Extract<TranscriptEntryModel, { kind: 'transcript-goal-change' }>>) => rowsOf([goal('complete', extra)])[0] as Extract<StreamRow, { kind: 'goal-change' }>
    expect(done({ rounds: 3, elapsedMs: 119_000 })).toMatchObject({ mark: '✓', tone: 'success', text: 'Goal complete · 3 rounds · 1m 59s' })
    expect(done({ rounds: 1 }).text).toBe('Goal complete · 1 round')
    expect(done({}).text).toBe('Goal complete · 0 rounds')
    const long = rowsOf([goal('create', { objective: 'x'.repeat(300) })])[0] as Extract<StreamRow, { kind: 'goal-change' }>
    expect(long.text.endsWith('…')).toBe(true)
    expect(long.text.length).toBeLessThan(150)
  })

  it('names a round marker by its number', () => {
    seq += 1
    const marker = { kind: 'transcript-goal-round', id: `goal-round:${String(seq)}`, seq, updatedSeq: seq, turn: 1, round: 4 } as TranscriptEntryModel
    expect(rowsOf([marker])[0]).toEqual({ kind: 'goal-round', id: marker.id, text: 'goal round 4' })
  })

  it('paints a change as a wrapped line led by its mark, and a round as a rule across the stream', () => {
    const painted = (rows: readonly StreamRow[]) => TranscriptView({ turns: [{ id: 'turn:1', number: 1, rows }], queued: [] }).items.filter(item => item.id === rows[0]!.id)
    const [changed] = painted([{ kind: 'goal-change', id: 'g1', mark: '●', tone: 'accent', text: 'Goal set · ship it' }])
    expect(changed).toMatchObject({ id: 'g1', wrap: true, hang: 2, labelSpans: [{ text: '● ', tone: 'accent' }, { text: 'Goal set · ship it', tone: 'default' }] })
    // A pause is muted all through; a clear has no mark and keeps the column.
    expect(painted([{ kind: 'goal-change', id: 'g2', mark: '⏸', tone: 'muted', text: 'Goal paused' }])[0]!.labelSpans).toEqual([{ text: '⏸ ', tone: 'muted' }, { text: 'Goal paused', tone: 'muted' }])
    expect(painted([{ kind: 'goal-change', id: 'g3', mark: '', tone: 'muted', text: 'Goal cleared' }])[0]!.labelSpans![0]).toEqual({ text: '  ', tone: 'muted' })
    const [round] = painted([{ kind: 'goal-round', id: 'r1', text: 'goal round 2' }])
    expect(round).toMatchObject({ id: 'r1', disabled: true, bodyAlways: true, body: { kind: 'divider', label: 'goal round 2', align: 'center', tone: 'muted' } })
    expect((round!.body as { readonly inset: number }).inset).toBeGreaterThan(0)
  })
})

describe('the goal entries as the transcript model and its text', () => {
  const projection = (entries: ConversationProjection['entries']): ConversationProjection => ({ entries, streaming: false, settledSteps: [], turns: [] })
  const tools = { get: () => undefined } as never

  it('converts a change with its rounds and the time it had been open, and a round with its number', () => {
    const entries = conversationTranscriptModel(projection([
      { kind: 'goal-change', id: 'goal:1', seq: 1, updatedSeq: 1, turn: 1, operation: 'block', objective: 'ship it', blockedReason: { code: 'cap', message: 'round cap' }, roundsStarted: 8, createdAt: 1_000, updatedAt: 61_000 },
      { kind: 'goal-change', id: 'goal:2', seq: 2, updatedSeq: 2, turn: 1, operation: 'clear' },
      { kind: 'goal-round', id: 'goal-round:3', seq: 3, updatedSeq: 3, turn: 1, round: 2 },
    ]), tools).entries
    expect(entries[0]).toMatchObject({ kind: 'transcript-goal-change', operation: 'block', objective: 'ship it', blockedReason: { code: 'cap', message: 'round cap' }, rounds: 8, elapsedMs: 60_000 })
    expect(entries[1]).toMatchObject({ kind: 'transcript-goal-change', operation: 'clear' })
    expect(entries[1]).not.toHaveProperty('objective')
    expect(entries[1]).not.toHaveProperty('elapsedMs')
    expect(entries[2]).toMatchObject({ kind: 'transcript-goal-round', round: 2 })
  })
})
