/**
 * Transient-only Assistant presentation derived from the official Client event window.
 * @module @ephemeral-ai/mayfly/conversation/live
 */
import type {
  SessionEventLikeEntry,
  SessionEventWindow,
  SessionTransientEventEntry,
} from '@deepseek-ai/dsh-api-session-controller/client'
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import { foldAssistantStreamRecords, initialAssistantStream } from '@ephemeral-ai/mayfly-host/conversation'
import type { ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import { transientAssistantProjection, type AssistantStreamDraft } from './transient.ts'

/** Replaceable live overlay; never retained as durable Session truth. */
export interface RemoteLiveConversation {
  readonly attemptId: string
  readonly turn: number
  readonly step: number
  readonly projection: ConversationProjection
}

/**
 * Current-attempt overlay over one official event window. A contiguous append
 * folds only its new chunks onto the attempt's retained stream state, so a turn
 * costs work linear in its deltas; every other change refolds the window.
 */
export class LiveConversationFold {
  private revision: number | undefined
  private attemptId: string | undefined
  private state: AssistantStreamDraft = initialAssistantStream()
  private value: RemoteLiveConversation | undefined

  /**
   * Follow one window revision.
   * @param window - the source's current window.
   * @returns the overlay of the window's latest transient attempt, if any.
   */
  advance(window: SessionEventWindow): RemoteLiveConversation | undefined {
    if (window.revision === this.revision) return this.value
    const change = window.change
    if (change.kind !== 'append' || this.revision === undefined || window.revision !== this.revision + 1) return this.reset(window)
    const chunks = change.entries.filter(isTransient)
    if (chunks.some(entry => String(entry.event.data.attemptId) !== this.attemptId)) return this.reset(window)
    this.revision = window.revision
    if (chunks.length > 0) this.fold(chunks)
    return this.value
  }

  /**
   * Refold the whole window, as after an attach, a hidden period, or a non-append change.
   * @param window - the source's current window.
   * @returns the overlay of the window's latest transient attempt, if any.
   */
  reset(window: SessionEventWindow): RemoteLiveConversation | undefined {
    this.revision = window.revision
    this.state = initialAssistantStream()
    this.value = undefined
    const entries = window.entries
    const latest = entries.findLast(isTransient)
    this.attemptId = latest === undefined ? undefined : String(latest.event.data.attemptId)
    if (latest !== undefined) this.fold(entries.filter(entry => isTransient(entry) && String(entry.event.data.attemptId) === this.attemptId) as SessionTransientEventEntry[])
    return this.value
  }

  /** Forget the observed window, as when its source detaches. */
  clear(): void {
    this.revision = undefined
    this.attemptId = undefined
    this.state = initialAssistantStream()
    this.value = undefined
  }

  private fold(chunks: readonly SessionTransientEventEntry[]): void {
    // A raw stream record carries its discriminant. The shared fold validates
    // records and rejects a batch holding an invalid one, so each record folds
    // alone: an invalid chunk is dropped identically by a refold and an append.
    for (const entry of chunks) {
      const record: AssistantStreamRecord = { type: 'chunk', time: entry.event.time, chunk: entry.event.data.chunk }
      this.state = foldAssistantStreamRecords(this.state, [record])
    }
    const latest = chunks.at(-1)!.event
    const { turn, step } = latest.data
    this.value = {
      attemptId: this.attemptId!,
      turn,
      step,
      projection: transientAssistantProjection(this.state, { seq: latest.seq, time: latest.time, turn, step }),
    }
  }
}

function isTransient(entry: SessionEventLikeEntry): entry is SessionTransientEventEntry {
  return entry.type === 'transient'
}
