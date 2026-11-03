/** Native Job history replay, checkpoints, complete replacement and summary isolation. @module */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { mayflyJobsProjectionDefinition as projection } from '../../src/conversation/jobs.ts'

const registration = { jobId: 'one', owner: 'session', kind: 'shell', label: 'Build', startedAt: 1_000 }
const settled = { ...registration, finishedAt: 2_000, status: 'completed' }
const event = (type: string, data: object): SessionEvent => ({ type, data, seq: 1, time: 2_000 }) as SessionEvent
const value = (events: readonly SessionEvent[]) => events.reduce((state, item) => projection.apply(state, item), projection.init('session' as never, {} as never))

describe('mayflyJobs native history projection', () => {
  it('uses a versioned checkpoint and excludes Job history from model summaries', () => {
    expect(projection.key).toBe('mayflyJobs'); expect(projection.stateVersion).toBe(1)
    expect(projection.wire.summary).toBe(false)
    const empty = projection.init('session' as never, {} as never)
    expect(projection.apply(empty, event('turn/start', {}))).toBe(empty)
    expect(projection.wire.view(empty)).toEqual([])
    expect(projection.wire.view(empty)).toBe(projection.wire.view(empty))
    expect(projection.wire.viewSchema.parse([])).toEqual([])
  })

  it('keeps incomplete registrations absent and replays settlements with or without their registration', () => {
    const open = value([event('job/registered', registration)])
    expect(projection.wire.view(open)).toEqual([])
    const events = [event('job/registered', registration), event('job/settled', { ...settled, label: 'settlement label never replaces registration' }), event('job/settled', { ...settled, jobId: 'two', status: 'failed', detail: 'exit 1' })]
    const state = value(events)
    expect(projection.wire.view(state)).toEqual([
      { id: 'one', owner: 'session', kind: 'shell', label: 'Build', startedAt: 1_000, finishedAt: 2_000, status: 'completed', output: { earliest: 0, total: 0 } },
      { id: 'two', owner: 'session', kind: 'shell', label: 'Build', startedAt: 1_000, finishedAt: 2_000, status: 'failed', detail: 'exit 1', output: { earliest: 0, total: 0 } },
    ])
    const checkpoint = projection.stateSchema.parse(JSON.parse(JSON.stringify(state)))
    expect(projection.wire.view(checkpoint)).toEqual(projection.wire.view(state))
    expect(projection.wire.viewSchema.parse(projection.wire.view(state))).toEqual(projection.wire.view(state))
  })

  it('retains registration order, clears re-registered settlement and leaves prior checkpoints immutable', () => {
    const state = value([event('job/registered', registration), event('job/settled', settled), event('job/settled', { ...settled, jobId: 'two' })])
    const saved = JSON.stringify(state)
    const reopened = projection.apply(state, event('job/registered', registration))
    expect(projection.wire.view(reopened).map(row => row.id)).toEqual(['two'])
    const completed = projection.apply(reopened, event('job/settled', { ...settled, status: 'killed' }))
    expect(projection.wire.view(completed).map(row => row.id)).toEqual(['one', 'two'])
    expect(projection.wire.view(completed)[0]!.status).toBe('killed')
    expect(JSON.stringify(state)).toBe(saved)
    expect(projection.wire.viewSchema.safeParse([{ ...settled, status: 'running' }]).success).toBe(false)
  })
})
