/**
 * Renderer-neutral Agent lifecycle labels shared by panes and transcript rows.
 * @module @ephemeral-ai/mayfly/transcript/agent-presentation
 */

import type { MayflyTone } from '@ephemeral-ai/mayfly-ui'

/** Canonical visual semantics of one Agent lifecycle phase. */
export interface AgentPhasePresentation {
  readonly label: 'running' | 'waiting' | 'done' | 'failed' | 'cancelled'
  readonly marker: '●' | '✓' | '✗' | '⊘'
  readonly tone: MayflyTone
}

/** Compact non-negative duration from elapsed seconds. */
export function compactElapsedSeconds(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds))
  if (safe < 60) return `${String(safe)}s`
  return `${String(Math.floor(safe / 60))}m ${String(safe % 60)}s`
}

/** Compact non-negative duration from elapsed milliseconds. */
export function compactElapsedMs(ms: number): string {
  return compactElapsedSeconds(ms / 1000)
}

/** Normalize product-specific phase spellings onto one marker/tone vocabulary. */
export function agentPhasePresentation(phase: 'pending' | 'running' | 'waiting' | 'done' | 'completed' | 'failed' | 'cancelled'): AgentPhasePresentation {
  if (phase === 'failed') return { label: 'failed', marker: '✗', tone: 'danger' }
  if (phase === 'waiting') return { label: 'waiting', marker: '●', tone: 'warning' }
  if (phase === 'done' || phase === 'completed') return { label: 'done', marker: '✓', tone: 'success' }
  if (phase === 'cancelled') return { label: 'cancelled', marker: '⊘', tone: 'muted' }
  return { label: 'running', marker: '●', tone: 'accent' }
}

/** Stable tree branch prefix for one lifecycle row. */
export function agentTreeBranch(last: boolean): '└─' | '├─' {
  return last ? '└─' : '├─'
}

/** Argument keys naming a spawned agent, in priority order. */
const AGENT_NAME_KEYS = ['name', 'agent_name', 'agent', 'type', 'preset']

function stringArgument(args: unknown, key: string): string | undefined {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) return undefined
  const value = (args as Record<string, unknown>)[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * The display label of one spawn-class call: its agent name (with the task
 * description as detail), else the description, else the tool name with its
 * raw arguments as detail.
 * @param name - the tool name.
 * @param args - the parsed arguments, when valid.
 * @param raw - the raw arguments string.
 * @returns the label and optional detail.
 */
export function agentCallLabel(name: string, args: unknown, raw: string): { readonly label: string, readonly detail?: string } {
  const named = AGENT_NAME_KEYS.map(key => stringArgument(args, key)).find(value => value !== undefined)
  const description = stringArgument(args, 'description')
  if (named !== undefined) return { label: named, ...(description === undefined || description === named ? {} : { detail: description }) }
  if (description !== undefined) return { label: description }
  return { label: name, ...(raw === '' ? {} : { detail: raw }) }
}
