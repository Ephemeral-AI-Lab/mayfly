/**
 * Current Mayfly Git badge formatting over Host-owned status DTOs.
 * @module @ephemeral-ai/mayfly/remote/status/git
 */

import type { MayflyGitStatus } from '@ephemeral-ai/mayfly-host/types'

/** Render branch, numstat, and upstream counts without running Git locally. */
export function formatRemoteGitBadge(status: NonNullable<MayflyGitStatus>): string {
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
