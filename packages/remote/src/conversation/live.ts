/**
 * Transient-only Assistant presentation derived from the official Client event window.
 * @module @ephemeral-ai/mayfly/conversation/live
 */
import type { SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import {
  foldConversationProjection, initialConversationState,
  type ConversationProjection,
} from '@ephemeral-ai/mayfly/conversation'

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
  const stream = chunks.map(entry => ({ time: entry.event.time, chunk: entry.event.data.chunk }))
  const { turn, step } = latest.event.data
  const event = {
    type: 'assistant/attempt',
    seq: latest.event.seq,
    time: latest.event.time,
    data: { turn, step, stream },
  } as never
  const state = foldConversationProjection(initialConversationState(), event)
  return {
    attemptId,
    turn,
    step,
    projection: {
      entries: state.entries,
      streaming: state.active,
      settledSteps: state.finalizedSteps,
      turns: state.turns,
    },
  }
}
