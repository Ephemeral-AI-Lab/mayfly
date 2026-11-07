/** Fiber-owned access to the internal structured notification lane.
 * @module @ephemeral-ai/mayfly/interaction/notifications
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyFeedback, MayflyUiScope } from '@ephemeral-ai/mayfly-ui'

interface InteractionNotificationOwner {
  report(id: string, feedback: MayflyFeedback, scope?: MayflyUiScope, operationId?: string): void
  clear(id: string): void
  clearAll(): void
}

/** Create one producer identity and retire only its records with the calling Fiber. */
export function createInteractionNotificationOwner(ctx: Context, label: string, scope: () => MayflyUiScope): InteractionNotificationOwner {
  const owner = ctx.get('mayflyUiInteraction')?.createNotificationOwner(label)
  if (owner !== undefined) ctx.effect(() => () => owner.dispose())
  return {
    report: (id, feedback, target = scope(), operationId = id) => owner?.report(id, target, feedback, operationId),
    clear: id => owner?.clear(id),
    clearAll: () => owner?.clearAll(),
  }
}
