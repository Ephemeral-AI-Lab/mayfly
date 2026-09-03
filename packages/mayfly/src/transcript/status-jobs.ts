/**
 * Native live-job count in the Mayfly status footer.
 *
 * @module @ephemeral-ai/mayfly/transcript/status-jobs
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import type { MayflyStatusNode } from '@ephemeral-ai/mayfly-ui'

/** Stable Cordis plugin name. */
export const name = 'mayfly-status-jobs'

/** Native and Mayfly services required by the status contribution. */
export const inject = ['mayflyStatus', 'mayflyCurrentAgent', 'jobs']

/** Count jobs still occupying the background queue. */
export function liveJobCount(jobs: readonly JobSnapshot[]): number {
  return jobs.filter(job => job.status === 'running' || job.status === 'stopping').length
}

/** Register the direct status contribution. */
export function apply(ctx: Context): void {
  let text = ''
  let status: ReturnType<typeof ctx.mayflyStatus.register>
  const node = (): MayflyStatusNode | null => text === '' ? null : { kind: 'text', content: text, tone: 'primary' }
  const refresh = (): void => {
    const agent = ctx.mayflyCurrentAgent.current()
    let count = 0
    try {
      count = agent === null ? 0 : liveJobCount(ctx.jobs.list(agent))
    } catch (error) {
      ctx.logger.warn(`could not list background jobs for status: ${error instanceof Error ? error.message : String(error)}`)
    }
    const next = count > 0 ? `⏵ ${String(count)} jobs` : ''
    if (next === text) return
    text = next
    status?.set(node())
  }
  status = ctx.mayflyStatus.register({
    id: 'mayfly.status.jobs',
    priority: 3,
  }, node())
  const offJobs = ctx.jobs.onJobsChanged((owner) => {
    const current = ctx.mayflyCurrentAgent.current()
    if (owner === undefined || owner === current) refresh()
  })
  const offAgent = ctx.mayflyCurrentAgent.subscribe(() => refresh())
  ctx.effect(() => () => {
    offJobs()
    offAgent()
  })
}
