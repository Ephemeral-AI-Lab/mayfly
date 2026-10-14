/** Work-details display plan: the tier each view draws a call at, the turn header and its hint, the compact title line, file changes as members, compaction boundaries, and the running turn.
 * @module @ephemeral-ai/mayfly/tests/transcript/process-groups
 */
import { describe, expect, it } from 'vitest'
import type { TranscriptEntryModel, TranscriptModel, TranscriptTurnModel } from '../../src/frontend/models.ts'
import { buildDisplay, memberFacts, runningTurnOf, type DisplayItem } from '../../src/transcript/process-groups.ts'
import { PROCESS_POLICIES, type TranscriptViewMode } from '../../src/transcript/presentation-policy.ts'
import { withOverrides, type Overrides } from '../fixture-fields.ts'

type Entry = TranscriptModel['entries'][number]
let seq = 0
const base = (turn: number) => ({ seq: ++seq, updatedSeq: seq, turn })
const user = (turn: number, text = 'ask'): TranscriptEntryModel => ({ kind: 'transcript-user', id: `u${String(seq + 1)}`, ...base(turn), text, images: [] })
const reply = (turn: number, step: number, text: string): TranscriptEntryModel => ({ kind: 'transcript-assistant', id: `a${String(seq + 1)}`, ...base(turn), step, text, streaming: false })
const think = (turn: number, step: number, text = 'plan'): TranscriptEntryModel => ({ kind: 'transcript-thinking', id: `t${String(seq + 1)}`, ...base(turn), step, text, streaming: false })
type ToolEntry = Extract<TranscriptEntryModel, { kind: 'transcript-tool' }>
const tool = (turn: number, overrides: Overrides<ToolEntry> = {}): TranscriptEntryModel => withOverrides<ToolEntry>({
  kind: 'transcript-tool', id: `x${String(seq + 1)}`, ...base(turn), step: 1, callId: `c${String(seq)}`, name: 'bash', family: 'command',
  activity: 'commands', detail: 'pnpm test', arguments: '{}', startedAt: 0, result: { text: 'ok', isError: false, endedAt: 1 },
}, overrides)
const edit = (turn: number, overrides: Overrides<ToolEntry> = {}): TranscriptEntryModel =>
  tool(turn, { name: 'edit', family: 'edit', activity: 'edit', detail: 'src/a.ts', ...overrides })
const reads = (turn: number, states: readonly ('ok' | 'pending' | 'error')[]): TranscriptEntryModel => ({
  kind: 'transcript-read-group', id: `r${String(seq + 1)}`, ...base(turn), step: 0,
  reads: states.map((state, index) => ({ callId: `rc${String(index)}`, activity: 'read', detail: `f${String(index)}.ts`, seq, updatedSeq: seq, turn, step: 0, path: `f${String(index)}.ts`, state, name: 'read', startedAt: 0 })),
})

/** The turn of the decision tests: reads, a bash call, a subagent spawn, and the reasoning of each step around them. */
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
const running: TranscriptTurnModel[] = [{ turn: 1, startedAt: 0 }]

interface PlanOptions {
  readonly runningTurn?: number
  readonly turns?: TranscriptTurnModel[]
  /** Turns the reader opened (Ctrl-O's reach, or Enter on a header). */
  readonly open?: number[]
  /** Turns within Ctrl-O's reach, which name the key in their hints. */
  readonly scope?: number[]
  readonly flat?: boolean
  readonly previousSeq?: number
  readonly runningHeader?: boolean
}

function plan(entries: readonly Entry[], mode: TranscriptViewMode, options: PlanOptions = {}): DisplayItem[] {
  return buildDisplay({
    entries, policy: PROCESS_POLICIES[mode], runningTurn: options.runningTurn, turns: options.turns ?? closed,
    open: new Set(options.open ?? []), rows: new Set(), scope: new Set(options.scope ?? [1]), flat: options.flat ?? false,
    ...(options.previousSeq === undefined ? {} : { previousSeq: options.previousSeq }),
    ...(options.runningHeader === undefined ? {} : { runningHeader: options.runningHeader }),
  })
}

/** The tier of each tool or reasoning row the plan gives one, in order. */
function tiers(items: readonly DisplayItem[]): string[] {
  return items.flatMap(item => item.kind === 'entry' && item.tier !== undefined ? [`${item.entry.kind.replace('transcript-', '')}:${item.tier}`] : [])
}

/** A compact picture of the plan: each entry by kind (`+` when opened), each header by its state and hint, each title by its calls. */
function shape(items: readonly DisplayItem[]): string[] {
  return items.map((item) => {
    if (item.kind === 'entry') return `${item.entry.kind.replace('transcript-', '')}${item.expanded ? '+' : ''}`
    if (item.kind === 'turn-header') return `header:${item.running ? 'running' : 'closed'}${item.hint ? ':hint' : ''}`
    return `title:${String(item.toolCalls)}${item.hint ? ':hint' : ''}`
  })
}

describe('work-details display plan', () => {
  it('collects a completed turn into one title line at Compact, and keeps the blocks inline at Standard and Detailed', () => {
    // Compact: the turn's calls are one line where its first call was; the header is not drawn (nothing folds away).
    const compact = plan(turnOne(), 'compact')
    expect(shape(compact)).toEqual(['user', 'title:3:hint', 'assistant', 'assistant'])
    // A subagent spawn counts as a subagent, not also as a tool call: two reads and one command are three calls.
    expect(compact[1]).toMatchObject({ kind: 'process-title', toolCalls: 3, subagents: 1, failed: 0 })
    expect(shape(plan(turnOne(), 'compact', { scope: [] }))).toEqual(['user', 'title:3', 'assistant', 'assistant'])
    // Standard and Detailed keep the completed turn open: an open header that names the key, then the blocks inline.
    for (const mode of ['standard', 'detailed'] as const) {
      expect(shape(plan(turnOne(), mode))).toEqual(['user', 'header:closed:hint', 'thinking', 'read-group', 'assistant', 'tool', 'thinking', 'tool', 'assistant'])
      expect(shape(plan(turnOne(), mode, { scope: [] }))).toEqual(['user', 'header:closed', 'thinking', 'read-group', 'assistant', 'tool', 'thinking', 'tool', 'assistant'])
    }
  })

  it('gives each call the tier its view draws: standard inline, the latest step verbose in a live Detailed turn, verbose at Verbose', () => {
    expect(tiers(plan(turnOne(false), 'standard', { runningTurn: 1, turns: running }))).toEqual(['thinking:standard', 'read-group:standard', 'tool:standard', 'thinking:standard', 'tool:standard'])
    // Detailed: the steps before the latest collapse to blocks; the latest step's reasoning draws its body.
    expect(tiers(plan(turnOne(false), 'detailed', { runningTurn: 1, turns: running }))).toEqual(['thinking:standard', 'read-group:standard', 'tool:standard', 'thinking:verbose', 'tool:standard'])
    expect(tiers(plan(turnOne(false), 'verbose', { runningTurn: 1, turns: running }))).toEqual(['thinking:verbose', 'read-group:verbose', 'tool:verbose', 'thinking:verbose', 'tool:verbose'])
    // A settled Detailed turn is all standard.
    expect(tiers(plan(turnOne(), 'detailed'))).toEqual(['thinking:standard', 'read-group:standard', 'tool:standard', 'thinking:standard', 'tool:standard'])
  })

  it('keeps verbose flat under an open header, and Ctrl-O opens the turns it reaches only', () => {
    expect(shape(plan(turnOne(), 'verbose'))).toEqual(['user', 'header:closed', 'thinking', 'read-group', 'assistant', 'tool', 'thinking', 'tool', 'assistant'])
    expect(shape(plan(turnOne(), 'compact', { open: [1] }))).toEqual(['user+', 'header:closed', 'thinking+', 'read-group+', 'assistant+', 'tool+', 'thinking+', 'tool+', 'assistant+'])
    // A turn Ctrl-O did not open stays collected.
    expect(shape(plan(turnOne(), 'compact', { open: [], scope: [] }))).toEqual(['user', 'title:3', 'assistant', 'assistant'])
  })

  it('shows a running turn in the past tense: no header, the live blocks inline, and Compact hides the running process', () => {
    // The activity row owns the lifecycle: no running header.
    expect(shape(plan(turnOne(false), 'standard', { runningTurn: 1, turns: running }))).toEqual(['user', 'thinking', 'read-group', 'assistant', 'tool', 'thinking', 'tool'])
    // A tree without an activity row keeps its live header, which names the key.
    expect(shape(plan(turnOne(false), 'standard', { runningTurn: 1, turns: running, runningHeader: true }))).toEqual(['user', 'header:running:hint', 'thinking', 'read-group', 'assistant', 'tool', 'thinking', 'tool'])
    // A still-running spawn stays a process member, counted in the header, and is never a title.
    const spawning = [...turnOne(false).slice(0, -1), tool(1, { name: 'subagent', activity: 'subagents', detail: 'Review', result: undefined })]
    expect(plan(spawning, 'standard', { runningTurn: 1, turns: running, runningHeader: true })[1]).toMatchObject({ kind: 'turn-header', running: true, toolCalls: 3, subagents: 1 })
    // Reasoning and running calls draw their blocks in a live Standard turn.
    seq = 0
    expect(shape(plan([user(1), think(1, 0), reply(1, 1, 'interim'), think(1, 2)], 'standard', { runningTurn: 1, turns: running }))).toEqual(['user', 'thinking', 'assistant', 'thinking'])
    seq = 0
    expect(shape(plan([user(1), think(1, 0), tool(1, { result: undefined })], 'standard', { runningTurn: 1, turns: running }))).toEqual(['user', 'thinking', 'tool'])
    // Detailed and Verbose show every card.
    // Compact collects the running process too: its line counts up where the first call was, and nothing else of it draws.
    expect(shape(plan(turnOne(false), 'compact', { runningTurn: 1, turns: running }))).toEqual(['user', 'title:3:hint', 'assistant'])
    for (const mode of ['detailed', 'verbose'] as const) {
      expect(shape(plan(turnOne(false), mode, { runningTurn: 1, turns: running }))).toEqual(['user', 'thinking', 'read-group', 'assistant', 'tool', 'thinking', 'tool'])
    }
  })

  it('never collapses a stopped or failed turn at Standard, and titles a stopped turn\'s groups at Compact', () => {
    const aborted = [{ turn: 1, startedAt: 0, endedAt: 5, outcome: 'aborted' }]
    expect(shape(plan(turnOne(), 'compact', { turns: aborted }))).toEqual(['user', 'title:3:hint', 'assistant', 'assistant'])
    for (const mode of ['standard', 'detailed'] as const) {
      expect(shape(plan(turnOne(), mode, { turns: aborted }))).toEqual(['user', 'header:closed:hint', 'thinking', 'read-group', 'assistant', 'tool', 'thinking', 'tool', 'assistant'])
    }
    seq = 0
    const failed = [user(1), tool(1), { kind: 'transcript-error' as const, id: 'e', ...base(1), message: 'down' }]
    expect(shape(plan(failed, 'standard', { turns: [] }))).toEqual(['user', 'header:closed:hint', 'tool', 'error'])
    seq = 0
    const steered = [user(1), tool(1), user(1, 'steer'), tool(1), reply(1, 2, 'done')]
    expect(shape(plan(steered, 'standard'))).toEqual(['user', 'header:closed:hint', 'tool', 'user', 'tool', 'assistant'])
    // A call with no result in the stopped turn is still a process member of it.
    seq = 0
    expect(shape(plan([user(1), think(1, 0), tool(1, { result: undefined }), think(1, 1)], 'standard', { turns: aborted })))
      .toEqual(['user', 'header:closed:hint', 'thinking', 'tool', 'thinking'])
  })

  it('treats file changes as content from Standard up: each splits the blocks around it, and Compact collects them into the title', () => {
    const turn = (final: boolean): Entry[] => {
      seq = 0
      return [user(1), reads(1, ['ok']), edit(1), tool(1), ...(final ? [reply(1, 3, 'final')] : [])]
    }
    for (const mode of ['standard', 'detailed'] as const) {
      const items = plan(turn(true), mode)
      expect(shape(items)).toEqual(['user', 'header:closed:hint', 'read-group', 'tool', 'tool', 'assistant'])
      expect(items[3]).toMatchObject({ kind: 'entry', entry: { name: 'edit' } })
      // Edits still count as tool calls.
      expect(items[1]).toMatchObject({ kind: 'turn-header', toolCalls: 3 })
    }
    expect(shape(plan(turn(true), 'compact'))).toEqual(['user', 'title:3:hint', 'assistant'])
    // Running: the edit card shows at once, even pending, splitting the groups around it.
    const pending = [...turn(false).slice(0, 2), edit(1, { result: undefined }), tool(1, { result: undefined })]
    expect(shape(plan(pending, 'standard', { runningTurn: 1, turns: running }))).toEqual(['user', 'read-group', 'tool', 'tool'])
    // The calls still in flight keep their own compact lines under the title.
    expect(shape(plan(pending, 'compact', { runningTurn: 1, turns: running }))).toEqual(['user', 'title:3:hint', 'tool', 'tool'])
    // Ctrl-O opens everything in scope.
    expect(shape(plan(turn(true), 'standard', { open: [1] }))).toEqual(['user+', 'header:closed', 'read-group+', 'tool+', 'tool+', 'assistant+'])
  })

  it('keeps compaction boundary rows visible in every mode and out of process groups', () => {
    type CompactionEntry = Extract<TranscriptEntryModel, { kind: 'transcript-compaction' }>
    const compaction = (overrides: Overrides<CompactionEntry> = {}): TranscriptEntryModel => withOverrides<CompactionEntry>({
      kind: 'transcript-compaction', id: `cmp${String(seq + 1)}`, ...base(1),
      state: 'ok', trigger: 'manual', startedAt: 0, endedAt: 1, shadowedCount: 3, shadowedTokens: 4_096,
    }, overrides)
    seq = 0
    expect(shape(plan([...turnOne(), compaction()], 'compact'))).toEqual(['user', 'title:3:hint', 'assistant', 'assistant', 'compaction'])
    for (const mode of ['standard', 'detailed'] as const) {
      expect(shape(plan([...turnOne(), compaction()], mode)))
        .toEqual(['user', 'header:closed:hint', 'thinking', 'read-group', 'assistant', 'tool', 'thinking', 'tool', 'assistant', 'compaction'])
    }
    // In a running turn the marker flushes the pending process group like an error row does, splitting it into two groups of blocks.
    seq = 0
    const live = plan([user(1), tool(1), compaction({ state: 'running', trigger: 'auto', endedAt: undefined, shadowedCount: undefined, shadowedTokens: undefined }), tool(1)], 'standard', { runningTurn: 1, turns: running })
    expect(shape(live)).toEqual(['user', 'tool', 'compaction', 'tool'])
    // A lone compaction never invents a header or a group of its own.
    seq = 0
    expect(shape(plan([user(1), compaction()], 'standard'))).toEqual(['user', 'compaction'])
  })

  it('reports cancelled members and header counts, and counts a preparing call on no line', () => {
    seq = 0
    const pendingCall = tool(1, { result: undefined })
    const preparing = tool(1, { id: 'p', name: 'write', activity: 'write', result: undefined, preparing: { characters: 9 } })
    // The plan keeps running calls as members; the view draws them as pending lines (tool-calls `callsOf`).
    expect(shape(plan([user(1), pendingCall, preparing], 'standard', { runningTurn: 1, turns: running }))).toEqual(['user', 'tool', 'tool'])
    expect(plan([user(1), pendingCall, preparing], 'standard', { runningTurn: 1, turns: running, runningHeader: true })[1]).toMatchObject({ kind: 'turn-header', toolCalls: 1 })
    expect(memberFacts(pendingCall, true)).toEqual([expect.objectContaining({ running: false, failed: false })])
    expect(memberFacts(tool(1, { terminal: { command: 'x', exitCode: 2 } }), true)).toEqual([expect.objectContaining({ failed: true })])
    expect(memberFacts(tool(1, { terminal: { command: 'x', signal: 'SIGTERM' } }), true)).toEqual([expect.objectContaining({ failed: true })])
    expect(memberFacts(tool(1, { terminal: { command: 'x', exitCode: 0 } }), true)).toEqual([expect.objectContaining({ failed: false })])
    expect(memberFacts(reads(1, ['pending', 'error']), false).map(fact => [fact.running, fact.failed])).toEqual([[true, false], [false, true]])
    const search: TranscriptEntryModel = { kind: 'transcript-search-group', id: 's', ...base(1), step: 0, searches: [{ callId: 's1', activity: 'search', detail: 'x', seq, updatedSeq: seq, turn: 1, step: 0, name: 'grep', startedAt: 0, state: 'pending' }] }
    const commands: TranscriptEntryModel = { kind: 'transcript-command-group', id: 'g', ...base(1), step: 0, commands: [{ callId: 'g1', activity: 'commands', detail: 'ls', seq, updatedSeq: seq, turn: 1, step: 0, name: 'bash', startedAt: 0, command: 'ls', state: 'error' }] }
    expect(memberFacts(search, false)).toEqual([expect.objectContaining({ running: true })])
    expect(memberFacts(commands, false)).toEqual([expect.objectContaining({ failed: true })])
    expect(memberFacts(user(1), false)).toEqual([])
  })

  it('passes turns without process, flat models, and canonical nodes through with their ordering seqs', () => {
    seq = 0
    const simple = [user(2), reply(2, 0, 'hi')]
    expect(shape(plan(simple, 'standard'))).toEqual(['user', 'assistant'])
    expect(shape(plan(turnOne(), 'standard', { flat: true }))).toEqual(['user', 'thinking', 'read-group', 'assistant', 'tool', 'thinking', 'tool', 'assistant'])
    const node = { kind: 'text' as const, content: 'local' }
    const entries = turnOne()
    const items = plan([node, ...entries.slice(0, 3), node, ...entries.slice(3)], 'verbose', { previousSeq: 0 })
    expect(items[0]).toMatchObject({ kind: 'entry', seq: 0 })
    expect(shape(items)).toEqual(['text', 'user', 'header:closed', 'thinking', 'read-group', 'text', 'assistant', 'tool', 'thinking', 'tool', 'assistant'])
    // A canonical node inside a collected turn stays visible.
    expect(shape(plan([...entries.slice(0, 3), node, ...entries.slice(3)], 'compact'))).toEqual(['user', 'title:3:hint', 'text', 'assistant', 'assistant'])
  })

  it('resolves the running turn from the live overlay, open turn times, or the latest entry', () => {
    const entries = turnOne()
    const model = (overrides: Partial<TranscriptModel>): TranscriptModel => ({ kind: 'transcript', id: 'm', generation: 0, entries, ...overrides } as TranscriptModel)
    expect(runningTurnOf(model({ live: { turn: 7, step: 0, entries: [] } }), entries)).toBe(7)
    expect(runningTurnOf(model({ streaming: false }), entries)).toBeUndefined()
    // A new turn opened without entries yet: the previous turn is closed.
    expect(runningTurnOf(model({ streaming: true, turns: [...closed, { turn: 2, startedAt: 50 }] }), entries)).toBe(2)
    expect(runningTurnOf(model({ streaming: true, turns: closed }), entries)).toBeUndefined()
    expect(runningTurnOf(model({ streaming: true }), entries)).toBe(1)
  })

  it('ignores a live overlay pinned to a turn the model already closed or moved past', () => {
    const entries = turnOne()
    const model = (overrides: Partial<TranscriptModel>): TranscriptModel => ({ kind: 'transcript', id: 'm', generation: 0, entries, ...overrides } as TranscriptModel)
    // The turn row carries an end time: the overlay is stale, the turn closes.
    expect(runningTurnOf(model({ live: { turn: 1, step: 4, entries: [] }, streaming: true, turns: closed }), entries)).toBeUndefined()
    // A newer open turn row supersedes the pinned turn.
    expect(runningTurnOf(model({ live: { turn: 1, step: 4, entries: [] }, streaming: true, turns: [...closed, { turn: 2, startedAt: 50 }] }), entries)).toBe(2)
    // Newer durable entries alone supersede it when no turn rows exist.
    expect(runningTurnOf(model({ live: { turn: 0, step: 0, entries: [] }, streaming: true, turns: [] }), entries)).toBe(1)
    // Fresh overlays for the current or a not-yet-recorded turn still win.
    expect(runningTurnOf(model({ live: { turn: 1, step: 4, entries: [] }, streaming: true, turns: running }), entries)).toBe(1)
    expect(runningTurnOf(model({ live: { turn: 2, step: 0, entries: [] }, turns: closed }), entries)).toBe(2)
    // The display plan's last line of defense: a recorded end closes the turn no matter which runningTurn the caller resolved.
    expect(shape(plan(turnOne(), 'compact', { runningTurn: 1 }))).toEqual(['user', 'title:3:hint', 'assistant', 'assistant'])
  })
})
