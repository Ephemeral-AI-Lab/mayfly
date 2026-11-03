/**
 * Mayfly Host plugin registering conversation and Workflow projections plus
 * the focused mayflyHost Remote namespace.
 *
 * @module @ephemeral-ai/mayfly-host
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-session-projection'
import { mayflyJobsProjectionDefinition } from './conversation/jobs.ts'
import { deliverablesProjection } from './conversation/deliverables.ts'
import { conversationFactsProjectionDefinition } from './conversation/facts.ts'
import { conversationProjectionDefinition } from './conversation/projection.ts'
import { MayflyHostService } from './remote/service.ts'
import { mayflyRetractionProjectionDefinition } from './remote/retraction.ts'
import { mayflyWorkflowProjectionDefinition } from './remote/workflow.ts'

export type * from './types.ts'
export * from './conversation/projection.ts'
export * from './conversation/facts.ts'
export * from './conversation/deliverables.ts'
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
  await ctx.sessionProjections.register(conversationFactsProjectionDefinition)
  await ctx.sessionProjections.register(deliverablesProjection)
  await ctx.sessionProjections.register(mayflyJobsProjectionDefinition)
  await ctx.sessionProjections.register(mayflyWorkflowProjectionDefinition)
  await ctx.sessionProjections.register(mayflyRetractionProjectionDefinition)
  ctx.plugin(MayflyHostService)
}
