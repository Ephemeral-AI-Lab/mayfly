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
import { clockTime, StreamFacts, userMessageText, type StreamInputs } from '../../src/transcript/stream-facts.ts'
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
    const facts = new StreamFacts().build(model([user(1, 'q')], [{ turn: 1, startedAt: NOON }], true), inputs({ queued: [{ id: 'm1', text: 'later', lane: 'turn' }, { id: 'm1', text: 'later', lane: 'turn' }, { id: 'm2', text: 'then', lane: 'turn' }] }))
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
    const queued = [{ id: 'q1', text: 'then the \x1b[31mchangelog\x1b[0m', lane: 'turn' as const }]
    const first = kept.build(model([user(1, 'go')], [{ turn: 1, startedAt: NOON }], true), inputs({ queued }))
    expect(first.queued).toEqual([{ id: 'q1', text: 'then the changelog', suffix: '⏎ queued', lane: 'turn', open: false }])
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
      startedAt: NOON - 3_000, result: { text: JSON.stringify({ kind: 'activation', subagentId: 'child-1' }), isError: false, endedAt: NOON - 2_900 },
    })
    const turns = [{ turn: 1, startedAt: NOON - 4_000 }]
    const lineOf = (more: Partial<StreamInputs>): string => JSON.stringify(new StreamFacts().build(model([user(1, 'go'), spawn()], turns), inputs(more)).turns[0]!.rows)

    it('reads running while its child works, and settled with its child\'s end once it ends', () => {
      const running = { byId: new Map([['child-1', { state: 'running' as const }]]), byPrompt: new Map() }
      expect(lineOf({ children: running })).toContain('running')
      const settled = { byId: new Map([['child-1', { state: 'settled' as const, failed: true, endedAt: NOON - 500 }]]), byPrompt: new Map() }
      expect(lineOf({ children: settled })).toContain('failed')
      expect(lineOf({})).not.toContain('running')
    })

    it('keeps following its child while a request waits on another call, and when the first request names no call', () => {
      const running = { byId: new Map([['child-1', { state: 'running' as const }]]), byPrompt: new Map() }
      expect(lineOf({ children: running, requests: [{ type: 'approval', callId: 'other-call', reason: 'removes files' } as never] })).toContain('running')
      expect(lineOf({ children: running, requests: [{ type: 'approval', toolName: 'bash', reason: 'asks first' } as never] })).toContain('running')
      // A request with no reason asks the same, and a child-less stream is unchanged.
      expect(lineOf({ requests: [{ type: 'plan', callId: 'other-call' } as never] })).not.toContain('running')
    })
  })
})

describe('StreamFacts: how a turn reads when it failed', () => {
  const failed = (turn: number, name: string): TranscriptEntryModel => ({ ...tool(turn, name, 'boom'), result: { text: 'boom', isError: true, endedAt: 2 } } as TranscriptEntryModel)

  it('closes a turn that ended in error with its duration, and counts the failed calls in its title', () => {
    const entries = [user(1, 'run both'), tool(1, 'bash', 'pnpm test'), failed(1, 'bash'), assistant(1, 'stopped')]
    const turns = [{ turn: 1, startedAt: NOON, endedAt: NOON + 4_000, outcome: 'error' }]
    const compact = { ...DEFAULT_TRANSCRIPT_PRESENTATION, mode: 'compact', process: PROCESS_POLICIES.compact } as const
    const facts = new StreamFacts().build(model(entries, turns, false), inputs({ policy: compact }))
    expect(facts.turns[0]!.closing).toBe(`Failed after 4s · done ${clockTime(NOON + 4_000)}`)
    expect(rowsOf(facts.turns[0])[1]).toMatchObject({ kind: 'title', text: '2 tool calls' })
  })

  it('reads a turn that is still running without a closing line, and with the header tail at Verbose', () => {
    const entries = [user(1, 'working'), tool(1, 'bash', 'pnpm test', false)]
    const verbose = { ...DEFAULT_TRANSCRIPT_PRESENTATION, mode: 'verbose', process: PROCESS_POLICIES.verbose } as const
    const facts = new StreamFacts().build(model(entries, [{ turn: 1, startedAt: NOON }], true), inputs({ policy: verbose, liveTurnHeader: true }))
    expect(facts.turns[0]!.closing).toBeUndefined()
    expect(rowsOf(facts.turns[0]).length).toBeGreaterThan(1)
  })
})

describe('StreamFacts: the remaining decisions', () => {
  const failedCall = (turn: number, callId: string): TranscriptEntryModel => ({ ...tool(turn, 'bash', 'exit 1'), callId, result: { text: 'boom', isError: true, endedAt: 2 } } as TranscriptEntryModel)
  const okCall = (turn: number, callId: string): TranscriptEntryModel => ({ ...tool(turn, 'bash', 'ls'), callId } as TranscriptEntryModel)
  const compaction = (overrides: Partial<Extract<TranscriptEntryModel, { kind: 'transcript-compaction' }>>): TranscriptEntryModel => ({
    ...base(1), id: 'cmp:1', kind: 'transcript-compaction', state: 'ok', trigger: 'auto', startedAt: NOON, ...overrides,
  } as TranscriptEntryModel)
  const one = (facts: ReturnType<StreamFacts['build']>) => rowsOf(facts.turns[0])

  it('reads the text of a user message: its text, and a count of its images', () => {
    const text = { type: 'text', text: 'look' } as const
    const image = { type: 'image', mediaType: 'image/png', data: '' } as never
    expect(userMessageText({ role: 'user', content: [text, { type: 'text', text: 'at\nthis' }] } as never)).toBe('look at this')
    expect(userMessageText({ role: 'user', content: [text, image] } as never)).toBe('look [1 image]')
    expect(userMessageText({ role: 'user', content: [text, image, image] } as never)).toBe('look [2 images]')
    expect(userMessageText({ role: 'user', content: [image] } as never)).toBe('[1 image]')
  })

  it('draws no turns and no queued messages for a view with no model attached', () => {
    const facts = new StreamFacts().build(null, inputs({ queued: [{ id: 'q1', text: 'later', lane: 'turn' }] }))
    expect(facts.turns).toEqual([])
    expect(facts.queued.map(message => message.id)).toEqual(['q1'])
  })

  it('draws a canonical node between two turns in the turn it follows, as a note of its own text', () => {
    const between = createTranscriptModel('spec', [user(1, 'q'), { kind: 'text', content: 'between' } as MayflyUiNode, assistant(1, 'a')], false, 0, [{ turn: 1, startedAt: NOON, endedAt: NOON + 1, outcome: 'completed' }])
    expect(rowsOf(new StreamFacts().build(between, inputs()).turns[0]).map(row => row.kind)).toEqual(['prompt', 'note', 'answer'])
    const code = createTranscriptModel('spec', [user(1, 'q'), { kind: 'code', code: 'npm test' } as unknown as MayflyUiNode], false, 0, [{ turn: 1, startedAt: NOON }])
    expect(rowsOf(new StreamFacts().build(code, inputs()).turns[0])[1]).toMatchObject({ kind: 'note', text: 'npm test' })
    const other = createTranscriptModel('spec', [user(1, 'q'), { kind: 'image', alt: 'x' } as unknown as MayflyUiNode], false, 0, [{ turn: 1, startedAt: NOON }])
    expect(rowsOf(new StreamFacts().build(other, inputs()).turns[0])[1]).toMatchObject({ kind: 'note', text: '[image]' })
  })

  it('draws a request that names no call as a block of its own at the end of the stream', () => {
    const requests = [{ type: 'approval' as const, toolName: 'web_fetch', reason: 'fetch the spec' }, { type: 'approval' as const, toolName: 'web_fetch' }]
    const facts = new StreamFacts().build(model([user(1, 'q')], [{ turn: 1, startedAt: NOON }], true), inputs({ requests }))
    expect(one(facts).at(-1)).toEqual({ kind: 'tool', id: 'request:approval:web_fetch', state: 'waiting', name: 'web_fetch', outcome: '1 of 2 waiting', body: [{ text: 'fetch the spec', tone: 'muted' }] })
    const plan = new StreamFacts().build(model([user(1, 'q')], [{ turn: 1, startedAt: NOON }], true), inputs({ requests: [{ type: 'plan', toolName: 'exit_plan_mode', reason: '' }] }))
    expect(one(plan).at(-1)).toEqual({ kind: 'tool', id: 'request:plan:exit_plan_mode', state: 'waiting', name: 'exit_plan_mode', outcome: 'waiting' })
  })

  it('reads the text of a queued message and of a call inside a group, in both forms', () => {
    const stream = new StreamFacts()
    stream.build(model([user(1, 'go')], [{ turn: 1, startedAt: NOON }], true), inputs({ queued: [{ id: 'q1', text: 'then', lane: 'turn' }] }))
    expect(stream.textOf('queued.q1', 'text')).toBe('then')
    expect(stream.textOf('queued.q1', 'raw')).toBe('then')
    expect(stream.textOf('queued.q9', 'text')).toBeUndefined()
    const search = { id: 'search:1', kind: 'transcript-search-group', seq: 1, updatedSeq: 1, turn: 1, step: 0, searches: [{ callId: 's1', activity: 'search', detail: 'needle', seq: 1, updatedSeq: 1, turn: 1, step: 0, name: 'grep', startedAt: 0, pattern: 'needle', shape: 'lines', state: 'ok', matches: [] }] } as unknown as TranscriptEntryModel
    const commands = { id: 'command:1', kind: 'transcript-command-group', seq: 2, updatedSeq: 2, turn: 1, step: 0, commands: [{ callId: 'g1', activity: 'commands', detail: 'ls', seq: 2, updatedSeq: 2, turn: 1, step: 0, name: 'bash', startedAt: 0, command: 'ls', state: 'ok' }] } as unknown as TranscriptEntryModel
    const grouped = new StreamFacts()
    grouped.build(model([user(1, 'go'), search, commands], [{ turn: 1, startedAt: NOON, endedAt: NOON + 1, outcome: 'completed' }]), inputs({ disclosure: { ...NO_DISCLOSURE, groups: new Set(['search:1:s1', 'command:1:g1']) } }))
    const searchRow = grouped.rowOf('search:1:s1')
    const commandRow = grouped.rowOf('command:1:g1')
    expect(searchRow).toBeDefined()
    expect(grouped.textOf(searchRow!, 'text')).toContain('needle')
    expect(grouped.textOf(commandRow!, 'raw')).toContain('ls')
  })

  it('answers a call that waits on the user with its own block, and says what the user decided on the others', () => {
    const waiting = { ...tool(1, 'bash', 'sleep 9', false), callId: 'wait-1' } as TranscriptEntryModel
    const requests = [{ type: 'approval' as const, callId: 'wait-1', toolName: 'bash', reason: 'delete the cache' }]
    const asked = new StreamFacts().build(model([user(1, 'q'), waiting], [{ turn: 1, startedAt: NOON }], true), inputs({ requests }))
    expect(one(asked).find(row => row.kind === 'tool' && row.state === 'waiting')).toBeDefined()
    const approvals = [{ id: 'a1', callId: 'c-ok', outcome: 'allowed-once' as const }, { id: 'a2', callId: 'c-err', outcome: 'rejected' as const }, { id: 'a3', outcome: 'rejected' as const }, { id: 'a4', callId: 'c-x', outcome: 'cancelled' as const }]
    const decided = new StreamFacts().build(model([user(1, 'q'), okCall(1, 'c-ok'), failedCall(1, 'c-err')], [{ turn: 1, startedAt: NOON, endedAt: NOON + 1, outcome: 'completed' }], false), inputs({ approvals, requests: [] }))
    const text = JSON.stringify(one(decided))
    expect(text).toContain('allowed')
    expect(text).toContain('rejected')
  })

  it('names the request on the card with its reason, or without one', () => {
    const call = { ...tool(1, 'bash', 'sleep 9', false), callId: 'wait-2' } as TranscriptEntryModel
    const noReason = new StreamFacts().build(model([user(1, 'q'), call], [{ turn: 1, startedAt: NOON }], true), inputs({ requests: [{ type: 'approval', callId: 'wait-2', toolName: 'bash' }] }))
    expect(one(noReason).find(row => row.kind === 'tool' && row.state === 'waiting')).toBeDefined()
    const withReason = new StreamFacts().build(model([user(1, 'q'), call], [{ turn: 1, startedAt: NOON }], true), inputs({ requests: [{ type: 'approval', callId: 'wait-2', toolName: 'bash', reason: 'remove it' }, { type: 'approval', toolName: 'other' }] }))
    expect(JSON.stringify(one(withReason))).toContain('remove it')
  })

  it('closes a turn that ended in error with a Failed header, and counts its subagents on the header', () => {
    const subagent = { ...tool(1, 'task', 'explore'), activity: 'subagents' } as TranscriptEntryModel
    const failed = new StreamFacts().build(model([user(1, 'q'), subagent, failedCall(1, 'c-f')], [{ turn: 1, startedAt: NOON, endedAt: NOON + 2, outcome: 'error' }]), inputs())
    expect(one(failed).find(row => row.kind === 'header')).toMatchObject({ kind: 'header', mood: 'failed', label: 'Failed' })
    const onlyAgents = new StreamFacts().build(model([user(1, 'q'), { ...subagent, id: 'tool:agent' } as TranscriptEntryModel], [{ turn: 1, startedAt: NOON, endedAt: NOON + 2, outcome: 'completed' }]), inputs())
    expect(one(onlyAgents).find(row => row.kind === 'header')).toMatchObject({ label: '1 subagent · Ctrl+O to expand' })
  })

  it('titles a compact turn with only its subagents, and withholds the Ctrl-O hint from a turn past the expand reach', () => {
    const compact = { ...DEFAULT_TRANSCRIPT_PRESENTATION, mode: 'compact', process: PROCESS_POLICIES.compact } as const
    const subagent = { ...tool(1, 'task', 'explore'), activity: 'subagents' } as TranscriptEntryModel
    const onlyAgents = new StreamFacts().build(model([user(1, 'q'), subagent], [{ turn: 1, startedAt: NOON, endedAt: NOON + 2, outcome: 'completed' }]), inputs({ policy: compact }))
    expect(one(onlyAgents).find(row => row.kind === 'title')).toMatchObject({ text: '1 subagent', hint: 'Ctrl+O to expand' })
    const turns = [1, 2, 3, 4].map(turn => ({ turn, startedAt: NOON + turn, endedAt: NOON + turn + 1, outcome: 'completed' as const }))
    const entries = [1, 2, 3, 4].flatMap(turn => [user(turn, `q${String(turn)}`), okCall(turn, `c${String(turn)}`)])
    const far = new StreamFacts().build(model(entries, turns), inputs({ policy: { ...compact, windowTurns: 10 } }))
    expect(rowsOf(far.turns[0]).find(row => row.kind === 'title')).not.toHaveProperty('hint')
    expect(rowsOf(far.turns[3]).find(row => row.kind === 'title')).toHaveProperty('hint')
  })

  it('lists a reasoning block of a compact turn with no lines, and caps a settled block with a more line', () => {
    const compact = { ...DEFAULT_TRANSCRIPT_PRESENTATION, mode: 'compact', process: PROCESS_POLICIES.compact } as const
    const live = new StreamFacts().build(model([user(1, 'q'), thinking(1, 'pondering', true)], [{ turn: 1, startedAt: NOON }], true), inputs({ policy: compact }))
    expect(one(live).find(row => row.kind === 'reasoning')).toEqual({ kind: 'reasoning', id: expect.any(String), label: 'Thinking', pending: true })
    const ten = Array.from({ length: 10 }, (_, index) => `thought ${String(index + 1)}`).join('\n')
    const verbose = new TranscriptPresentationPolicy()
    verbose.apply({ transcriptView: 'verbose' })
    const settled = new StreamFacts().build(model([user(1, 'q'), thinking(1, ten)], [{ turn: 1, startedAt: NOON, endedAt: NOON + 9, outcome: 'completed' }]), inputs({ policy: verbose.snapshot() }))
    expect(one(settled).find(row => row.kind === 'reasoning')).toMatchObject({ rows: Array.from({ length: 8 }, (_, index) => `thought ${String(index + 1)}`), more: '… +2 more · Ctrl+O' })
  })

  it('shows a call that waits on the user as a block of its own in a standard run', () => {
    const runs = [okCall(1, 'r1'), { ...tool(1, 'bash', 'sleep 9', false), callId: 'wait-3' } as TranscriptEntryModel, okCall(1, 'r2')]
    const facts = new StreamFacts().build(model([user(1, 'q'), ...runs], [{ turn: 1, startedAt: NOON }], true), inputs({ requests: [{ type: 'approval', callId: 'wait-3', toolName: 'bash' }] }))
    expect(one(facts).filter(row => row.kind === 'tool')).toHaveLength(3)
    expect(one(facts).find(row => row.kind === 'tool' && row.state === 'waiting')).toBeDefined()
  })

  it('draws an error entry with its code, and a compaction by its stage, its failure, and its summary', () => {
    const error = { ...base(1), id: 'error:1', kind: 'transcript-error', message: 'rate limited', code: '429' } as unknown as TranscriptEntryModel
    const plain = { ...base(1), id: 'error:2', kind: 'transcript-error', message: 'offline' } as unknown as TranscriptEntryModel
    const errors = new StreamFacts().build(model([user(1, 'q'), error, plain], [{ turn: 1, startedAt: NOON }], true), inputs())
    expect(one(errors)).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'error', text: 'rate limited (429)' }), expect.objectContaining({ kind: 'error', text: 'offline' })]))
    const build = (entry: TranscriptEntryModel, more: Partial<StreamInputs> = {}) => one(new StreamFacts().build(model([user(1, 'q'), entry], [{ turn: 1, startedAt: NOON }], true), inputs(more))).find(row => row.kind === 'compaction')
    expect(build(compaction({ state: 'running', shadowedCount: 4 }))).toMatchObject({ facts: { state: 'running', progress: ['applying'] } })
    expect(build(compaction({ state: 'running' }))).toMatchObject({ facts: { state: 'running', progress: ['summarizing', expect.any(String)] } })
    expect(build(compaction({ state: 'error' }))).toMatchObject({ facts: { state: 'error', title: 'Compaction failed' } })
    expect(build(compaction({ state: 'error', error: 'boom\nsecond line' }))).toMatchObject({ facts: { state: 'error', title: 'Compaction failed: boom' } })
    expect(build(compaction({ state: 'error', detail: '   ' }))).toMatchObject({ facts: { state: 'error', title: 'Compaction failed' } })
    expect(build(compaction({ endedAt: NOON + 1, shadowedCount: 4 }))).toMatchObject({ facts: { state: 'ok', title: 'Compacted 4 items' } })
    expect(build(compaction({ endedAt: NOON + 1, detail: '   ' }))).toMatchObject({ facts: { state: 'ok', title: 'Compacted' } })
    expect(build(compaction({ endedAt: NOON + 1, detail: 'Kept the plan' }))).toMatchObject({ facts: { state: 'ok', title: 'Kept the plan' } })
    const summary = Array.from({ length: 10 }, (_, index) => `point ${String(index + 1)}`).join('\n')
    const opened = build(compaction({ endedAt: NOON + 1, summary }), { disclosure: { ...NO_DISCLOSURE, recent: true } })
    expect(opened).toMatchObject({ summary: Array.from({ length: 8 }, (_, index) => `point ${String(index + 1)}`), more: '… +2 more' })
    expect(build(compaction({ endedAt: NOON + 1, summary }))).toMatchObject({ hint: 'Ctrl+O summary' })
  })
})

describe('StreamFacts: the turn of a view with no turn, the text of a header, and a compaction in every state', () => {
  const compaction = (overrides: Partial<Extract<TranscriptEntryModel, { kind: 'transcript-compaction' }>>): TranscriptEntryModel => ({
    ...base(1), id: 'cmp:1', kind: 'transcript-compaction', state: 'ok', trigger: 'auto', startedAt: NOON, ...overrides,
  } as TranscriptEntryModel)
  const build = (entries: TranscriptEntryModel[], more: Partial<StreamInputs> = {}, streaming = true) => new StreamFacts().build(model(entries, [{ turn: 1, startedAt: NOON }], streaming), inputs(more))
  const compactionRow = (facts: ReturnType<typeof build>) => rowsOf(facts.turns[0]).find(row => row.kind === 'compaction')

  it('keeps the canonical nodes of a view with no turn in a turn numbered zero', () => {
    const facts = new StreamFacts().build(createTranscriptModel('spec', [{ kind: 'text', content: 'a notice' } as MayflyUiNode]), inputs())
    expect(facts.turns).toEqual([{ id: 'turn:-1', number: 0, rows: [{ kind: 'note', id: 'node:0', text: 'a notice' }] }])
  })

  it('reads the text of a turn header as its entries, bracketed in raw form, and of an unknown item as nothing', () => {
    const stream = new StreamFacts()
    stream.build(model([user(1, 'first'), assistant(1, 'answer')], [{ turn: 1, startedAt: NOON, endedAt: NOON + 1, outcome: 'completed' }]), inputs())
    expect(stream.textOf('turn:1.end', 'text')).toBe('first\n\nanswer')
    expect(stream.textOf('turn:1.end', 'raw')).toMatch(/^\[\n[\s\S]*\n\]$/u)
    expect(stream.textOf('unknown:9', 'text')).toBeUndefined()
    expect(new StreamFacts().textOf('user:1', 'text')).toBeUndefined()
  })

  it('reads the text of a read group run', () => {
    const read = { callId: 'r1', activity: 'read', detail: 'a.ts', seq: 1, updatedSeq: 1, turn: 1, step: 0, name: 'read', startedAt: 0, endedAt: 1, state: 'ok', path: 'a.ts', range: { first: 1, last: 2 }, totalLines: 2, previewLines: [{ number: 1, text: 'const a = 1' }] }
    const group = { id: 'read:1', kind: 'transcript-read-group', seq: 1, updatedSeq: 1, turn: 1, step: 0, reads: [read] } as unknown as TranscriptEntryModel
    const stream = new StreamFacts()
    stream.build(model([user(1, 'go'), group], [{ turn: 1, startedAt: NOON, endedAt: NOON + 1, outcome: 'completed' }]), inputs({ disclosure: { ...NO_DISCLOSURE, rows: new Set(['read:1:r1']) } }))
    const row = stream.rowOf('read:1:r1')
    expect(row).toBeDefined()
    expect(stream.textOf(row!, 'text')).toContain('a.ts')
  })

  it('shows a settled compaction with the token counts of its marks and its change of context, and a manual one after its turn', () => {
    const marks = [{ id: 'c-1', before: 80_000, after: 20_000, window: 100_000 }]
    const settled = compactionRow(build([user(1, 'q'), compaction({ endedAt: NOON + 1, summaryAt: NOON + 1, compactionId: 'c-1' })], { compactions: marks, now: NOON + 60_000 }, false))
    expect(settled).toMatchObject({ facts: { state: 'ok', change: 'context 80% → 20%', tokens: '~78.1k → ~19.5k tokens', trigger: 'auto' } })
    expect(build([user(1, 'q'), compaction({ endedAt: NOON + 1, shadowedTokens: 5_000, trigger: 'manual' })], {}, false).turns[0]).toMatchObject({ after: [{ kind: 'compaction' }] })
    expect(compactionRow(build([user(1, 'q'), compaction({ endedAt: NOON + 1, shadowedTokens: 5_000 })], { contextWindow: 100_000 }, false))).toMatchObject({ facts: { tokens: '~4.9k tokens' } })
    expect(compactionRow(build([user(1, 'q'), compaction({ state: 'running', startedAt: NOON - 4_000, trigger: 'manual' })]))).toMatchObject({ facts: { state: 'running', progress: ['summarizing', expect.any(String)] } })
  })

  it('keeps a compaction that has just landed in its applying state until the bar fills', () => {
    const landed = compaction({ endedAt: NOON + 1, summaryAt: NOON + 500, state: 'ok', shadowedCount: 3 })
    const filling = compactionRow(build([user(1, 'q'), landed], { now: NOON + 600 }))
    expect(filling).toMatchObject({ facts: { state: 'running', progress: ['applying'] } })
    expect(compactionRow(build([user(1, 'q'), landed], { now: NOON + 60_000 }, false))).toMatchObject({ facts: { state: 'ok', title: 'Compacted 3 items' } })
  })
})

describe('StreamFacts: the compact title, the live call, and the plain entries', () => {
  const compact = { ...DEFAULT_TRANSCRIPT_PRESENTATION, mode: 'compact', process: PROCESS_POLICIES.compact } as const
  const failedTool = (turn: number, callId: string, interruption?: 'aborted' | 'unknown'): TranscriptEntryModel => ({
    ...tool(turn, 'bash', 'exit 1'), callId, result: { text: 'boom', isError: true, endedAt: 2, ...(interruption === undefined ? {} : { interruption }) },
  } as TranscriptEntryModel)
  const okTool = (turn: number, callId: string): TranscriptEntryModel => ({ ...tool(turn, 'bash', 'ls'), callId } as TranscriptEntryModel)
  const titleOf = (entries: TranscriptEntryModel[], turns: { turn: number, startedAt: number, endedAt?: number, outcome?: 'completed' }[] = [{ turn: 1, startedAt: NOON, endedAt: NOON + 4_000, outcome: 'completed' }], streaming = false) => {
    const facts = new StreamFacts().build(model(entries, turns as never, streaming), inputs({ policy: compact }))
    return rowsOf(facts.turns[0]).find(row => row.kind === 'title')
  }

  it('counts the failed calls of a settled compact turn, and says whether the others succeeded', () => {
    expect(titleOf([user(1, 'q'), okTool(1, 'c1'), failedTool(1, 'c2')])).toMatchObject({ text: '2 tool calls', failed: '1 failed', partial: true })
    expect(titleOf([user(1, 'q'), failedTool(1, 'c3')])).toEqual({ kind: 'title', id: expect.any(String), text: '1 tool call', failed: '1 failed', hint: 'Ctrl+O to expand' })
  })

  it('names the calls the user cancelled as interrupted, apart from the failed ones', () => {
    expect(titleOf([user(1, 'q'), failedTool(1, 'c4', 'aborted')])).toMatchObject({ interrupted: '1 interrupted' })
    expect(titleOf([user(1, 'q'), failedTool(1, 'c5', 'aborted')])).not.toHaveProperty('failed')
    expect(titleOf([user(1, 'q'), failedTool(1, 'c6', 'unknown')])).toMatchObject({ failed: '1 failed' })
  })

  it('adds the lines an edit changed to the title', () => {
    const edit = { ...okTool(1, 'c7'), change: { kind: 'edit', added: 3, removed: 1 } } as unknown as TranscriptEntryModel
    expect(titleOf([user(1, 'q'), edit])).toMatchObject({ text: '1 tool call · +3 −1' })
  })

  it('leaves the duration out of a title whose turn still runs, and draws a call in flight on its own line', () => {
    const running = { ...tool(1, 'bash', 'sleep 9', false), callId: 'c8' } as TranscriptEntryModel
    const facts = new StreamFacts().build(model([user(1, 'q'), okTool(1, 'c9'), running], [{ turn: 1, startedAt: NOON }], true), inputs({ policy: compact }))
    const rows = rowsOf(facts.turns[0])
    expect(rows.find(row => row.kind === 'title')).toMatchObject({ text: '2 tool calls' })
    expect(rows.filter(row => row.kind === 'tool')).toHaveLength(1)
  })

  it('draws a plain entry by its id, and an item suffixed to it', () => {
    const stream = new StreamFacts()
    const first = user(1, 'first')
    stream.build(model([first], [{ turn: 1, startedAt: NOON, endedAt: NOON + 1, outcome: 'completed' }]), inputs())
    expect(stream.textOf(first.id, 'text')).toBe('first')
    expect(stream.textOf(`${first.id}.body`, 'text')).toBe('first')
  })

  it('draws neither a blank answer nor an image with no name by name', () => {
    const blank = new StreamFacts().build(model([user(1, 'q'), assistant(1, '   ')], [{ turn: 1, startedAt: NOON }], true), inputs())
    expect(rowsOf(blank.turns[0]).map(row => row.kind)).toEqual(['prompt'])
    const image = { attachmentId: 'att-2', mediaType: 'image/png' as const, bytes: 1024, width: 2, height: 2 }
    const named = new StreamFacts().build(model([{ ...user(1, 'look'), images: [image] } as TranscriptEntryModel], [{ turn: 1, startedAt: NOON }], true), inputs())
    expect(rowsOf(named.turns[0])[0]).toMatchObject({ images: [{ alt: '[image] 1 · 2×2 · 1 KB' }] })
  })

  it('shows every line of an opened reasoning block that carries more than its rows, without the Ctrl-O hint', () => {
    const many = Array.from({ length: 45 }, (_, index) => `step ${String(index + 1)}`).join('\n')
    const block = thinking(1, many)
    const opened = new StreamFacts().build(model([user(1, 'q'), block], [{ turn: 1, startedAt: NOON, endedAt: NOON + 9, outcome: 'completed' }]), inputs({ disclosure: { ...NO_DISCLOSURE, rows: new Set([block.id]) } }))
    expect(rowsOf(opened.turns[0]).find(row => row.kind === 'reasoning')).toMatchObject({ rows: expect.any(Array), more: '… +5 more' })
  })

  it('shows the summary of a compaction in full when it has few lines', () => {
    const entry = { ...base(1), id: 'cmp:2', kind: 'transcript-compaction', state: 'ok', trigger: 'auto', startedAt: NOON, endedAt: NOON + 1, summary: 'kept\nthe plan' } as TranscriptEntryModel
    const facts = new StreamFacts().build(model([user(1, 'q'), entry], [{ turn: 1, startedAt: NOON }], true), inputs({ disclosure: { ...NO_DISCLOSURE, recent: true }, now: NOON + 60_000 }))
    expect(rowsOf(facts.turns[0]).find(row => row.kind === 'compaction')).toMatchObject({ summary: ['kept', 'the plan'] })
    expect(rowsOf(facts.turns[0]).find(row => row.kind === 'compaction')).not.toHaveProperty('more')
  })
})

describe('StreamFacts: the turn index over a long session', () => {
  const lifetime = (turn: number) => ({ turn, startedAt: NOON + turn, endedAt: NOON + turn + 1, outcome: 'completed' as const })
  const long = (count: number): TranscriptEntryModel[] => Array.from({ length: count }, (_, index) => index + 1)
    .flatMap(turn => [user(turn, `q${String(turn)}`), thinking(turn, `thinking ${String(turn)}`), assistant(turn, `a${String(turn)}`)])

  it('builds a 2,000-turn model with the facts of the same tail alone', () => {
    const turns = Array.from({ length: 2_000 }, (_, index) => lifetime(index + 1))
    const entries = long(2_000)
    const facts = new StreamFacts().build(model(entries, turns), inputs())
    // The default window is the newest 15 turns, in order.
    expect(facts.turns.map(turn => turn.id)).toEqual(Array.from({ length: 15 }, (_, index) => `turn:${String(1_986 + index)}`))
    // A model that holds only those entries maps to the same facts: the cached index did not change the mapping.
    const tail = new StreamFacts().build(model(entries.slice(-45), turns), inputs())
    expect(facts.turns).toEqual(tail.turns)
  })

  it('keeps an old forced turn mounted beside the window', () => {
    const policy = new TranscriptPresentationPolicy()
    policy.apply({ windowTurns: 2 })
    const turns = Array.from({ length: 2_000 }, (_, index) => lifetime(index + 1))
    const facts = new StreamFacts().build(model(long(2_000), turns), inputs({ policy: policy.snapshot(), disclosure: { ...NO_DISCLOSURE, forced: new Set([1]) } }))
    expect(facts.turns.map(turn => turn.id)).toEqual(['turn:1', 'turn:1999', 'turn:2000'])
    expect(rowsOf(facts.turns[0]).map(row => row.kind)).toEqual(['prompt', 'header', 'reasoning', 'answer'])
  })

  it('draws a live step once, from its live entries', () => {
    const durableThought = thinking(1, 'durable reasoning')
    const durableAnswer = assistant(1, 'durable answer')
    const liveThought = { ...thinking(1, 'live reasoning'), id: 'thinking:live', streaming: true }
    const liveAnswer = { ...assistant(1, 'live answer'), id: 'assistant:live', streaming: true }
    const base = model([user(1, 'go'), durableThought, durableAnswer, tool(1, 'bash', 'ls')], [{ turn: 1, startedAt: NOON }], true)
    const live = { ...base, live: { turn: 1, step: 1, entries: [liveThought, liveAnswer] } } as TranscriptModel
    const rows = rowsOf(new StreamFacts().build(live, inputs()).turns[0])
    expect(rows.filter(row => row.kind === 'reasoning')).toHaveLength(1)
    expect(rows.filter(row => row.kind === 'answer')).toHaveLength(1)
    expect(rows.find(row => row.kind === 'reasoning')).toMatchObject({ rows: ['live reasoning'] })
    expect(rows.find(row => row.kind === 'answer')).toMatchObject({ text: 'live answer' })
  })

  it('keeps a canonical node in its original place between visible turns', () => {
    const before: MayflyUiNode = { kind: 'text', content: 'before the second turn' }
    const after: MayflyUiNode = { kind: 'text', content: 'inside the second turn' }
    const entries = [user(1, 'one'), assistant(1, 'first'), before, user(2, 'two'), after, assistant(2, 'second')]
    const facts = new StreamFacts().build(model(entries as TranscriptEntryModel[], [lifetime(1), lifetime(2)]), inputs())
    expect(facts.turns.flatMap(turn => turn.rows.map(row => row.kind))).toEqual(['prompt', 'answer', 'note', 'prompt', 'note', 'answer'])
    expect(facts.turns.flatMap(turn => turn.rows).filter(row => row.kind === 'note').map(row => row.kind === 'note' ? row.text : '')).toEqual(['before the second turn', 'inside the second turn'])
  })
})
