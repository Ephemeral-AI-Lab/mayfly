/** Fiber-owned access to the internal structured notification lane.
 * @module @ephemeral-ai/mayfly/interaction/notifications
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyFeedback, MayflyUiScope } from '@ephemeral-ai/mayfly-ui'

export interface InteractionNotificationOwner {
  report(id: string, feedback: MayflyFeedback, scope?: MayflyUiScope, operationId?: string): void
  clear(id: string): void
  clearAll(): void
}
export type InteractionFeedbackReporter = (id: string, feedback: MayflyFeedback) => void

export function currentNotificationScope(ctx: Context, targetId: string): MayflyUiScope {
  const agent = ctx.get('mayflyCurrentAgent')?.current()
  return agent == null ? { kind: 'app', targetId } : { kind: 'session', sessionId: String(agent.id) }
}

/** Create one producer identity and retire only its records with the calling Fiber. */
export function createInteractionNotificationOwner(ctx: Context, label: string, targetId = label): InteractionNotificationOwner {
  const owner = ctx.get('mayflyUiInteraction')?.createNotificationOwner(label)
  if (owner !== undefined) ctx.effect(() => () => owner.dispose())
  return {
    report: (id, feedback, scope = currentNotificationScope(ctx, targetId), operationId = id) => owner?.report(id, scope, feedback, operationId),
    clear: id => owner?.clear(id),
    clearAll: () => owner?.clearAll(),
  }
}
