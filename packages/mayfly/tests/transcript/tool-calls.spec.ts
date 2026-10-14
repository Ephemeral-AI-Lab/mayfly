/** Decision tests of the settled tool calls at the three tiers: the name, target, and outcome of each kind, the states, the body caps, and the standard runs.
 * @module @ephemeral-ai/mayfly/tests/transcript/tool-calls
 */
import { describe, expect, it } from 'vitest'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import type { TranscriptEntryModel, TranscriptModel } from '../../src/frontend/models.ts'
import { createTranscriptModel } from '../../src/transcript/transcript-model.ts'
import { DEFAULT_TRANSCRIPT_PRESENTATION, PROCESS_POLICIES, type TranscriptPresentationSnapshot } from '../../src/transcript/presentation-policy.ts'
import type { StreamRow } from '../../src/components/transcript-view.ts'
import { NO_DISCLOSURE } from '../../src/transcript/disclosure.ts'
import { StreamFacts, type StreamInputs } from '../../src/transcript/stream-facts.ts'
import { callsOf, standardRow, verboseRow, VERBOSE_BODY_ROWS, OPEN_BODY_ROWS } from '../../src/transcript/tool-calls.ts'

const t = interpolateLocaleMessage
const NOON = Date.UTC(2026, 0, 1, 12, 5)
let seq = 0
const base = (turn: number) => ({ seq: (seq += 1), updatedSeq: seq, turn })

/** A settled transcript tool entry; overrides carry the kind-specific fields. */
const tool = (overrides: Record<string, unknown> = {}): TranscriptEntryModel => ({
  ...base(1), id: `tool:${String(seq)}`, kind: 'transcript-tool', step: 1, callId: `c${String(seq)}`, name: 'bash', family: 'command',
  activity: 'commands', detail: 'pnpm test', arguments: '{}', startedAt: 0, result: { text: 'ok', isError: false, endedAt: 4_200 },
  ...overrides,
} as unknown as TranscriptEntryModel)

/** A read group holding one read call, with the fields the read call model reads. */
const readGroup = (call: Record<string, unknown>): TranscriptEntryModel => ({
  ...base(1), id: `read:${String(seq)}`, kind: 'transcript-read-group', step: 0,
  reads: [{ callId: `r${String(seq)}`, activity: 'read', detail: 'src/a.ts', name: 'read', startedAt: 0, endedAt: 1, state: 'ok', path: 'src/a.ts', ...call, seq, updatedSeq: seq, turn: 1, step: 0 }],
} as unknown as TranscriptEntryModel)

/** A command group holding one command call. */
const commandGroup = (call: Record<string, unknown>): TranscriptEntryModel => ({
  ...base(1), id: `cmd:${String(seq)}`, kind: 'transcript-command-group', step: 0,
  commands: [{ callId: `g${String(seq)}`, activity: 'commands', detail: 'pnpm test', name: 'bash', startedAt: 0, state: 'ok', command: 'pnpm test', ...call, seq, updatedSeq: seq, turn: 1, step: 0 }],
} as unknown as TranscriptEntryModel)

/** A search group holding one search call. */
const searchGroup = (call: Record<string, unknown>): TranscriptEntryModel => ({
  ...base(1), id: `search:${String(seq)}`, kind: 'transcript-search-group', step: 0,
  searches: [{ callId: `s${String(seq)}`, activity: 'search', detail: 'x', name: 'grep', startedAt: 0, endedAt: 1, state: 'ok', ...call, seq, updatedSeq: seq, turn: 1, step: 0 }],
} as unknown as TranscriptEntryModel)

const lines = (count: number, prefix = 'line'): string => Array.from({ length: count }, (_, index) => `${prefix} ${String(index + 1)}`).join('\n')
const NOW = NOON + 60_000
const callOf = (entry: TranscriptEntryModel) => callsOf(entry, t, NOW)[0]!
/** A verbose block, narrowed to its tool row. */
const toolRow = (call: ReturnType<typeof callOf>, open: boolean) => verboseRow(call, open, t, 'verbose') as Extract<StreamRow, { kind: 'tool' }>

describe('tool calls at the three tiers', () => {
  it('names each tool kind by its own name, with its target and outcome', () => {
    expect(callOf(readGroup({ range: { first: 1, last: 100 }, totalLines: 342 }))).toMatchObject({ name: 'Read', target: 'src/a.ts', outcome: ['100 of 342 lines'] })
    expect(callOf(searchGroup({ name: 'grep', shape: 'matches', pattern: 'foo', total: 3, files: [{ path: 'a.ts', count: 2, previews: [] }, { path: 'b.ts', count: 1, previews: [] }] })))
      .toMatchObject({ name: 'Grep', target: '"foo"', outcome: ['3 matches in 2 files'] })
    expect(callOf(searchGroup({ name: 'glob', detail: '**/*.ts', shape: 'paths', pathsTotal: 0, paths: [] }))).toMatchObject({ name: 'Glob', target: '**/*.ts', outcome: ['no matches'] })
    expect(callOf(tool({ terminal: { command: 'pnpm test', exitCode: 0 } }))).toMatchObject({ name: 'Bash', target: 'pnpm test', outcome: ['4.2s'] })
    expect(callOf(tool({ terminal: { command: 'pnpm test', exitCode: 2 }, result: { text: 'boom', isError: true, endedAt: 4_200 } })))
      .toMatchObject({ state: 'error', outcome: ['exit 2', '4.2s'] })
    expect(callOf(tool({ terminal: { command: 'sleep 9', signal: 'SIGTERM' }, result: { text: '', isError: true, endedAt: 4_200 } })))
      .toMatchObject({ state: 'error', outcome: ['signal SIGTERM', '4.2s'] })
    expect(callOf(tool({ name: 'web_fetch', activity: 'webFetch', web: { kind: 'fetch', url: 'https://x.dev/a', statusCode: 200, truncated: true }, result: { text: 'x'.repeat(2_048), isError: false, endedAt: 4_200 } })))
      .toMatchObject({ name: 'WebFetch', target: 'https://x.dev/a', outcome: ['200', '2 KB', 'truncated', '4.2s'] })
    expect(callOf(tool({ name: 'web_search', activity: 'webSearch', detail: 'mayfly', web: { kind: 'search', sources: [{ url: 'https://a' }, { url: 'https://b' }], truncated: false }, result: { text: 'ok', isError: false, endedAt: 1_000 } })))
      .toMatchObject({ name: 'WebSearch', target: '"mayfly"', outcome: ['2 sources', '1s'] })
    const mcp = callOf(tool({ name: 'mcp__github__search_issues', activity: 'tools', detail: '' }))
    expect(mcp).toMatchObject({ name: 'github › search_issues' })
    expect(mcp).not.toHaveProperty('target')
    expect(callOf(tool({ name: 'custom_tool', activity: 'tools', detail: 'q' }))).toMatchObject({ name: 'CustomTool', target: 'q', label: 'CustomTool(q)' })
  })

  it('keeps a call without a result pending, with its time so far as its outcome', () => {
    // The Harness settles every call of a turn it ends, so a call with no result is in flight, never a missing row.
    const pending = tool({ result: undefined, startedAt: NOW - 3_000 })
    expect(callOf(pending)).toMatchObject({ state: 'pending', outcome: ['3s'] })
    expect(toolRow(callOf(pending), false)).toMatchObject({ kind: 'tool', state: 'pending', name: 'Bash' })
  })

  it('shows a failed read or search only its reason, and keeps a failed command\'s output tail', () => {
    const failedRead = callOf(readGroup({ state: 'error', error: 'File not found: nope.txt', previewLines: [{ number: 1, text: 'ghost' }] }))
    expect(toolRow(failedRead, false)).toEqual({ kind: 'tool', id: failedRead.id, state: 'error', name: 'Read', target: 'src/a.ts', outcome: 'File not found: nope.txt' })
    const failedCommand = callOf(commandGroup({ state: 'error', exitCode: 1, previewLines: ['error TS2304', 'boom'] }))
    expect(toolRow(failedCommand, false)).toMatchObject({ state: 'error', outcome: 'exit 1', body: [{ text: 'error TS2304' }, { text: 'boom' }] })
  })

  it('caps a verbose body at six rows with the Ctrl+O hint, and lifts the cap to forty once Ctrl+O opens the turn', () => {
    const output = lines(10)
    const plain = callOf(tool({ result: { text: output, isError: false, endedAt: 1 } }))
    const closed = toolRow(plain, false)
    expect(closed.body).toHaveLength(VERBOSE_BODY_ROWS)
    expect(closed).toMatchObject({ more: '… +4 more · Ctrl+O' })
    expect(toolRow(plain, true)).toMatchObject({ body: expect.any(Array) })
    expect(toolRow(plain, true).body).toHaveLength(10)
    expect(toolRow(plain, true)).not.toHaveProperty('more')
    // A command shows its tail; the rows it left out are above them.
    const command = callOf(tool({ terminal: { command: 'pnpm test', exitCode: 0, output: lines(50) }, result: { text: lines(50), isError: false, endedAt: 1 } }))
    const shut = toolRow(command, false)
    expect(shut.body).toHaveLength(VERBOSE_BODY_ROWS)
    expect(shut).toMatchObject({ moreBefore: '… +44 earlier · Ctrl+O' })
    expect(shut.body?.at(-1)).toMatchObject({ text: 'line 50' })
    const opened = toolRow(command, true)
    expect(opened.body).toHaveLength(OPEN_BODY_ROWS)
    expect(opened).toMatchObject({ moreBefore: '… +10 earlier' })
    expect(opened.body?.[0]).toMatchObject({ text: 'line 11' })
  })

  it('groups consecutive calls of one kind across entries in Standard, splits on another kind or reasoning, and draws a single call as one line', () => {
    const entries: TranscriptEntryModel[] = [
      { ...base(1), id: 'user:1', kind: 'transcript-user', text: 'go', images: [] },
      tool({ id: 'b1' }),
      tool({ id: 'b2', detail: 'pnpm build', terminal: { command: 'pnpm build', exitCode: 0 } }),
      tool({ id: 'r1', name: 'read', activity: 'read', family: 'read', detail: 'src/a.ts', result: { text: 'x', isError: false, endedAt: 1 } }),
      tool({ id: 'b3', detail: 'git status', terminal: { command: 'git status', exitCode: 0 } }),
      { ...base(1), id: 'thinking:1', kind: 'transcript-thinking', step: 2, text: 'next', streaming: false, durationMs: 4_000 },
      tool({ id: 'b4', detail: 'ls', terminal: { command: 'ls', exitCode: 0 } }),
    ]
    const policy: TranscriptPresentationSnapshot = { ...DEFAULT_TRANSCRIPT_PRESENTATION, process: PROCESS_POLICIES.standard }
    const inputs: StreamInputs = { policy, disclosure: NO_DISCLOSURE, liveTurnHeader: false, t, now: NOW, queued: [] }
    const facts = new StreamFacts().build(createTranscriptModel('spec', entries, false, 0, [{ turn: 1, startedAt: NOON, endedAt: NOON + 9_000, outcome: 'completed' }] as TranscriptModel['turns']), inputs)
    const rows = facts.turns[0]!.rows
    // Two bash calls share one block; the read splits it, the reasoning splits the next bash from the run before.
    // The closed turn opens with its header, which the run never enters.
    expect(rows.map(row => row.kind)).toEqual(['prompt', 'header', 'tools', 'tool', 'tool', 'reasoning', 'tool'])
    expect(rows[2]).toMatchObject({ kind: 'tools', items: [{ label: 'pnpm test' }, { label: 'pnpm build' }] })
    expect(rows[3]).toMatchObject({ kind: 'tool', name: 'Read', target: 'src/a.ts' })
    expect(rows[4]).toMatchObject({ kind: 'tool', name: 'Bash', target: 'git status' })
  })

  it('keeps the identity of an unchanged row across passes, and replaces the row whose content changed', () => {
    const turns = [{ turn: 1, startedAt: NOON, endedAt: NOON + 1_000, outcome: 'completed' }] as TranscriptModel['turns']
    const entries = (answer: string): TranscriptEntryModel[] => [
      { ...base(1), id: 'user:1', kind: 'transcript-user', text: 'hi', images: [] },
      tool({ id: 'b1', detail: 'ls', terminal: { command: 'ls', exitCode: 0 } }),
      { ...base(1), id: 'assistant:1', kind: 'transcript-assistant', step: 2, text: answer, streaming: false },
    ]
    const policy: TranscriptPresentationSnapshot = { ...DEFAULT_TRANSCRIPT_PRESENTATION, process: PROCESS_POLICIES.standard }
    const inputs: StreamInputs = { policy, disclosure: NO_DISCLOSURE, liveTurnHeader: false, t, now: NOW, queued: [] }
    const stream = new StreamFacts()
    const first = stream.build(createTranscriptModel('spec', entries('done'), false, 0, turns), inputs).turns[0]!.rows
    const second = stream.build(createTranscriptModel('spec', entries('done'), false, 0, turns), inputs).turns[0]!.rows
    // A fresh model with the same content hands back the rows it already drew.
    expect(second[1]).toBe(first[1])
    expect(second[0]).toBe(first[0])
    const changed = stream.build(createTranscriptModel('spec', entries('done again'), false, 0, turns), inputs).turns[0]!.rows
    expect(changed[1]).toBe(first[1])
    expect(changed.at(-1)).not.toBe(first.at(-1))
  })

  it('draws a Standard run of one kind as a head and one item per call', () => {
    const calls = callsOf(tool({ id: 'x', detail: 'ls', terminal: { command: 'ls', exitCode: 0 } }), t, NOW)
    expect(standardRow(calls, t, NOW)).toMatchObject({ kind: 'tool', name: 'Bash', target: 'ls' })
  })
})
