/**
 * The facts of the conversation stream: a transcript model mapped to turns and rows through the display plan, with the
 * policy's window, the Ctrl-O reach, row identity across passes, and the closing line of a turn that has ended.
 * @module transcript-stream-facts
 */

import { describe, expect, it } from 'vitest'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { StreamRow, StreamTurn } from '../../src/components/transcript-view.ts'
import { createTranscriptModel } from '../../src/transcript/transcript-model.ts'
import type { TranscriptEntryModel, TranscriptModel } from '../../src/frontend/models.ts'
import { DEFAULT_TRANSCRIPT_PRESENTATION, TranscriptPresentationPolicy, type TranscriptPresentationSnapshot } from '../../src/transcript/presentation-policy.ts'
import { clockTime, StreamFacts, type StreamInputs } from '../../src/transcript/stream-facts.ts'

let seq = 0
const base = (turn: number) => ({ seq: (seq += 1), updatedSeq: seq, turn })
const user = (turn: number, text: string): TranscriptEntryModel => ({ ...base(turn), id: `user:${String(seq + 1)}`, kind: 'transcript-user', text, images: [] })
const assistant = (turn: number, text: string, streaming = false): TranscriptEntryModel => ({ ...base(turn), id: `assistant:${String(seq + 1)}`, kind: 'transcript-assistant', step: 1, text, streaming })
const thinking = (turn: number, text: string, streaming = false): TranscriptEntryModel => ({ ...base(turn), id: `thinking:${String(seq + 1)}`, kind: 'transcript-thinking', step: 1, text, streaming, durationMs: 4_000 })
const tool = (turn: number, name: string, detail: string, done = true): TranscriptEntryModel => ({
  ...base(turn), id: `tool:${String(seq + 1)}`, kind: 'transcript-tool', step: 1, callId: `c${String(seq)}`, name, family: 'other', activity: 'tools', detail, arguments: '{}', startedAt: 0,
  ...(done ? { result: { text: 'ok', isError: false, endedAt: 1 } } : {}),
})
const interrupted = (turn: number): TranscriptEntryModel => ({ ...base(turn), id: `interrupted:${String(turn)}`, kind: 'transcript-interrupted' })

const NOON = Date.UTC(2026, 0, 1, 12, 5)
const t = (key: string, values?: Record<string, unknown>): string => key.replace(/\{(\w+)\}/gu, (_, name: string) => String(values?.[name] ?? ''))
const inputs = (more: Partial<StreamInputs> = {}): StreamInputs => ({ policy: DEFAULT_TRANSCRIPT_PRESENTATION, expanded: false, liveTurnHeader: false, t, queued: [], ...more })
const model = (entries: TranscriptEntryModel[], turns: TranscriptModel['turns'], streaming = false): TranscriptModel => createTranscriptModel('spec', entries, streaming, 0, turns)
const rowsOf = (turn: StreamTurn | undefined): StreamRow[] => [...(turn?.rows ?? [])]

describe('StreamFacts', () => {
  it('formats a turn start as the local HH:MM', () => {
    const local = new Date(NOON)
    expect(clockTime(NOON)).toBe(`${String(local.getHours()).padStart(2, '0')}:${String(local.getMinutes()).padStart(2, '0')}`)
  })

  it('groups the rows of each turn and closes the turns that have ended', () => {
    const facts = new StreamFacts().build(model(
      [user(1, 'hello'), assistant(1, 'hi'), user(2, 'again'), assistant(2, 'sure')],
      [{ turn: 1, startedAt: NOON, endedAt: NOON + 1_000, outcome: 'completed' }, { turn: 2, startedAt: NOON + 60_000 }],
    ), inputs())
    expect(facts.turns.map(turn => turn.id)).toEqual(['turn:1', 'turn:2'])
    expect(facts.turns[0]!.closing).toBe(`Worked for 1s · done ${clockTime(NOON + 1_000)}`)
    // A running turn has no closing line: the activity row owns its state.
    expect(facts.turns[1]!.closing).toBeUndefined()
    expect(rowsOf(facts.turns[0]).map(row => row.kind)).toEqual(['prompt', 'answer'])
  })

  it('folds a completed turn with process behind its header and opens it with the Ctrl-O reach', () => {
    const entries = [user(1, 'run it'), thinking(1, 'plan the run\nsecond line'), tool(1, 'bash', 'pnpm test'), assistant(1, 'done')]
    const turns = [{ turn: 1, startedAt: NOON, endedAt: NOON + 4_000, outcome: 'completed' }]
    const folded = new StreamFacts().build(model(entries, turns, false), inputs())
    expect(rowsOf(folded.turns[0]).map(row => row.kind)).toEqual(['prompt', 'header', 'answer'])
    expect(rowsOf(folded.turns[0])[1]).toMatchObject({ kind: 'header', mood: 'done', open: false, label: '1 tool call · Ctrl+O to expand', tail: '' })
    // Streaming models carry the lifecycle; a flat model draws the entries alone.
    const open = new StreamFacts().build(model(entries, turns, true), inputs({ expanded: true }))
    expect(rowsOf(open.turns[0]).map(row => row.kind)).toEqual(['prompt', 'header', 'reasoning', 'step', 'answer'])
    expect(rowsOf(open.turns[0])[0]).toMatchObject({ kind: 'prompt', open: true })
  })

  it('labels a stopped turn, its cut marker, and a failed call', () => {
    const entries = [user(1, 'go'), tool(1, 'bash', 'sleep 9', false), interrupted(1)]
    const facts = new StreamFacts().build(model(entries, [{ turn: 1, startedAt: NOON, endedAt: NOON + 1_000, outcome: 'interrupted' }], true), inputs())
    const rows = rowsOf(facts.turns[0])
    expect(rows.map(row => row.kind)).toEqual(['prompt', 'header', 'title', 'interrupted'].filter(kind => rows.some(row => row.kind === kind)))
    expect(rows.find(row => row.kind === 'header')).toMatchObject({ mood: 'stopped', label: 'Stopped' })
    expect(rows.find(row => row.kind === 'interrupted')).toMatchObject({ text: '■ interrupted' })
  })

  it('shows the tail of a streaming reasoning once the mode shows the live process, and nothing of a blank one', () => {
    const verbose = new TranscriptPresentationPolicy()
    verbose.apply({ transcriptView: 'verbose' })
    const entries = [user(1, 'q'), thinking(1, 'first\nsecond thought\n', true), thinking(1, '   ')]
    const live = new StreamFacts().build(model(entries, [{ turn: 1, startedAt: NOON }], true), inputs({ policy: verbose.snapshot() }))
    expect(rowsOf(live.turns[0]).filter(row => row.kind === 'reasoning')).toEqual([expect.objectContaining({ label: 'second thought' })])
    // Standard keeps a running turn's process out of the stream: the activity row says what it is doing.
    const standard = new StreamFacts().build(model(entries, [{ turn: 1, startedAt: NOON }], true), inputs())
    expect(rowsOf(standard.turns[0]).some(row => row.kind === 'reasoning')).toBe(false)
  })

  it('keeps the window of recent turns the policy names', () => {
    const policy = new TranscriptPresentationPolicy()
    policy.apply({ windowTurns: 2 })
    const entries = [1, 2, 3, 4].flatMap(turn => [user(turn, `q${String(turn)}`), assistant(turn, `a${String(turn)}`)])
    const facts = new StreamFacts().build(model(entries, [1, 2, 3, 4].map(turn => ({ turn, startedAt: NOON + turn, endedAt: NOON + turn + 1, outcome: 'completed' }))), inputs({ policy: policy.snapshot() satisfies TranscriptPresentationSnapshot }))
    expect(facts.turns.map(turn => turn.id)).toEqual(['turn:3', 'turn:4'])
  })

  it('keeps rows and turns by identity across passes while their content is equal', () => {
    const entries = [user(1, 'one'), assistant(1, 'first'), user(2, 'two'), assistant(2, 'partial', true)]
    const turns = [{ turn: 1, startedAt: NOON, endedAt: NOON + 1, outcome: 'completed' }, { turn: 2, startedAt: NOON + 9 }]
    const kept = new StreamFacts()
    const first = kept.build(model(entries, turns, true), inputs())
    const next = kept.build(model([...entries.slice(0, 3), assistant(2, 'partial and more', true)], turns, true), inputs())
    expect(next.turns[0]).toBe(first.turns[0])
    expect(next.turns[1]).not.toBe(first.turns[1])
    expect(next.turns[1]!.rows[0]).toBe(first.turns[1]!.rows[0])
    // A reset forgets them: the same facts come back as new objects.
    kept.reset()
    expect(kept.build(model(entries, turns, true), inputs()).turns[0]).not.toBe(first.turns[0])
  })

  it('maps the queued messages to rows of their own and keeps them by identity', () => {
    const kept = new StreamFacts()
    const queued = [{ id: 'q1', text: 'then the \x1b[31mchangelog\x1b[0m' }]
    const first = kept.build(model([user(1, 'go')], [{ turn: 1, startedAt: NOON }], true), inputs({ queued }))
    expect(first.queued).toEqual([{ id: 'q1', text: 'then the changelog', suffix: '⏎ queued' }])
    expect(kept.build(model([user(1, 'go')], [{ turn: 1, startedAt: NOON }], true), inputs({ queued })).queued[0]).toBe(first.queued[0])
  })

  it('draws the text of a hand-built canonical node and keeps a running header only where asked', () => {
    const node: MayflyUiNode = { kind: 'text', content: 'a notice' }
    const withNode = new StreamFacts().build(createTranscriptModel('spec', [node, user(1, 'q')], false), inputs())
    expect(rowsOf(withNode.turns[0])[0]).toMatchObject({ kind: 'note', text: 'a notice' })
    const entries = [user(1, 'q'), tool(1, 'bash', 'x', false)]
    const running = (liveTurnHeader: boolean): StreamRow[] => rowsOf(new StreamFacts().build(model(entries, [{ turn: 1, startedAt: NOON }], true), inputs({ liveTurnHeader })).turns[0])
    expect(running(false).some(row => row.kind === 'header')).toBe(false)
    expect(running(true).find(row => row.kind === 'header')).toMatchObject({ mood: 'running', label: 'Deep diving...' })
  })
})
