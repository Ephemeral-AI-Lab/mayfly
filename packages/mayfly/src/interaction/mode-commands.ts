/**
 * Independent plan and permission state over native dsh projections and commands.
 *
 * @module @ephemeral-ai/mayfly/interaction/mode-commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '../app/index.ts'
import type { PermissionPresetsService } from './permission-panel.ts'
import type { InteractionFeedbackReporter } from './notifications.ts'
import { getSharedEditor } from './editor-instance.ts'
import { interactionTranslator } from './locale.ts'
import { registerSessionlessCommand } from './sessionless-commands.ts'

/** Independent native state for plan switching and status display. */
interface MayflySessionModeSnapshot {
  readonly plan: { readonly active: boolean, readonly pending: boolean } | undefined
  readonly yolo: boolean
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolve Mayfly's labels from the native plan and permission projections. */
export function sessionModeSnapshot(ctx: Context, agent: Agent): MayflySessionModeSnapshot {
  const { values } = ctx.sessionProjections.snapshot(agent.session, ['plan', 'permissions'])
  const plan = values.plan
  const currentPreset = values.permissions?.currentValue
  const presets = ctx.get('permissionPresets') as PermissionPresetsService | undefined
  let yolo = false
  if (currentPreset !== undefined && presets !== undefined) {
    try {
      const spec = presets.resolve(currentPreset)
      yolo = spec.sandbox === 'danger-full-access' && spec.approval === 'never'
    } catch {
      /* A withdrawn or derived preset is not a yolo bundle. */
    }
  }
  return { plan, yolo }
}

function showResult(report: InteractionFeedbackReporter, result: { readonly kind: 'success' | 'error', readonly text?: string }): void {
  if (result.text === undefined) return
  report('mode', { message: result.text, severity: result.kind === 'error' ? 'error' : 'success' })
}

/** Toggle only the current Agent's plan selection, preserving permissions. */
export async function cycleMode(ctx: Context, reporter?: InteractionFeedbackReporter): Promise<void> {
  const t = interactionTranslator(ctx)
  const report = reporter ?? getSharedEditor(ctx)?.report ?? (() => {})
  const agent = ctx.mayflyCurrentAgent.current()
  if (agent === null) {
    // The start surface has no Agent to carry plan state yet: the selection
    // rides the lazy start and the first message's session takes it.
    if (ctx.mayflyCurrentAgent.primary() !== null) {
      report('mode', { message: t('no session is live yet'), severity: 'error' })
      return
    }
    const starter = ctx.get('mayflySessionStart')
    if (starter === undefined) {
      report('mode', { message: t('no session is live yet'), severity: 'error' })
      return
    }
    const active = !starter.planActive()
    starter.setPlanActive(active)
    report('mode', {
      message: t(active ? 'Plan mode on for the next session' : 'Plan mode off for the next session'),
      severity: 'success',
    })
    return
  }
  const plan = ctx.sessionProjections.snapshot(agent.session, ['plan']).values.plan
  if (plan === undefined) {
    report('mode', { message: t('plan mode is unavailable'), severity: 'error' })
    return
  }
  // The wire projection's pending flag means the selected value is opposite active.
  const line = plan.active !== plan.pending ? '/plan off' : '/plan'
  try {
    const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
    if (execution === undefined) {
      report('mode', { message: t('mode command is unavailable: /plan'), severity: 'error' })
      return
    }
    showResult(report, execution.result)
  } catch (error) {
    ctx.logger.warn(`mode cycle dispatch failed: ${describe(error)}`)
  }
}

/**
 * Register the native `/plan` command's start-surface form. A live Agent runs
 * the preset's own command; with no session, bare `/plan` and `/plan off` set
 * the pending selection the first message's session takes. A message argument
 * needs a session to steer into and is refused here.
 * @returns the disposer removing the sessionless entry.
 */
export function registerSessionlessPlan(ctx: Context): () => void {
  return registerSessionlessCommand(ctx, {
    name: 'plan',
    description: 'Enter or leave plan mode for the next session',
    input: { hint: '[off]' },
    handler: invocation => {
      const t = interactionTranslator(ctx)
      const starter = ctx.get('mayflySessionStart')
      if (starter === undefined) return { kind: 'error', text: t('plan mode is unavailable') }
      const argument = invocation.rawInput.trim()
      if (argument !== '' && argument !== 'off') return { kind: 'error', text: t('Send a message first: /plan with a message needs a session') }
      const active = argument !== 'off'
      starter.setPlanActive(active)
      return { kind: 'success', text: t(active ? 'Plan mode on for the next session' : 'Plan mode off for the next session') }
    },
  })
}
