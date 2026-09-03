/**
 * Capturing overlay example opened only from a Mayfly-owned user dispatch.
 *
 * @module @mayfly-example/overlay
 */
import type { Context } from '@deepseek-ai/cordis'
import type { MayflyOverlayDefinition, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type {} from '@deepseek-ai/dsh-commands'
import { ui } from '@ephemeral-ai/mayfly-ui'

export const name = '@mayfly-example/overlay'
export const inject = ['commands', 'mayflyOverlays']

/** Static request reused by the command and packed fixture. */
export const overlayRequest: MayflyOverlayDefinition & { readonly node: MayflyUiNode } = {
  id: 'example.overlay.details',
  title: 'Example details',
  capturing: true,
  dismissible: true,
  anchor: 'center',
  width: '70%',
  maxHeight: '70%',
  node: ui.stack.column([
    ui.text('Opened by an explicit Mayfly user gesture.'),
    ui.text('Escape returns focus to the previous surface.', { tone: 'muted' }),
  ], { gap: 1 }),
}

/** Register a regular dsh command that opens the direct Mayfly overlay. */
export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'example-overlay',
    description: 'Open the example overlay',
    handler: () => {
      ctx.mayflyOverlays.close(overlayRequest.id)
      const { node, ...definition } = overlayRequest
      ctx.mayflyOverlays.open(definition, node)
      return { kind: 'success', text: 'opened the example overlay' }
    },
  })
}
