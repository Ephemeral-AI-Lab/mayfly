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
import { DEFAULT_TRANSCRIPT_PRESENTATION, PROCESS_POLICIES, TranscriptPresentationPolicy, type TranscriptPresentationSnapshot } from '../../src/transcript/presentation-policy.ts'
import { clockTime, StreamFacts, type StreamInputs } from '../../src/transcript/stream-facts.ts'
import { NO_DISCLOSURE } from '../../src/transcript/disclosure.ts'

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
const inputs = (more: Partial<StreamInputs> = {}): StreamInputs => ({ policy: DEFAULT_TRANSCRIPT_PRESENTATION, disclosure: NO_DISCLOSURE, liveTurnHeader: false, t, queued: [], now: NOON, ...more })
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

  it('collects a completed turn\'s process into one title line at Compact, and opens it with the Ctrl-O reach', () => {
    const entries = [user(1, 'run it'), thinking(1, 'plan the run\nsecond line'), tool(1, 'bash', 'pnpm test'), assistant(1, 'done')]
    const turns = [{ turn: 1, startedAt: NOON, endedAt: NOON + 4_000, outcome: 'completed' }]
    const compact = { ...DEFAULT_TRANSCRIPT_PRESENTATION, mode: 'compact', process: PROCESS_POLICIES.compact } as const
    // Compact: the calls of the turn are one title line where the first call was; no header folds them away.
    const collected = new StreamFacts().build(model(entries, turns, false), inputs({ policy: compact }))
    expect(rowsOf(collected.turns[0]).map(row => row.kind)).toEqual(['prompt', 'title', 'answer'])
    expect(rowsOf(collected.turns[0])[1]).toEqual({ kind: 'title', id: expect.any(String), text: '1 tool call', hint: 'Ctrl+O to expand' })
    // Ctrl-O opens the turn: its blocks draw verbose under an open header, the reasoning included.
    const open = new StreamFacts().build(model(entries, turns, true), inputs({ disclosure: { ...NO_DISCLOSURE, recent: true }, policy: compact }))
    expect(rowsOf(open.turns[0]).map(row => row.kind)).toEqual(['prompt', 'header', 'reasoning', 'tool', 'answer'])
    expect(rowsOf(open.turns[0])[0]).toMatchObject({ kind: 'prompt', open: true })
    // Standard keeps the same turn open: its blocks draw inline, with no fold to open.
    const standard = new StreamFacts().build(model(entries, turns, false), inputs())
    expect(rowsOf(standard.turns[0]).map(row => row.kind)).toEqual(['prompt', 'header', 'reasoning', 'tool', 'answer'])
  })

  it('labels a stopped turn, its cut marker, and a failed call', () => {
    const entries = [user(1, 'go'), tool(1, 'bash', 'sleep 9', false), interrupted(1)]
    const facts = new StreamFacts().build(model(entries, [{ turn: 1, startedAt: NOON, endedAt: NOON + 1_000, outcome: 'interrupted' }], true), inputs())
    const rows = rowsOf(facts.turns[0])
    expect(rows.map(row => row.kind)).toEqual(['prompt', 'header', 'tool', 'interrupted'])
    expect(rows.find(row => row.kind === 'header')).toMatchObject({ mood: 'stopped', label: 'Stopped' })
    expect(rows.find(row => row.kind === 'interrupted')).toMatchObject({ text: '■ interrupted' })
  })

  it('streams a reasoning block as its last lines, capped by tier: eight at Verbose, three at Standard, forty once opened', () => {
    const ten = Array.from({ length: 10 }, (_, index) => `thought ${String(index + 1)}`).join('\n')
    const entries = [user(1, 'q'), thinking(1, `${ten}\n`, true), thinking(1, '   ')]
    const live = (mode: 'verbose' | 'detailed' | 'standard', disclosure = NO_DISCLOSURE) => {
      const policy = new TranscriptPresentationPolicy()
      policy.apply({ transcriptView: mode })
      return new StreamFacts().build(model(entries, [{ turn: 1, startedAt: NOON }], true), inputs({ policy: policy.snapshot(), disclosure }))
    }
    const reasoning = (facts: ReturnType<typeof live>) => rowsOf(facts.turns[0]).filter(row => row.kind === 'reasoning')
    // Blank reasoning draws nothing; a live block is the reasoning's end, with the earlier lines above it.
    expect(reasoning(live('verbose'))).toEqual([{ kind: 'reasoning', id: expect.any(String), label: 'Thinking', pending: true, rows: expect.arrayContaining(['thought 3', 'thought 10']), earlier: '… +2 earlier · Ctrl+O' }])
    expect(reasoning(live('verbose'))[0]).toMatchObject({ rows: Array.from({ length: 8 }, (_, index) => `thought ${String(index + 3)}`) })
    expect(reasoning(live('standard'))[0]).toMatchObject({ rows: ['thought 8', 'thought 9', 'thought 10'], earlier: '… +7 earlier · Ctrl+O' })
    // Detailed draws the latest step verbose: a single step is the latest one.
    expect(reasoning(live('detailed'))[0]).toMatchObject({ rows: expect.any(Array), earlier: '… +2 earlier · Ctrl+O' })
    // Opened, the block shows every line it carries.
    expect(reasoning(live('standard', { ...NO_DISCLOSURE, recent: true }))[0]).toMatchObject({ rows: Array.from({ length: 10 }, (_, index) => `thought ${String(index + 1)}`) })
    expect(reasoning(live('standard', { ...NO_DISCLOSURE, recent: true }))[0]).not.toHaveProperty('earlier')
  })

  it('shows a settled reasoning under its label with its duration, its lines capped by tier', () => {
    const entries = [user(1, 'q'), thinking(1, 'first line\nsecond line')]
    const verbose = new TranscriptPresentationPolicy()
    verbose.apply({ transcriptView: 'verbose' })
    const whole = new StreamFacts().build(model(entries, [], false), inputs({ policy: verbose.snapshot() }))
    expect(rowsOf(whole.turns[0]).find(row => row.kind === 'reasoning')).toMatchObject({ kind: 'reasoning', label: 'Thinking · 4s', rows: ['first line', 'second line'] })
    expect(rowsOf(whole.turns[0]).find(row => row.kind === 'reasoning')).not.toHaveProperty('pending')
    // A flat model draws its entries alone, with no tier: the reasoning's full block (up to the Verbose cap).
    const flat = new StreamFacts().build(createTranscriptModel('spec', entries), inputs())
    expect(rowsOf(flat.turns[0]).find(row => row.kind === 'reasoning')).toMatchObject({ kind: 'reasoning', label: 'Thinking · 4s', rows: ['first line', 'second line'] })
  })

  it('keeps each prompt image as an attachment id with its fallback text, and remembers the reference for the loader', () => {
    const image = { attachmentId: 'att-1', mediaType: 'image/png' as const, bytes: 2048, width: 4, height: 3, name: 'shot.png' }
    const entry = { ...user(1, 'look'), images: [image] }
    const imageRefs = new Map<string, { readonly attachmentId: string, readonly mediaType: string }>()
    const facts = new StreamFacts().build(model([entry], [{ turn: 1, startedAt: NOON }], true), inputs({ imageRefs }))
    expect(rowsOf(facts.turns[0])[0]).toMatchObject({ kind: 'prompt', images: [{ attachmentId: 'att-1', alt: '[image] 1 · shot.png · 4×3 · 2 KB' }] })
    expect(imageRefs.get('att-1')).toEqual({ attachmentId: 'att-1', mediaType: 'image/png' })
  })

  it('shows a message that sits twice in the inbox once', () => {
    const facts = new StreamFacts().build(model([user(1, 'q')], [{ turn: 1, startedAt: NOON }], true), inputs({ queued: [{ id: 'm1', text: 'later' }, { id: 'm1', text: 'later' }, { id: 'm2', text: 'then' }] }))
    expect(facts.queued.map(message => message.id)).toEqual(['m1', 'm2'])
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

  describe('a spawn call that follows its child', () => {
    const spawn = (): TranscriptEntryModel => ({
      ...base(1), id: `tool:${String(seq + 1)}`, kind: 'transcript-tool', step: 1, callId: 'spawn-1', name: 'subagent', family: 'other', activity: 'subagents', detail: 'Audit', arguments: JSON.stringify({ prompt: 'audit it' }),
      startedAt: NOON - 3_000, result: { text: 'started subagent child-1', isError: false, endedAt: NOON - 2_900 },
    })
    const turns = [{ turn: 1, startedAt: NOON - 4_000 }]
    const lineOf = (more: Partial<StreamInputs>): string => JSON.stringify(new StreamFacts().build(model([user(1, 'go'), spawn()], turns), inputs(more)).turns[0]!.rows)

    it('reads running in background while its child works, and settled with its child\'s end once it ends', () => {
      const running = { byId: new Map([['child-1', { state: 'running' as const }]]), byPrompt: new Map() }
      expect(lineOf({ children: running })).toContain('running in background')
      const settled = { byId: new Map([['child-1', { state: 'settled' as const, failed: true, endedAt: NOON - 500 }]]), byPrompt: new Map() }
      expect(lineOf({ children: settled })).toContain('failed')
      expect(lineOf({})).not.toContain('running in background')
    })

    it('keeps following its child while a request waits on another call, and when the first request names no call', () => {
      const running = { byId: new Map([['child-1', { state: 'running' as const }]]), byPrompt: new Map() }
      expect(lineOf({ children: running, requests: [{ type: 'approval', callId: 'other-call', reason: 'removes files' } as never] })).toContain('running in background')
      expect(lineOf({ children: running, requests: [{ type: 'approval', toolName: 'bash', reason: 'asks first' } as never] })).toContain('running in background')
      // A request with no reason asks the same, and a child-less stream is unchanged.
      expect(lineOf({ requests: [{ type: 'plan', callId: 'other-call' } as never] })).not.toContain('running in background')
    })
  })
})
