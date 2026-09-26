/**
 * Pure assistant content and phase folding shared by live frames, reconnect
 * baselines, and durable attempt replay.
 *
 * @module @ephemeral-ai/mayfly/conversation/stream-accumulator
 */

import { expandAssistantStream, type AssistantStreamRecord, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { appendOutputProgress } from './output-progress.ts'
import type { OutputProgress } from './types.ts'

/** Visible output of one attempt; transport identity stays with its owner. */
export interface AssistantStreamState {
  readonly preparing?: readonly { readonly id: string, readonly name: string, readonly characters: number }[]
  readonly reasoning: string
  readonly text: string
  readonly phase: 'waiting' | 'thinking' | 'composing'
  readonly outputProgress: OutputProgress | undefined
  readonly updatedAt: number
  readonly chars: number
  /** Producer time of the first visible reasoning delta, absent before any. */
  readonly reasoningStartedAt?: number
  /** Producer time of the latest visible reasoning delta. */
  readonly reasoningEndedAt?: number
}

/** Empty attempt before its first visible output. */
export function initialAssistantStream(): AssistantStreamState {
  return { reasoning: '', text: '', phase: 'waiting', outputProgress: undefined, updatedAt: 0, chars: 0 }
}

/** Fold one trusted chunk using its original producer timestamp. */
export function foldAssistantStreamChunk(state: AssistantStreamState, chunk: StreamChunk, time: number): AssistantStreamState {
  if (chunk.type === 'tool-call-delta') {
    const calls = state.preparing ?? []
    const previous = calls.find(call => call.id === chunk.id)
    const name = chunk.name ?? previous?.name
    if (name === undefined) return state
    const call = { id: chunk.id, name, characters: (previous?.characters ?? 0) + chunk.argumentsDelta.length }
    return { ...state, preparing: previous === undefined ? [...calls, call] : calls.map(item => item.id === call.id ? call : item), phase: 'waiting', outputProgress: undefined, updatedAt: Math.max(state.updatedAt, time) }
  }
  if (chunk.type === 'reasoning-delta' || chunk.type === 'text-delta') {
    if (chunk.text === '') return state
    const reasoning = chunk.type === 'reasoning-delta'
    const text = reasoning ? state.reasoning + chunk.text : state.text + chunk.text
    const phase = reasoning ? 'thinking' : 'composing'
    if (reasoning && text.trim() === '') return { ...state, reasoning: text }
    const chars = reasoning && state.reasoning.trim() === '' ? text.length : chunk.text.length
    return {
      ...state,
      ...(reasoning ? { reasoning: text, reasoningStartedAt: state.reasoningStartedAt ?? time, reasoningEndedAt: time } : { text }),
      phase,
      outputProgress: appendOutputProgress(state.phase === phase ? state.outputProgress : undefined, chars, time),
      chars: state.chars + chars,
      updatedAt: Math.max(state.updatedAt, time),
    }
  }
  if (chunk.type === 'finish'
    || (chunk.type === 'block-start' && chunk.blockType !== 'reasoning')
    || (chunk.type === 'block-end' && ((chunk.block.type === 'reasoning' && state.phase === 'thinking')
      || (chunk.block.type === 'text' && state.phase === 'composing')))) {
    if (state.phase === 'waiting' && state.outputProgress === undefined) return state
    return { ...state, phase: 'waiting', outputProgress: undefined, updatedAt: Math.max(state.updatedAt, time) }
  }
  return state
}

/** Fold a compact baseline or one complete durable attempt exactly once. */
export function foldAssistantStreamRecords(state: AssistantStreamState, stream: readonly AssistantStreamRecord[] | undefined): AssistantStreamState {
  if (!Array.isArray(stream)) return state
  let chunks
  try {
    chunks = expandAssistantStream(stream)
  } catch {
    return state
  }
  let next = state
  for (const { chunk, time } of chunks) next = foldAssistantStreamChunk(next, chunk, time)
  return next
}
