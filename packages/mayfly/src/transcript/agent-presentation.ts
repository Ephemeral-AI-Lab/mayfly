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
  if (safe < 3600) return `${String(Math.floor(safe / 60))}m ${String(safe % 60)}s`
  return `${String(Math.floor(safe / 3600))}h ${String(Math.floor((safe % 3600) / 60))}m ${String(safe % 60)}s`
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

/** Groups up to this size keep spawn order and a separate detail line per member. */
export const COMPACT_MEMBER_LIMIT = 3

/** At most this many member rows render in a dock pane; the rest fold into one count row. */
export const MAX_MEMBER_ROWS = 6

/** Labels that keep a member in the visible selection first. */
const LIVE_LABELS: ReadonlySet<string> = new Set(['running', 'waiting'])

/** Label order of the hidden-member count. */
const HIDDEN_LABEL_ORDER = ['running', 'waiting', 'failed', 'cancelled', 'done']

/**
 * The members a pane shows. A small group keeps spawn order. A larger group
 * lists live members first, so a dock that cuts the pane short still shows
 * what is running, then settled ones, each in spawn order; past
 * {@link MAX_MEMBER_ROWS} it keeps every live member first and fills with the
 * most recently spawned settled ones.
 * @param rows - every member, in spawn order, with its phase label.
 * @returns the shown members in display order and the hidden members.
 */
export function selectVisibleMembers<Row extends { readonly phaseLabel: string }>(rows: readonly Row[]): {
  readonly shown: readonly Row[]
  readonly hidden: readonly Row[]
} {
  if (rows.length <= COMPACT_MEMBER_LIMIT) return { shown: rows, hidden: [] }
  const picked = new Set<number>()
  rows.forEach((row, index) => {
    if (picked.size < MAX_MEMBER_ROWS && LIVE_LABELS.has(row.phaseLabel)) picked.add(index)
  })
  for (let index = rows.length - 1; index >= 0 && picked.size < MAX_MEMBER_ROWS; index -= 1) picked.add(index)
  const shown = rows.filter((_row, index) => picked.has(index))
  return {
    shown: [...shown.filter(row => LIVE_LABELS.has(row.phaseLabel)), ...shown.filter(row => !LIVE_LABELS.has(row.phaseLabel))],
    hidden: rows.filter((_row, index) => !picked.has(index)),
  }
}

/** The closing tree row standing in for hidden members, counted by phase. */
export function hiddenMembersText(hidden: readonly { readonly phaseLabel: string }[]): string {
  const counts = new Map<string, number>()
  for (const row of hidden) counts.set(row.phaseLabel, (counts.get(row.phaseLabel) ?? 0) + 1)
  const parts = HIDDEN_LABEL_ORDER.flatMap(label => {
    const count = counts.get(label)
    return count === undefined ? [] : [`${String(count)} ${label}`]
  })
  return `  ${agentTreeBranch(true)} … +${String(hidden.length)} more (${parts.join(', ')})`
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
