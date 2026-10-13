/**
 * Work-details display plan: the pure segmentation of transcript entries into
 * turn headers, process groups, and visible entries, after the upstream
 * Harness Chat `TurnGroups` rules. Reasoning and tool calls are process
 * members; a reply, a user message, an error, or an interruption closes the
 * current group. A call in flight is a line of its own at every level. At the compact level a turn's process is collected
 * into one line (`▸ 6 tool calls`) that stands where its first call was and counts up as the turn works, so nothing folds
 * away at the end; a running turn has no header unless its tree has no activity row. Rendering and width live elsewhere.
 *
 * @module @ephemeral-ai/mayfly/transcript/process-groups
 */

import type { TranscriptEntryModel, TranscriptModel, TranscriptTurnModel } from '../frontend/models.ts'
import type { ProcessPolicy } from './presentation-policy.ts'
import { summarizeProcess, type ProcessMemberFact } from './process-activity.ts'

type Entry = TranscriptModel['entries'][number]

/** One turn header row: the whole-turn disclosure and its lifecycle label. */
export interface TurnHeaderItem {
  readonly kind: 'turn-header'
  readonly id: string
  readonly turn: number
  readonly seq: number
  readonly running: boolean
  readonly startedAt?: number | undefined
  readonly endedAt?: number | undefined
  readonly outcome?: string | undefined
  /** Tool calls other than subagent spawns; the row renders counts only once the turn ends. */
  readonly toolCalls: number
  /** Subagent spawns, counted apart from tool calls as upstream does. */
  readonly subagents: number
  /** Whether Ctrl-O reaches this turn, so the row may name the key. */
  readonly hint: boolean
}

/** The line that collects a turn's process at the compact level: how many calls it made, and how they went. */
export interface ProcessTitleItem {
  readonly kind: 'process-title'
  readonly id: string
  readonly turn: number
  readonly seq: number
  /** Tool calls other than subagent spawns, those in flight included. */
  readonly toolCalls: number
  readonly subagents: number
  readonly failed: number
  /** Wall time of the calls, once every one of them has settled. */
  readonly durationMs?: number
  /** Lines the calls' file changes added and removed, when any made one. */
  readonly added?: number
  readonly removed?: number
  /** Whether Ctrl-O reaches this turn, so the line may name the key. */
  readonly hint: boolean
}

/** One visible entry with its disclosure state. */
export interface EntryItem {
  readonly kind: 'entry'
  readonly entry: Entry
  /** Anchor ordering seq: the entry's own, or the preceding one for canonical nodes. */
  readonly seq: number | undefined
  /** Whether this entry's body is drawn in full: its turn is open, or the reader lifted it. */
  readonly expanded: boolean
  /** Whether Ctrl-O reaches this entry, so hints may name the key. */
  readonly hint: boolean
  /** Whether the entry's turn has ended (pending calls read as cancelled). */
  readonly turnClosed: boolean
  /**
   * How a tool entry is drawn: `verbose` is one block per call with its body, `standard` lets a run of calls of one kind
   * share a block, `compact` keeps only the calls still in flight, as their lines. Absent on a plain (flat) model, where
   * each call is a verbose block.
   */
  readonly tier?: 'verbose' | 'standard' | 'compact'
}

/** One row group of the display plan, in render order. */
export type DisplayItem = EntryItem | TurnHeaderItem | ProcessTitleItem

/** Inputs of one display plan. */
interface DisplayInput {
  readonly entries: readonly Entry[]
  readonly policy: ProcessPolicy
  /** The running turn, or `undefined` when every turn has ended. */
  readonly runningTurn: number | undefined
  readonly turns?: readonly TranscriptTurnModel[] | undefined
  /** Turns drawn at their Verbose tier: Ctrl-O's reach, flipped by Enter on a header, plus the turns a search holds open. */
  readonly open: ReadonlySet<number>
  /** Entries whose body the reader lifted to its full rows. */
  readonly rows: ReadonlySet<string>
  /** Turns within Ctrl-O's reach, so hints may name the key. */
  readonly scope: ReadonlySet<number>
  /** Plain or hand-built models: entries only, no headers, groups, or folds. */
  readonly flat: boolean
  /** The seq preceding the first entry, for canonical nodes that lead the slice. */
  readonly previousSeq?: number | undefined
  /** Whether a running turn keeps its live header (trees without an activity row). */
  readonly runningHeader?: boolean | undefined
}

function isSemantic(entry: Entry): entry is TranscriptEntryModel {
  return entry.kind.startsWith('transcript-')
}

function isMember(entry: Entry): boolean {
  return entry.kind === 'transcript-thinking' || entry.kind === 'transcript-tool'
    || entry.kind === 'transcript-read-group' || entry.kind === 'transcript-search-group' || entry.kind === 'transcript-command-group'
}

/** Whether a settled terminal run exited non-zero or by signal. */
function exitFailed(entry: Extract<TranscriptEntryModel, { readonly kind: 'transcript-tool' }>): boolean {
  const terminal = entry.terminal
  return terminal !== undefined && (terminal.signal !== undefined || (terminal.exitCode !== undefined && terminal.exitCode !== 0))
}

function times(call: { readonly startedAt: number, readonly endedAt?: number }): { readonly startedAt: number, readonly endedAt?: number } {
  return { startedAt: call.startedAt, ...(call.endedAt === undefined ? {} : { endedAt: call.endedAt }) }
}

/**
 * The summary facts one process member contributes.
 * @param entry - a process member entry.
 * @param closed - whether its turn has ended (nothing still runs).
 * @returns zero or more member facts; reasoning contributes none.
 */
export function memberFacts(entry: Entry, closed: boolean): ProcessMemberFact[] {
  switch (entry.kind) {
    case 'transcript-tool':
      return [{
        activity: entry.activity,
        running: !closed && entry.result === undefined,
        ...(entry.preparing === undefined ? {} : { preparing: true }),
        failed: entry.result?.isError === true || exitFailed(entry),
        startedAt: entry.startedAt,
        ...(entry.result === undefined ? {} : { endedAt: entry.result.endedAt }),
        ...(entry.change === undefined ? {} : { added: entry.change.added, removed: entry.change.removed }),
      }]
    case 'transcript-read-group':
      return entry.reads.map(read => ({ activity: read.activity, running: !closed && read.state === 'pending', failed: read.state === 'error', ...times(read) }))
    case 'transcript-search-group':
      return entry.searches.map(call => ({ activity: call.activity, running: !closed && call.state === 'pending', failed: call.state === 'error', ...times(call) }))
    case 'transcript-command-group':
      return entry.commands.map(call => ({ activity: call.activity, running: !closed && call.state === 'pending', failed: call.state === 'error', ...times(call) }))
    default:
      return []
  }
}

/**
 * Resolve the running turn: the live overlay's turn, else (while streaming)
 * the latest turn the projection still holds open, else the latest entry turn
 * when the model carries no turn times.
 * @param model - the transcript model.
 * @param entries - the model's windowed entries.
 * @returns the running turn, or `undefined`.
 */
export function runningTurnOf(model: TranscriptModel, entries: readonly Entry[]): number | undefined {
  const live = model.live
  if (live !== undefined && !liveTurnStale(model, live.turn, entries)) return live.turn
  if (model.streaming !== true) return undefined
  const turns = model.turns ?? []
  if (turns.length > 0) return turns.findLast(turn => turn.endedAt === undefined)?.turn
  return entries.findLast(isSemantic)?.turn
}

/**
 * Whether the model itself proves the live overlay's turn ended or was
 * superseded: its turn row carries an end time, a newer turn row exists, or a
 * newer durable entry does. A stale overlay must not pin a settled turn open.
 * @param model - the transcript model.
 * @param turn - the overlay's pinned turn.
 * @param entries - the model's windowed entries.
 * @returns whether the overlay turn is stale.
 */
function liveTurnStale(model: TranscriptModel, turn: number, entries: readonly Entry[]): boolean {
  const turns = model.turns ?? []
  if (turns.some(item => item.turn > turn || (item.turn === turn && item.endedAt !== undefined))) return true
  return (entries.findLast(isSemantic)?.turn ?? -1) > turn
}

/**
 * Build the display plan for one contiguous slice of entries.
 * @param input - entries, policy, running turn, and disclosure state.
 * @returns the ordered display items.
 */
export function buildDisplay(input: DisplayInput): DisplayItem[] {
  const items: DisplayItem[] = []
  let lastSeq = input.previousSeq
  const turnInfo = new Map((input.turns ?? []).map(turn => [turn.turn, turn]))
  const plainEntry = (entry: Entry, turnClosed: boolean, expanded: boolean, hint: boolean, tier?: 'verbose' | 'standard' | 'compact'): EntryItem => {
    if (isSemantic(entry)) lastSeq = entry.seq
    return { kind: 'entry', entry, seq: lastSeq, expanded: expanded || (isSemantic(entry) && input.rows.has(entry.id)), hint, turnClosed, ...(tier === undefined ? {} : { tier }) }
  }
  let index = 0
  const entries = input.entries
  while (index < entries.length) {
    const first = entries[index]!
    if (!isSemantic(first)) {
      items.push(plainEntry(first, true, false, false))
      index += 1
      continue
    }
    // One turn block: contiguous entries of the same turn, canonical nodes included.
    const turn = first.turn
    const block: Entry[] = []
    while (index < entries.length) {
      const entry = entries[index]!
      if (isSemantic(entry) && entry.turn !== turn) break
      block.push(entry)
      index += 1
    }
    // A flat model carries no lifecycle: its pending calls stay pending. A turn
    // row with a recorded end is closed no matter what runningTurn says.
    const info = turnInfo.get(turn)
    const closed = !input.flat && (info?.endedAt !== undefined || turn !== input.runningTurn)
    const inScope = input.scope.has(turn)
    const expandedTurn = input.open.has(turn)
    if (input.flat || !block.some(isMember)) {
      for (const entry of block) items.push(plainEntry(entry, closed, expandedTurn, inScope))
      continue
    }
    const lead = block.findIndex(entry => entry.kind !== 'transcript-user')
    const rest = block.slice(lead)
    const policy = input.policy
    const view = expandedTurn ? 'cards' : closed ? policy.settledProcess : policy.liveProcess
    // The step the model works in: at the `current` view its calls are verbose blocks and the steps before it collapse.
    const currentStep = rest.reduce((latest, entry) => isSemantic(entry) && 'step' in entry ? Math.max(latest, entry.step) : latest, -1)
    const facts = rest.filter(isMember).flatMap(entry => memberFacts(entry, closed)).filter(fact => fact.preparing !== true)
    const subagents = facts.filter(fact => fact.activity === 'subagents').length
    for (const entry of block.slice(0, lead)) items.push(plainEntry(entry, closed, expandedTurn, inScope))
    // The activity row owns a running turn's lifecycle; only a tree without
    // one keeps the live header.
    if ((closed || input.runningHeader === true) && view !== 'collect') {
      const headerSeq = (rest.find(isSemantic) as TranscriptEntryModel).seq
      items.push({
        kind: 'turn-header',
        id: `turn-header:${String(turn)}`,
        turn,
        seq: headerSeq,
        running: !closed,
        ...(info === undefined ? {} : {
          startedAt: info.startedAt,
          ...(info.endedAt === undefined ? {} : { endedAt: info.endedAt }),
          ...(info.outcome === undefined ? {} : { outcome: info.outcome }),
        }),
        toolCalls: facts.length - subagents,
        subagents,
        // Ctrl+O names itself wherever it would open more: a view short of the verbose blocks.
        hint: inScope && !expandedTurn && view !== 'cards',
      })
      lastSeq = headerSeq
    }
    // The compact level: the turn's calls are one line where its first call was, and only what is in flight keeps its own line.
    if (view === 'collect') {
      const calls = rest.filter(isMember).flatMap(entry => memberFacts(entry, closed)).filter(fact => fact.preparing !== true)
      const settled = calls.every(fact => !fact.running)
      const summary = summarizeProcess(calls.filter(fact => !fact.running))
      let collected = calls.length === 0
      for (const entry of rest) {
        if (!isMember(entry)) {
          items.push(plainEntry(entry, closed, expandedTurn, inScope))
          continue
        }
        if (!collected) {
          collected = true
          items.push({
            kind: 'process-title',
            id: `process:${String(turn)}`,
            turn,
            seq: (entry as TranscriptEntryModel).seq,
            toolCalls: calls.length - subagents,
            subagents,
            failed: summary.failed,
            ...(settled && summary.durationMs !== undefined ? { durationMs: summary.durationMs } : {}),
            ...(summary.added === undefined ? {} : { added: summary.added, removed: summary.removed ?? 0 }),
            hint: inScope && !expandedTurn,
          })
        }
        const inFlight = entry.kind === 'transcript-thinking' ? entry.streaming : memberFacts(entry, closed).some(fact => fact.running)
        if (inFlight) items.push(plainEntry(entry, closed, expandedTurn, inScope, 'compact'))
        else lastSeq = (entry as TranscriptEntryModel).seq
      }
      continue
    }
    let pending: Entry[] = []
    const flush = (): void => {
      if (pending.length === 0) return
      const members = pending
      pending = []
      for (const entry of members) {
        const verbose = view === 'cards' || (view === 'current' && 'step' in entry && entry.step === currentStep)
        items.push(plainEntry(entry, closed, expandedTurn, inScope, verbose ? 'verbose' : 'standard'))
      }
    }
    for (const entry of rest) {
      if (isMember(entry)) {
        pending.push(entry)
        continue
      }
      flush()
      items.push(plainEntry(entry, closed, expandedTurn, inScope))
    }
    flush()
  }
  return items
}
