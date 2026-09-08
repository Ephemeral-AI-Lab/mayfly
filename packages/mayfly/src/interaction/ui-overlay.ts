/** Signal cleanup for ordinary UI overlay registrations.
 * @module @ephemeral-ai/mayfly/interaction/ui-overlay
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyOverlayDefinition, MayflyOverlayHandle, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'

export function openUiOverlay(ctx: Context, definition: MayflyOverlayDefinition, node: MayflyUiNode, signal?: AbortSignal): MayflyOverlayHandle {
  signal?.throwIfAborted()
  const registry = ctx.get('mayflyOverlays')
  if (registry === undefined) throw new Error('Mayfly overlays are unavailable')
  const handle = registry.open(definition, node)
  const abort = () => handle.close()
  let cleanup!: () => void
  const off = registry.subscribe(delta => { if (delta.kind === 'remove' && delta.id === definition.id && handle.closed) cleanup() })
  cleanup = ctx.effect(() => () => { off(); signal?.removeEventListener('abort', abort) })
  signal?.addEventListener('abort', abort, { once: true })
  if (handle.closed) cleanup()
  return handle
}
