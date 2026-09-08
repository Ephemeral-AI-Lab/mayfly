/**
 * Independent plan and permission state over native dsh projections and commands.
 *
 * @module @ephemeral-ai/mayfly/interaction/mode-commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { PermissionPresetsService } from './permission-panel.ts'
import type { InteractionFeedbackReporter } from './notifications.ts'
import { getSharedEditor } from './editor-instance.ts'

/** Independent native state for plan switching and status display. */
export interface MayflySessionModeSnapshot {
  readonly plan: { readonly active: boolean, readonly pending: boolean } | undefined
  readonly yolo: boolean
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve Mayfly's labels from dsh's plan projection and permission bundles. */
export function sessionModeSnapshot(ctx: Context, agent: Agent): MayflySessionModeSnapshot {
  const plan = ctx.sessionProjections.snapshot(agent.session, ['plan']).values.plan
  const presets = ctx.get('permissionPresets') as PermissionPresetsService | undefined
  const currentPreset = presets?.current(agent.session)
  const yolo = presets?.names.some(name => {
    if (name !== currentPreset) return false
    const spec = presets.resolve(name)
    return spec.sandbox === 'danger-full-access' && spec.approval === 'never'
  }) ?? false
  return { plan, yolo }
}

function showResult(report: InteractionFeedbackReporter, result: { readonly kind: 'success' | 'error', readonly text?: string }): void {
  if (result.text === undefined) return
  report('mode', { message: result.text, severity: result.kind === 'error' ? 'error' : 'success' })
}

/** Toggle only the current Agent's plan selection, preserving permissions. */
export async function cycleMode(ctx: Context, reporter?: InteractionFeedbackReporter): Promise<void> {
  const report = reporter ?? getSharedEditor(ctx)?.report ?? (() => {})
  const agent = ctx.mayflyCurrentAgent.current()
  if (agent === null) {
    report('mode', { message: 'no session is live yet', severity: 'error' })
    return
  }
  const plan = ctx.sessionProjections.snapshot(agent.session, ['plan']).values.plan
  if (plan === undefined) {
    report('mode', { message: 'plan mode is unavailable', severity: 'error' })
    return
  }
  // The wire projection's pending flag means the selected value is opposite active.
  const line = plan.active !== plan.pending ? '/plan off' : '/plan'
  try {
    const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
    if (execution === undefined) {
      report('mode', { message: 'mode command is unavailable: /plan', severity: 'error' })
      return
    }
    showResult(report, execution.result)
  } catch (error) {
    ctx.logger.warn(`mode cycle dispatch failed: ${describe(error)}`)
  }
}
