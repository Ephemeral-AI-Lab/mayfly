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

/** The row of a call at a tier, narrowed to the tool block. */
const blockAt = (call: ReturnType<typeof callOf>, tier: 'verbose' | 'standard' | 'compact', open = false) => verboseRow(call, open, t, tier) as Extract<StreamRow, { kind: 'tool' }>

/** An edit or write whose arguments are still being written: `preparing` while the model streams them, running once they are whole. */
const liveFile = (name: 'edit' | 'write', args: string, overrides: Record<string, unknown> = {}): TranscriptEntryModel =>
  tool({ name, family: 'edit', activity: name, detail: '', arguments: args, result: undefined, startedAt: NOW - 4_000, preparing: { characters: args.length }, ...overrides })

describe('read and search calls', () => {
  it('names a read by its path, else its label, else the tool, and counts one line in the singular', () => {
    expect(callOf(readGroup({ range: { first: 7, last: 7 } }))).toMatchObject({ outcome: ['1 line'], lines: 1 })
    expect(callOf(readGroup({ path: undefined, label: 'job_id: 5', name: 'read_job' }))).toMatchObject({ target: 'job_id: 5', label: 'job_id: 5' })
    const bare = callOf(readGroup({ path: undefined, label: undefined, name: 'job_output' }))
    expect(bare).toMatchObject({ label: 'JobOutput', outcome: [undefined] })
    expect(bare).not.toHaveProperty('target')
    expect(bare).not.toHaveProperty('lines')
  })

  it('numbers the preview lines of a read in one gutter, and has none without a preview', () => {
    const read = callOf(readGroup({ range: { first: 9, last: 10 }, previewLines: [{ number: 9, text: 'nine\tindented' }, { number: 10, text: 'ten' }] }))
    expect(read.body()).toEqual({ rows: [{ lead: ' 9', text: 'nine  indented' }, { lead: '10', text: 'ten' }], total: 2 })
    expect(callOf(readGroup({})).body()).toEqual({ rows: [], total: 0 })
  })

  it('shows a read or search in flight with no input under its line, and a read that was stopped with only its short reason', () => {
    const reading = callOf(readGroup({ state: 'pending', endedAt: undefined, previewLines: [{ number: 1, text: 'x' }] }))
    expect(reading.input()).toEqual({ rows: [], total: 0 })
    expect(blockAt(reading, 'verbose')).not.toHaveProperty('body')
    expect(callOf(searchGroup({ state: 'pending', endedAt: undefined })).input()).toEqual({ rows: [], total: 0 })
    const stopped = callOf(readGroup({ state: 'error', interruption: 'aborted', previewLines: [{ number: 1, text: 'x' }] }))
    expect(stopped).toMatchObject({ state: 'cancelled', interruption: 'aborted', outcome: ['interrupted'] })
    expect(blockAt(stopped, 'verbose')).toEqual({ kind: 'tool', id: stopped.id, state: 'cancelled', name: 'Read', target: 'src/a.ts', outcome: 'interrupted' })
  })

  it('keeps a read in flight without an end, and a failed one with no message without a reason', () => {
    const running = callOf(readGroup({ state: 'pending', endedAt: undefined }))
    expect(running).toMatchObject({ state: 'pending', phase: 'running' })
    expect(running).not.toHaveProperty('endedAt')
    expect(callOf(readGroup({ state: 'error' })).outcome).toEqual([undefined])
    expect(callOf(readGroup({ state: 'error', error: ' \n  ' })).outcome).toEqual([undefined])
  })

  it('counts the paths a glob found, from the total it reports, else from the paths it lists', () => {
    const glob = (extra: Record<string, unknown>) => callOf(searchGroup({ name: 'glob', detail: '*.ts', shape: 'paths', ...extra }))
    expect(glob({ paths: ['a.ts'] }).outcome).toEqual(['1 path'])
    const capped = glob({ paths: ['a.ts', 'b.ts'], pathsTotal: 30 })
    expect(capped.outcome).toEqual(['30 paths'])
    expect(capped.body()).toEqual({ rows: [{ text: 'a.ts' }, { text: 'b.ts' }], total: 30 })
    const none = glob({})
    expect(none.outcome).toEqual(['no matches'])
    expect(none.body()).toEqual({ rows: [], total: 0 })
  })

  it('counts the matches of a grep from its total, else from its files, and lists the matching lines under their file', () => {
    const grep = (extra: Record<string, unknown>) => callOf(searchGroup({ name: 'grep', shape: 'matches', pattern: 'foo', ...extra }))
    const files = [{ path: 'a.ts', count: 1, previews: [{ lineNumber: 3, line: '  foo()  ' }] }]
    const one = grep({ files })
    expect(one).toMatchObject({ outcome: ['1 match in 1 file'], matches: 1 })
    expect(one.body()).toEqual({ rows: [{ lead: 'a.ts:3', text: 'foo()' }], total: 1 })
    // The total the Harness reports can exceed the lines it kept.
    expect(grep({ files, total: 9 }).body()).toEqual({ rows: [{ lead: 'a.ts:3', text: 'foo()' }], total: 9 })
    const none = grep({})
    expect(none).toMatchObject({ outcome: ['no matches'], matches: 0 })
    expect(none.body()).toEqual({ rows: [], total: 0 })
  })

  it('names a search without a pattern by its detail, and says nothing found for a shape it does not know', () => {
    expect(callOf(searchGroup({ name: 'tool_search', detail: 'mail', shape: undefined }))).toMatchObject({ target: 'mail', label: 'mail', outcome: [undefined] })
  })

  it('gives a search that was stopped its short reason, and one that failed its message, both without an end for a call in flight', () => {
    expect(callOf(searchGroup({ state: 'error', interruption: 'aborted', error: 'x' }))).toMatchObject({ state: 'cancelled', interruption: 'aborted', outcome: ['interrupted'] })
    expect(callOf(searchGroup({ state: 'error', error: 'bad pattern\nmore' }))).toMatchObject({ state: 'error', outcome: ['bad pattern'] })
    const pending = callOf(searchGroup({ state: 'pending', endedAt: undefined }))
    expect(pending).toMatchObject({ state: 'pending', phase: 'running' })
    expect(pending).not.toHaveProperty('endedAt')
  })
})

describe('command groups', () => {
  it('gives a command the lines it was given as its input, and a one-line command none', () => {
    const several = callOf(commandGroup({ command: 'cd a …', commandLines: ['cd a', 'make'] }))
    expect(several.input()).toEqual({ rows: [{ text: 'cd a' }, { text: 'make' }], total: 2 })
    expect(several.inputIsTarget).toBe(true)
    const single = callOf(commandGroup({}))
    expect(single.input()).toEqual({ rows: [], total: 0 })
    expect(single).not.toHaveProperty('inputIsTarget')
    expect(single.body()).toEqual({ rows: [], total: 0, tail: true })
  })

  it('explains a failed command by its exit, else its message, and a stopped one by its short reason', () => {
    expect(callOf(commandGroup({ state: 'error', error: 'spawn ENOENT' })).outcome).toEqual(['spawn ENOENT', undefined])
    expect(callOf(commandGroup({ state: 'error' })).outcome).toEqual([undefined, undefined])
    expect(callOf(commandGroup({ state: 'error', interruption: 'unknown' }))).toMatchObject({ state: 'error', interruption: 'unknown', outcome: ['outcome unknown', undefined] })
    expect(callOf(commandGroup({ state: 'error', interruption: 'not-started', endedAt: 2_000 }))).toMatchObject({ state: 'cancelled', outcome: ['not started', '2s'], endedAt: 2_000 })
  })
})

describe('file changes in flight', () => {
  it('shows the code of a write as it streams, its last rows and the count so far', () => {
    const call = callOf(liveFile('write', '{"file_path":"src/a.ts","content":"one\\ntwo\\nthree\\n'))
    expect(call).toMatchObject({ state: 'pending', phase: 'preparing', name: 'Write', target: 'src/a.ts', label: 'src/a.ts', outcome: [] })
    expect(call.file).toMatchObject({ stat: { added: 3, removed: 0 }, statInLine: false })
    expect(call.file!.content()).toEqual({ kind: 'code', head: ['one', 'two', 'three'], total: 3, tail: true, language: 'typescript' })
    const row = blockAt(call, 'verbose')
    expect(row.code).toEqual({ text: 'one\ntwo\nthree', start: 1, language: 'typescript' })
    expect(row).not.toHaveProperty('moreBefore')
  })

  it('names the rows of a streaming write that scrolled off, above the code', () => {
    const content = Array.from({ length: 30 }, (_, index) => `row ${String(index + 1)}`).join('\\n')
    const row = blockAt(callOf(liveFile('write', `{"path":"notes","content":"${content}`)), 'standard')
    expect(row.code!.start).toBe(25)
    expect(row.code!.text.split('\n')).toHaveLength(6)
    expect(row.code).not.toHaveProperty('language')
    expect(row).toMatchObject({ moreBefore: '… +24 earlier · Ctrl+O' })
    expect(blockAt(callOf(liveFile('write', `{"path":"notes","content":"${content}`)), 'standard', true)).toMatchObject({ moreBefore: '… +24 earlier' })
  })

  it('draws a write whose arguments are whole from its first rows, with the rest named after them', () => {
    const content = Array.from({ length: 30 }, (_, index) => `row ${String(index + 1)}`).join('\\n')
    const call = callOf(liveFile('write', `{"file_path":"a.py","content":"${content}"}`, { preparing: undefined }))
    expect(call).toMatchObject({ state: 'pending', phase: 'running' })
    expect(call.file!.content()).toMatchObject({ kind: 'code', total: 30, language: 'python' })
    expect(call.file!.content()).not.toHaveProperty('tail')
    const row = blockAt(call, 'verbose')
    expect(row.code!.text.split('\n')).toHaveLength(12)
    expect(row).toMatchObject({ more: '… +18 more · Ctrl+O' })
  })

  it('draws the rows of a file with no known language as plain code and plain hunks, while the call is in flight', () => {
    const whole = blockAt(callOf(liveFile('write', '{"file_path":"notes","content":"one\\ntwo"}', { preparing: undefined })), 'verbose')
    expect(whole.code).toEqual({ text: 'one\ntwo' })
    const side = (prefix: string): string => Array.from({ length: 10 }, (_, index) => `${prefix} ${String(index + 1)}`).join('\\n')
    const editing = blockAt(callOf(liveFile('edit', `{"file_path":"notes","old_string":"${side('old')}","new_string":"${side('new')}`)), 'standard')
    expect(editing.diff![0]).not.toHaveProperty('language')
  })

  it('draws nothing of a write until the model has written some of it', () => {
    expect(callOf(liveFile('write', '{"file_path":"a.ts"')).file).toBeUndefined()
    expect(callOf(liveFile('write', '{"file_path":"a.ts","content":"')).file).toBeUndefined()
    expect(callOf(liveFile('edit', '{"file_path":"a.ts"')).file).toBeUndefined()
  })

  it('draws an edit as the two sides written so far, the end of them while it streams', () => {
    const call = callOf(liveFile('edit', '{"file_path":"a.ts","old_string":"const a = 1","new_string":"const a = 2\\nconst b = 3'))
    expect(call.file!.stat).toEqual({ added: 2, removed: 1 })
    expect(call.file!.content()).toMatchObject({ kind: 'diff', language: 'typescript', tail: true, hidden: 0, hunks: [{ before: 'const a = 1', after: 'const a = 2\nconst b = 3' }] })
    // An edit whose new side has not started yet is a removal so far.
    expect(callOf(liveFile('edit', '{"file_path":"a.ts","old_string":"gone')).file!.stat).toEqual({ added: 0, removed: 1 })
    // One whose old side has not been written is an addition.
    expect(callOf(liveFile('edit', '{"file_path":"a.ts","new_string":"fresh')).file!.stat).toEqual({ added: 1, removed: 0 })
  })

  it('counts the lines a long edit leaves out of its live sides, and settles on the same rows once its arguments are whole', () => {
    const many = (prefix: string) => Array.from({ length: 70 }, (_, index) => `${prefix} ${String(index)}`).join('\\n')
    const args = `{"file_path":"a.txt","old_string":"${many('old')}","new_string":"${many('new')}"}`
    const call = callOf(liveFile('edit', args, { preparing: undefined }))
    expect(call.file!.content()).toMatchObject({ kind: 'diff', hidden: 20 })
    expect(call.file!.content()).not.toHaveProperty('tail')
    expect(call.file!.content()).not.toHaveProperty('language')
  })

  it('gives a change the user stopped its short reason and no rows', () => {
    const call = callOf(tool({ name: 'edit', family: 'edit', activity: 'edit', detail: 'a.ts', result: { text: 'stopped', isError: true, interruption: 'aborted', endedAt: 1_000 } }))
    expect(call).toMatchObject({ state: 'cancelled', interruption: 'aborted', outcome: ['interrupted'] })
    expect(blockAt(call, 'verbose')).toEqual({ kind: 'tool', id: call.id, state: 'cancelled', name: 'Edit', target: 'a.ts', outcome: 'interrupted' })
  })

  it('names a file change by the detail the call carries until the path is written, or by the tool when it has none', () => {
    expect(callOf(liveFile('edit', '{"fi', { detail: 'src/pending.ts' }))).toMatchObject({ name: 'Edit', target: 'src/pending.ts', label: 'src/pending.ts' })
    const unnamed = callOf(liveFile('edit', '{"fi'))
    expect(unnamed).toMatchObject({ label: 'Edit' })
    expect(unnamed).not.toHaveProperty('target')
  })
})

describe('file changes that settled', () => {
  const settledWrite = (path: string, lines: number, bytes: number, overrides: Record<string, unknown> = {}): TranscriptEntryModel => tool({
    name: 'write', family: 'edit', activity: 'write', detail: path, change: { path, added: lines, removed: 0, hunks: [], hiddenLines: 0, write: { bytes, lines, head: ['a'] } }, ...overrides,
  })

  it('gives a write its line count and size, in bytes under a kilobyte and in kilobytes after it, and a file with no known language no highlighting', () => {
    expect(callOf(settledWrite('Makefile', 1, 12)).outcome).toEqual(['1 line', '12 B'])
    const big = callOf(settledWrite('Makefile', 40, 2_048))
    expect(big.outcome).toEqual(['40 lines', '2 KB'])
    expect(big.file!.content()).toEqual({ kind: 'code', head: ['a'], total: 40 })
  })

  it('draws an edit of a file with no known language as plain rows', () => {
    const edit = tool({ name: 'edit', family: 'edit', activity: 'edit', detail: 'x.unknown', change: { path: 'x.unknown', added: 1, removed: 1, hunks: [{ before: 'a', after: 'b' }], hiddenLines: 0 } })
    expect(callOf(edit).file!.content()).toMatchObject({ kind: 'diff', hunks: [{ before: 'a', after: 'b' }] })
    expect(callOf(edit).file!.content()).not.toHaveProperty('language')
    expect(callOf(edit).name).toBe('Edit')
  })
})

describe('lone tool calls', () => {
  const bash = (command: string, overrides: Record<string, unknown> = {}): TranscriptEntryModel => tool({ detail: command, terminal: { command, exitCode: 0 }, ...overrides })

  it('names a command that spans several lines by its first and carries the rest as its input', () => {
    const call = callOf(bash('cd packages\npnpm test\n\npnpm build'))
    expect(call).toMatchObject({ target: 'cd packages …', label: 'cd packages …', inputIsTarget: true })
    expect(call.input().rows.map(row => row.text)).toEqual(['cd packages', 'pnpm test', 'pnpm build'])
    expect(callOf(bash('pnpm test')).input()).toEqual({ rows: [], total: 0 })
    expect(callOf(bash('pnpm test'))).not.toHaveProperty('inputIsTarget')
  })

  it('gives a command of blank lines no target on its row', () => {
    const row = blockAt(callOf(bash('\n  \n')), 'verbose')
    expect(row).not.toHaveProperty('target')
  })

  it('names a call by the arguments written so far while they stream, a command or else the salient one', () => {
    const typing = callOf(tool({ result: undefined, preparing: { characters: 20 }, arguments: '{"command":"pnpm te', terminal: undefined, startedAt: NOW - 1_000 }))
    expect(typing).toMatchObject({ phase: 'preparing', target: 'pnpm te', outcome: [] })
    const searching = callOf(tool({ name: 'web_search', activity: 'webSearch', result: undefined, preparing: { characters: 20 }, arguments: '{"query":"may', detail: '', startedAt: NOW - 1_000 }))
    expect(searching).toMatchObject({ phase: 'preparing', target: '"may"' })
  })

  it('has no target for a command call that has neither a terminal nor a command, and falls back to the tool name', () => {
    const call = callOf(tool({ detail: '', terminal: undefined }))
    expect(call).toMatchObject({ name: 'Bash', label: 'Bash' })
    expect(call).not.toHaveProperty('target')
  })

  it('counts a fetched page in whole kilobytes, at least one, and says nothing of a page that was not cut', () => {
    const fetched = callOf(tool({ name: 'web_fetch', activity: 'webFetch', web: { kind: 'fetch', url: 'https://x.dev', statusCode: 204, truncated: false }, result: { text: 'x', isError: false, endedAt: 1_000 } }))
    expect(fetched.outcome).toEqual(['204', '1 KB', undefined, '1s'])
  })

  it('lists the sources of a web search with their titles and addresses without the scheme, and says one source in the singular', () => {
    const search = callOf(tool({ name: 'web_search', activity: 'webSearch', detail: 'mayfly', web: { kind: 'search', sources: [{ url: 'https://a.dev/x', title: 'A page' }, { url: 'https://b.dev' }], truncated: false } }))
    expect(search.body()).toEqual({ rows: [{ text: 'A page · a.dev/x' }, { text: 'https://b.dev' }], total: 2 })
    const one = callOf(tool({ name: 'web_search', activity: 'webSearch', detail: 'mayfly', web: { kind: 'search', sources: [{ url: 'https://a.dev' }], truncated: false } }))
    expect(one.outcome[0]).toBe('1 source')
  })

  it('gives a call that is neither a command nor a web call the head of its result as its body', () => {
    const call = callOf(tool({ name: 'custom_tool', activity: 'tools', detail: 'q', terminal: undefined, result: { text: 'first\n\nsecond', isError: false, endedAt: 1_000 } }))
    expect(call.body()).toEqual({ rows: [{ text: 'first' }, { text: 'second' }], total: 2 })
  })

  it('keeps the first forty rows of a long result, and counts every row it had', () => {
    const call = callOf(tool({ name: 'custom_tool', activity: 'tools', terminal: undefined, result: { text: lines(55), isError: false, endedAt: 1_000 } }))
    const body = call.body()
    expect(body.rows).toHaveLength(OPEN_BODY_ROWS)
    expect(body.total).toBe(55)
  })

  it('clips a body row to 200 characters with an ellipsis', () => {
    const call = callOf(tool({ name: 'custom_tool', activity: 'tools', terminal: undefined, result: { text: 'x'.repeat(260), isError: false, endedAt: 1_000 } }))
    const [row] = call.body().rows
    expect(row!.text).toHaveLength(200)
    expect(row!.text.endsWith('…')).toBe(true)
  })
})

describe('plan calls', () => {
  const plan = (text: string, overrides: Record<string, unknown> = {}): TranscriptEntryModel => tool({
    name: 'exit_plan_mode', activity: 'plan', family: 'other', detail: '', terminal: undefined, arguments: JSON.stringify({ plan: '1. read\n2. write\n3) test\nnote' }),
    result: { text, isError: false, endedAt: 1_000 }, ...overrides,
  })
  const rejected = (text: string): TranscriptEntryModel => plan(text, { result: { text, isError: true, endedAt: 1_000 } })

  it('reads an approved plan as what the user decided, with the steps it listed, and keeps its Markdown for Ctrl+O', () => {
    const call = callOf(plan('approved'))
    expect(call).toMatchObject({ state: 'ok', name: 'Plan approved', label: 'Plan approved', outcome: ['3 steps', undefined], plan: '1. read\n2. write\n3) test\nnote' })
    expect(call).not.toHaveProperty('target')
    expect(call.body()).toEqual({ rows: [], total: 0 })
    expect(callOf(plan('approved', { arguments: JSON.stringify({ plan: '1. only' }) })).outcome[0]).toBe('1 step')
    const bare = callOf(plan('approved', { arguments: '{}' }))
    expect(bare.outcome).toEqual([undefined, undefined])
    expect(bare).not.toHaveProperty('plan')
    expect(callOf(plan('approved', { arguments: JSON.stringify({ plan: '  ' }) }))).not.toHaveProperty('plan')
  })

  it('reads a plan the user sent back with their feedback quoted, and a plan they rejected without one', () => {
    expect(callOf(rejected('The user chose to keep planning, their feedback: cover the edge cases\nplease')))
      .toMatchObject({ state: 'returned', name: 'Plan sent back', outcome: ['3 steps', '"cover the edge cases"'] })
    expect(callOf(rejected('The user chose to keep planning.'))).toMatchObject({ state: 'error', name: 'Plan rejected', outcome: ['3 steps', undefined] })
    expect(callOf(rejected('their feedback:   '))).toMatchObject({ state: 'error', name: 'Plan rejected' })
  })

  it('keeps a plan call that was cut short a plain call with its short reason', () => {
    expect(callOf(plan('x', { result: { text: 'x', isError: true, interruption: 'unknown', endedAt: 1_000 } })))
      .toMatchObject({ state: 'error', name: 'ExitPlanMode', outcome: ['outcome unknown', '1s'] })
  })

  it('tells the reader at the tiers below Verbose that Ctrl+O opens the plan, and gives the plan itself at Verbose', () => {
    const call = callOf(plan('approved'))
    expect(blockAt(call, 'standard')).toMatchObject({ outcome: '3 steps · Ctrl+O to expand' })
    expect(blockAt(call, 'standard')).not.toHaveProperty('markdown')
    expect(blockAt(call, 'verbose')).toMatchObject({ outcome: '3 steps', markdown: '1. read\n2. write\n3) test\nnote' })
  })
})

describe('calls that wait on the user', () => {
  const noRequests = { decided: new Map<string, 'allowed' | 'rejected'>() }
  const askedOf = (callId: string, request: Parameters<typeof Map.prototype.set>[1]) => ({ ...noRequests, asked: new Map([[callId, request]]) }) as Parameters<typeof callsOf>[3]
  const approval = (extra: Record<string, unknown> = {}) => ({ type: 'approval', index: 1, total: 1, ...extra })
  const pendingBash = (command: string, overrides: Record<string, unknown> = {}): TranscriptEntryModel => tool({ callId: 'wait', detail: command, terminal: { command }, result: undefined, startedAt: NOW - 1_000, ...overrides })
  const waiting = (entry: TranscriptEntryModel, request: unknown) => callsOf(entry, t, NOW, askedOf('wait', request))[0]!

  it('turns the call a request waits on into a waiting line with its place in the queue', () => {
    expect(waiting(pendingBash('pnpm test'), approval({ index: 2, total: 3 }))).toMatchObject({ state: 'waiting', outcome: ['2 of 3 waiting'] })
    expect(waiting(pendingBash('pnpm test'), approval())).toMatchObject({ state: 'waiting', outcome: ['waiting'] })
  })

  it('shows what the asker said under the line, and warns of a command that deletes files', () => {
    const call = waiting(pendingBash('rm -rf build'), approval({ reason: 'clean the output' }))
    expect(call.waiting).toEqual({ rows: [{ text: '⚠ deletes files', tone: 'warning' }, { text: 'clean the output', tone: 'muted' }] })
    expect(blockAt(call, 'compact')).toMatchObject({ state: 'waiting', body: [{ text: '⚠ deletes files' }, { text: 'clean the output' }] })
    // An empty reason is no row.
    expect(waiting(pendingBash('ls'), approval({ reason: '' })).waiting).toEqual({ rows: [] })
  })

  it('shows every line of a command that spans several, the first led by the prompt', () => {
    const call = waiting(pendingBash('cd out\nrm -r tmp'), approval())
    expect(call.waiting!.rows).toEqual([{ lead: '$', text: 'cd out' }, { lead: ' ', text: 'rm -r tmp' }, { text: '⚠ deletes files', tone: 'warning' }])
    expect(waiting(pendingBash('cd out\nls'), approval()).waiting!.rows).toEqual([{ lead: '$', text: 'cd out' }, { lead: ' ', text: 'ls' }])
  })

  it('shows the lines of a command in a group, and checks a command that has no target for deleting', () => {
    const grouped = callsOf(commandGroup({ callId: 'wait', state: 'pending', endedAt: undefined, command: 'cd a …', commandLines: ['cd a', 'rm b'] }), t, NOW, askedOf('wait', approval()))[0]!
    expect(grouped.waiting!.rows).toEqual([{ lead: '$', text: 'cd a' }, { lead: ' ', text: 'rm b' }, { text: '⚠ deletes files', tone: 'warning' }])
    expect(waiting(pendingBash('', { terminal: undefined, detail: '' }), approval()).waiting).toEqual({ rows: [] })
  })

  it('shows nothing under the line of a request about a call that is not a command', () => {
    const call = waiting(tool({ callId: 'wait', name: 'web_fetch', activity: 'webFetch', web: { kind: 'fetch', url: 'https://x.dev', statusCode: 200, truncated: false }, result: undefined, startedAt: NOW - 1_000 }), approval({ reason: 'needs the page' }))
    expect(call.waiting).toEqual({ rows: [{ text: 'needs the page', tone: 'muted' }] })
  })

  it('shows the change an edit waits on whole, with its diffstat, whatever the tier', () => {
    const edit = liveFile('edit', '{"file_path":"a.ts","old_string":"a","new_string":"b"}', { callId: 'wait', preparing: undefined })
    const call = waiting(edit, approval())
    expect(call).toMatchObject({ state: 'waiting', outcome: ['waiting'] })
    const row = blockAt(call, 'compact')
    expect(row).toMatchObject({ state: 'waiting', target: 'a.ts', stat: { added: 1, removed: 1 } })
    expect(row.diff).toHaveLength(1)
  })

  it('names a plan under review for what it is, with its steps and its Markdown, and drops the tool\'s target', () => {
    const entry = tool({ callId: 'wait', name: 'exit_plan_mode', activity: 'plan', detail: 'plan', terminal: undefined, arguments: JSON.stringify({ plan: '1. a\n2. b' }), result: undefined, startedAt: NOW - 1_000 })
    const call = waiting(entry, { type: 'plan', index: 1, total: 1, reason: 'ready' })
    expect(call).toMatchObject({ state: 'waiting', name: 'Plan ready for review', label: 'Plan ready for review', outcome: ['2 steps'] })
    expect(call).not.toHaveProperty('target')
    expect(call.waiting).toEqual({ rows: [{ text: 'ready', tone: 'muted' }], markdown: '1. a\n2. b' })
    expect(blockAt(call, 'standard')).toMatchObject({ markdown: '1. a\n2. b' })
    // A plan whose text has not arrived has no Markdown to show.
    const empty = waiting(tool({ callId: 'wait', name: 'exit_plan_mode', activity: 'plan', terminal: undefined, arguments: '{}', result: undefined, startedAt: NOW - 1_000 }), { type: 'plan', index: 1, total: 1 })
    expect(empty.waiting).toEqual({ rows: [] })
    expect(empty.outcome).toEqual([undefined])
  })

  it('says what the user decided on a call that settled, and leaves other calls and the plan\'s own wording alone', () => {
    const decide = (entry: TranscriptEntryModel, decision: 'allowed' | 'rejected') => callsOf(entry, t, NOW, { asked: new Map(), decided: new Map([[(entry as { callId: string }).callId, decision]]) })[0]!
    expect(decide(tool({ callId: 'd', terminal: { command: 'ls', exitCode: 0 } }), 'allowed').outcome).toEqual(['allowed', '4.2s'])
    expect(decide(tool({ callId: 'd', terminal: { command: 'ls', exitCode: 1 }, result: { text: 'no', isError: true, endedAt: 4_200 } }), 'rejected').outcome).toEqual(['rejected'])
    // A decision that does not fit how the call ended changes nothing.
    expect(decide(tool({ callId: 'd', terminal: { command: 'ls', exitCode: 1 }, result: { text: 'no', isError: true, endedAt: 4_200 } }), 'allowed').outcome).toEqual(['exit 1', '4.2s'])
    expect(decide(tool({ callId: 'd', terminal: { command: 'ls', exitCode: 0 } }), 'rejected').outcome).toEqual(['4.2s'])
    expect(decide(tool({ callId: 'd', name: 'exit_plan_mode', activity: 'plan', terminal: undefined, arguments: '{}' }), 'allowed')).toMatchObject({ name: 'Plan approved' })
  })

  it('takes no calls from an entry that is not a tool, and shows a call in its first second with no time', () => {
    expect(callsOf({ ...base(1), id: 'user:x', kind: 'transcript-user', text: 'go', images: [] } as TranscriptEntryModel, t, NOW)).toEqual([])
    expect(callsOf(tool({ result: undefined, startedAt: NOW - 400 }), t, NOW)[0]!.outcome).toEqual([undefined])
  })
})

describe('a call as a block at each tier', () => {
  const script = 'cd out\n' + Array.from({ length: 9 }, (_, index) => `step ${String(index + 1)}`).join('\n')
  const running = (): ReturnType<typeof callOf> => callOf(tool({ terminal: { command: script }, detail: script, result: undefined, startedAt: NOW - 2_000 }))

  it('shows the lines a running command was given under the bare tool name, three at Standard, six at Verbose, forty once opened, and none at Compact', () => {
    const call = running()
    expect(call.input().total).toBe(10)
    const standard = blockAt(call, 'standard')
    expect(standard.body).toHaveLength(3)
    expect(standard).toMatchObject({ state: 'pending', name: 'Bash', more: '… +7 more · Ctrl+O' })
    expect(standard).not.toHaveProperty('target')
    expect(blockAt(call, 'verbose').body).toHaveLength(6)
    expect(blockAt(call, 'verbose', true).body).toHaveLength(10)
    expect(blockAt(call, 'verbose', true)).not.toHaveProperty('more')
    // At Compact the line alone is drawn, so the command is named on it.
    const compact = blockAt(call, 'compact')
    expect(compact).toMatchObject({ target: 'cd out …' })
    expect(compact).not.toHaveProperty('body')
    expect(compact).not.toHaveProperty('more')
  })

  it('draws no change for a file call at Compact unless a request waits on it, and none for a change that did not settle', () => {
    const writing = callOf(liveFile('write', '{"file_path":"a.ts","content":"one\\ntwo'))
    expect(blockAt(writing, 'compact')).not.toHaveProperty('code')
    expect(blockAt(writing, 'standard').code).toBeDefined()
    const failed = callOf(tool({ name: 'edit', family: 'edit', activity: 'edit', detail: 'a.ts', result: { text: 'no match', isError: true, endedAt: 1_000 } }))
    expect(blockAt(failed, 'verbose')).toMatchObject({ state: 'error', outcome: 'no match' })
    expect(blockAt(failed, 'verbose')).not.toHaveProperty('diff')
  })

  it('cuts a streaming edit to the end of it, with the rows before named', () => {
    const side = (prefix: string, count: number): string => Array.from({ length: count }, (_, index) => `${prefix} ${String(index + 1)}`).join('\\n')
    const call = callOf(liveFile('edit', `{"file_path":"a.ts","old_string":"${side('old', 10)}","new_string":"${side('new', 10)}`))
    const row = blockAt(call, 'standard')
    expect(row.diff).toHaveLength(1)
    expect(row.diff![0]).toMatchObject({ language: 'typescript' })
    expect(row.diff![0]!.after!.split('\n').at(-1)).toBe('new 10')
    expect(row.diff![0]!.start).toBeGreaterThan(1)
    expect(row.moreBefore).toMatch(/^… \+\d+ earlier · Ctrl\+O$/u)
    expect(blockAt(call, 'standard', true).moreBefore).toMatch(/^… \+\d+ earlier$/u)
  })

  it('starts the window of a streaming edit on one line of context at most, numbering the rows from where it starts', () => {
    const keep = Array.from({ length: 5 }, (_, index) => `keep ${String(index + 1)}`)
    const before = ['a1', ...keep, 'z1', 'z2'].join('\\n')
    const after = ['b1', ...keep, 'y1', 'y2'].join('\\n')
    const row = blockAt(callOf(liveFile('edit', `{"file_path":"a.ts","old_string":"${before}","new_string":"${after}`)), 'standard')
    expect(row.diff).toEqual([{ before: 'keep 5\nz1\nz2', after: 'keep 5\ny1\ny2', start: 6, beforeStart: 6, language: 'typescript' }])
    expect(row.moreBefore).toMatch(/^… \+\d+ earlier · Ctrl\+O$/u)
  })

  it('names the rows an edit leaves out after its hunks, and counts a hunk that has no room at all among them', () => {
    const hunks = Array.from({ length: 4 }, (_, index) => ({ before: `old ${String(index)}`, after: `new ${String(index)}` }))
    const edit = tool({ name: 'edit', family: 'edit', activity: 'edit', detail: 'a.txt', change: { path: 'a.txt', added: 4, removed: 4, hunks, hiddenLines: 0 } })
    const row = blockAt(callOf(edit), 'standard')
    expect(row.diff).toHaveLength(2)
    expect(row.diff!.every(hunk => hunk.tail === undefined)).toBe(true)
    expect(row.more).toBe('… +4 rows · Ctrl+O')
  })

  it('ends the hunk that does not fit with the row that counts what the hunks after it left out', () => {
    const hunks = [{ before: 'old 0\nold 1', after: 'new 0\nnew 1' }, { before: 'old 2', after: 'new 2' }, { before: 'old 3', after: 'new 3' }]
    const edit = tool({ name: 'edit', family: 'edit', activity: 'edit', detail: 'a.txt', change: { path: 'a.txt', added: 4, removed: 4, hunks, hiddenLines: 0 } })
    const row = blockAt(callOf(edit), 'standard')
    expect(row.diff).toHaveLength(2)
    expect(row.diff![1]).toMatchObject({ maxRows: 1, tail: '… +3 rows · Ctrl+O' })
    expect(row).not.toHaveProperty('more')
  })

  it('shows a request the whole of what it asks about at every tier', () => {
    const entry = tool({ callId: 'wait', detail: 'ls', terminal: { command: 'ls' }, result: undefined, startedAt: NOW - 1_000 })
    const call = callsOf(entry, t, NOW, { asked: new Map([['wait', { type: 'approval', index: 1, total: 1, reason: 'list the folder' }]]), decided: new Map() })[0]!
    for (const tier of ['compact', 'standard', 'verbose'] as const) expect(blockAt(call, tier).body).toEqual([{ text: 'list the folder', tone: 'muted' }])
  })
})

describe('a run of calls as a standard block', () => {
  const calls = (...entries: TranscriptEntryModel[]) => entries.flatMap(entry => callsOf(entry, t, NOW))
  const standard = (...entries: TranscriptEntryModel[]) => standardRow(calls(...entries), t, NOW) as Extract<StreamRow, { kind: 'tools' }>
  const search = (extra: Record<string, unknown> = {}) => searchGroup({ shape: 'matches', pattern: 'foo', files: [{ path: 'a.ts', count: 1, previews: [] }], ...extra })

  it('sums the lines the reads returned and the matches the searches found, in the singular for one match', () => {
    const reads = standard(readGroup({ range: { first: 1, last: 10 } }), readGroup({ range: { first: 1, last: 5 } }))
    expect(reads).toMatchObject({ kind: 'tools', state: 'ok', name: 'Read', head: '2 files · 15 lines' })
    expect(standard(search(), search({ pattern: 'bar' }))).toMatchObject({ head: '2 searches · 2 matches' })
    expect(standard(search({ total: 1 }), search({ total: 0, files: [] }))).toMatchObject({ head: '2 searches · 1 match' })
    // A search that lists paths counts no matches, so the run reports none.
    expect(standard(search(), searchGroup({ shape: 'paths', paths: [] }))).toMatchObject({ head: '2 searches' })
    expect(standard(search({ total: 0, files: [] }), search({ total: 0, files: [] }))).toMatchObject({ head: '2 searches' })
  })

  it('titles a run of several tools of one kind by the kind, and a run of one tool by its name', () => {
    expect(standard(search(), searchGroup({ name: 'glob', shape: 'paths', paths: ['a'] }))).toMatchObject({ name: 'Search' })
    expect(standard(search(), search())).toMatchObject({ name: 'Grep' })
  })

  it('counts the failed calls apart from the interrupted ones, and tells a partial failure from a total one', () => {
    const failed = searchGroup({ state: 'error', error: 'bad' })
    expect(standard(search(), failed)).toMatchObject({ state: 'partial', failed: '1 failed' })
    expect(standard(failed, searchGroup({ state: 'error', error: 'worse' }))).toMatchObject({ state: 'error', failed: '2 failed' })
    const stopped = () => searchGroup({ state: 'error', interruption: 'not-started', endedAt: undefined })
    const interrupted = standard(stopped(), stopped())
    expect(interrupted).toMatchObject({ state: 'cancelled', interrupted: '2 interrupted', head: '2 searches' })
    expect(interrupted).not.toHaveProperty('failed')
  })

  it('shows a run with a call in flight as pending with the time since the first started, and lines with no outcome while a call has none yet', () => {
    const first = tool({ result: undefined, startedAt: NOW - 3_000 })
    const second = tool({ result: undefined, startedAt: NOW })
    const run = standard(first, second)
    expect(run).toMatchObject({ state: 'pending', head: '2 calls · 3s' })
    expect(run.items[1]).not.toHaveProperty('outcome')
    expect(run.items[0]).toMatchObject({ state: 'pending', outcome: '3s' })
  })

  it('opens the calls the reader opened in place under their lines, with the rows left out named', () => {
    const preview = Array.from({ length: 50 }, (_, index) => ({ number: index + 1, text: `row ${String(index + 1)}` }))
    const long = readGroup({ path: 'long.ts', range: { first: 1, last: 50 }, totalLines: 50, previewLines: preview })
    const short = readGroup({ path: 'short.ts', range: { first: 1, last: 1 } })
    const run = calls(long, short)
    const opened = standardRow(run, t, NOW, new Set([run[0]!.id])) as Extract<StreamRow, { kind: 'tools' }>
    expect(opened.items[0]!.body).toHaveLength(40)
    expect(opened.items[0]).toMatchObject({ more: '… +10 more' })
    expect(opened.items[1]).not.toHaveProperty('body')
    expect(opened.items[1]).not.toHaveProperty('more')
    // A run of one call that was opened is its Verbose block.
    expect(standardRow([run[0]!], t, NOW, new Set([run[0]!.id]))).toMatchObject({ kind: 'tool', name: 'Read' })
  })
})
