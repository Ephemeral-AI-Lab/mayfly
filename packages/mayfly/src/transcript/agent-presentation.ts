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
