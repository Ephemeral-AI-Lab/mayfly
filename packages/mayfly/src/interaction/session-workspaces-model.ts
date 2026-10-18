/** Workspace rows over the native Workspace registry: identity and membership
 * come from `WorkspaceId`, while the header cwd is only display metadata for
 * sessions the registry has not indexed. No session log is opened.
 * @module @ephemeral-ai/mayfly/interaction/session-workspaces-model
 */
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller'
import type { Workspace, WorkspaceId } from '@deepseek-ai/dsh-workspace'
import type { MayflyListItem, MayflyTabItem } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { displayPath, homeRelative } from '../internal/paths.ts'

/** The registry view the placement pass needs; a Host registry satisfies it. */
export interface WorkspaceResolver {
  readonly list: () => readonly Workspace[]
  readonly resolveByPath: (path: string) => Promise<Workspace | undefined>
}

/** One picker row: a registered workspace, or the unregistered fallback. */
export interface SessionWorkspace {
  /** Stable row id: `workspace:<WorkspaceId>` or the single fallback id. */
  readonly id: string
  /** Display path: the registered canonical path, or undefined for the fallback. */
  readonly cwd: string | undefined
  readonly count: number
  /** Registered creation instant, or the fallback's newest member activity, in epoch ms. */
  readonly createdAt: number
  /** Native identity; absent on the fallback row. */
  readonly workspaceId?: WorkspaceId
  /** Native display title; absent on the fallback row. */
  readonly title?: string
  /** Translation key of the fallback label; absent on a registered row. */
  readonly label?: string
  readonly current?: boolean
}

/** The fallback row holds sessions the registry does not own. */
const UNREGISTERED_ID = 'workspace:unregistered'

/** Row identity for one registered workspace. */
export function sessionWorkspaceRowId(workspace: Workspace): string {
  return `workspace:${workspace.id}`
}

/** Keep the complete workspace path distinct; only abbreviate the home prefix. */
export function sessionWorkspaceLabel(cwd: string | undefined, home: string, t: MayflyTranslate, platform: NodeJS.Platform = process.platform): string {
  if (cwd === undefined) return t('No working directory')
  return homeRelative(cwd, home, platform) ?? displayPath(cwd, platform)
}

/**
 * Map each listed Session to the registered Workspace that owns it. Native
 * `sessionIds` membership wins; otherwise the exact path is matched, and a
 * canonical-path resolution handles a differently spelled cwd. Sessions the
 * registry does not own stay unplaced and join the fallback row.
 * @param resolver - `ctx.workspaceRegistry`.
 * @param summaries - the native Session catalog.
 * @returns the placed Session ids, keyed by string id.
 */
export async function sessionWorkspacePlacements(
  resolver: WorkspaceResolver,
  summaries: readonly SessionSummary[],
): Promise<ReadonlyMap<string, WorkspaceId>> {
  const workspaces = resolver.list()
  const membership = new Map<string, WorkspaceId>()
  const byPath = new Map<string, WorkspaceId>()
  for (const workspace of workspaces) {
    byPath.set(workspace.path, workspace.id)
    for (const sessionId of workspace.sessionIds) membership.set(String(sessionId), workspace.id)
  }
  const placements = new Map<string, WorkspaceId>()
  const resolved = new Map<string, WorkspaceId | undefined>()
  for (const summary of summaries) {
    const sessionId = String(summary.sessionId)
    const accounted = membership.get(sessionId)
    if (accounted !== undefined) { placements.set(sessionId, accounted); continue }
    const cwd = summary.cwd
    if (cwd === undefined) continue
    const exact = byPath.get(cwd)
    if (exact !== undefined) { placements.set(sessionId, exact); continue }
    let owner = resolved.get(cwd)
    if (!resolved.has(cwd)) {
      try {
        owner = (await resolver.resolveByPath(cwd))?.id
      } catch {
        // A path the Host cannot canonicalize owns no workspace.
        owner = undefined
      }
      resolved.set(cwd, owner)
    }
    if (owner !== undefined) placements.set(sessionId, owner)
  }
  return placements
}

/**
 * The picker rows: every registered workspace in registry order, then one
 * fallback row for sessions no workspace owns. The current workspace is
 * flagged, never reordered.
 * @param workspaces - native registry order.
 * @param summaries - the native Session catalog.
 * @param placements - ids placed by {@link sessionWorkspacePlacements}.
 * @param currentWorkspaceId - the workspace the displayed conversation lives in.
 * @returns the rows.
 */
export function sessionWorkspaces(
  workspaces: readonly Workspace[],
  summaries: readonly SessionSummary[],
  placements: ReadonlyMap<string, WorkspaceId>,
  currentWorkspaceId?: WorkspaceId,
): readonly SessionWorkspace[] {
  const rows: SessionWorkspace[] = workspaces.map((workspace) => {
    const members = summaries.filter(summary => placements.get(String(summary.sessionId)) === workspace.id)
    return {
      id: sessionWorkspaceRowId(workspace),
      cwd: workspace.path,
      count: members.length,
      createdAt: creationOf(workspace),
      workspaceId: workspace.id,
      title: workspace.title,
      ...(workspace.id === currentWorkspaceId ? { current: true } : {}),
    }
  })
  const others = summaries.filter(summary => placements.get(String(summary.sessionId)) === undefined)
  if (others.length > 0) {
    rows.push({
      id: UNREGISTERED_ID,
      cwd: undefined,
      count: others.length,
      createdAt: newest(others),
      label: 'Other sessions',
    })
  }
  return rows
}

/** A registered workspace's durable creation instant in epoch milliseconds. */
function creationOf(workspace: Workspace): number {
  const parsed = Date.parse(workspace.createdAt)
  return Number.isNaN(parsed) ? 0 : parsed
}

function newest(summaries: readonly SessionSummary[]): number {
  let latest = 0
  for (const summary of summaries) latest = Math.max(latest, summary.updatedAt)
  return latest
}

/**
 * One picker row: the native workspace title (or its shortened path), the
 * session count, and the current flag.
 * @param workspace - the row.
 * @param currentCwd - the displayed conversation's cwd, a display-only fallback for the current flag.
 * @param home - the home directory for path shortening.
 * @param t - interaction translator.
 * @returns the list item.
 */
export function sessionWorkspaceItem(workspace: SessionWorkspace, currentCwd: string | undefined, home: string, t: MayflyTranslate): MayflyListItem {
  const label = workspace.label === undefined
    ? workspace.title ?? sessionWorkspaceLabel(workspace.cwd, home, t)
    : t(workspace.label)
  return {
    id: workspace.id,
    label,
    detail: t(workspace.count === 1 ? '1 session' : '{count} sessions', { count: workspace.count }),
    searchText: workspace.cwd ?? label,
    ...(workspace.current ?? (workspace.cwd !== undefined && workspace.cwd === currentCwd) ? { current: true } : {}),
  }
}

/**
 * One rail label for the sessions panel: the workspace label, its session count,
 * and a `current` suffix on the workspace holding the displayed conversation.
 * @param workspace - the row.
 * @param currentCwd - the displayed conversation's cwd, a display-only fallback for the current flag.
 * @param home - the home directory for path shortening.
 * @param t - interaction translator.
 * @returns the rail tab item.
 */
export function sessionWorkspaceTab(workspace: SessionWorkspace, currentCwd: string | undefined, home: string, t: MayflyTranslate): MayflyTabItem {
  const label = workspace.label === undefined
    ? workspace.title ?? sessionWorkspaceLabel(workspace.cwd, home, t)
    : t(workspace.label)
  const current = workspace.current ?? (workspace.cwd !== undefined && workspace.cwd === currentCwd)
  return {
    id: workspace.id,
    label: current ? `${label} · ${t('current')}` : label,
    count: workspace.count,
  }
}
