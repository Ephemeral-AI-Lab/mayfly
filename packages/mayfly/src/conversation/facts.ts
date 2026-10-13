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
import type { AssistantStreamRecord, ContentBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tool-todo'
// Empty type import activates the compaction-lifecycle event declarations
// the meter cases below consume.
import type {} from '@deepseek-ai/dsh-compaction/types'
import { z } from 'zod'
import { everyAdmitted, identityAdmission } from './admission.ts'
import { outputProgressSchema } from './output-progress.ts'
import type { ConversationFactsState } from './types.ts'
import { foldAssistantStreamRecords, initialAssistantStream } from './stream-accumulator.ts'
import { argumentDetail } from './activity-detail.ts'
import { isSpawnToolName } from './projection.ts'

const todoSchema = z.object({
  content: z.string(),
  status: z.enum(['pending', 'in_progress', 'completed']),
})

/** Runtime schema for the persisted facts state. */
export const conversationFactsSchema = z.object({
  phase: z.enum(['idle', 'waiting', 'thinking', 'composing', 'tool']),
  active: z.boolean(),
  turn: z.number().int().nonnegative(),
  turnStartedAt: z.number().optional(),
  flowUp: z.number().nonnegative().optional(),
  flowDownChars: z.number().int().nonnegative(),
  outputProgress: outputProgressSchema.optional(),
  currentStep: z.number().int().nonnegative().optional(),
  lastCompletedStep: z.number().int().nonnegative().optional(),
  todos: z.array(todoSchema),
  contextTokens: z.number().nonnegative(),
  contextCacheReadTokens: z.number().nonnegative().optional(),
  contextWindow: z.number().positive().optional(),
  model: z.string().optional(),
  provider: z.string().optional(),
  reasoningEffort: z.string().optional(),
  promptText: z.string().optional(),
  epochToolCount: z.number().int().nonnegative().optional(),
  epochTokens: z.number().nonnegative().optional(),
  usageByStep: z.record(z.string(), z.number().nonnegative()).optional(),
  activity: z.object({
    kind: z.enum(['reasoning', 'text', 'tool']),
    name: z.string().optional(),
    preparing: z.boolean().optional(),
  }).optional(),
  inFlight: z.array(z.object({ callId: z.string(), name: z.string(), detail: z.string().optional(), preparing: z.boolean().optional() })).optional(),
  retrying: z.object({ retry: z.number(), maxRetries: z.number(), at: z.number(), delayMs: z.number(), reason: z.string().optional() }).optional(),
  runOutcome: z.enum(['completed', 'failed']).optional(),
  endedAt: z.number().optional(),
  agentCalls: z.array(z.object({
    seq: z.number().int(), turn: z.number().int().nonnegative(), step: z.number().int().nonnegative(),
    callId: z.string(), name: z.string(), arguments: z.string(), startedAt: z.number(),
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

/**
 * The context occupancy of one step: the disjoint input-side token counts
 * (`inputTokens + cacheReadTokens + cacheWriteTokens`). The single owner for
 * both the facts projection and the footer status readout.
 * @param usage - the step's token accounting.
 * @returns occupied context tokens.
 */
export function contextTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * Fold one expanded durable stream (the compact records an attempt or message
 * event embeds) into the facts state. Harness `0.1.5` moved streaming deltas
 * out of the session event log; the durable events now carry the same chunks
 * as timed records, so the phase machine runs over the expansion.
 */
function foldStreamChunks(
  state: ConversationFactsState,
  turn: number,
  step: number,
  stream: readonly AssistantStreamRecord[],
): ConversationFactsState {
  // Each durable assistant/attempt owns one complete compact stream. A retry
  // for the same step must replace the previous attempt's measurements rather
  // than inherit its phase or output-rate window.
  const initial = initialAssistantStream()
  const draft = foldAssistantStreamRecords(initial, stream)
  if (draft.chars === 0 && draft.phase === 'waiting') return { ...state, phase: 'waiting', active: true, turn, currentStep: step, outputProgress: undefined }
  return {
    ...state, phase: draft.phase, active: true, turn, currentStep: step,
    flowDownChars: state.flowDownChars + draft.chars,
    activity: draft.phase === 'waiting'
      ? state.activity
      : draft.phase === 'thinking' ? { kind: 'reasoning' } : { kind: 'text' },
    outputProgress: draft.outputProgress,
  }
}

/**
 * Fold one committed session event into the renderer-neutral facts state.
 * Unrelated events return the same state reference to avoid change-feed work.
 * The state stays plain JSON: the projection cache refuses a checkpoint that
 * holds `undefined`, so a field the fold clears is deleted, not kept.
 */
export function foldConversationFacts(
  state: ConversationFactsState,
  event: SessionEvent,
): ConversationFactsState {
  const next = foldFacts(state, event)
  return next === state ? state : withoutCleared(next)
}

/** The state without the fields set to `undefined`; the same reference when there are none. */
function withoutCleared(state: ConversationFactsState): ConversationFactsState {
  let plain: Record<string, unknown> | undefined
  for (const key in state) {
    if ((state as unknown as Record<string, unknown>)[key] !== undefined) continue
    plain ??= { ...state }
    delete plain[key]
  }
  return plain === undefined ? state : plain as unknown as ConversationFactsState
}

/** The salient argument of a committed call's raw JSON arguments, `''` when they do not parse. */
function detailOf(raw: string): string {
  try {
    return argumentDetail(JSON.parse(raw))
  } catch {
    return ''
  }
}

/** The failure a retry record carries, as a short reason. */
function retryReason(failure: unknown): string | undefined {
  if (typeof failure !== 'object' || failure === null) return undefined
  const { message, code } = failure as { readonly message?: unknown, readonly code?: unknown }
  const text = typeof code === 'string' && code !== '' ? code : typeof message === 'string' ? message : undefined
  return text === undefined ? undefined : text.replace(/\s+/gu, ' ').trim().slice(0, 80)
}

function foldFacts(
  state: ConversationFactsState,
  event: SessionEvent,
): ConversationFactsState {
  // The retry records are the retry plugin's events, which this package does not type.
  const kind: string = event.type
  if (kind === 'llm/retry') {
    const data = (event as unknown as { readonly data: { readonly retry: number, readonly maxRetries: number, readonly delayMs: number, readonly failure?: unknown } }).data
    const reason = retryReason(data.failure)
    return { ...state, retrying: { retry: data.retry, maxRetries: data.maxRetries, at: event.time, delayMs: data.delayMs, ...(reason === undefined ? {} : { reason }) } }
  }
  if (kind === 'llm/retry-started') return state.retrying === undefined ? state : { ...state, retrying: undefined }
  if (kind === 'assistant/message' && state.retrying !== undefined) return foldFacts({ ...state, retrying: undefined }, event)
  switch (event.type) {
    case 'turn/start':
      return {
        ...state, phase: 'waiting', active: true, turn: event.data.turn, turnStartedAt: event.time, flowUp: undefined,
        flowDownChars: 0, outputProgress: undefined, epochToolCount: 0, epochTokens: 0, usageByStep: {},
        activity: undefined, inFlight: undefined, retrying: undefined, runOutcome: undefined, endedAt: undefined, currentStep: undefined, lastCompletedStep: undefined,
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
    case 'assistant/attempt': {
      const { turn, step, stream } = event.data
      if (turn < state.turn || (turn === state.turn && (state.runOutcome !== undefined
        || (state.currentStep !== undefined && step < state.currentStep)
        || (state.lastCompletedStep !== undefined && step <= state.lastCompletedStep)))) return state
      return foldStreamChunks(state, turn, step, stream)
    }
    case 'assistant/message': {
      if (event.data.turn < state.turn) return state
      if (event.data.turn === state.turn && state.runOutcome !== undefined) return state
      let folded: ConversationFactsState = state
      const currentStep = state.currentStep === undefined || event.data.step >= state.currentStep
      if (currentStep) {
        folded = { ...state, phase: 'waiting', outputProgress: undefined, currentStep: event.data.step, lastCompletedStep: event.data.step }
      }
      // The assembled message embeds its own compact stream; folding it keeps
      // flow-down and phase measurements over successful attempts too.
      const streamed = currentStep
        ? { ...foldStreamChunks(folded, event.data.turn, event.data.step, event.data.stream), phase: 'waiting' as const, outputProgress: undefined }
        : folded
      const usage = event.data.usage
      if (usage === undefined) return streamed
      const used = contextTokens(usage)
      const total = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens
      const key = `${event.data.turn}/${event.data.step}`
      const usageByStep = { ...streamed.usageByStep, [key]: total }
      const epochTokens = Object.values(usageByStep).reduce((sum, value) => sum + value, 0)
      return { ...streamed, contextTokens: used, contextCacheReadTokens: usage.cacheReadTokens, flowUp: used, usageByStep, epochTokens }
    }
    case 'tool/call':
      if (isSpawnToolName(event.data.name)) {
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
        inFlight: [...(state.inFlight ?? []), { callId: String(event.data.callId), name: event.data.name, detail: detailOf(event.data.arguments) }],
      }
    case 'tool/result': {
      // Tool results are first-class tool-role messages; logs written before
      // that promotion wrapped them in a tool-result content block instead.
      const message = event.data.message
      if (message === undefined || typeof message !== 'object' || typeof message.toolCallId !== 'string') return state
      const callId = String(message.toolCallId)
      const index = state.agentCalls.findIndex(call => call.callId === callId)
      if (index < 0) {
        // A call that settled leaves the list of calls in flight.
        const remaining = (state.inFlight ?? []).filter(call => call.callId !== callId)
        return remaining.length === (state.inFlight ?? []).length ? state : { ...state, inFlight: remaining }
      }
      const content = Array.isArray(message.content) ? message.content : []
      const text = content
        .filter((item): item is Extract<ContentBlock, { type: 'text' }> => typeof item === 'object' && item !== null && item.type === 'text')
        .map(item => item.text)
        .join('\n')
      const result = { text, isError: message.isError === true || event.data.error !== undefined, endedAt: event.time }
      const agentCalls = [...state.agentCalls]
      agentCalls[index] = { ...agentCalls[index]!, result }
      return { ...state, phase: 'tool', active: true, agentCalls }
    }
    case 'step/end':
      if (event.data.turn < state.turn || (event.data.turn === state.turn && state.runOutcome !== undefined)) return state
      return { ...state, phase: 'waiting', active: true, turn: event.data.turn, outputProgress: undefined, inFlight: undefined, retrying: undefined }
    case 'turn/end':
      if (event.data.turn < state.turn || (event.data.turn === state.turn && state.runOutcome !== undefined)) return state
      return {
        ...state, phase: 'idle', active: false, turn: event.data.turn, outputProgress: undefined, inFlight: undefined, retrying: undefined,
        runOutcome: event.data.reason.kind === 'completed' ? 'completed' : 'failed', endedAt: event.time,
      }
    case 'todo/write':
      return { ...state, todos: event.data.todos.map(todo => ({ ...todo })) }
    case 'request/context':
      return event.data.contextWindow === state.contextWindow ? state : { ...state, contextWindow: event.data.contextWindow }
    // `compaction/summary` and `compaction/prune` are the metering events
    // paired with a surface `replace`: a consumer subtracts the shadow price
    // without retaining per-node prices. The summarize call's output tokens
    // stand in for the framed checkpoint; the post-replacement cache share
    // is unknown, so the stale segment clears until the next model step.
    case 'compaction/summary':
      return {
        ...state,
        contextTokens: Math.max(0, state.contextTokens - event.data.shadowedTokenCount + (event.data.usage?.outputTokens ?? 0)),
        contextCacheReadTokens: undefined,
      }
    case 'compaction/prune':
      return {
        ...state,
        contextTokens: Math.max(0, state.contextTokens - event.data.shadowedTokenCount),
        contextCacheReadTokens: undefined,
      }
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

/* Every committed event of every session re-validates a changed facts view.
   Spawn-class calls and the per-step usage record are retained by identity
   across folds, so they pass their strict schemas once; the small remainder
   stays strictly checked on each view. */
const admitAgentCalls = everyAdmitted(identityAdmission(conversationFactsSchema.shape.agentCalls.element))
const admitUsageByStep = identityAdmission(conversationFactsSchema.shape.usageByStep.unwrap())
const factsRemainderSchema = conversationFactsSchema.omit({ agentCalls: true, usageByStep: true })

function isFactsView(value: unknown): value is ConversationFactsState {
  if (typeof value !== 'object' || value === null) return false
  const { agentCalls, usageByStep, ...remainder } = value as Record<string, unknown>
  return admitAgentCalls(agentCalls)
    && (usageByStep === undefined || admitUsageByStep(usageByStep))
    && factsRemainderSchema.safeParse(remainder).success
}

/** Client-visible facts schema: strict, with retained objects memoized by identity. */
const conversationFactsViewSchema = z.custom<ConversationFactsState>(isFactsView, 'invalid conversation facts view')

export const conversationFactsProjectionDefinition: ConversationFactsProjectionDefinition = {
  key: 'mayflyConversationFacts',
  stateSchema: conversationFactsSchema,
  init: initialConversationFacts,
  apply: foldConversationFacts,
  wire: {
    viewSchema: conversationFactsViewSchema,
    view: state => ({
      ...state,
      todos: state.todos.map(todo => ({ ...todo })),
    }),
  },
  stateVersion: 8,
}
