/** Readonly reference upgrade presentation, independent of process and package management.
 * @module @ephemeral-ai/mayfly/interaction/update-model
 */
import { panel, ui, type MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/locale.ts'

/** Stages presented by the immutable rc.2 upgrade panel. */
export type UpdateStep = 'snapshot' | 'install' | 'verify' | 'smoke-imports' | 'smoke-boot' | 'rollback' | 'done'
/** One executor progress fact. */
export interface UpdateProgress { readonly step: UpdateStep, readonly state: 'start' | 'ok' | 'fail' }
/** Settled upgrade facts supplied by the owning process. */
export interface UpdateOutcome {
  readonly kind: 'success' | 'rolled-back' | 'failed-no-rollback' | 'rollback-incomplete'
  readonly fromVersion: string
  readonly toVersion: string
  readonly message: string
  readonly logPath: string
}

/** The step rows the panel renders, in execution order. */
const STEP_ROWS: readonly { step: UpdateStep, label: string }[] = [
  { step: 'snapshot', label: 'snapshot' },
  { step: 'install', label: 'install' },
  { step: 'verify', label: 'verify versions' },
  { step: 'smoke-imports', label: 'smoke: imports' },
  { step: 'smoke-boot', label: 'smoke: boot' },
  { step: 'rollback', label: 'rollback' },
]

/** Renderer-neutral state behind the generic update panel model. */
export interface UpdateProgressState {
  readonly steps: Map<UpdateStep, 'start' | 'ok' | 'fail'>
  outcome?: UpdateOutcome
  blockedMessage?: string
}

/** Create empty progress state for one update attempt. */
export function createUpdateProgressState(): UpdateProgressState {
  return { steps: new Map() }
}

/** Fold one swap progress fact into the model state. */
export function applyUpdateProgress(state: UpdateProgressState, progress: UpdateProgress): void {
  state.steps.set(progress.step, progress.state)
}

/** Project update progress and outcome into the shared panel vocabulary. */
export function updatePanelModel(
  state: UpdateProgressState,
  fromVersion: string,
  toVersion: string,
  t: MayflyTranslate = interpolateLocaleMessage,
): MayflyUiNode {
  const stepItems = STEP_ROWS.flatMap(row => {
    const value = state.steps.get(row.step)
    if (value === undefined && row.step === 'rollback') return []
    const mark = value === 'ok' ? '✓' : value === 'fail' ? '✗' : value === 'start' ? '…' : '·'
    return [{ id: row.step, label: `${mark} ${t(row.label)}`, disabled: true }]
  })
  const nodes: MayflyUiNode[] = [
    { kind: 'divider', label: `v${fromVersion} → v${toVersion}` },
    { kind: 'list', role: 'browse', id: 'update-steps', selectedIds: [], items: stepItems },
  ]
  if (state.outcome !== undefined) {
    nodes.push(
      { kind: 'divider', label: t(state.outcome.kind === 'success' ? 'Complete' : 'Failed') },
      { kind: 'text', content: state.outcome.message },
      { kind: 'text', content: t('log: {path}', { path: state.outcome.logPath }), tone: 'muted' },
    )
  }
  if (state.blockedMessage !== undefined) {
    nodes.push(
      { kind: 'divider', label: t('Blocked') },
      { kind: 'text', content: state.blockedMessage, tone: 'danger' },
      { kind: 'text', content: t('nothing was changed'), tone: 'muted' },
    )
  }
  return panel({
    title: t('Update Mayfly'),
    escapeLabel: 'close',
    body: ui.stack.column(nodes),
  })
}

