import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Client-only live Assistant chunk accepted by the presentation fold. */
export interface AssistantChunkEvent {
  readonly type: 'assistant/chunk'
  readonly seq: number
  readonly time: number
  readonly data: {
    readonly turn: number
    readonly step: number
    readonly chunk: StreamChunk
  }
}

/** Durable Session facts plus transient presentation rows from the official Client event window. */
export type ConversationInputEvent = SessionEvent | AssistantChunkEvent

/** Accept only append-origin surface messages; replacements need their own presentation semantics. */
export function isAppendSurfaceEvent(event: SessionEvent<'assistant/message' | 'tool/result' | 'user/message'>): boolean {
  return event.surfaceOp === undefined || event.surfaceOp === 'append'
}
