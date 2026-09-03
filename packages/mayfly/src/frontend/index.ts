/** Renderer-neutral Mayfly frontend services and models.
 * @module @ephemeral-ai/mayfly/frontend
 */
import type { Context } from '@deepseek-ai/cordis'
import { MayflyLocaleService } from './locale.ts'

export * from './models.ts'
export * from './theme.ts'
export * from './locale.ts'

export const name = 'mayfly-frontend'

/** Mount Mayfly's ordinary frontend-tree locale service. */
export function apply(ctx: Context): void {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  const service = new MayflyLocaleService(ctx, { systemLocale: locale })
  ctx.effect(() => () => service.dispose())
}
