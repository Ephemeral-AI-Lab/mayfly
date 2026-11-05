/** Transient assistant presentation from one official Client attempt window. @module */
import type { AssistantStreamRecord } from '@deepseek-ai/dsh-llm'
import type { ConversationEntry, ConversationProjection } from './types.ts'
import { foldAssistantStreamRecords, initialAssistantStream } from '@ephemeral-ai/mayfly-host/conversation'

/** Render only the selected live attempt; durable history remains a Host projection. */
export function transientAssistantConversation(
  stream: readonly AssistantStreamRecord[],
  cursor: { readonly seq: number, readonly time: number, readonly turn: number, readonly step: number },
): ConversationProjection {
  const { seq, turn, step } = cursor
  const draft = foldAssistantStreamRecords(initialAssistantStream(), stream)
  const base = { seq, updatedSeq: seq, turn, step }
  const entries: ConversationEntry[] = []
  if (draft.reasoning.trim() !== '') entries.push({
    ...base, kind: 'thinking', id: `thinking:${String(turn)}:${String(step)}`,
    text: draft.reasoning, streaming: draft.phase === 'thinking',
    ...(draft.phase === 'thinking' ? { outputProgress: draft.outputProgress } : {}),
    durationMs: Math.max(0, draft.reasoningEndedAt! - draft.reasoningStartedAt!),
  })
  if (draft.text !== '') entries.push({
    ...base, kind: 'assistant', id: `assistant:${String(turn)}:${String(step)}`,
    text: draft.text, streaming: draft.phase === 'composing',
  })
  return { entries, streaming: true, settledSteps: [], turns: [] }
}
