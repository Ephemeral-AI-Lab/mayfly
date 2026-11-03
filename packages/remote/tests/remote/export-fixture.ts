/** Export facts shared by the frozen rc.2 samples and Remote formatter regressions. @module */
import type { ConversationEntry, ConversationProjection } from '@ephemeral-ai/mayfly-host/types'
import type { SessionWireEvent } from '@deepseek-ai/dsh-api-session-controller/types'

const base = { id: 'entry', seq: 1, updatedSeq: 1, turn: 0 }
const image = { attachmentId: 'image', mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1 }

export const projection: ConversationProjection = {
  streaming: false, settledSteps: [], turns: [],
  entries: [
    { ...base, kind: 'user', text: 'first question', images: [image, { ...image, name: 'sample.png' }] },
    { ...base, id: 'thinking', kind: 'thinking', step: 0, text: 'reasoning trail', streaming: false },
    { ...base, id: 'answer', kind: 'assistant', step: 0, text: '**answer** text', streaming: false },
    { ...base, id: 'tool-a', kind: 'tool', step: 0, callId: 'a', channel: 'transcript', name: 'read', arguments: '{"file_path":"a.ts"}', startedAt: 1, result: { text: 'result A', content: [], isError: false, endedAt: 2 } },
    { ...base, id: 'tool-b', kind: 'tool', step: 0, callId: 'b', channel: 'transcript', name: 'read', arguments: '{"file_path":"b.ts"}', startedAt: 1, result: { text: 'result B', content: [], isError: false, endedAt: 2 } },
    { ...base, id: 'error', kind: 'error', turn: 1, message: 'endpoint 404', code: 'ENDPOINT_404' },
    { ...base, id: 'interruption', kind: 'interrupted', turn: 2 },
    { ...base, id: 'compaction', kind: 'compaction', state: 'ok', trigger: 'auto', startedAt: 1 },
    { ...base, id: 'goal', kind: 'goal-change', operation: 'clear' },
    { ...base, id: 'round', kind: 'goal-round', round: 1 },
  ],
}

export function entry(value: object): ConversationEntry {
  return { ...base, ...value } as ConversationEntry
}

export function wire(type: string, data: unknown, seq = 1): SessionWireEvent {
  return { type, data: data as SessionWireEvent['data'], seq, time: seq }
}

export const events: readonly SessionWireEvent[] = [
  wire('turn/start', { turn: 0 }),
  wire('request/header', { reason: 'initial' }, 2),
  wire('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] }, 3),
  wire('user/message', { source: { kind: 'user-approval' }, content: [{ type: 'text', text: '  ' }, { type: 'image' }, { type: 'audio' }, { type: 'text', text: 'CONTEXT' }] }, 4),
  wire('step/start', { turn: 0, step: 0 }, 5),
  wire('assistant/attempt', { turn: 0, step: 0, stream: [{ type: 'reasoning-chunks', time0: 1, index: 0, dt: [], texts: ['private reasoning'] }, { type: 'text-chunks', time0: 2, index: 1, dt: [], texts: ['partial answer'] }] }, 6),
  wire('assistant/message', { turn: 0, step: 0, message: { content: [{ type: 'reasoning', text: 'reasoning trail' }, { type: 'text', text: 'the answer' }] }, usage: { inputTokens: 2097152, outputTokens: 9216, cacheReadTokens: 61440, cacheWriteTokens: 4096 } }, 7),
  wire('tool/call', { turn: 0, step: 0, name: 'read', arguments: '{"path":"a"}' }, 8),
  wire('tool/result', { message: { content: [{ type: 'text', text: 'file A' }] } }, 9),
  wire('tool/result', { meta: 'raw result', message: { content: [] }, error: { name: 'ToolError', code: 'E_TOOL' } }, 10),
  wire('step/end', { turn: 0, step: 0 }, 11),
  wire('turn/end', { turn: 0, reason: { kind: 'completed' } }, 12),
  wire('turn/start', { turn: 1 }, 13),
  wire('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'endpoint 404', code: 'ENDPOINT_404' } } }, 14),
]

export const exportedAt = new Date('2026-08-21T07:15:30.000Z')
