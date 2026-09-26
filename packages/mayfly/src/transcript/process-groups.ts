/**
 * Work-details display plan: the pure segmentation of transcript entries into
 * turn headers, process groups, and visible entries, mirroring the upstream
 * Harness Chat `TurnGroups` rules. Reasoning and tool calls are process
 * members; a reply, a user message, an error, or an interruption closes the
 * current group; the last group of a running turn stays open. A normally
 * completed turn folds everything but its final answer behind the turn
 * header. Rendering, timers, and width live elsewhere.
 *
 * @module @ephemeral-ai/mayfly/transcript/process-groups
 */

import type { TranscriptEntryModel, TranscriptModel, TranscriptTurnModel } from '../frontend/index.ts'
import type { ProcessPolicy } from './presentation-policy.ts'
import { summarizeProcess, type ProcessMemberFact, type ProcessSummary } from './process-activity.ts'

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
  /** Whether the turn's process and interim replies are hidden behind this row. */
  readonly folded: boolean
  /** Whether Ctrl-O reaches this turn, so the row may name the key. */
  readonly hint: boolean
}

/** One collapsed process group row. */
export interface ProcessTitleItem {
  readonly kind: 'process-title'
  readonly id: string
  readonly turn: number
  readonly seq: number
  readonly closed: boolean
  readonly summary: ProcessSummary
  /** Whether a running title appends its live detail. */
  readonly liveDetail: boolean
}

/** One visible entry with its disclosure state. */
export interface EntryItem {
  readonly kind: 'entry'
  readonly entry: Entry
  /** Anchor ordering seq: the entry's own, or the preceding one for canonical nodes. */
  readonly seq: number | undefined
  /** Whether Ctrl-O currently expands this entry's body. */
  readonly expanded: boolean
  /** Whether Ctrl-O reaches this entry, so hints may name the key. */
  readonly hint: boolean
  /** Whether the entry's turn has ended (pending calls read as cancelled). */
  readonly turnClosed: boolean
}

/** One row group of the display plan, in render order. */
export type DisplayItem = EntryItem | TurnHeaderItem | ProcessTitleItem

/** Inputs of one display plan. */
export interface DisplayInput {
  readonly entries: readonly Entry[]
  readonly policy: ProcessPolicy
  /** The running turn, or `undefined` when every turn has ended. */
  readonly runningTurn: number | undefined
  readonly turns?: readonly TranscriptTurnModel[] | undefined
  /** The global Ctrl-O toggle. */
  readonly expanded: boolean
  /** Turns within Ctrl-O's reach. */
  readonly scope: ReadonlySet<number>
  /** Plain or hand-built models: entries only, no headers, groups, or folds. */
  readonly flat: boolean
  /** The seq preceding the first entry, for canonical nodes that lead the slice. */
  readonly previousSeq?: number | undefined
}

function isSemantic(entry: Entry): entry is TranscriptEntryModel {
  return entry.kind.startsWith('transcript-')
}

function isMember(entry: Entry): boolean {
  return entry.kind === 'transcript-thinking' || entry.kind === 'transcript-tool'
    || entry.kind === 'transcript-read-group' || entry.kind === 'transcript-search-group' || entry.kind === 'transcript-command-group'
}

const ABNORMAL_OUTCOMES = new Set(['aborted', 'error', 'interrupted', 'forked'])

/** Whether a settled terminal run exited non-zero or by signal. */
function exitFailed(entry: Extract<TranscriptEntryModel, { readonly kind: 'transcript-tool' }>): boolean {
  const terminal = entry.terminal
  return terminal !== undefined && (terminal.signal !== undefined || (terminal.exitCode !== undefined && terminal.exitCode !== 0))
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
        detail: entry.detail,
      }]
    case 'transcript-read-group':
      return entry.reads.map(read => ({ activity: read.activity, running: !closed && read.state === 'pending', failed: read.state === 'error', detail: read.detail }))
    case 'transcript-search-group':
      return entry.searches.map(call => ({ activity: call.activity, running: !closed && call.state === 'pending', failed: call.state === 'error', detail: call.detail }))
    case 'transcript-command-group':
      return entry.commands.map(call => ({ activity: call.activity, running: !closed && call.state === 'pending', failed: call.state === 'error', detail: call.detail }))
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
  if (model.live !== undefined) return model.live.turn
  if (model.streaming !== true) return undefined
  const turns = model.turns ?? []
  if (turns.length > 0) return turns.findLast(turn => turn.endedAt === undefined)?.turn
  return entries.findLast(isSemantic)?.turn
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
  const plainEntry = (entry: Entry, turnClosed: boolean, expanded: boolean, hint: boolean): EntryItem => {
    if (isSemantic(entry)) lastSeq = entry.seq
    return { kind: 'entry', entry, seq: lastSeq, expanded, hint, turnClosed }
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
    // A flat model carries no lifecycle: its pending calls stay pending.
    const closed = !input.flat && turn !== input.runningTurn
    const inScope = input.scope.has(turn)
    const expandedTurn = input.expanded && inScope
    if (input.flat || !block.some(isMember)) {
      for (const entry of block) items.push(plainEntry(entry, closed, expandedTurn, inScope))
      continue
    }
    const lead = block.findIndex(entry => entry.kind !== 'transcript-user')
    const rest = block.slice(lead)
    const info = turnInfo.get(turn)
    const interleaved = rest.some(entry => entry.kind === 'transcript-user')
    const abnormal = (info?.outcome !== undefined && ABNORMAL_OUTCOMES.has(info.outcome))
      || rest.some(entry => entry.kind === 'transcript-error' || entry.kind === 'transcript-interrupted')
    const folded = input.policy.foldCompletedTurns && closed && !interleaved && !abnormal && !expandedTurn
    const grouped = !expandedTurn && (input.policy.stepGrouping === 'collapsed' || (input.policy.stepGrouping === 'history' && closed))
    const facts = rest.filter(isMember).flatMap(entry => memberFacts(entry, closed)).filter(fact => fact.preparing !== true)
    const subagents = facts.filter(fact => fact.activity === 'subagents').length
    for (const entry of block.slice(0, lead)) items.push(plainEntry(entry, closed, expandedTurn, inScope))
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
      folded,
      hint: folded && inScope,
    })
    lastSeq = headerSeq
    if (folded) {
      const answer = rest.findLast(entry => entry.kind === 'transcript-assistant')
      for (const entry of rest) {
        if (entry === answer || !isSemantic(entry)) items.push(plainEntry(entry, closed, expandedTurn, inScope))
      }
      lastSeq = (rest.findLast(isSemantic) as TranscriptEntryModel).seq
      continue
    }
    let pending: Entry[] = []
    const flush = (groupClosed: boolean): void => {
      if (pending.length === 0) return
      const members = pending
      pending = []
      if (!grouped) {
        for (const entry of members) items.push(plainEntry(entry, closed, expandedTurn, inScope))
        return
      }
      const head = members[0] as TranscriptEntryModel
      const reasoning = members.findLast(entry => entry.kind === 'transcript-thinking') as Extract<TranscriptEntryModel, { readonly kind: 'transcript-thinking' }> | undefined
      items.push({
        kind: 'process-title',
        id: `process:${head.id}`,
        turn,
        seq: head.seq,
        closed: groupClosed,
        summary: summarizeProcess(members.flatMap(entry => memberFacts(entry, groupClosed)), groupClosed ? '' : reasoning?.text ?? ''),
        liveDetail: input.policy.liveProcessDetail,
      })
      lastSeq = (members.findLast(isSemantic) as TranscriptEntryModel).seq
    }
    for (const entry of rest) {
      if (isMember(entry)) {
        pending.push(entry)
        continue
      }
      flush(true)
      items.push(plainEntry(entry, closed, expandedTurn, inScope))
    }
    flush(closed)
  }
  return items
}
