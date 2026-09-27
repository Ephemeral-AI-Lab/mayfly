/** Work-details display plan: settled headers, past-tense groups, file-change content, folds, and scope.
 * @module @ephemeral-ai/mayfly/tests/transcript/process-groups
 */
import { describe, expect, it } from 'vitest'
import type { TranscriptEntryModel, TranscriptModel, TranscriptTurnModel } from '../../src/frontend/models.ts'
import { buildDisplay, memberFacts, runningTurnOf, type DisplayItem } from '../../src/transcript/process-groups.ts'
import { PROCESS_POLICIES, type TranscriptViewMode } from '../../src/transcript/presentation-policy.ts'

type Entry = TranscriptModel['entries'][number]
let seq = 0
const base = (turn: number) => ({ seq: ++seq, updatedSeq: seq, turn })
const user = (turn: number, text = 'ask'): TranscriptEntryModel => ({ kind: 'transcript-user', id: `u${String(seq + 1)}`, ...base(turn), text, images: [] })
const reply = (turn: number, step: number, text: string): TranscriptEntryModel => ({ kind: 'transcript-assistant', id: `a${String(seq + 1)}`, ...base(turn), step, text, streaming: false })
const think = (turn: number, step: number, text = 'plan'): TranscriptEntryModel => ({ kind: 'transcript-thinking', id: `t${String(seq + 1)}`, ...base(turn), step, text, streaming: false })
const tool = (turn: number, overrides: Partial<Extract<TranscriptEntryModel, { kind: 'transcript-tool' }>> = {}): TranscriptEntryModel => ({
  kind: 'transcript-tool', id: `x${String(seq + 1)}`, ...base(turn), step: 1, callId: `c${String(seq)}`, name: 'bash', family: 'command',
  activity: 'commands', detail: 'pnpm test', arguments: '{}', startedAt: 0, result: { text: 'ok', isError: false, endedAt: 1 }, ...overrides,
})
const edit = (turn: number, overrides: Partial<Extract<TranscriptEntryModel, { kind: 'transcript-tool' }>> = {}): TranscriptEntryModel =>
  tool(turn, { name: 'edit', family: 'edit', activity: 'edit', detail: 'src/a.ts', ...overrides })
const reads = (turn: number, states: readonly ('ok' | 'pending' | 'error')[]): TranscriptEntryModel => ({
  kind: 'transcript-read-group', id: `r${String(seq + 1)}`, ...base(turn), step: 0,
  reads: states.map((state, index) => ({ callId: `rc${String(index)}`, activity: 'read', detail: `f${String(index)}.ts`, seq, updatedSeq: seq, turn, step: 0, path: `f${String(index)}.ts`, state })),
})

function turnOne(final = true): Entry[] {
  seq = 0
  return [
    user(1),
    think(1, 0),
    reads(1, ['ok', 'ok']),
    reply(1, 1, 'interim'),
    tool(1),
    think(1, 2, 'next\n\nverify the fix'),
    tool(1, { name: 'subagent', activity: 'subagents', detail: 'Review' }),
    ...(final ? [reply(1, 3, 'final answer')] : []),
  ]
}

const closed: TranscriptTurnModel[] = [{ turn: 1, startedAt: 0, endedAt: 38_000, outcome: 'completed' }]

function plan(entries: readonly Entry[], mode: TranscriptViewMode, options: { runningTurn?: number, turns?: TranscriptTurnModel[], expanded?: boolean, scope?: number[], flat?: boolean, previousSeq?: number, runningHeader?: boolean } = {}): DisplayItem[] {
  return buildDisplay({
    entries, policy: PROCESS_POLICIES[mode], runningTurn: options.runningTurn, turns: options.turns ?? closed,
    expanded: options.expanded ?? false, scope: new Set(options.scope ?? [1]), flat: options.flat ?? false,
    ...(options.previousSeq === undefined ? {} : { previousSeq: options.previousSeq }),
    ...(options.runningHeader === undefined ? {} : { runningHeader: options.runningHeader }),
  })
}

const open = [{ turn: 1, startedAt: 0 }]

function shape(items: readonly DisplayItem[]): string[] {
  return items.map(item => item.kind === 'entry'
    ? `${item.entry.kind.replace('transcript-', '')}${item.expanded ? '+' : ''}`
    : item.kind === 'turn-header' ? `header:${item.running ? 'running' : 'closed'}:${item.folded ? 'folded' : 'open'}${item.hint ? ':hint' : ''}` : `title:${item.summary.counts.map(count => count.activity).join('+')}`)
}

describe('work-details display plan', () => {
  it('folds a completed turn to its header and final answer in compact, standard, and detailed', () => {
    for (const mode of ['compact', 'standard', 'detailed'] as const) {
      const items = plan(turnOne(), mode)
      expect(shape(items)).toEqual(['user', 'header:closed:folded:hint', 'assistant'])
      // A subagent spawn counts as a subagent, not also as a tool call.
      expect(items[1]).toMatchObject({ kind: 'turn-header', startedAt: 0, endedAt: 38_000, outcome: 'completed', toolCalls: 3, subagents: 1 })
      expect((items[2] as { entry: { text: string } }).entry.text).toBe('final answer')
    }
    // Out of Ctrl-O's reach the header does not name the key.
    expect(shape(plan(turnOne(), 'standard', { scope: [] }))).toEqual(['user', 'header:closed:folded', 'assistant'])
  })

  it('keeps verbose flat under an open header, and Ctrl-O opens everything in scope only', () => {
    expect(shape(plan(turnOne(), 'verbose'))).toEqual(['user', 'header:closed:open', 'thinking', 'read-group', 'assistant', 'tool', 'thinking', 'tool', 'assistant'])
    expect(shape(plan(turnOne(), 'compact', { expanded: true }))).toEqual(['user+', 'header:closed:open', 'thinking+', 'read-group+', 'assistant+', 'tool+', 'thinking+', 'tool+', 'assistant+'])
    expect(shape(plan(turnOne(), 'compact', { expanded: true, scope: [] }))).toEqual(['user', 'header:closed:folded', 'assistant'])
  })

  it('shows a running turn in the past tense: no header, titles of settled work only', () => {
    const running = plan(turnOne(false), 'standard', { runningTurn: 1, turns: open })
    // The activity row owns the lifecycle: no running header, no live title.
    expect(shape(running)).toEqual(['user', 'title:read', 'assistant', 'title:commands+subagents'])
    expect(running.at(-1)).toMatchObject({ kind: 'process-title', summary: { counts: [{ activity: 'commands', count: 1 }, { activity: 'subagents', count: 1 }], failed: 0 } })
    // A tree without an activity row keeps its live header, still without counts rendered.
    const headed = plan(turnOne(false), 'standard', { runningTurn: 1, turns: open, runningHeader: true })
    expect(shape(headed)).toEqual(['user', 'header:running:open', 'title:read', 'assistant', 'title:commands+subagents'])
    // A still-running spawn is not summarized: only settled work is titled.
    const spawning = [...turnOne(false).slice(0, -1), tool(1, { name: 'subagent', activity: 'subagents', detail: 'Review', result: undefined })]
    expect(shape(plan(spawning, 'standard', { runningTurn: 1, turns: open }))).toEqual(['user', 'title:read', 'assistant', 'title:commands'])
    expect(plan(spawning, 'standard', { runningTurn: 1, turns: open, runningHeader: true })[1]).toMatchObject({ kind: 'turn-header', running: true, toolCalls: 3, subagents: 1 })
    // A reasoning-only group, or one whose work still runs, has no title at all.
    seq = 0
    expect(shape(plan([user(1), think(1, 0), reply(1, 1, 'interim'), think(1, 2)], 'standard', { runningTurn: 1, turns: open }))).toEqual(['user', 'assistant'])
    seq = 0
    expect(shape(plan([user(1), think(1, 0), tool(1, { result: undefined })], 'standard', { runningTurn: 1, turns: open }))).toEqual(['user'])
    // Compact hides the running process; Detailed and Verbose show every card.
    expect(shape(plan(turnOne(false), 'compact', { runningTurn: 1, turns: open }))).toEqual(['user', 'assistant'])
    for (const mode of ['detailed', 'verbose'] as const) {
      expect(shape(plan(turnOne(false), mode, { runningTurn: 1, turns: open }))).toEqual(['user', 'thinking', 'read-group', 'assistant', 'tool', 'thinking', 'tool'])
    }
  })

  it('never folds a stopped, failed, or steered turn, yet still groups it', () => {
    for (const mode of ['compact', 'standard', 'detailed'] as const) {
      expect(shape(plan(turnOne(), mode, { turns: [{ turn: 1, startedAt: 0, endedAt: 5, outcome: 'aborted' }] })))
        .toEqual(['user', 'header:closed:open', 'title:read', 'assistant', 'title:commands+subagents', 'assistant'])
    }
    seq = 0
    const failed = [user(1), tool(1), { kind: 'transcript-error' as const, id: 'e', ...base(1), message: 'down' }]
    expect(shape(plan(failed, 'standard', { turns: [] }))).toEqual(['user', 'header:closed:open', 'title:commands', 'error'])
    seq = 0
    const steered = [user(1), tool(1), user(1, 'steer'), tool(1), reply(1, 2, 'done')]
    expect(shape(plan(steered, 'standard'))).toEqual(['user', 'header:closed:open', 'title:commands', 'user', 'title:commands', 'assistant'])
    // A call cut off by the stop counts as settled once the turn has ended.
    seq = 0
    expect(shape(plan([user(1), think(1, 0), tool(1, { result: undefined }), think(1, 1)], 'standard', { turns: [{ turn: 1, startedAt: 0, endedAt: 5, outcome: 'aborted' }] })))
      .toEqual(['user', 'header:closed:open', 'title:commands'])
  })

  it('treats file changes as content from Standard up: cards that close groups and survive the fold', () => {
    const turn = (final: boolean): Entry[] => {
      seq = 0
      return [user(1), reads(1, ['ok']), edit(1), tool(1), ...(final ? [reply(1, 3, 'final')] : [])]
    }
    for (const mode of ['standard', 'detailed'] as const) {
      const folded = plan(turn(true), mode)
      expect(shape(folded)).toEqual(['user', 'header:closed:folded:hint', 'tool', 'assistant'])
      expect(folded[2]).toMatchObject({ entry: { name: 'edit' } })
      // Edits still count as tool calls.
      expect(folded[1]).toMatchObject({ kind: 'turn-header', toolCalls: 3 })
    }
    expect(shape(plan(turn(true), 'compact'))).toEqual(['user', 'header:closed:folded:hint', 'assistant'])
    expect(shape(plan(turn(true), 'verbose'))).toEqual(['user', 'header:closed:open', 'read-group', 'tool', 'tool', 'assistant'])
    // Running: the edit card shows at once, even pending, splitting the groups around it.
    const pending = [...turn(false).slice(0, 2), edit(1, { result: undefined }), tool(1, { result: undefined })]
    expect(shape(plan(pending, 'standard', { runningTurn: 1, turns: open }))).toEqual(['user', 'title:read', 'tool'])
    expect(shape(plan(pending, 'compact', { runningTurn: 1, turns: open }))).toEqual(['user'])
    // A failed turn keeps titles around its file changes; Compact titles them too.
    const failed = [...turn(false), { kind: 'transcript-error' as const, id: 'e', ...base(1), message: 'down' }]
    expect(shape(plan(failed, 'standard', { turns: [] }))).toEqual(['user', 'header:closed:open', 'title:read', 'tool', 'title:commands', 'error'])
    expect(shape(plan(failed, 'compact', { turns: [] }))).toEqual(['user', 'header:closed:open', 'title:read+edit+commands', 'error'])
    // Ctrl-O opens everything in scope.
    expect(shape(plan(turn(true), 'standard', { expanded: true }))).toEqual(['user+', 'header:closed:open', 'read-group+', 'tool+', 'tool+', 'assistant+'])
  })

  it('keeps compaction boundary rows visible in every mode and out of process groups', () => {
    const compaction = (overrides: Partial<Extract<TranscriptEntryModel, { kind: 'transcript-compaction' }>> = {}): TranscriptEntryModel => ({
      kind: 'transcript-compaction', id: `cmp${String(seq + 1)}`, ...base(1),
      state: 'ok', trigger: 'manual', startedAt: 0, endedAt: 1, shadowedCount: 3, shadowedTokens: 4_096, ...overrides,
    })
    seq = 0
    for (const mode of ['compact', 'standard', 'detailed'] as const) {
      expect(shape(plan([...turnOne(), compaction()], mode))).toEqual(['user', 'header:closed:folded:hint', 'assistant', 'compaction'])
    }
    seq = 0
    expect(shape(plan([...turnOne(), compaction()], 'verbose')))
      .toEqual(['user', 'header:closed:open', 'thinking', 'read-group', 'assistant', 'tool', 'thinking', 'tool', 'assistant', 'compaction'])
    // In a running turn the marker flushes the pending process group like an
    // error row does, splitting it into two titled groups.
    seq = 0
    const running = plan([user(1), tool(1), compaction({ state: 'running', trigger: 'auto', endedAt: undefined, shadowedCount: undefined, shadowedTokens: undefined }), tool(1)], 'standard', { runningTurn: 1, turns: [{ turn: 1, startedAt: 0 }] })
    expect(shape(running)).toEqual(['user', 'title:commands', 'compaction', 'title:commands'])
    // A lone compaction never invents a header or a group of its own.
    seq = 0
    expect(shape(plan([user(1), compaction()], 'standard'))).toEqual(['user', 'compaction'])
  })

  it('reports cancelled members and header counts without preparing calls', () => {
    seq = 0
    const pendingCall = tool(1, { result: undefined })
    const preparing = tool(1, { id: 'p', name: 'write', activity: 'write', result: undefined, preparing: { characters: 9 } })
    expect(shape(plan([user(1), pendingCall, preparing], 'standard', { runningTurn: 1 }))).toEqual(['user'])
    expect(plan([user(1), pendingCall, preparing], 'standard', { runningTurn: 1, runningHeader: true })[1]).toMatchObject({ kind: 'turn-header', toolCalls: 1 })
    expect(memberFacts(pendingCall, true)).toEqual([expect.objectContaining({ running: false, failed: false })])
    expect(memberFacts(tool(1, { terminal: { command: 'x', exitCode: 2 } }), true)).toEqual([expect.objectContaining({ failed: true })])
    expect(memberFacts(tool(1, { terminal: { command: 'x', signal: 'SIGTERM' } }), true)).toEqual([expect.objectContaining({ failed: true })])
    expect(memberFacts(tool(1, { terminal: { command: 'x', exitCode: 0 } }), true)).toEqual([expect.objectContaining({ failed: false })])
    expect(memberFacts(reads(1, ['pending', 'error']), false).map(fact => [fact.running, fact.failed])).toEqual([[true, false], [false, true]])
    const search: TranscriptEntryModel = { kind: 'transcript-search-group', id: 's', ...base(1), step: 0, searches: [{ callId: 's1', activity: 'search', detail: 'x', seq, updatedSeq: seq, turn: 1, step: 0, state: 'pending' }] }
    const commands: TranscriptEntryModel = { kind: 'transcript-command-group', id: 'g', ...base(1), step: 0, commands: [{ callId: 'g1', activity: 'commands', detail: 'ls', seq, updatedSeq: seq, turn: 1, step: 0, command: 'ls', state: 'error' }] }
    expect(memberFacts(search, false)).toEqual([expect.objectContaining({ running: true })])
    expect(memberFacts(commands, false)).toEqual([expect.objectContaining({ failed: true })])
    expect(memberFacts(user(1), false)).toEqual([])
  })

  it('passes turns without process, flat models, and canonical nodes through with ordering seqs', () => {
    seq = 0
    const simple = [user(2), reply(2, 0, 'hi')]
    expect(shape(plan(simple, 'standard'))).toEqual(['user', 'assistant'])
    expect(shape(plan(turnOne(), 'standard', { flat: true }))).toEqual(['user', 'thinking', 'read-group', 'assistant', 'tool', 'thinking', 'tool', 'assistant'])
    const node = { kind: 'text' as const, content: 'local' }
    const entries = turnOne()
    const items = plan([node, ...entries.slice(0, 3), node, ...entries.slice(3)], 'verbose', { previousSeq: 0 })
    expect(items[0]).toMatchObject({ kind: 'entry', seq: 0 })
    expect(shape(items)).toEqual(['text', 'user', 'header:closed:open', 'thinking', 'read-group', 'text', 'assistant', 'tool', 'thinking', 'tool', 'assistant'])
    // A canonical node inside a folded turn stays visible.
    expect(shape(plan([...entries.slice(0, 3), node, ...entries.slice(3)], 'standard'))).toEqual(['user', 'header:closed:folded:hint', 'text', 'assistant'])
  })

  it('resolves the running turn from the live overlay, open turn times, or the latest entry', () => {
    const entries = turnOne()
    const model = (overrides: Partial<TranscriptModel>): TranscriptModel => ({ kind: 'transcript', id: 'm', generation: 0, entries, ...overrides })
    expect(runningTurnOf(model({ live: { turn: 7, step: 0, entries: [] } }), entries)).toBe(7)
    expect(runningTurnOf(model({ streaming: false }), entries)).toBeUndefined()
    // A new turn opened without entries yet: the previous turn is closed.
    expect(runningTurnOf(model({ streaming: true, turns: [...closed, { turn: 2, startedAt: 50 }] }), entries)).toBe(2)
    expect(runningTurnOf(model({ streaming: true, turns: closed }), entries)).toBeUndefined()
    expect(runningTurnOf(model({ streaming: true }), entries)).toBe(1)
  })
})
