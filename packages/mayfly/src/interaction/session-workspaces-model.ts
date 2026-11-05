import type { MayflyTabItem } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import { displayPath, homeRelative } from '../internal/paths.ts'

/** Only display data needed by workspace labels, without native branded identities. */
export interface SessionWorkspaceLabelFacts {
  readonly id: string
  readonly cwd: string | undefined
  readonly count: number
  readonly title?: string
  readonly label?: string
  readonly current?: boolean
}

/** Keep the complete workspace path distinct; only abbreviate the home prefix. */
export function sessionWorkspaceLabel(cwd: string | undefined, home: string, t: MayflyTranslate, platform: NodeJS.Platform = process.platform): string {
  if (cwd === undefined) return t('No working directory')
  return homeRelative(cwd, home, platform) ?? displayPath(cwd, platform)
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
export function sessionWorkspaceTab(workspace: SessionWorkspaceLabelFacts, currentCwd: string | undefined, home: string, t: MayflyTranslate): MayflyTabItem {
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
