/**
 * Mayfly Host plugin registering the conversation projection and the focused
 * mayflyHost Remote namespace.
 *
 * @module @ephemeral-ai/mayfly-host
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import { conversationProjectionDefinition } from './conversation/projection.ts'
import { MayflyHostService } from './remote/service.ts'

export type * from './types.ts'
export * from './conversation/projection.ts'
export { MayflyHostService } from './remote/service.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-host'

/** Services required by the Mayfly Host projection. */
export const inject = ['sessionProjections']

/**
 * Register the projection and Remote provider on the caller's Fiber.
 * @param ctx - Host plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.sessionProjections.register(conversationProjectionDefinition)
  ctx.plugin(MayflyHostService)
}
