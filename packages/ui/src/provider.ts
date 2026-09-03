/**
 * Fiber-owned Cordis providers for Mayfly's four UI contribution services.
 *
 * @module @ephemeral-ai/mayfly-ui/provider
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-include'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import {
  MayflyEditorExtensionService,
  MayflyOverlayService,
  MayflyPaneService,
  MayflyStatusService,
} from './services.ts'

export {
  MayflyEditorExtensionService,
  MayflyOverlayService,
  MayflyPaneService,
  MayflyStatusService,
} from './services.ts'

export const name = 'mayfly-ui-provider'

export function apply(ctx: Context): void {
  ctx.plugin(MayflyPaneService)
  ctx.plugin(MayflyOverlayService)
  ctx.plugin(MayflyStatusService)
  ctx.plugin(MayflyEditorExtensionService)
}
