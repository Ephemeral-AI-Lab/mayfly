/** Real local jobs, native command dispatch, and shared UI fixtures.
 * @module @ephemeral-ai/mayfly/tests/interaction/jobs-fixture
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { vi } from 'vitest'
import * as jobsPlugin from '../../src/interaction/jobs.ts'
import { informationFixture } from './information-fixture.ts'
import { flushRequests } from './request-fixture.ts'

export async function jobsFixture(ctx: Context) {
  const bench = await informationFixture(ctx)
  Object.assign(bench.other, { ctx: new Context() })
  ctx.effect(() => async () => { await bench.agent.ctx.fiber.dispose(); await bench.other.ctx.fiber.dispose() })
  const provider = await ctx.plugin(LocalJobRegistry, {})
  const registry = ctx.jobs
  const controller = await ctx.plugin({ name: 'test-job-controller', inject: ['jobs'], apply(owner: Context) { owner.jobs.attachController('test') } })
  const consumer = await ctx.plugin(jobsPlugin)
  const start = (options: { owner?: Agent | null, label?: string, output?: string, finalOnly?: boolean } = {}) => {
    const done = Promise.withResolvers<JobOutcome>()
    let pending = options.output ?? ''
    const readOutput = vi.fn(() => { const text = pending; pending = ''; return text })
    const cancel = vi.fn((_reason?: string) => { done.resolve({ status: 'killed' }) })
    const owner = options.owner === null ? undefined : options.owner ?? bench.agent
    const id = registry.start({ kind: 'bash', label: options.label ?? 'Example job', ...(owner === undefined ? {} : { owner }), run: () => ({
      cancel, done: done.promise, ...(options.finalOnly === true ? {} : { readOutput }),
    }) })
    return { id, cancel, readOutput, append(text: string) { pending += text }, async finish(outcome: JobOutcome) { done.resolve(outcome); await flushRequests() } }
  }
  return { ...bench, registry, provider, controller, consumer, start }
}
