/**
 * Presentation-only activity derivation from official Facts, Conversation, and Session snapshots.
 * @module @ephemeral-ai/mayfly/app/status/activity
 */

import type { ConversationFacts, ConversationProjection, OutputProgress } from '@ephemeral-ai/mayfly-host/types'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MayflyTranslate } from '@ephemeral-ai/mayfly-ui'
import type { TranscriptModel } from '../../frontend/models.ts'
import { toolActivity } from '../../transcript/process-activity.ts'
import { formatTokens } from '../../transcript/status-context-model.ts'
import { flightName } from '../../transcript/tool-calls.ts'
import { mcpNameOf } from '../../transcript/tool-calls-mcp.ts'
import { kindOf } from '../../transcript/tool-kinds.ts'

/** One in-flight tool used by the activity label and detail line. */
export interface RemoteActivityCall {
  readonly callId: string
  readonly name: string
  /** When it started; a call whose arguments still stream has not. */
  readonly startedAt?: number
  readonly preparing: boolean
}

/** Read-only activity facts derived anew from each official projection snapshot. */
export interface RemoteActivitySnapshot {
  readonly active: boolean
  readonly phase: 'idle' | 'diving' | 'thinking' | 'writing' | 'tool'
  readonly turn: number
  readonly turnStartedAt?: number
  readonly outputProgress?: OutputProgress
  readonly flowDownChars: number
  readonly inFlight: readonly RemoteActivityCall[]
  readonly latestOutcome?: string
}

/** Map the Facts fold's terminal phase onto the activity row's presentation phase. */
function factsPhase(phase: ConversationFacts['phase'], active: boolean): RemoteActivitySnapshot['phase'] {
  if (!active) return 'idle'
  if (phase === 'thinking') return 'thinking'
  if (phase === 'composing') return 'writing'
  if (phase === 'tool') return 'tool'
  return 'diving'
}

/**
 * Derive current activity without retaining a second Conversation projection.
 * The Host's `mayflyConversationFacts` value leads every field it carries; the
 * Conversation projection remains the fallback for Hosts without the Facts
 * projection.
 */
export function deriveRemoteActivity(
  projection: ConversationProjection | undefined,
  session: SessionSnapshot | undefined,
  facts?: ConversationFacts | undefined,
): RemoteActivitySnapshot {
  if (facts !== undefined) {
    return {
      active: facts.active,
      phase: factsPhase(facts.phase, facts.active),
      turn: facts.turn,
      ...facts.turnStartedAt === undefined ? {} : { turnStartedAt: facts.turnStartedAt },
      ...facts.outputProgress === undefined ? {} : { outputProgress: facts.outputProgress },
      flowDownChars: facts.flowDownChars,
      inFlight: [
        ...(facts.inFlight ?? []).map(call => ({ callId: call.callId, name: call.name, startedAt: call.startedAt, preparing: false })),
        // A spawn is in flight until the Harness acknowledges it; after that the Agents view has it.
        ...facts.agentCalls.filter(call => call.turn === facts.turn && call.result === undefined).map(call => ({ callId: call.callId, name: call.name, startedAt: call.startedAt, preparing: false })),
      ],
      ...facts.runOutcome === undefined ? {} : { latestOutcome: facts.runOutcome },
    }
  }
  const turn = projection?.turns.at(-1)
  const turnId = turn?.turn ?? 0
  const entries = projection?.entries.filter(entry => entry.turn === turnId) ?? []
  const inFlight = entries.flatMap((entry): RemoteActivityCall[] => {
    if (entry.kind !== 'tool' || entry.result !== undefined || entry.channel === 'todo') return []
    return [{
      callId: entry.callId,
      name: entry.name,
      startedAt: entry.startedAt,
      preparing: false,
    }]
  })
  const streaming = entries.findLast(entry => (entry.kind === 'assistant' || entry.kind === 'thinking') && entry.streaming)
  const active = session?.running === true || (turn !== undefined && turn.endedAt === undefined && projection?.streaming === true)
  const phase = !active ? 'idle' as const
    : inFlight.length > 0 ? 'tool' as const
      : streaming?.kind === 'thinking' ? 'thinking' as const
        : streaming?.kind === 'assistant' ? 'writing' as const
          : 'diving' as const
  return {
    active,
    phase,
    turn: turnId,
    ...turn?.startedAt === undefined ? {} : { turnStartedAt: turn.startedAt },
    ...streaming?.kind === 'thinking' && streaming.outputProgress !== undefined ? { outputProgress: streaming.outputProgress } : {},
    flowDownChars: entries.reduce((sum, entry) => sum + (entry.kind === 'assistant' ? entry.text.length : 0), 0),
    inFlight,
    ...turn?.outcome === undefined ? {} : { latestOutcome: turn.outcome },
  }
}

/** Compact non-negative elapsed milliseconds. */
export function remoteCompactElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1_000))
  if (seconds < 60) return `${String(seconds)}s`
  if (seconds < 3_600) return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
  return `${String(Math.floor(seconds / 3_600))}h ${String(Math.floor((seconds % 3_600) / 60))}m ${String(seconds % 60)}s`
}

/** Approximate output tokens from streamed characters. */
export function remoteOutputCounter(chars: number): string {
  const tokens = Math.floor(chars / 4)
  return tokens > 0 ? `↓${formatTokens(tokens)}` : ''
}

/** Current output rate while the stream is active; no synthetic rate for missing progress. */
export function remoteOutputRate(progress: OutputProgress | undefined, now: number): string {
  if (progress === undefined || now - progress.updatedAt > 2_000) return ''
  const elapsed = progress.updatedAt - progress.startedAt
  if (elapsed < 250) return ''
  return `${String(Math.round((progress.chars - progress.initialChars) / 4 * 1_000 / elapsed))} tok/s`
}

/** How long the oldest of several calls must have run before the row says so. */
const OLDEST_SHOWN_MS = 10_000

/** What a call's label is shared with: its category, or for an MCP tool its server. */
function flightKey(name: string): string {
  const activity = toolActivity(name)
  return activity === 'mcp' ? `mcp:${mcpNameOf(name).server ?? ''}` : activity
}

/**
 * The present-tense label of the calls in flight: their category's or server's when they share one, else how many.
 * @param calls - the calls in flight.
 * @returns the label's key and values.
 */
export function remoteFlightLabel(calls: readonly RemoteActivityCall[]): { readonly key: string, readonly values?: Readonly<Record<string, string | number>> } {
  const first = calls[0]
  if (first === undefined) return { key: 'Deep diving' }
  const preparing = calls.every(call => call.preparing)
  if (new Set(calls.map(call => flightKey(call.name))).size > 1) {
    return { key: preparing ? 'Preparing {count} tool calls' : 'Running {count} tools', values: { count: calls.length } }
  }
  const activity = toolActivity(first.name)
  const server = activity === 'mcp' ? mcpNameOf(first.name).server : undefined
  if (server !== undefined) return { key: preparing ? 'Preparing to call {server}' : 'Calling {server}', values: { server } }
  return { key: kindOf(activity)[preparing ? 'preparing' : 'running'] }
}

/**
 * What the row adds to that label: how many of one tool are in flight and how long the oldest has run, and under it the names
 * of different tools. The stream's own lines say each call's arguments.
 * @param calls - the calls in flight.
 * @param now - the time.
 * @param t - translator of the activity namespace.
 * @returns the muted tail, and the line under the header when the tools differ.
 */
export function remoteFlightDetail(calls: readonly RemoteActivityCall[], now: number, t: MayflyTranslate): { readonly tail: readonly string[], readonly info?: string } {
  const names = [...new Set(calls.map(call => flightName(call.name)))]
  const starts = calls.flatMap(call => call.startedAt === undefined ? [] : [call.startedAt])
  const oldest = starts.length === 0 ? 0 : now - Math.min(...starts)
  const tail = calls.length < 2 ? [] : [
    ...names.length === 1 ? [t('{count} in flight', { count: calls.length })] : [],
    ...oldest >= OLDEST_SHOWN_MS ? [t('oldest {elapsed}', { elapsed: remoteCompactElapsedMs(oldest) })] : [],
  ]
  if (names.length < 2) return { tail }
  return { tail, info: `${names.slice(0, 3).join(' · ')}${names.length > 3 ? ` ${t('+{count} more', { count: names.length - 3 })}` : ''}` }
}

/**
 * The calls whose arguments still stream, read from the attempt's overlay.
 * @param model - the displayed conversation.
 * @returns each call's id and name.
 */
export function preparingCalls(model: TranscriptModel): readonly { readonly callId: string, readonly name: string }[] {
  return (model.live?.entries ?? []).flatMap(entry => entry.kind === 'transcript-tool' && entry.preparing !== undefined ? [{ callId: entry.callId, name: entry.name }] : [])
}

/**
 * Tell the activity row which calls are being prepared, only when that changes: a model is published per streamed chunk, and
 * the row's label does not move with the characters.
 * @param emit - where to announce them.
 * @returns what to call with each published model.
 */
export function preparingAnnouncer(emit: (calls: ReturnType<typeof preparingCalls>) => void): (model: TranscriptModel) => void {
  let shown = ''
  return (model) => {
    const calls = preparingCalls(model)
    const shape = calls.map(call => call.callId).join('\0')
    if (shape === shown) return
    shown = shape
    emit(calls)
  }
}
