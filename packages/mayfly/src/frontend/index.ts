/** Renderer-neutral Mayfly frontend services and models.
 * @module @ephemeral-ai/mayfly/frontend
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MayflyLocaleService } from './locale.ts'
import { MayflyUiImagesService } from '../core/ui-images.ts'
import { mountUiRegistryObservers, UiInteractionService } from '../core/ui-interaction-state.ts'
import { MayflyTickService } from '../transcript/tick.ts'
import { InteractionStateService } from '../interaction/runtime-state.ts'
import { DEFAULT_SETTINGS } from '../frontend/settings.ts'

export * from './models.ts'
export * from './theme.ts'
export * from './locale.ts'
export * from './common-locale.ts'
export { createInteractionNotificationOwner } from '../interaction/notifications.ts'

export const name = 'mayfly-frontend'
export interface Config { readonly displayVersion?: string }
export const Config: z<Config> = z.object({ displayVersion: z.string() })

/** Mount stable interaction ownership and its independent consumer Fibers. */
export function apply(ctx: Context): void {
  const state = new InteractionStateService(ctx, DEFAULT_SETTINGS)
  ctx.effect(() => () => state.dispose())
  const tick = new MayflyTickService(ctx)
  ctx.effect(() => () => tick.dispose())
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const service = new MayflyLocaleService(ctx, { systemLocale: locale })
  ctx.effect(() => () => service.dispose())
  // Image bytes are provided before the interaction owner, whose arrival is what mounts the renderers that read them.
  const images = new MayflyUiImagesService(ctx)
  ctx.effect(() => () => images.dispose())
  const interaction = new UiInteractionService(ctx)
  ctx.effect(() => () => interaction.dispose())
  mountUiRegistryObservers(ctx)
}
