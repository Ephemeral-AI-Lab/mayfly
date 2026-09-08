/** Native-Agent-scoped UI registrations with selection and Fiber cancellation.
 * @module @ephemeral-ai/mayfly/interaction/agent-overlay
 */
import type { Context, Fiber } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { MayflyOverlayDefinition, MayflyOverlayHandle, MayflyUiActionHandler, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type {} from '../app/index.ts'

/** Own one interactive Agent view under a child Fiber with exact native authority. */
export async function openAgentOverlay(
  ctx: Context,
  agent: Agent,
  definition: Omit<MayflyOverlayDefinition, 'scope' | 'onEvent'>,
  node: MayflyUiNode,
  handler: (ctx: Context) => MayflyUiActionHandler,
  signal?: AbortSignal,
): Promise<MayflyOverlayHandle | undefined> {
  let owner: Fiber | undefined
  let handle: MayflyOverlayHandle | undefined
  let closed = false
  owner = await ctx.plugin({
    name: 'mayfly-agent-overlay',
    inject: ['mayflyCurrentAgent', 'mayflyOverlays'],
    apply(scope: Context) {
      if (closed || scope.mayflyCurrentAgent.current() !== agent || signal?.aborted) { closed = true; return }
      const onEvent = handler(scope)
      handle = scope.mayflyOverlays.open({
        ...definition, scope: { kind: 'session', sessionId: agent.id },
        onEvent: { action: (event, context) => {
          if (scope.mayflyCurrentAgent.current() !== agent || context.signal.aborted) return { kind: 'cancelled', dismiss: true }
          return onEvent(event, context)
        } },
      }, node)
      const close = (): void => { handle?.close() }
      const offAgent = scope.mayflyCurrentAgent.subscribe(current => { if (current !== agent) close() })
      const offOverlay = scope.mayflyOverlays.subscribe(delta => {
        if (delta.kind === 'remove' && delta.id === definition.id && handle?.closed) { closed = true; void owner?.dispose() }
      })
      signal?.addEventListener('abort', close, { once: true })
      scope.effect(() => () => { closed = true; offAgent(); offOverlay(); signal?.removeEventListener('abort', close); handle?.close(); queueMicrotask(() => { void owner?.dispose() }) })
    },
  })
  if (closed || handle === undefined) await owner.dispose()
  return handle
}
