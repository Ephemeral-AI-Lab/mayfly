/** Native jobs status contribution behavior.
 * @module @ephemeral-ai/mayfly/transcript/tests/status-jobs
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, type JobEvent, type JobEventFilter, type JobEventListener, type JobView } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import * as jobs from '../../src/transcript/status-jobs.ts'
import { bootStatusPlugin, COLORS, fakeAgent } from './status-fakes.ts'

function job(id: string, status: JobView['status'], owner?: SessionId): JobView {
  return { id: JobId(id), kind: 'bash', label: id, status, startedAt: 1, output: { total: 0, earliest: 0 }, ...owner === undefined ? {} : { owner } }
}

function fakeJobs(initial: readonly JobView[] = []) {
  let rows = [...initial]
  let throwOnList: unknown
  const listeners = new Set<JobEventListener>()
  const service = {
    list: vi.fn(() => {
      if (throwOnList !== undefined) throw throwOnList
      return [...rows]
    }),
    events: {
      subscribe(_filter: JobEventFilter, listener: JobEventListener) {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    },
  }
  return {
    service,
    listenerCount: () => listeners.size,
    publish(next: readonly JobView[], owner?: SessionId) {
      rows = [...next]
      const event: JobEvent = { type: 'registered', job: job('changed', 'running', owner) }
      for (const listener of listeners) listener(event)
    },
    output(owner?: SessionId) {
      const event: JobEvent = { type: 'output', id: JobId('changed'), total: 1, ...owner === undefined ? {} : { owner } }
      for (const listener of listeners) listener(event)
    },
    fail(error: unknown) { throwOnList = error },
  }
}

describe('liveJobCount', () => {
  it('counts only running and stopping jobs', () => {
    expect(jobs.liveJobCount([])).toBe(0)
    expect(jobs.liveJobCount([
      job('a', 'running'), job('b', 'stopping'), job('c', 'completed'), job('d', 'killed'), job('e', 'failed'),
    ])).toBe(2)
  })
})

describe('mayfly-status-jobs', () => {
  it('tracks the exact current Agent and only refreshes visible count changes', async () => {
    const current = fakeAgent([])
    const foreign = fakeAgent([]) as unknown as Agent
    const registry = fakeJobs()
    const accent = (text: string): string => `[Ac]${text}[/Ac]`
    const harness = await bootStatusPlugin(jobs, current, {
      colors: { ...COLORS, primary: accent },
      services: {
        jobs: registry.service,
        mayflyCurrentAgent: {
          current: () => current as unknown as Agent,
          subscribe(listener: (agent: Agent | null, revision: number) => void) {
            listener(current as unknown as Agent, 0)
            return () => {}
          },
        },
      },
    })
    expect(harness.entry.id).toBe('')
    registry.publish([job('a', 'running')], foreign.id)
    expect(harness.entry.id).toBe('')
    registry.publish([job('a', 'running')], current.id)
    expect(harness.entry.id).toBe('mayfly.status.jobs')
    expect(harness.entry.priority).toBe(3)
    expect(harness.entry.render(80)).toBe('[Ac]⏵ 1 jobs[/Ac]')
    const baseline = harness.screen.renderRequests.length
    registry.publish([job('a', 'running'), job('done', 'completed')])
    expect(harness.screen.renderRequests.length).toBe(baseline)
    registry.publish([job('a', 'running'), job('b', 'stopping')])
    expect(harness.entry.render(80)).toBe('[Ac]⏵ 2 jobs[/Ac]')
    registry.publish([job('a', 'completed')])
    expect(harness.entry.id).toBe('')
    await harness.dispose()
    expect(registry.listenerCount()).toBe(0)
  })

  it('refreshes on owned and unowned output events but ignores foreign owners', async () => {
    const current = fakeAgent([])
    const foreign = fakeAgent([]) as unknown as Agent
    const registry = fakeJobs()
    const harness = await bootStatusPlugin(jobs, current, {
      services: {
        jobs: registry.service,
        mayflyCurrentAgent: {
          current: () => current as unknown as Agent,
          subscribe(listener: (agent: Agent | null, revision: number) => void) {
            listener(current as unknown as Agent, 0)
            return () => {}
          },
        },
      },
    })
    const listed = () => registry.service.list.mock.calls.length
    const baseline = listed()
    registry.output(foreign.id)
    expect(listed()).toBe(baseline)
    registry.output(current.id)
    expect(listed()).toBe(baseline + 1)
    registry.output()
    expect(listed()).toBe(baseline + 2)
    await harness.dispose()
  })

  it('contains list failures and treats a missing current Agent as empty', async () => {
    const registry = fakeJobs([job('a', 'running')])
    registry.fail(new Error('registry offline'))
    const harness = await bootStatusPlugin(jobs, null, {
      services: {
        jobs: registry.service,
        mayflyCurrentAgent: {
          current: () => null,
          subscribe(listener: (agent: Agent | null, revision: number) => void) {
            listener(null, 0)
            return () => {}
          },
        },
      },
    })
    expect(harness.entry.id).toBe('')
    await harness.dispose()

    const current = fakeAgent([])
    registry.fail('registry string failure')
    const failing = await bootStatusPlugin(jobs, current, {
      services: {
        jobs: registry.service,
        mayflyCurrentAgent: {
          current: () => current as unknown as Agent,
          subscribe(listener: (agent: Agent | null, revision: number) => void) {
            listener(current as unknown as Agent, 0)
            return () => {}
          },
        },
      },
    })
    expect(failing.entry.id).toBe('')
    await failing.dispose()

    registry.fail(new Error('registry offline'))
    const errorFailure = await bootStatusPlugin(jobs, current, {
      services: {
        jobs: registry.service,
        mayflyCurrentAgent: {
          current: () => current as unknown as Agent,
          subscribe(listener: (agent: Agent | null, revision: number) => void) {
            listener(current as unknown as Agent, 0)
            return () => {}
          },
        },
      },
    })
    expect(errorFailure.entry.id).toBe('')
    await errorFailure.dispose()
  })
})
