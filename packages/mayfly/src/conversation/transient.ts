/** Transient assistant presentation from one official Client attempt window. @module */
import type { ConversationEntry, ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import { toolEntryId, type initialAssistantStream } from '@ephemeral-ai/mayfly-host/conversation'

/** One attempt's folded visible output, as the shared Host stream fold returns it. */
export type AssistantStreamDraft = ReturnType<typeof initialAssistantStream>

/** Cursor of the attempt's latest live chunk. */
export interface TransientCursor {
  readonly seq: number
  readonly time: number
  readonly turn: number
  readonly step: number
}

/** Render only the selected, already folded live attempt; durable history remains a Host projection. */
export function transientAssistantProjection(draft: AssistantStreamDraft, cursor: TransientCursor): ConversationProjection {
  const { seq, turn, step } = cursor
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
  for (const call of draft.preparing ?? []) entries.push({
    ...base, kind: 'tool', id: toolEntryId(call.id), callId: call.id, name: call.name, arguments: call.arguments,
    startedAt: call.startedAt, channel: 'transcript', preparing: { characters: call.characters },
  })
  return { entries, streaming: true, settledSteps: [], turns: [] }
}
