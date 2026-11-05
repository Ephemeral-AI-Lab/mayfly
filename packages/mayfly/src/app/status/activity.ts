/**
 * Presentation-only activity derivation from official Facts, Conversation, and Session snapshots.
 * @module @ephemeral-ai/mayfly/remote/status/activity
 */

import type { ConversationFacts, ConversationProjection, OutputProgress } from '@ephemeral-ai/mayfly-host/types'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import { formatTokens } from '../../transcript/status-context-model.ts'

/** One in-flight tool used by the activity label and detail line. */
export interface RemoteActivityCall {
  readonly callId: string
  readonly name: string
  readonly detail?: string
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
      inFlight: (facts.inFlight ?? []).map(call => ({
        callId: call.callId,
        name: call.name,
        ...call.detail === undefined ? {} : { detail: call.detail },
        preparing: call.preparing === true,
      })),
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
      ...entry.arguments.trim() === '' ? {} : { detail: entry.arguments.replace(/\s+/gu, ' ').slice(0, 160) },
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

const LABELS: Readonly<Record<string, readonly [string, string]>> = {
  read: ['Reading files', 'Preparing to read files'],
  read_image: ['Reading images', 'Preparing to read images'],
  write: ['Writing files', 'Preparing to write files'],
  grep: ['Searching code', 'Preparing to search code'],
  glob: ['Searching code', 'Preparing to search code'],
  edit: ['Editing files', 'Preparing to edit files'],
  apply_patch: ['Editing files', 'Preparing to edit files'],
  bash: ['Running commands', 'Preparing to run commands'],
  pwsh: ['Running commands', 'Preparing to run commands'],
  run_code: ['Running code', 'Preparing to run code'],
  web_search: ['Searching the web', 'Preparing to search the web'],
  web_fetch: ['Visiting web pages', 'Preparing to visit web pages'],
  todo_write: ['Updating the plan', 'Preparing to update the plan'],
  ask_user_question: ['Waiting for your action', 'Preparing questions'],
}

/** Resolve the current Mayfly in-flight tool label. */
export function remoteFlightLabel(calls: readonly RemoteActivityCall[]): { readonly key: string, readonly values?: { readonly count: number } } {
  const first = calls[0]
  if (first === undefined) return { key: 'Deep diving' }
  const preparing = calls.every(call => call.preparing)
  if (calls.every(call => call.name === first.name)) {
    const pair = LABELS[first.name] ?? ['Calling tools', 'Preparing tool calls']
    return { key: pair[preparing ? 1 : 0] }
  }
  return { key: preparing ? 'Preparing {count} tool calls' : 'Running {count} tools', values: { count: calls.length } }
}
