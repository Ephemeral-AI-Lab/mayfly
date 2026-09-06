/**
 * Independent plan and permission state over native dsh projections and commands.
 *
 * @module @ephemeral-ai/mayfly/interaction/mode-commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-session-projection'
import { displayServices } from './display-services.ts'
import { getSharedEditor } from './editor-instance.ts'
import type { PermissionPresetsService } from './permission-panel.ts'

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

function showResult(ctx: Context, result: { readonly kind: 'success' | 'error', readonly text?: string }): void {
  if (result.text === undefined) return
  const paint = result.kind === 'error' ? displayServices(ctx)?.colors.error : undefined
  getSharedEditor(ctx)?.notice?.(paint === undefined ? result.text : paint(result.text))
}

/** Toggle only the current Agent's plan selection, preserving permissions. */
export async function cycleMode(ctx: Context): Promise<void> {
  const agent = ctx.mayflyCurrentAgent.current()
  if (agent === null) {
    getSharedEditor(ctx)?.notice?.('no session is live yet')
    return
  }
  const plan = ctx.sessionProjections.snapshot(agent.session, ['plan']).values.plan
  if (plan === undefined) {
    getSharedEditor(ctx)?.notice?.('plan mode is unavailable')
    return
  }
  // The wire projection's pending flag means the selected value is opposite active.
  const line = plan.active !== plan.pending ? '/plan off' : '/plan'
  try {
    const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
    if (execution === undefined) {
      getSharedEditor(ctx)?.notice?.('mode command is unavailable: /plan')
      return
    }
    showResult(ctx, execution.result)
  } catch (error) {
    ctx.logger.warn(`mode cycle dispatch failed: ${describe(error)}`)
  }
}
