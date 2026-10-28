/**
 * Client-safe conversation values and projection-table declaration merges.
 *
 * @module @ephemeral-ai/mayfly-host/conversation/types
 */

import type { SessionProjectionSummaryExcluded } from '@deepseek-ai/dsh-session-projection/types'

/** Lossless JSON accepted by the Harness session log and projection cache. */
export type ConversationJson = null | boolean | number | string | ConversationJson[] | { [key: string]: ConversationJson }

/** Durable image reference copied from a user message without loading bytes. */
export interface ConversationImage {
  readonly attachmentId: string
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string | undefined
  readonly originalDimensions?: Readonly<{ width: number, height: number }> | undefined
}

interface ConversationEntryBase {
  readonly id: string
  readonly seq: number
  readonly updatedSeq: number
  readonly turn: number
}

/** One direct human message. Synthetic context injections are excluded. */
interface ConversationUserEntry extends ConversationEntryBase {
  readonly kind: 'user'
  readonly text: string
  readonly images: readonly ConversationImage[]
}

/** One assistant answer, updated in place while chunks arrive. */
interface ConversationAssistantEntry extends ConversationEntryBase {
  readonly kind: 'assistant'
  readonly step: number
  readonly text: string
  readonly streaming: boolean
}

/** One assistant reasoning block, separate from its visible answer. */
export interface ConversationThinkingEntry extends ConversationEntryBase {
  readonly kind: 'thinking'
  readonly step: number
  readonly text: string
  readonly streaming: boolean
  readonly outputProgress?: OutputProgress | undefined
  /** Producer-time span of the visible reasoning, when the stream recorded one. */
  readonly durationMs?: number | undefined
}

/** One turn's lifecycle times from committed `turn/start` and `turn/end` events. */
export interface ConversationTurn {
  readonly turn: number
  /** Envelope time of `turn/start`, or of `turn/end` when the start is absent. */
  readonly startedAt: number
  /** Envelope time of `turn/end`; absent while the turn is open. */
  readonly endedAt?: number | undefined
  /** The `turn/end` reason kind (`completed`, `aborted`, `error`, …). */
  readonly outcome?: string | undefined
}

/** Output within one streaming phase, measured from committed event timestamps. */
export interface OutputProgress {
  readonly chars: number
  readonly initialChars: number
  readonly startedAt: number
  readonly updatedAt: number
}

/** Canonical result facts preserved for an official tool presenter. */
interface ConversationToolResult {
  readonly content: readonly ConversationJson[]
  readonly text: string
  readonly isError: boolean
  readonly endedAt: number
  readonly meta?: ConversationJson | undefined
  /** The Harness's failure code of the result (`ABORTED`, `TOOL_OUTCOME_UNKNOWN`), when it carries one. */
  readonly code?: string | undefined
}

/** One tool call, paired with its result when available. */
export interface ConversationToolEntry extends ConversationEntryBase {
  readonly kind: 'tool'
  readonly step: number
  readonly callId: string
  readonly name: string
  readonly arguments: string
  readonly startedAt: number
  readonly channel: 'transcript' | 'todo' | 'agents'
  readonly result?: ConversationToolResult | undefined
}

/** Structured turn failure. */
interface ConversationErrorEntry extends ConversationEntryBase {
  readonly kind: 'error'
  readonly message: string
  readonly code?: string | undefined
}

/** Durable marker for a turn cut before normal completion. */
interface ConversationInterruptedEntry extends ConversationEntryBase {
  readonly kind: 'interrupted'
}

/** The goal verbs the durable `goal/change` event records. */
export type ConversationGoalOperation = 'create' | 'edit' | 'pause' | 'resume' | 'complete' | 'block' | 'clear'

/**
 * One change of the session goal, from its durable `goal/change` event (whoever made it: the model, `/goal`, or the
 * round driver). A clear carries only the operation; every other verb carries the post-change snapshot.
 */
export interface ConversationGoalChangeEntry extends ConversationEntryBase {
  readonly kind: 'goal-change'
  readonly operation: ConversationGoalOperation
  readonly objective?: string | undefined
  readonly blockedReason?: { readonly code: string, readonly message: string } | undefined
  readonly roundsStarted?: number | undefined
  readonly createdAt?: number | undefined
  readonly updatedAt?: number | undefined
}

/** One autonomous goal round starting: the `user/message` the round driver wrote, which the stream shows as a marker. */
export interface ConversationGoalRoundEntry extends ConversationEntryBase {
  readonly kind: 'goal-round'
  /** The positive round the driver admitted. */
  readonly round: number
}

/**
 * One compaction transaction's lifecycle: opened by the initiating
 * `command/run` (manual) or `compaction/start` (automatic), filled by
 * `compaction/summary`, and settled by `compaction/end` — or by `command/done`
 * when the transaction never opened. The row is the transcript's durable
 * boundary marker for a surface replacement the conversation itself filters.
 */
export interface ConversationCompactionEntry extends ConversationEntryBase {
  readonly kind: 'compaction'
  /** Transaction identity from `compaction/start`, for the summary/end pairing. */
  readonly compactionId?: string | undefined
  /** The initiating `/compact` execution's pairing id, for `command/done`. */
  readonly commandId?: string | undefined
  readonly state: 'running' | 'ok' | 'error'
  /** Whether a human command or in-turn pressure/overflow triggered the run. */
  readonly trigger: 'manual' | 'auto'
  readonly startedAt: number
  readonly endedAt?: number | undefined
  /** When the summary landed: the instant the run moves from summarizing to applying. */
  readonly summaryAt?: number | undefined
  readonly shadowedCount?: number | undefined
  readonly shadowedTokens?: number | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
  /** The checkpoint summary text, for the expanded view. */
  readonly summary?: string | undefined
  /** The initiating command's own outcome text (e.g. "No compactable history yet."). */
  readonly detail?: string | undefined
  readonly error?: string | undefined
}

/** Complete frontend-relevant entry vocabulary of the projection. */
export type ConversationEntry =
  | ConversationUserEntry
  | ConversationAssistantEntry
  | ConversationThinkingEntry
  | ConversationToolEntry
  | ConversationErrorEntry
  | ConversationInterruptedEntry
  | ConversationCompactionEntry
  | ConversationGoalChangeEntry
  | ConversationGoalRoundEntry

/** Client-visible whole value served by `sessionProjections`. */
export interface ConversationProjection {
  readonly entries: readonly ConversationEntry[]
  readonly streaming: boolean
  /** Step keys whose assistant settlement is authoritative. */
  readonly settledSteps: readonly string[]
  /** Lifecycle times of every retained turn, in start order. */
  readonly turns: readonly ConversationTurn[]
}

/** One running compaction row and the ids its pending lifecycle events pair by. */
export interface OpenCompaction {
  /** The entry id of the running row. */
  readonly entryId: string
  /** The transaction id, once the `/compact` row adopts a `compaction/start`. */
  readonly compactionId?: string | undefined
  /** The initiating command id of a manual row, for `command/done`. */
  readonly commandId?: string | undefined
}

/** Plain-JSON internal fold state checkpointed by the registry. */
export interface ConversationProjectionState {
  readonly entries: readonly ConversationEntry[]
  readonly currentTurn: number
  readonly active: boolean
  readonly streamingStep: string | null
  readonly streamingAssistantId: string | null
  readonly streamingThinkingId: string | null
  readonly pendingReasoning: string
  readonly finalizedSteps: readonly string[]
  /** Running compaction rows, so lifecycle events pair by id instead of scanning the history. */
  readonly openCompactions: readonly OpenCompaction[]
  readonly interruptedTurns: readonly number[]
  /** Turns durably erased by Mayfly's safe-retraction surface marker. */
  readonly retractedTurns: readonly number[]
  readonly turns: readonly ConversationTurn[]
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Full conversation entries; excluded from Session summary payloads. */
    mayflyConversation: SessionProjectionSummaryExcluded<ConversationProjection>
  }

  interface SessionProjectionStateMap {
    mayflyConversation: ConversationProjectionState
  }
}
