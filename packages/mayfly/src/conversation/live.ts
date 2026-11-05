/**
 * Transient-only Assistant presentation derived from the official Client event window.
 * @module @ephemeral-ai/mayfly/conversation/live
 */
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  transientAssistantConversation,
  type ConversationProjection,
} from '../conversation.ts'

/** Replaceable live overlay; never retained as durable Session truth. */
export interface RemoteLiveConversation {
  readonly attemptId: string
  readonly turn: number
  readonly step: number
  readonly projection: ConversationProjection
}

/** Project only the latest transient attempt; durable entries are read from the Host projection instead. */
export function projectLiveConversation(entries: readonly SessionEventLikeEntry[]): RemoteLiveConversation | undefined {
  const latest = entries.findLast(entry => entry.type === 'transient')
  if (latest?.type !== 'transient') return undefined
  const attemptId = String(latest.event.data.attemptId)
  const chunks = entries.filter((entry): entry is Extract<SessionEventLikeEntry, { readonly type: 'transient' }> => (
    entry.type === 'transient' && String(entry.event.data.attemptId) === attemptId
  ))
  // A raw stream record carries its discriminant: the fold validates records
  // at the durable boundary, and a record without `type` is dropped silently.
  const stream = chunks.map(entry => ({ type: 'chunk' as const, time: entry.event.time, chunk: entry.event.data.chunk }))
  const { turn, step } = latest.event.data
  return {
    attemptId,
    turn,
    step,
    projection: transientAssistantConversation(stream, { seq: latest.event.seq, time: latest.event.time, turn, step }),
  }
}
