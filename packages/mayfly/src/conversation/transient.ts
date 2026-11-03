/** Transient assistant presentation from one official Client attempt window. @module */
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import type { ConversationProjection } from './types.ts'
import { foldConversationProjection, initialConversationState } from './projection.ts'

/** Render only the selected live attempt; durable history remains a Host projection. */
export function transientAssistantConversation(
  stream: readonly AssistantStreamRecord[],
  cursor: { readonly seq: number, readonly time: number, readonly turn: number, readonly step: number },
): ConversationProjection {
  const { seq, time, turn, step } = cursor
  const state = foldConversationProjection(initialConversationState(), {
    type: 'assistant/attempt', seq, time, data: { turn, step, stream },
  } as never)
  return { entries: state.entries, streaming: state.active, settledSteps: state.finalizedSteps, turns: state.turns }
}
