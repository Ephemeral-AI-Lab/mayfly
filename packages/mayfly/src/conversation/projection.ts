/**
 * Pure, state-versioned projection from committed Harness session events to
 * an append-origin human conversation. The registry owns all subscription,
 * watermark, checkpoint, and Fiber lifecycle behavior.
 *
 * @module @ephemeral-ai/mayfly/conversation/projection
 */

import type { ContentBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import { isAppendSurfaceEvent, type SessionEvent } from '@deepseek-ai/dsh-session'
// Empty type imports activate the command- and compaction-lifecycle event
// declaration merges the fold below consumes.
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-compaction/types'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { everyAdmitted, identityAdmission } from './admission.ts'
import { outputProgressSchema } from './output-progress.ts'
import { foldAssistantStreamRecords, initialAssistantStream, type AssistantStreamState } from './stream-accumulator.ts'
import type {
  ConversationCompactionEntry,
  ConversationEntry,
  ConversationImage,
  ConversationJson,
  ConversationProjection,
  ConversationProjectionState,
  ConversationThinkingEntry,
  ConversationToolEntry,
  ConversationTurn,
} from './types.ts'

const jsonSchema: z.ZodType<ConversationJson> = z.lazy(() => z.union([
  z.null(),
  z.boolean(),
  z.number(),
  z.string(),
  z.array(jsonSchema),
  z.record(z.string(), jsonSchema),
]))

const imageSchema = z.object({
  attachmentId: z.string(),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  bytes: z.number().nonnegative(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
  name: z.string().optional(),
  originalDimensions: z.object({ width: z.number().nonnegative(), height: z.number().nonnegative() }).optional(),
})

const entryBase = {
  id: z.string(),
  seq: z.number().int(),
  updatedSeq: z.number().int(),
  turn: z.number().int().nonnegative(),
}

const conversationEntriesSchema = z.array(z.discriminatedUnion('kind', [
  z.object({ ...entryBase, kind: z.literal('user'), text: z.string(), images: z.array(imageSchema) }),
  z.object({ ...entryBase, kind: z.literal('assistant'), step: z.number().int().nonnegative(), text: z.string(), streaming: z.boolean() }),
  z.object({ ...entryBase, kind: z.literal('thinking'), step: z.number().int().nonnegative(), text: z.string(), streaming: z.boolean(), outputProgress: outputProgressSchema.optional(), durationMs: z.number().nonnegative().optional() }),
  z.object({
    ...entryBase,
    kind: z.literal('tool'),
    step: z.number().int().nonnegative(),
    callId: z.string(),
    name: z.string(),
    arguments: z.string(),
    startedAt: z.number(),
    channel: z.union([z.literal('transcript'), z.literal('todo'), z.literal('agents')]),
    result: z.object({
      content: z.array(jsonSchema),
      text: z.string(),
      isError: z.boolean(),
      endedAt: z.number(),
      meta: jsonSchema.optional(),
    }).optional(),
  }),
  z.object({ ...entryBase, kind: z.literal('error'), message: z.string(), code: z.string().optional() }),
  z.object({ ...entryBase, kind: z.literal('interrupted') }),
  z.object({
    ...entryBase,
    kind: z.literal('compaction'),
    compactionId: z.string().optional(),
    commandId: z.string().optional(),
    state: z.enum(['running', 'ok', 'error']),
    trigger: z.enum(['manual', 'auto']),
    startedAt: z.number(),
    endedAt: z.number().optional(),
    shadowedCount: z.number().int().nonnegative().optional(),
    shadowedTokens: z.number().nonnegative().optional(),
    provider: z.string().optional(),
    model: z.string().optional(),
    summary: z.string().optional(),
    detail: z.string().optional(),
    error: z.string().optional(),
  }),
]))

const turnsSchema = z.array(z.object({
  turn: z.number().int().nonnegative(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  outcome: z.string().optional(),
}))

/** Runtime schema for the client-visible conversation value. */
export const conversationProjectionSchema = z.object({
  entries: conversationEntriesSchema,
  streaming: z.boolean(),
  settledSteps: z.array(z.string()),
  turns: turnsSchema,
}) satisfies z.ZodType<ConversationProjection>

/** Runtime schema for persisted projection checkpoints. */
export const conversationProjectionStateSchema = z.object({
  entries: conversationEntriesSchema,
  currentTurn: z.number().int().nonnegative(),
  active: z.boolean(),
  streamingStep: z.string().nullable(),
  streamingAssistantId: z.string().nullable(),
  streamingThinkingId: z.string().nullable(),
  pendingReasoning: z.string(),
  finalizedSteps: z.array(z.string()),
  interruptedTurns: z.array(z.number().int().nonnegative()),
  retractedTurns: z.array(z.number().int().nonnegative()),
  toolEntryIds: z.record(z.string(), z.string()),
  turns: turnsSchema,
}) satisfies z.ZodType<ConversationProjectionState>

/** Empty-log state for the conversation projection. */
export function initialConversationState(): ConversationProjectionState {
  return {
    entries: [],
    currentTurn: 0,
    active: false,
    streamingStep: null,
    streamingAssistantId: null,
    streamingThinkingId: null,
    pendingReasoning: '',
    finalizedSteps: [],
    interruptedTurns: [],
    retractedTurns: [],
    toolEntryIds: {},
    turns: [],
  }
}

function visibleText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && block.text !== '') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image]')
  }
  return parts.filter(Boolean).join('\n')
}

function reasoningText(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'reasoning').map(block => block.text).join('\n\n')
}

function imagesOf(content: readonly ContentBlock[]): ConversationImage[] {
  return content
    .filter((block): block is ImageBlock => block.type === 'image')
    .map(({ attachment }) => ({
      attachmentId: String(attachment.attachmentId),
      mediaType: attachment.mediaType,
      bytes: attachment.bytes,
      width: attachment.width,
      height: attachment.height,
      ...(attachment.name === undefined ? {} : { name: attachment.name }),
      ...(attachment.originalDimensions === undefined ? {} : { originalDimensions: { ...attachment.originalDimensions } }),
    }))
}

function stepKey(turn: number, step: number): string {
  return `${String(turn)}:${String(step)}`
}

function entryIndex(entries: readonly ConversationEntry[], id: string | null): number {
  return id === null ? -1 : entries.findIndex(entry => entry.id === id)
}

function replaceEntry(
  state: ConversationProjectionState,
  id: string,
  updatedSeq: number,
  replace: (entry: ConversationEntry) => ConversationEntry,
): ConversationProjectionState {
  const index = entryIndex(state.entries, id)
  if (index < 0) return state
  const current = state.entries[index]!
  const replacement = replace(current)
  if (replacement === current) return state
  const entries = [...state.entries]
  entries[index] = { ...replacement, updatedSeq }
  return { ...state, entries }
}

function settleStreaming(state: ConversationProjectionState, updatedSeq: number): ConversationProjectionState {
  let next = state
  if (state.streamingThinkingId !== null) {
    next = replaceEntry(next, state.streamingThinkingId, updatedSeq, entry => entry.kind === 'thinking' ? { ...entry, streaming: false } : entry)
  }
  if (state.streamingAssistantId !== null) {
    next = replaceEntry(next, state.streamingAssistantId, updatedSeq, entry => entry.kind === 'assistant' ? { ...entry, streaming: false } : entry)
  }
  if (next.streamingStep === null && next.streamingAssistantId === null && next.streamingThinkingId === null && next.pendingReasoning === '') return next
  return {
    ...next,
    streamingStep: null,
    streamingAssistantId: null,
    streamingThinkingId: null,
    pendingReasoning: '',
  }
}

/**
 * Whether a tool name is spawn-class delegation: `subagent` or any configured
 * `subagent_*` provider (fork, codex, claude-code), the upstream Chat rule.
 */
export function isSpawnToolName(name: string): boolean {
  return name === 'subagent' || name.startsWith('subagent_')
}

function toolChannel(name: string): ConversationToolEntry['channel'] {
  if (name === 'todo_write') return 'todo'
  if (isSpawnToolName(name)) return 'agents'
  return 'transcript'
}

/** Visible reasoning span of one folded stream, when it recorded one. */
function reasoningDuration(stream: AssistantStreamState): number | undefined {
  return stream.reasoningStartedAt === undefined || stream.reasoningEndedAt === undefined
    ? undefined
    : Math.max(0, stream.reasoningEndedAt - stream.reasoningStartedAt)
}

/** Record one turn boundary time; a missing start adopts the end time. */
function markTurn(state: ConversationProjectionState, turn: number, patch: Partial<ConversationTurn> & { readonly time: number }): ConversationProjectionState {
  const { time, ...fields } = patch
  const index = state.turns.findIndex(entry => entry.turn === turn)
  const turns = [...state.turns]
  if (index < 0) turns.push({ turn, startedAt: time, ...fields })
  else turns[index] = { ...turns[index]!, ...fields }
  return { ...state, turns }
}

function appendEntry(state: ConversationProjectionState, entry: ConversationEntry): ConversationProjectionState {
  return { ...state, entries: [...state.entries, entry] }
}

/** Whether an empty plugin-attributed developer replacement is Mayfly's durable
 * retraction marker. Harness forbids source citations on assistant
 * messages (they embed their own stream), so the empty replacement marker
 * rides a developer/message that derives to no model-visible message. */
export function isTurnRetraction(event: SessionEvent): boolean {
  if ((event.type !== 'developer/message' && event.type !== 'assistant/message')
    || event.data.message.content.length !== 0
    || event.surfaceOp === undefined || event.surfaceOp === 'append') return false
  // Historical assistant replacements retain their interrupted marker after
  // storage migration, even though new assistant events cannot cite sources.
  return event.type === 'assistant/message'
    ? event.data.interrupted === true
    : event.data.message.source.kind === 'mayfly-retraction'
}

/** Remove one safely retracted turn and suppress any late events from reopening it. */
function retractTurn(state: ConversationProjectionState, turn: number): ConversationProjectionState {
  if (state.retractedTurns.includes(turn)) return state
  const entries = state.entries.filter(entry => entry.turn !== turn)
  const liveEntryIds = new Set(entries.map(entry => entry.id))
  const toolEntryIds = Object.fromEntries(
    Object.entries(state.toolEntryIds).filter(([, id]) => liveEntryIds.has(id)),
  )
  const prefix = `${String(turn)}:`
  const ownsStreaming = state.streamingStep?.startsWith(prefix) === true || state.currentTurn === turn
  return {
    ...state,
    entries,
    ...(state.currentTurn === turn ? { active: false } : {}),
    streamingStep: state.streamingStep?.startsWith(prefix) === true ? null : state.streamingStep,
    streamingAssistantId: entries.some(entry => entry.id === state.streamingAssistantId)
      ? state.streamingAssistantId
      : null,
    streamingThinkingId: entries.some(entry => entry.id === state.streamingThinkingId)
      ? state.streamingThinkingId
      : null,
    pendingReasoning: ownsStreaming ? '' : state.pendingReasoning,
    finalizedSteps: state.finalizedSteps.filter(key => !key.startsWith(prefix)),
    interruptedTurns: state.interruptedTurns.filter(value => value !== turn),
    retractedTurns: [...state.retractedTurns, turn],
    toolEntryIds,
    turns: state.turns.filter(entry => entry.turn !== turn),
  }
}

function openStreamingStep(state: ConversationProjectionState, turn: number, step: number, updatedSeq: number): ConversationProjectionState {
  const key = stepKey(turn, step)
  // Each durable assistant/attempt is one complete (possibly failed) model
  // attempt. Reopening the same step replaces a prior failed attempt instead
  // of appending its text and accidentally concatenating retries.
  const settled = settleStreaming(state, updatedSeq)
  const entries = settled.entries.filter(entry => !((entry.kind === 'assistant' || entry.kind === 'thinking')
    && entry.turn === turn && entry.step === step))
  return {
    ...settled,
    entries,
    currentTurn: turn,
    active: true,
    streamingStep: key,
    streamingAssistantId: null,
    streamingThinkingId: null,
    pendingReasoning: '',
  }
}

/** Retain the entry id so the final authoritative message still rewrites it. */
function pauseThinking(state: ConversationProjectionState, seq: number): ConversationProjectionState {
  if (state.streamingThinkingId === null) return state
  return replaceEntry(state, state.streamingThinkingId, seq, entry => entry.kind === 'thinking' && entry.streaming
    ? { ...entry, streaming: false }
    : entry)
}

function finalizeAssistant(
  state: ConversationProjectionState,
  event: SessionEvent<'assistant/message'>,
): ConversationProjectionState {
  const { turn, step, message } = event.data
  const key = stepKey(turn, step)
  if (state.finalizedSteps.includes(key) || state.interruptedTurns.includes(turn)) return state
  let next = state.streamingStep === key ? state : settleStreaming(state, event.seq)
  const durationMs = reasoningDuration(foldAssistantStreamRecords(initialAssistantStream(), event.data.stream))
  const timing = durationMs === undefined ? {} : { durationMs }
  const reasoning = reasoningText(message.content)
  const answer = visibleText(message.content).trim()
  const thinkingId = `thinking:${key}`
  const assistantId = `assistant:${key}`
  const thinkingIndex = entryIndex(next.entries, next.streamingThinkingId)
  if (thinkingIndex >= 0) {
    next = replaceEntry(next, next.streamingThinkingId!, event.seq, entry => entry.kind === 'thinking'
      ? { ...entry, text: reasoning, streaming: false, ...timing }
      : entry)
  } else if (reasoning.trim() !== '') {
    const thinking: ConversationThinkingEntry = {
      kind: 'thinking', id: thinkingId, seq: event.seq, updatedSeq: event.seq, turn, step, text: reasoning, streaming: false, ...timing,
    }
    const entries = [...next.entries]
    const assistantIndex = entryIndex(entries, next.streamingAssistantId)
    entries.splice(assistantIndex < 0 ? entries.length : assistantIndex, 0, thinking)
    next = { ...next, entries }
  }
  const assistantIndex = entryIndex(next.entries, next.streamingAssistantId)
  if (assistantIndex >= 0) {
    next = replaceEntry(next, next.streamingAssistantId!, event.seq, entry => entry.kind === 'assistant'
      ? { ...entry, text: answer, streaming: false }
      : entry)
  } else if (answer !== '') {
    next = appendEntry(next, {
      kind: 'assistant', id: assistantId, seq: event.seq, updatedSeq: event.seq, turn, step, text: answer, streaming: false,
    })
  }
  return {
    ...next,
    currentTurn: turn,
    streamingStep: null,
    streamingAssistantId: null,
    streamingThinkingId: null,
    pendingReasoning: '',
    finalizedSteps: [...next.finalizedSteps, key],
  }
}

function applyToolResult(
  state: ConversationProjectionState,
  event: SessionEvent<'tool/result'>,
): ConversationProjectionState {
  // Tool results are first-class tool-role messages: the call identity and
  // error flag live on the message, and its content blocks are the result.
  const message = event.data.message
  const callId = String(message.toolCallId)
  const isError = message.isError === true || event.data.error !== undefined
  const text = typeof event.data.meta === 'string' && event.data.meta.trim() !== ''
    ? event.data.meta
    : visibleText(message.content)
  const result = {
    content: message.content as unknown as readonly ConversationJson[],
    text,
    isError,
    endedAt: event.time,
    ...(event.data.meta === undefined ? {} : { meta: event.data.meta as ConversationJson }),
  }
  const pairedId = state.toolEntryIds[callId]
  if (pairedId !== undefined) {
    return replaceEntry(state, pairedId, event.seq, entry => entry.kind === 'tool' ? { ...entry, result } : entry)
  }
  const id = `tool:${callId}`
  const entry: ConversationToolEntry = {
    kind: 'tool',
    id,
    seq: event.seq,
    updatedSeq: event.seq,
    turn: event.data.turn,
    step: event.data.step,
    callId,
    name: 'tool',
    arguments: '',
    startedAt: event.time,
    channel: 'transcript',
    result,
  }
  return {
    ...appendEntry(state, entry),
    toolEntryIds: { ...state.toolEntryIds, [callId]: id },
  }
}

/**
 * Fold one committed session event into the plain-JSON conversation state.
 * Unrelated events return the same state reference.
 */
export function foldConversationProjection(
  state: ConversationProjectionState,
  event: SessionEvent,
): ConversationProjectionState {
  if ((event.type === 'developer/message' || event.type === 'assistant/message') && isTurnRetraction(event)) return retractTurn(state, event.data.turn)
  switch (event.type) {
    case 'turn/start':
      if (state.retractedTurns.includes(event.data.turn)) return state
      return markTurn({ ...state, currentTurn: event.data.turn, active: true }, event.data.turn, { time: event.time, startedAt: event.time })
    case 'step/start': {
      if (state.retractedTurns.includes(event.data.turn)) return state
      const settled = settleStreaming(state, event.seq)
      return { ...settled, currentTurn: event.data.turn, active: true }
    }
    case 'turn/end': {
      if (state.retractedTurns.includes(event.data.turn)) return state
      const settled = { ...settleStreaming(state, event.seq), currentTurn: event.data.turn, active: false }
      // The first close wins: a later synthetic closer keeps the recorded outcome.
      let next = state.turns.some(entry => entry.turn === event.data.turn && entry.endedAt !== undefined)
        ? settled
        : markTurn(settled, event.data.turn, { time: event.time, endedAt: event.time, outcome: event.data.reason.kind })
      if (event.data.reason.kind === 'error') {
        const failure = event.data.reason.error
        return appendEntry(next, {
          kind: 'error',
          id: `error:${String(event.seq)}`,
          seq: event.seq,
          updatedSeq: event.seq,
          turn: event.data.turn,
          message: failure.message,
          ...(failure.code === '' ? {} : { code: failure.code }),
        })
      }
      if (event.data.reason.kind !== 'aborted' && event.data.reason.kind !== 'interrupted') return next
      if (next.interruptedTurns.includes(event.data.turn)) return next
      next = appendEntry(next, {
        kind: 'interrupted', id: `interrupted:${String(event.data.turn)}`, seq: event.seq, updatedSeq: event.seq, turn: event.data.turn,
      })
      return { ...next, interruptedTurns: [...next.interruptedTurns, event.data.turn] }
    }
    case 'user/message': {
      if (state.retractedTurns.includes(state.currentTurn)) return state
      if (!isAppendSurfaceEvent(event) || event.data.source.kind !== 'user') return state
      const text = visibleText(event.data.content)
      if (text.trim() === '') return state
      return appendEntry(state, {
        kind: 'user',
        id: `user:${String(event.seq)}`,
        seq: event.seq,
        updatedSeq: event.seq,
        turn: state.currentTurn,
        text,
        images: imagesOf(event.data.content),
      })
    }
    case 'assistant/attempt': {
      // Harness `0.1.5` persists failed or superseded attempts as one event
      // embedding its compact stream; expand it and run the same chunk
      // machine the live frames drive. Successful attempts settle as
      // `assistant/message`, whose content finalizes the entries directly.
      const { turn, step, stream } = event.data
      if (state.retractedTurns.includes(turn)) return state
      const key = stepKey(turn, step)
      if (state.interruptedTurns.includes(turn) || state.finalizedSteps.includes(key)) return state
      // A restored checkpoint may contain crossed stream ids. Keep it intact
      // rather than allowing a new attempt to rewrite unrelated entries.
      const thinking = state.streamingThinkingId === null ? undefined : state.entries[entryIndex(state.entries, state.streamingThinkingId)]
      const assistant = state.streamingAssistantId === null ? undefined : state.entries[entryIndex(state.entries, state.streamingAssistantId)]
      if ((thinking !== undefined && thinking.kind !== 'thinking') || (assistant !== undefined && assistant.kind !== 'assistant')) return state
      const draft = foldAssistantStreamRecords(initialAssistantStream(), stream)
      const next = openStreamingStep(state, turn, step, event.seq)
      const entries: ConversationEntry[] = [...next.entries]
      const thinkingId = draft.reasoning.trim() === '' ? null : `thinking:${key}`
      const assistantId = draft.text === '' ? null : `assistant:${key}`
      // Visible reasoning always carries its producer-time span.
      if (thinkingId !== null) entries.push({
        kind: 'thinking', id: thinkingId, seq: event.seq, updatedSeq: event.seq, turn, step,
        text: draft.reasoning, streaming: draft.phase === 'thinking',
        ...(draft.phase === 'thinking' ? { outputProgress: draft.outputProgress } : {}),
        durationMs: reasoningDuration(draft)!,
      })
      if (assistantId !== null) entries.push({
        kind: 'assistant', id: assistantId, seq: event.seq, updatedSeq: event.seq, turn, step,
        text: draft.text, streaming: draft.phase === 'composing',
      })
      return { ...next, entries, streamingThinkingId: thinkingId, streamingAssistantId: assistantId, pendingReasoning: thinkingId === null ? draft.reasoning : '' }
    }
    case 'assistant/message':
      return state.retractedTurns.includes(event.data.turn) || !isAppendSurfaceEvent(event)
        ? state
        : finalizeAssistant(state, event)
    case 'tool/call': {
      if (state.retractedTurns.includes(event.data.turn)) return state
      const id = `tool:${String(event.data.callId)}`
      const entry: ConversationToolEntry = {
        kind: 'tool',
        id,
        seq: event.seq,
        updatedSeq: event.seq,
        turn: event.data.turn,
        step: event.data.step,
        callId: String(event.data.callId),
        name: event.data.name,
        arguments: event.data.arguments,
        startedAt: event.time,
        channel: toolChannel(event.data.name),
      }
      return {
        ...appendEntry(pauseThinking(state, event.seq), entry),
        toolEntryIds: { ...state.toolEntryIds, [entry.callId]: id },
      }
    }
    case 'tool/result':
      return state.retractedTurns.includes(event.data.turn) || !isAppendSurfaceEvent(event)
        ? state
        : applyToolResult(state, event)
    // The `/compact` lifecycle: `command/run` opens the row at submit time so
    // a busy or never-started attempt still leaves a trace; `compaction/start`
    // either adopts that row (manual) or opens one itself (automatic);
    // `compaction/end` settles it, and `command/done` is the terminal record
    // for attempts that never reached the transaction.
    case 'command/run': {
      if (event.data.name !== 'compact') return state
      const commandId = String(event.data.commandId)
      const id = `compaction:cmd:${commandId}`
      if (state.entries.some(entry => entry.id === id)) return state
      return appendEntry(state, {
        kind: 'compaction', id, seq: event.seq, updatedSeq: event.seq, turn: state.currentTurn,
        commandId, state: 'running', trigger: 'manual', startedAt: event.time,
      })
    }
    case 'compaction/start': {
      const compactionId = String(event.data.compactionId)
      const sourceCommandId = event.data.sourceCommandId === undefined ? undefined : String(event.data.sourceCommandId)
      const existing = state.entries.findLast((entry): entry is ConversationCompactionEntry =>
        entry.kind === 'compaction' && entry.state === 'running'
        && (entry.compactionId === compactionId
          || (sourceCommandId !== undefined && entry.commandId === sourceCommandId)))
      if (existing !== undefined) {
        return replaceEntry(state, existing.id, event.seq, () => ({ ...existing, compactionId }))
      }
      return appendEntry(state, {
        kind: 'compaction', id: `compaction:${compactionId}`, seq: event.seq, updatedSeq: event.seq,
        turn: event.data.turn ?? state.currentTurn, compactionId,
        state: 'running', trigger: sourceCommandId === undefined ? 'auto' : 'manual', startedAt: event.time,
      })
    }
    case 'compaction/summary': {
      const compactionId = String(event.data.compactionId)
      const entry = state.entries.findLast((candidate): candidate is ConversationCompactionEntry =>
        candidate.kind === 'compaction' && candidate.compactionId === compactionId && candidate.state === 'running')
      if (entry === undefined) return state
      const summary = visibleText(event.data.summary)
      return replaceEntry(state, entry.id, event.seq, () => ({
        ...entry,
        shadowedCount: event.data.shadowedSeqs.length,
        shadowedTokens: event.data.shadowedTokenCount,
        provider: event.data.provider,
        model: event.data.model,
        ...(summary === '' ? {} : { summary }),
      }))
    }
    case 'compaction/end': {
      const compactionId = String(event.data.compactionId)
      const entry = state.entries.findLast((candidate): candidate is ConversationCompactionEntry =>
        candidate.kind === 'compaction' && candidate.compactionId === compactionId && candidate.state === 'running')
      if (entry === undefined) return state
      const error = event.data.error
      return replaceEntry(state, entry.id, event.seq, () => ({
        ...entry,
        state: error === undefined ? 'ok' : 'error',
        endedAt: event.time,
        ...(error === undefined ? {} : { error }),
      }))
    }
    case 'command/done': {
      const commandId = String(event.data.commandId)
      const entry = state.entries.findLast((candidate): candidate is ConversationCompactionEntry =>
        candidate.kind === 'compaction' && candidate.commandId === commandId && candidate.state === 'running')
      if (entry === undefined) return state
      return replaceEntry(state, entry.id, event.seq, () => event.data.kind === 'error'
        ? { ...entry, state: 'error' as const, endedAt: event.time, error: event.data.text ?? 'compaction failed' }
        : { ...entry, state: 'ok' as const, endedAt: event.time, ...(event.data.text === undefined ? {} : { detail: event.data.text }) })
    }
    // A constructor seed ends every prior lifecycle: a compaction still open
    // across it died with the previous session instance, so its row settles
    // instead of replaying as a spinner forever.
    case 'session/end-seed': {
      let next = state
      for (const entry of state.entries) {
        if (entry.kind !== 'compaction' || entry.state !== 'running') continue
        next = replaceEntry(next, entry.id, event.seq, () => ({
          ...entry, state: 'error' as const, endedAt: event.time, error: 'compaction interrupted by restart',
        }))
      }
      return next
    }
    default:
      return state
  }
}

/** Official session-projection unit registered by the package plugin. */
type ConversationProjectionDefinition = Omit<
  ProjectionDefinition<'mayflyConversation', ConversationProjectionState>,
  'wire'
> & { wire: NonNullable<ProjectionDefinition<'mayflyConversation', ConversationProjectionState>['wire']> }

/* The registry compares successive wire views with `Object.is` and skips the
   schema parse plus every listener wakeup when the object repeats. States are
   immutable fold results, so one memoized view per state object is exact —
   unchanged states answer the identical view for the lifetime of the state. */
const conversationViewCache = new WeakMap<ConversationProjectionState, ConversationProjection>()

/* A changed view still passes `viewSchema` on every committed event of every
   session, child sessions included. Entries, step keys, and turn records are
   retained by identity across folds, so each object is admitted through the
   strict element schema once and the view leaves without a deep copy. */
const admitEntries = everyAdmitted(identityAdmission(conversationEntriesSchema.element))
const admitSettledSteps = identityAdmission(z.array(z.string()))
const admitTurns = identityAdmission(turnsSchema)

function isConversationView(value: unknown): value is ConversationProjection {
  if (typeof value !== 'object' || value === null) return false
  const view = value as Partial<Record<keyof ConversationProjection, unknown>>
  return typeof view.streaming === 'boolean'
    && admitSettledSteps(view.settledSteps)
    && admitTurns(view.turns)
    && admitEntries(view.entries)
}

/** Client-visible wire schema: strict per object, memoized by identity. */
const conversationViewSchema = z.custom<ConversationProjection>(isConversationView, 'invalid conversation projection view')

export const conversationProjectionDefinition: ConversationProjectionDefinition = {
  key: 'mayflyConversation',
  stateSchema: conversationProjectionStateSchema,
  init: initialConversationState,
  apply: foldConversationProjection,
  wire: {
    viewSchema: conversationViewSchema,
    view: state => {
      let view = conversationViewCache.get(state)
      if (view === undefined) {
        view = { entries: state.entries, streaming: state.active, settledSteps: state.finalizedSteps, turns: state.turns }
        conversationViewCache.set(state, view)
      }
      return view
    },
  },
  stateVersion: 8,
}
