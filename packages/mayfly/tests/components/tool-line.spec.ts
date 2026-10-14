/**
 * Decision tests of a tool call drawn at the three tiers: the line's glyph by state, the tool's own name in bold with its
 * target in parentheses and its outcome after `·`, the block's body caps, the Standard run's head and tree, the Detailed
 * tier of the latest step, the blank row between rows, and that every row fits the width it is given.
 * @module components-tool-line
 */

import { describe, expect, it } from 'vitest'
import { compileMayflyUiNode } from '../../src/core/ui-compiler.ts'
import { ToolBody, ToolGroupHead, ToolGroupItem, ToolLine, ToolMore } from '../../src/components/tool-line.ts'
import { TranscriptView, type StreamRow, type TranscriptViewFacts } from '../../src/components/transcript-view.ts'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import type { TranscriptEntryModel, TranscriptModel } from '../../src/frontend/models.ts'
import { createTranscriptModel } from '../../src/transcript/transcript-model.ts'
import { DEFAULT_TRANSCRIPT_PRESENTATION, PROCESS_POLICIES, TranscriptPresentationPolicy, type TranscriptPresentationSnapshot } from '../../src/transcript/presentation-policy.ts'
import { StreamFacts, type StreamInputs } from '../../src/transcript/stream-facts.ts'
import { NO_DISCLOSURE, type Disclosure } from '../../src/transcript/disclosure.ts'
import { callsOf, standardRow, verboseRow, OPEN_BODY_ROWS, VERBOSE_BODY_ROWS } from '../../src/transcript/tool-calls.ts'
import { visibleWidth } from '../../src/core/width.ts'
import { fakeMayflyComponents } from '../transcript/helpers.ts'
import { plainColors, plainText } from '../helpers.ts'

const t = interpolateLocaleMessage
const NOON = Date.UTC(2026, 0, 1, 12, 5)
const NOW = NOON + 60_000
let seq = 0
const base = (turn: number) => ({ seq: (seq += 1), updatedSeq: seq, turn })

/** A settled bash call; overrides carry the rest. */
const bash = (overrides: Record<string, unknown> = {}): TranscriptEntryModel => ({
  ...base(1), id: `tool:${String(seq)}`, kind: 'transcript-tool', step: 1, callId: `c${String(seq)}`, name: 'bash', family: 'command',
  activity: 'commands', detail: 'pnpm test', arguments: '{}', startedAt: 0, result: { text: 'ok', isError: false, endedAt: 4_200 },
  terminal: { command: 'pnpm test', exitCode: 0 },
  ...overrides,
} as unknown as TranscriptEntryModel)

/** A tool entry of another kind (web, todo, subagent, or an unknown tool). */
const other = (overrides: Record<string, unknown>): TranscriptEntryModel => ({
  ...base(1), id: `tool:${String(seq)}`, kind: 'transcript-tool', step: 1, callId: `c${String(seq)}`, family: 'other', detail: '', arguments: '{}', startedAt: 0,
  result: { text: 'ok', isError: false, endedAt: 1_000 }, ...overrides,
} as unknown as TranscriptEntryModel)

const lines = (count: number, prefix = 'line'): string => Array.from({ length: count }, (_, index) => `${prefix} ${String(index + 1)}`).join('\n')
const user = (turn: number, text: string): TranscriptEntryModel => ({ ...base(turn), id: `user:${String(seq)}`, kind: 'transcript-user', text, images: [] })
const reply = (turn: number, text: string): TranscriptEntryModel => ({ ...base(turn), id: `assistant:${String(seq)}`, kind: 'transcript-assistant', step: 3, text, streaming: false })

const closedTurn = (turn: number): TranscriptModel['turns'] => [{ turn, startedAt: NOON, endedAt: NOON + 9_000, outcome: 'completed' }] as TranscriptModel['turns']
const runningTurn = (turn: number): TranscriptModel['turns'] => [{ turn, startedAt: NOON }] as TranscriptModel['turns']

/** The stream's facts of a model, at a work-details level; a running turn is open. */
function facts(entries: TranscriptEntryModel[], mode: TranscriptPresentationSnapshot['mode'], options: { readonly running?: boolean, readonly disclosure?: Disclosure } = {}): TranscriptViewFacts {
  const policy = new TranscriptPresentationPolicy()
  policy.apply({ transcriptView: mode })
  const inputs: StreamInputs = { policy: policy.snapshot(), disclosure: options.disclosure ?? NO_DISCLOSURE, liveTurnHeader: false, t, now: NOW, queued: [] }
  const turns = options.running === true ? runningTurn(1) : closedTurn(1)
  return new StreamFacts().build(createTranscriptModel('spec', entries, options.running === true, 0, turns), inputs)
}

/** The stream drawn at a width, as plain rows (the list's own clip and wrap applied). */
function drawn(value: TranscriptViewFacts, width: number): string[] {
  const node = TranscriptView(value)
  const compiled = compileMayflyUiNode(node, {
    components: fakeMayflyComponents(), colors: plainColors(), getViewport: () => ({ columns: width, rows: 1000 }), screenMode: 'main', emit: () => {},
  })
  const component = compiled.ok ? compiled.value.component : compiled.errorComponent
  return component.render(width).map(row => plainText(row))
}

const toolRowOf = (value: TranscriptViewFacts): StreamRow => value.turns[0]!.rows.find(row => row.kind === 'tool' || row.kind === 'tools')!

describe('tool line glyphs and spans', () => {
  it('draws each state with its glyph: running dots, waiting question, success tick, failure cross, cut-off circle', () => {
    const plain = (spans: ReturnType<typeof ToolLine>) => spans.map(span => span.text).join('')
    expect(plain(ToolLine({ state: 'ok', name: 'Read', target: 'src/a.ts', outcome: '100 of 342 lines' }))).toBe('✓ Read(src/a.ts) · 100 of 342 lines')
    expect(plain(ToolLine({ state: 'error', name: 'Bash', target: 'pnpm test', outcome: 'exit 2 · 4.2s' }))).toBe('✗ Bash(pnpm test) · exit 2 · 4.2s')
    expect(plain(ToolLine({ state: 'cancelled', name: 'Bash', target: 'sleep 9' }))).toBe('⊘ Bash(sleep 9)')
    expect(plain(ToolLine({ state: 'waiting', name: 'Bash', target: 'rm -rf dist', outcome: '1 of 3 waiting' }))).toBe('? Bash(rm -rf dist) · 1 of 3 waiting')
    expect(plain(ToolLine({ state: 'returned', name: 'Plan sent back' }))).toBe('↩ Plan sent back')
    // A call in flight leads with a breathing dot, a motion span only a row body may paint.
    const pending = ToolLine({ state: 'pending', name: 'Bash', target: 'pnpm test' })
    expect(pending[0]).toEqual({ text: '', motion: 'loader', variant: 'breath' })
    expect(pending[1]).toEqual({ text: ' ' })
  })

  it('draws the name in bold, the target in accent inside parentheses, and the outcome muted after a dot', () => {
    const spans = ToolLine({ state: 'ok', name: 'WebSearch', target: '"mayfly"', outcome: '2 sources · 1s' })
    expect(spans).toEqual([
      { text: '✓ ', tone: 'success' },
      { text: 'WebSearch', tone: 'default', styles: ['strong'] },
      { text: '(', tone: 'muted' },
      { text: '"mayfly"', tone: 'accent' },
      { text: ')', tone: 'muted' },
      { text: ' · 2 sources · 1s', tone: 'muted' },
    ])
    // A cancelled call's name is muted too, so the cut-off line reads as a line that did not finish.
    expect(ToolLine({ state: 'cancelled', name: 'Read' })[1]).toMatchObject({ text: 'Read', tone: 'muted' })
  })

  it('draws an edit\'s diffstat as its signed counts and a bar split by their share, each side keeping a cell', () => {
    const plain = ToolLine({ state: 'ok', name: 'Edit', target: 'src/a.ts', stat: { added: 4, removed: 2 } }).map(span => span.text).join('')
    expect(plain).toBe('✓ Edit(src/a.ts) · +4 −2 ▮▮▮▮▮▮▮▮')
    expect(ToolLine({ state: 'ok', name: 'Write', target: 'src/b.ts', stat: { added: 1, removed: 0 } }).at(-1)).toEqual({ text: '▮'.repeat(8), tone: 'success' })
    expect(ToolLine({ state: 'ok', name: 'Edit', target: 'src/c.ts', stat: { added: 0, removed: 3 } }).at(-1)).toEqual({ text: '▮'.repeat(8), tone: 'danger' })
  })

  it('draws a change that touched no line as its zero counts alone, with no bar', () => {
    const plain = ToolLine({ state: 'ok', name: 'Write', target: 'src/empty.ts', stat: { added: 0, removed: 0 } }).map(span => span.text).join('')
    expect(plain).toBe('✓ Write(src/empty.ts) · +0 −0')
  })

  it('draws the body rows indented under the line, the cap row muted, and a standard block\'s head and tree', () => {
    expect(ToolBody({ text: 'ok', tone: 'muted' }).map(span => span.text).join('')).toBe('  ok')
    expect(ToolBody({ lead: '12', text: 'const a = 1' }).map(span => span.text).join('')).toBe('  12 const a = 1')
    expect(ToolMore('… +4 more · Ctrl+O').map(span => span.text).join('')).toBe('  … +4 more · Ctrl+O')
    const head = ToolGroupHead({ state: 'ok', name: 'Bash', head: '3 calls · 6s', items: [] })
    expect(head.map(span => span.text).join('')).toBe('✓ Bash · 3 calls · 6s')
    expect(ToolGroupHead({ state: 'partial', name: 'Bash', head: '3 calls', failed: '1 failed', items: [] }).at(-1)).toEqual({ text: ' · 1 failed', tone: 'warning' })
    expect(ToolGroupItem({ state: 'ok', label: 'pnpm test', outcome: '4.2s' }, false).map(span => span.text).join('')).toBe('  ├ pnpm test · 4.2s')
    expect(ToolGroupItem({ state: 'error', label: 'pnpm build', outcome: 'exit 1' }, true).map(span => span.text).join('')).toBe('  └ ✗ pnpm build · exit 1')
  })
})

describe('tool calls at the three tiers', () => {
  it('names each tool kind by its own name, with its target and outcome, at Verbose', () => {
    const callOf = (entry: TranscriptEntryModel) => callsOf(entry, t, NOW)[0]!
    expect(callOf(bash())).toMatchObject({ name: 'Bash', target: 'pnpm test', outcome: ['4.2s'] })
    expect(callOf(bash({ terminal: { command: 'pnpm test', exitCode: 2 }, result: { text: 'boom', isError: true, endedAt: 4_200 } })))
      .toMatchObject({ state: 'error', outcome: ['exit 2', '4.2s'] })
    expect(callOf(bash({ terminal: { command: 'sleep 9', signal: 'SIGTERM' }, result: { text: '', isError: true, endedAt: 4_200 } })))
      .toMatchObject({ state: 'error', outcome: ['signal SIGTERM', '4.2s'] })
    expect(callOf(other({ name: 'web_fetch', activity: 'webFetch', web: { kind: 'fetch', url: 'https://x.dev/a', statusCode: 200, truncated: true }, result: { text: 'x'.repeat(2_048), isError: false, endedAt: 4_200 } })))
      .toMatchObject({ name: 'WebFetch', target: 'https://x.dev/a', outcome: ['200', '2 KB', 'truncated', '4.2s'] })
    expect(callOf(other({ name: 'web_search', activity: 'webSearch', detail: 'mayfly', web: { kind: 'search', sources: [{ url: 'https://a' }, { url: 'https://b' }], truncated: false }, result: { text: 'ok', isError: false, endedAt: 1_000 } })))
      .toMatchObject({ name: 'WebSearch', target: '"mayfly"', outcome: ['2 sources', '1s'] })
    expect(callOf(other({ name: 'todo_write', activity: 'plan', detail: '', arguments: '{"todos":[{"content":"a"},{"content":"b"}]}' })))
      .toMatchObject({ name: 'TodoWrite' })
    expect(callOf(other({ name: 'subagent', activity: 'subagents', detail: 'Review', result: { text: 'done', isError: false, endedAt: 9_000 } })))
      .toMatchObject({ name: 'Subagent', target: 'Review' })
    // A generic tool falls back to its own name, and its detail in the parentheses.
    expect(callOf(other({ name: 'custom_tool', activity: 'tools', detail: 'q' }))).toMatchObject({ name: 'CustomTool', target: 'q', label: 'CustomTool(q)' })
    const mcp = callOf(other({ name: 'mcp__github__search_issues', activity: 'tools', detail: '' }))
    expect(mcp).toMatchObject({ name: 'github › search_issues' })
    expect(mcp).not.toHaveProperty('target')
  })

  it('shows a call without a result as pending with its time so far', () => {
    const running = callsOf(bash({ result: undefined, startedAt: NOW - 3_000 }), t, NOW)[0]!
    expect(running).toMatchObject({ state: 'pending', outcome: ['3s'] })
  })

  it('draws a failed read or search only its reason, and keeps a failed command\'s output tail', () => {
    const failedRead = callsOf(other({ name: 'read', activity: 'read', family: 'read', result: { text: 'File not found', isError: true, endedAt: 1 }, detail: 'nope.txt', path: 'nope.txt' }), t, NOW)[0]!
    expect(verboseRow(failedRead, false, t, 'verbose')).toMatchObject({ state: 'error', name: 'Read' })
    expect(verboseRow(failedRead, false, t, 'verbose')).not.toHaveProperty('body')
    const failedCommand = callsOf(bash({ terminal: { command: 'tsc', exitCode: 1, output: 'error TS2304\nboom' }, result: { text: 'error TS2304\nboom', isError: true, endedAt: 1 } }), t, NOW)[0]!
    expect(verboseRow(failedCommand, false, t, 'verbose')).toMatchObject({ state: 'error', outcome: 'exit 1', body: [{ text: 'error TS2304' }, { text: 'boom' }] })
  })

  it('caps a verbose body at six rows with its Ctrl+O hint, lifts the cap to forty when the turn opens, and shows a command\'s tail', () => {
    const output = lines(10)
    const plain = callsOf(other({ name: 'custom_tool', activity: 'tools', detail: '', result: { text: output, isError: false, endedAt: 1 } }), t, NOW)[0]!
    expect(verboseRow(plain, false, t, 'verbose')).toMatchObject({ body: expect.any(Array), more: '… +4 more · Ctrl+O' })
    expect((verboseRow(plain, false, t, 'verbose') as Extract<StreamRow, { kind: 'tool' }>).body).toHaveLength(VERBOSE_BODY_ROWS)
    const opened = verboseRow(plain, true, t, 'verbose') as Extract<StreamRow, { kind: 'tool' }>
    expect(opened.body).toHaveLength(10)
    expect(opened).not.toHaveProperty('more')
    const command = callsOf(bash({ terminal: { command: 'pnpm test', exitCode: 0, output: lines(50) }, result: { text: lines(50), isError: false, endedAt: 1 } }), t, NOW)[0]!
    const shut = verboseRow(command, false, t, 'verbose') as Extract<StreamRow, { kind: 'tool' }>
    expect(shut.body).toHaveLength(VERBOSE_BODY_ROWS)
    expect(shut).toMatchObject({ moreBefore: '… +44 earlier · Ctrl+O' })
    expect(shut.body?.at(-1)).toMatchObject({ text: 'line 50' })
    const wide = verboseRow(command, true, t, 'verbose') as Extract<StreamRow, { kind: 'tool' }>
    expect(wide.body).toHaveLength(OPEN_BODY_ROWS)
    expect(wide).toMatchObject({ moreBefore: '… +10 earlier' })
    expect(wide.body?.[0]).toMatchObject({ text: 'line 11' })
  })

  it('shows no body at Standard for a single call, and draws a Standard run of one kind as a head and one item per call', () => {
    const single = callsOf(bash({ terminal: { command: 'ls', exitCode: 0 }, detail: 'ls' }), t, NOW)
    expect(standardRow(single, t, NOW)).toMatchObject({ kind: 'tool', name: 'Bash', target: 'ls' })
    expect(standardRow(single, t, NOW)).not.toHaveProperty('body')
    const run = [
      ...callsOf(bash({ id: 'b1', terminal: { command: 'pnpm test', exitCode: 0 }, detail: 'pnpm test' }), t, NOW),
      ...callsOf(bash({ id: 'b2', terminal: { command: 'pnpm build', exitCode: 2 }, detail: 'pnpm build', result: { text: 'x', isError: true, endedAt: 4_200 } }), t, NOW),
    ]
    expect(standardRow(run, t, NOW)).toMatchObject({ kind: 'tools', name: 'Bash', state: 'partial', head: '2 calls · 4.2s', failed: '1 failed', items: [{ label: 'pnpm test', outcome: '4.2s' }, { label: 'pnpm build', state: 'error', outcome: 'exit 2 · 4.2s' }] })
  })
})

describe('tool rows of the stream at the three tiers and Detailed', () => {
  it('draws a settled bash call at Verbose as its line with the output under it, and the Ctrl+O hint on a capped body', () => {
    const value = facts([user(1, 'run it'), bash({ terminal: { command: 'pnpm test', exitCode: 0, output: lines(8) }, result: { text: lines(8), isError: false, endedAt: 4_200 } })], 'verbose')
    expect(toolRowOf(value)).toMatchObject({ kind: 'tool', name: 'Bash', target: 'pnpm test', outcome: '4.2s', moreBefore: '… +2 earlier · Ctrl+O' })
    const rows = drawn(value, 120)
    expect(rows.some(row => row.includes('✓ Bash(pnpm test) · 4.2s'))).toBe(true)
    // The turn's closing line comes after the body.
    expect(rows.at(-1)).toMatch(/Worked for/u)
    expect(rows.some(row => row.trimEnd().endsWith('line 8'))).toBe(true)
    expect(rows.findIndex(row => row.includes('✓ Bash(pnpm test) · 4.2s'))).toBeLessThan(rows.findIndex(row => row.trimEnd().endsWith('line 8')))
  })

  it('shows the call at Standard as its own line with no body, and a settled file-free run as one block', () => {
    const value = facts([user(1, 'go'), bash({ id: 'b1', detail: 'ls', terminal: { command: 'ls', exitCode: 0 } }), bash({ id: 'b2', detail: 'pwd', terminal: { command: 'pwd', exitCode: 0 } })], 'standard')
    expect(value.turns[0]!.rows.map(row => row.kind)).toEqual(['prompt', 'header', 'tools'])
    expect(drawn(value, 120)).toEqual(expect.arrayContaining(['  ✓ Bash · 2 calls · 4.2s', '    ├ ls · 4.2s', '    └ pwd · 4.2s']))
  })

  it('draws the live call of a Detailed turn: the latest step verbose, the earlier steps as Standard blocks', () => {
    const entries = [
      user(1, 'go'),
      bash({ id: 'b1', step: 1, detail: 'ls', terminal: { command: 'ls', exitCode: 0 }, result: undefined }),
      bash({ id: 'b2', step: 2, detail: 'pnpm test', terminal: { command: 'pnpm test', exitCode: 0 }, result: undefined, arguments: '{"command":"pnpm test"}' }),
    ]
    const value = facts(entries, 'detailed', { running: true })
    const rows = value.turns[0]!.rows
    expect(rows.map(row => row.kind)).toEqual(['prompt', 'tool', 'tool'])
    expect(rows[1]).toMatchObject({ kind: 'tool', state: 'pending', name: 'Bash', target: 'ls' })
    expect(rows[2]).toMatchObject({ kind: 'tool', state: 'pending', name: 'Bash', target: 'pnpm test' })
    // A call in flight at Standard and at Detailed carries its command's lines as its input, never an outcome.
    expect(drawn(value, 120).join('\n')).toContain('● Bash')
  })

  it('draws a closed turn at Compact as one title line, and a call still in flight as its own line under it', () => {
    const closed = facts([user(1, 'go'), bash({ detail: 'ls', terminal: { command: 'ls', exitCode: 0 } }), reply(1, 'done')], 'compact')
    expect(closed.turns[0]!.rows.map(row => row.kind)).toEqual(['prompt', 'title', 'answer'])
    const running = facts([user(1, 'go'), bash({ detail: 'sleep 9', terminal: { command: 'sleep 9' }, result: undefined })], 'compact', { running: true })
    expect(running.turns[0]!.rows.map(row => row.kind)).toEqual(['prompt', 'title', 'tool'])
    expect(running.turns[0]!.rows[2]).toMatchObject({ kind: 'tool', state: 'pending', name: 'Bash' })
  })

  it('separates every row of a turn from the next by a blank row, the row gap of the list', () => {
    const value = facts([user(1, 'go'), bash({ detail: 'ls', terminal: { command: 'ls', exitCode: 0 } }), reply(1, 'done')], 'verbose')
    const items = TranscriptView(value).items.map(item => item.id)
    // Each row opens with a gap item of its own: the answer's gap sits between the call and the answer.
    const answer = value.turns[0]!.rows[2]!.id
    expect(items[items.indexOf(answer) - 1]).toBe(`${answer}.gap`)
    expect(items.indexOf(answer)).toBeGreaterThan(items.findIndex(id => id.startsWith('tool:')))
  })

  it('fits every tool row in the width it is given, at 120 and at 40 columns, at every tier', () => {
    const long = bash({ detail: `pnpm vitest run ${'packages/mayfly/tests/'.repeat(8)}`, terminal: { command: `pnpm vitest run ${'packages/mayfly/tests/'.repeat(8)}`, exitCode: 0, output: lines(20) }, result: { text: lines(20), isError: false, endedAt: 4_200 } })
    for (const mode of ['compact', 'standard', 'detailed', 'verbose'] as const) {
      for (const width of [120, 40]) {
        const rows = drawn(facts([user(1, 'go'), long, reply(1, 'done')], mode), width)
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
      }
    }
    // The exact line at 120 columns, and the narrow line at 40 keeps its name and outcome.
    const narrow = drawn(facts([user(1, 'go'), long], 'verbose'), 40)
    expect(narrow.some(row => row.includes('✓ Bash('))).toBe(true)
    // FINDING (see report): the list clips the line's end, so at 40 columns a long target takes the outcome with it.
  })

  it('keeps the presentation policy table the tiers read, the same for Standard and Detailed settled turns', () => {
    expect(PROCESS_POLICIES.compact.settledProcess).toBe('collect')
    expect(PROCESS_POLICIES.standard.liveProcess).toBe('blocks')
    expect(PROCESS_POLICIES.detailed.liveProcess).toBe('current')
    expect(PROCESS_POLICIES.verbose.settledProcess).toBe('cards')
    expect(DEFAULT_TRANSCRIPT_PRESENTATION.mode).toBe('standard')
  })
})

describe('interrupted tool calls', () => {
  /** A bash call the Harness cut short: `sleep 9` with the long text it stores and the kind its code derives. */
  const cut = (interruption: 'aborted' | 'not-started' | 'unknown', overrides: Record<string, unknown> = {}): TranscriptEntryModel => bash({
    detail: 'sleep 9',
    terminal: { command: 'sleep 9' },
    result: {
      text: interruption === 'unknown' ? 'The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown and it may have had side effects.' : interruption === 'aborted' ? 'Error: tool call aborted' : 'The tool call was not started.',
      isError: true,
      endedAt: interruption === 'not-started' ? 20 : 4_200,
      interruption,
    },
    ...overrides,
  })
  const THREE = (): TranscriptEntryModel[] => [cut('aborted', { id: 'i1' }), cut('not-started', { id: 'i2' }), cut('unknown', { id: 'i3' })]

  it('draws a stopped call and a call that never ran as a muted cancelled line with a short reason, at every tier', () => {
    for (const mode of ['verbose', 'standard', 'detailed'] as const) {
      const stopped = drawn(facts([user(1, 'go'), cut('aborted')], mode), 120)
      expect(stopped).toContain('  ⊘ Bash(sleep 9) · interrupted · 4.2s')
      const never = drawn(facts([user(1, 'go'), cut('not-started')], mode), 120)
      expect(never).toContain('  ⊘ Bash(sleep 9) · not started')
      for (const row of [...stopped, ...never]) expect(row).not.toMatch(/aborted|was not started/u)
    }
    expect(toolRowOf(facts([user(1, 'go'), cut('aborted')], 'verbose'))).toMatchObject({ kind: 'tool', state: 'cancelled', outcome: 'interrupted · 4.2s' })
    expect(toolRowOf(facts([user(1, 'go'), cut('aborted')], 'verbose'))).not.toHaveProperty('body')
  })

  it('keeps a call whose outcome is unknown as a failure with a short reason, because it may have had a side effect', () => {
    for (const mode of ['verbose', 'standard', 'detailed'] as const) {
      const rows = drawn(facts([user(1, 'go'), cut('unknown')], mode), 120)
      expect(rows).toContain('  ✗ Bash(sleep 9) · outcome unknown · 4.2s')
      for (const row of rows) expect(row).not.toMatch(/durably|side effects/u)
    }
    expect(toolRowOf(facts([user(1, 'go'), cut('unknown')], 'verbose'))).toMatchObject({ kind: 'tool', state: 'error', outcome: 'outcome unknown · 4.2s' })
    expect(toolRowOf(facts([user(1, 'go'), cut('unknown')], 'verbose'))).not.toHaveProperty('body')
  })

  it('gives a read, a search, and a file change the same short reasons', () => {
    const read = (interruption: 'aborted' | 'unknown') => callsOf(other({ name: 'read', activity: 'read', family: 'read', detail: 'a.ts', path: 'a.ts', result: { text: 'long text', isError: true, endedAt: 1, interruption } }), t, NOW)[0]!
    expect(read('aborted')).toMatchObject({ state: 'cancelled', outcome: ['interrupted', undefined] })
    expect(read('unknown')).toMatchObject({ state: 'error', outcome: ['outcome unknown', undefined] })
    const group = (interruption: 'aborted' | 'not-started' | 'unknown') => ({
      ...base(1), id: `read:${interruption}`, kind: 'transcript-read-group', step: 0,
      reads: [{ callId: `r-${interruption}`, activity: 'read', detail: 'a.ts', name: 'read', startedAt: 0, endedAt: 1, state: 'error', path: 'a.ts', error: 'Error: tool call aborted', interruption, seq, updatedSeq: seq, turn: 1, step: 0 }],
    }) as unknown as TranscriptEntryModel
    expect(callsOf(group('aborted'), t, NOW)[0]).toMatchObject({ state: 'cancelled', outcome: ['interrupted'] })
    expect(callsOf(group('not-started'), t, NOW)[0]).toMatchObject({ state: 'cancelled', outcome: ['not started'] })
    expect(callsOf(group('unknown'), t, NOW)[0]).toMatchObject({ state: 'error', outcome: ['outcome unknown'] })
  })

  it('counts cancelled calls apart from failed ones in a Standard head and in the Compact title', () => {
    const standard = facts([user(1, 'go'), ...THREE()], 'standard')
    const run = standard.turns[0]!.rows.find(row => row.kind === 'tools')!
    expect(run).toMatchObject({ kind: 'tools', state: 'error', failed: '1 failed', interrupted: '2 interrupted', items: [{ state: 'cancelled', outcome: 'interrupted · 4.2s' }, { state: 'cancelled', outcome: 'not started' }, { state: 'error', outcome: 'outcome unknown · 4.2s' }] })
    const rows = drawn(standard, 120)
    expect(rows.some(row => /^ {2}✗ Bash · 3 calls · .* · 1 failed · 2 interrupted$/u.test(row))).toBe(true)
    expect(rows).toContain('    ├ ⊘ sleep 9 · interrupted · 4.2s')
    expect(rows).toContain('    ├ ⊘ sleep 9 · not started')
    expect(rows).toContain('    └ ✗ sleep 9 · outcome unknown · 4.2s')
    const compact = facts([user(1, 'go'), ...THREE()], 'compact')
    expect(compact.turns[0]!.rows.find(row => row.kind === 'title')).toMatchObject({ kind: 'title', failed: '1 failed', interrupted: '2 interrupted' })
    expect(drawn(compact, 120).some(row => /^ {2}▸ 3 tool calls · .* · 1 failed · 2 interrupted · Ctrl\+O to expand$/u.test(row))).toBe(true)
    // A run that was only stopped has no failure: its head is muted and says how many were interrupted.
    const stopped = facts([user(1, 'go'), cut('aborted', { id: 'j1' }), cut('aborted', { id: 'j2' })], 'standard')
    expect(stopped.turns[0]!.rows.find(row => row.kind === 'tools')).toMatchObject({ state: 'cancelled', interrupted: '2 interrupted' })
    expect(stopped.turns[0]!.rows.find(row => row.kind === 'tools')).not.toHaveProperty('failed')
    const title = facts([user(1, 'go'), cut('aborted', { id: 'j1' }), cut('aborted', { id: 'j2' })], 'compact').turns[0]!.rows.find(row => row.kind === 'title')!
    expect(title).toMatchObject({ interrupted: '2 interrupted' })
    expect(title).not.toHaveProperty('failed')
  })

  it('fits every interrupted row in the width it is given, at 120 and at 40 columns, at every tier', () => {
    const long = `pnpm vitest run ${'packages/mayfly/tests/'.repeat(8)}`
    const many = [cut('aborted', { id: 'k1', detail: long, terminal: { command: long } }), cut('not-started', { id: 'k2' }), cut('unknown', { id: 'k3' })]
    for (const mode of ['compact', 'standard', 'detailed', 'verbose'] as const) {
      for (const width of [120, 40]) {
        const rows = drawn(facts([user(1, 'go'), ...many], mode), width)
        expect(rows.length).toBeGreaterThan(0)
        for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
      }
    }
    const narrow = drawn(facts([user(1, 'go'), cut('aborted'), cut('unknown', { id: 'k4' })], 'verbose'), 40)
    expect(narrow).toContain('  ⊘ Bash(sleep 9) · interrupted · 4.2s')
    // The list clips the end of a line, so the longer reason gives its last words.
    expect(narrow.some(row => row.startsWith('  ✗ Bash(sleep 9) · outcome unknown'))).toBe(true)
  })
})
