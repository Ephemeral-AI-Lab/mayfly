/**
 * State-versioned session facts projection shared by renderer-neutral status
 * and dock consumers. It is deliberately separate from the human transcript:
 * log-only UI facts such as todo snapshots and request usage do not belong in
 * the append-origin conversation rows.
 *
 * @module @ephemeral-ai/mayfly/conversation/facts
 */

import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-todo'
import { z } from 'zod'
import { appendOutputProgress, outputProgressSchema } from './output-progress.ts'
import type { ConversationFactsState } from './types.ts'

const todoSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

/** Runtime schema for the persisted facts state. */
export const conversationFactsSchema = z.object({
  phase: z.enum(['idle', 'waiting', 'thinking', 'composing', 'tool']),
  active: z.boolean(),
  turn: z.number().int().nonnegative(),
  flowUp: z.number().nonnegative().optional(),
  flowDownChars: z.number().int().nonnegative(),
  outputProgress: outputProgressSchema.optional(),
  currentStep: z.number().int().nonnegative().optional(),
  lastCompletedStep: z.number().int().nonnegative().optional(),
  todos: z.array(todoSchema),
  contextTokens: z.number().nonnegative(),
  contextWindow: z.number().positive().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  reasoningEffort: z.string().optional(),
  promptText: z.string().optional(),
  epochToolCount: z.number().int().nonnegative().optional(),
  epochTokens: z.number().nonnegative().optional(),
  usageByStep: z.record(z.string(), z.number().nonnegative()).optional(),
  activity: z.object({ kind: z.enum(['reasoning', 'text', 'tool']), name: z.string().optional() }).optional(),
  runOutcome: z.enum(['completed', 'failed']).optional(),
  endedAt: z.number().optional(),
  agentCalls: z.array(z.object({
    seq: z.number().int(), turn: z.number().int().nonnegative(), step: z.number().int().nonnegative(),
    callId: z.string(), name: z.enum(['subagent', 'subagent_fork']), arguments: z.string(), startedAt: z.number(),
    result: z.object({ text: z.string(), isError: z.boolean(), endedAt: z.number() }).optional(),
  })),
}) satisfies z.ZodType<ConversationFactsState>

/** Empty facts for a session with no committed events. */
export function initialConversationFacts(): ConversationFactsState {
  return {
    phase: 'idle',
    active: false,
    turn: 0,
    flowDownChars: 0,
    todos: [],
    contextTokens: 0,
    agentCalls: [],
  }
}

function contextTokens(usage: { inputTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number }): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * Fold one committed session event into the renderer-neutral facts state.
 * Unrelated events return the same state reference to avoid change-feed work.
 */
export function foldConversationFacts(
  state: ConversationFactsState,
  event: SessionEvent,
): ConversationFactsState {
  switch (event.type) {
    case 'turn/start':
      return {
        ...state, phase: 'waiting', active: true, turn: event.data.turn, flowUp: undefined,
        flowDownChars: 0, outputProgress: undefined, epochToolCount: 0, epochTokens: 0, usageByStep: {},
        activity: undefined, runOutcome: undefined, endedAt: undefined, currentStep: undefined, lastCompletedStep: undefined,
      }
    case 'user/message': {
      if (event.data.source?.kind !== 'user') return state
      const text = event.data.content
        .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
      return text === '' || text === state.promptText ? state : { ...state, promptText: text }
    }
    case 'step/start':
      return { ...state, phase: 'waiting', active: true, turn: event.data.turn, currentStep: event.data.step, flowUp: undefined, flowDownChars: 0, outputProgress: undefined }
    case 'assistant/chunk': {
      const { turn, step } = event.data
      if (turn < state.turn || (turn === state.turn && (state.runOutcome !== undefined
        || (state.currentStep !== undefined && step < state.currentStep)
        || (state.lastCompletedStep !== undefined && step <= state.lastCompletedStep)))) return state
      const { chunk } = event.data
      if (chunk.type === 'finish'
        || (chunk.type === 'block-end' && ((chunk.block.type === 'reasoning' && state.phase === 'thinking')
          || (chunk.block.type === 'text' && state.phase === 'composing')))
        || chunk.type === 'tool-call-delta'
        || (chunk.type === 'block-start' && chunk.blockType !== 'reasoning')) {
        return { ...state, phase: 'waiting', outputProgress: undefined }
      }
      if (chunk.type === 'reasoning-delta') {
        if (chunk.text.trim() === '' && state.phase !== 'thinking') return state
        if (chunk.text === '') return state
        return {
          ...state, phase: 'thinking', active: true, turn: event.data.turn, currentStep: step,
          flowDownChars: state.flowDownChars + chunk.text.length, activity: { kind: 'reasoning' },
          outputProgress: appendOutputProgress(state.phase === 'thinking' ? state.outputProgress : undefined, chunk.text.length, event.time),
        }
      }
      if (chunk.type === 'text-delta') {
        if (chunk.text === '') return state
        return {
          ...state, phase: 'composing', active: true, turn: event.data.turn, currentStep: step,
          flowDownChars: state.flowDownChars + chunk.text.length, activity: { kind: 'text' },
          outputProgress: appendOutputProgress(state.phase === 'composing' ? state.outputProgress : undefined, chunk.text.length, event.time),
        }
      }
      return state
    }
    case 'assistant/message':
      if (event.data.turn < state.turn) return state
      if (state.currentStep === undefined || event.data.step >= state.currentStep) {
        state = { ...state, phase: 'waiting', outputProgress: undefined, currentStep: event.data.step, lastCompletedStep: event.data.step }
      }
      return event.data.usage === undefined
        ? state
        : (() => {
          const used = contextTokens(event.data.usage)
          const usage = event.data.usage
          const total = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens
          const key = `${event.data.turn}/${event.data.step}`
          const usageByStep = { ...state.usageByStep, [key]: total }
          const epochTokens = Object.values(usageByStep).reduce((sum, value) => sum + value, 0)
          return { ...state, contextTokens: used, flowUp: used, usageByStep, epochTokens }
        })()
    case 'tool/call':
      if (event.data.name === 'subagent' || event.data.name === 'subagent_fork') {
        return {
          ...state,
          phase: 'tool', active: true, turn: event.data.turn, outputProgress: undefined,
          epochToolCount: (state.epochToolCount ?? 0) + 1,
          activity: { kind: 'tool', name: event.data.name },
          agentCalls: [...state.agentCalls, {
            seq: event.seq,
            turn: event.data.turn,
            step: event.data.step,
            callId: String(event.data.callId),
            name: event.data.name,
            arguments: event.data.arguments,
            startedAt: event.time,
          }],
        }
      }
      return {
        ...state, phase: 'tool', active: true, turn: event.data.turn, outputProgress: undefined,
        epochToolCount: (state.epochToolCount ?? 0) + 1,
        activity: { kind: 'tool', name: event.data.name },
      }
    case 'tool/result': {
      const message = event.data.message
      const block = message === undefined || typeof message !== 'object' || !Array.isArray(message.content) ? undefined : message.content[0]
      if (block === undefined || typeof block !== 'object' || block === null || block.type !== 'tool-result' || typeof block.toolCallId !== 'string') return state
      const callId = block.toolCallId
      const index = state.agentCalls.findIndex(call => call.callId === callId)
      if (index < 0) return state
      const content = Array.isArray(block.content) ? block.content : []
      const text = content
        .filter((item): item is Extract<typeof item, { type: 'text' }> => typeof item === 'object' && item !== null && item.type === 'text')
        .map(item => item.text)
        .join('\n')
      const result = { text, isError: block.isError === true || event.data.error !== undefined, endedAt: event.time }
      const agentCalls = [...state.agentCalls]
      agentCalls[index] = { ...agentCalls[index]!, result }
      return { ...state, phase: 'tool', active: true, agentCalls }
    }
    case 'step/end':
      return { ...state, phase: 'waiting', active: true, turn: event.data.turn, outputProgress: undefined }
    case 'turn/end':
      return {
        ...state, phase: 'idle', active: false, turn: event.data.turn, outputProgress: undefined,
        runOutcome: event.data.reason.kind === 'completed' ? 'completed' : 'failed', endedAt: event.time,
      }
    case 'todo/write':
      return { ...state, todos: event.data.todos.map(todo => ({ ...todo })) }
    case 'request/context':
      return event.data.contextWindow === state.contextWindow ? state : { ...state, contextWindow: event.data.contextWindow }
    case 'request/header': {
      const config = event.data.header.config
      return {
        ...state,
        model: config.model,
        provider: config.provider,
        ...(config.reasoningEffort === undefined ? { reasoningEffort: undefined } : { reasoningEffort: config.reasoningEffort }),
      }
    }
    default:
      return state
  }
}

/** Official session-projection registration for shared session facts. */
type ConversationFactsProjectionDefinition = Omit<
  ProjectionDefinition<'mayflyConversationFacts', ConversationFactsState>,
  'wire'
> & { wire: NonNullable<ProjectionDefinition<'mayflyConversationFacts', ConversationFactsState>['wire']> }

export const conversationFactsProjectionDefinition: ConversationFactsProjectionDefinition = {
  key: 'mayflyConversationFacts',
  stateSchema: conversationFactsSchema,
  init: initialConversationFacts,
  apply: foldConversationFacts,
  wire: {
    viewSchema: conversationFactsSchema,
    view: state => ({
      ...state,
      todos: state.todos.map(todo => ({ ...todo })),
    }),
  },
  stateVersion: 3,
}
