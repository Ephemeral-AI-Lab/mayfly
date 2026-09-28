/** Workspace rows grouped by exact native cwd without opening session logs.
 * @module @ephemeral-ai/mayfly/interaction/session-workspaces-model
 */
import type { MayflyListItem } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/index.ts'
import { displayPath, homeRelative } from '../internal/paths.ts'
import type { SessionListHeader } from './session-list-reads.ts'

export interface SessionWorkspace {
  readonly id: string
  readonly cwd: string | undefined
  readonly count: number
  readonly createdAt: number
}

export function sessionWorkspaceId(cwd: string | undefined): string {
  return `cwd:${JSON.stringify(cwd ?? null)}`
}

/** Keep the complete workspace path distinct; only abbreviate the home prefix. */
export function sessionWorkspaceLabel(cwd: string | undefined, home: string, t: MayflyTranslate, platform: NodeJS.Platform = process.platform): string {
  if (cwd === undefined) return t('No working directory')
  return homeRelative(cwd, home, platform) ?? displayPath(cwd, platform)
}

export function sessionWorkspaces(records: readonly SessionListHeader[], currentCwd: string | undefined): readonly SessionWorkspace[] {
  const groups = new Map<string, SessionWorkspace>()
  for (const { header } of records) {
    const id = sessionWorkspaceId(header.cwd)
    const previous = groups.get(id)
    groups.set(id, { id, cwd: header.cwd, count: (previous?.count ?? 0) + 1, createdAt: Math.max(previous?.createdAt ?? 0, header.createdAt) })
  }
  return [...groups.values()].sort((a, b) => Number(b.cwd === currentCwd) - Number(a.cwd === currentCwd) || b.createdAt - a.createdAt || a.id.localeCompare(b.id))
}

export function sessionWorkspaceItem(workspace: SessionWorkspace, currentCwd: string | undefined, home: string, t: MayflyTranslate): MayflyListItem {
  return {
    id: workspace.id,
    label: sessionWorkspaceLabel(workspace.cwd, home, t),
    detail: t(workspace.count === 1 ? '1 session' : '{count} sessions', { count: workspace.count }),
    searchText: workspace.cwd ?? t('No working directory'),
    ...(workspace.cwd === currentCwd ? { badge: t('current') } : {}),
  }
}
