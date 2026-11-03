/** Shared status-git presentation over readonly facts. @module */
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'
import { SHED, shedNode } from './status-shed.ts'
/** The git facts behind the badge. */
export interface GitBadgeStatus {
  /** Checked-out branch name. */
  readonly branch: string
  /** Whether the working tree or index carries any change. */
  readonly dirty: boolean
  /** Commits on the branch not on its upstream. */
  readonly ahead: number
  /** Commits on the upstream not on the branch. */
  readonly behind: number
  /** Added lines under `HEAD` (dirty tree only). */
  readonly diffAdded: number
  /** Deleted lines under `HEAD` (dirty tree only). */
  readonly diffDeleted: number
}

/**
 * The degraded badge facts: the branch probe resolved, but the working-tree
 * probe failed or timed out, so dirty/ahead/behind are unknown — rendered
 * as `branch [?]`, never as a clean tree.
 */
export interface GitUnknownBadgeStatus {
  /** Checked-out branch name. */
  readonly branch: string
  /** Discriminant: always true, marks the tree state as unknown. */
  readonly unknown: true
}

/**
 * Render the badge text: `branch [+N -M ↑a ↓b]`, or `branch [?]` when the
 * working-tree probe failed and the tree state is unknown.
 * @param status - the git facts (known or unknown-status).
 * @returns the badge (one style-free line; the entry paints it).
 */
export function formatGitBadge(status: GitBadgeStatus | GitUnknownBadgeStatus): string {
  if ('unknown' in status) return `${status.branch} [?]`
  const parts: string[] = []
  if (status.diffAdded > 0) parts.push(`+${String(status.diffAdded)}`)
  if (status.diffDeleted > 0) parts.push(`-${String(status.diffDeleted)}`)
  if (parts.length === 0 && status.dirty) parts.push('±')
  let sync = ''
  if (status.ahead > 0) sync += `↑${String(status.ahead)}`
  if (status.behind > 0) sync += `↓${String(status.behind)}`
  if (sync !== '') parts.push(sync)
  return parts.length === 0 ? status.branch : `${status.branch} [${parts.join(' ')}]`
}

/** Build the reference Git badge with the same status-row shedding priority. */
export function buildGitStatusNode(text: string): MayflyStatusNode | null {
  return text === '' ? null : shedNode({ kind: 'text', content: text, tone: 'muted' }, [{ rank: SHED.git, node: null }])
}
