/** The Jobs item of the status row: its summary and closing line, its panel and the stop it offers, and the view that follows the exact current Agent.
 * @module @ephemeral-ai/mayfly/transcript/tests/status-jobs
 */

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { MayflyLocaleService } from '../../src/frontend/locale.ts'
import { JobId, type JobEvent, type JobEventFilter, type JobEventListener, type JobView } from '@deepseek-ai/dsh-jobs'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { MayflyListItem, MayflyUiActionEvent, MayflyUiEventContext } from '@ephemeral-ai/mayfly-ui'
import { describe, expect, it, vi } from 'vitest'
import { DONE_LINGER_MS } from '../../src/transcript/pane-todo.ts'
import * as jobsItem from '../../src/transcript/status-jobs.ts'
import { transcriptTranslatorFake } from './notices-fakes.ts'
import { bootPanePlugin, HandTick } from './pane-fakes.ts'
import { fakeAgent } from './status-fakes.ts'

const openJobOutput = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>(async () => {}))
vi.mock('../../src/interaction/jobs.ts', async (importOriginal) => ({ ...await importOriginal<typeof import('../../src/interaction/jobs.ts')>(), openJobOutput }))

const NOW = 100_000

function job(id: string, status: JobView['status'], extra: Partial<JobView> & { readonly owner?: SessionId } = {}): JobView {
  return { id: JobId(id), kind: 'bash', label: id, status, startedAt: 1, output: { total: 0, earliest: 0 }, ...extra } as JobView
}

/** The text of every rich-text span under a node, in order. */
function spansOf(node: unknown): { readonly text: string, readonly tone?: string }[] {
  if (node === null || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(spansOf)
  const record = node as Record<string, unknown>
  return [...record.kind === 'rich-text' ? record.spans as never[] : [], ...Object.entries(record).filter(([key]) => key !== 'spans').flatMap(([, value]) => spansOf(value))]
}
/** A summary's words at its full form (a shed node also holds its narrower forms). */
const fullText = (node: unknown): string => spansOf(node).map(span => span.text).join('')

describe('jobsSummary', () => {
  const t = transcriptTranslatorFake
  const summary = (jobs: JobView[], extra: Partial<jobsItem.JobsState> = {}) => jobsItem.jobsSummary({ jobs, now: NOW, history: false, ...extra }, t)

  it('counts the live jobs with no time', () => {
    const node = summary([job('a', 'running', { startedAt: NOW - 41_000 }), job('b', 'stopping', { startedAt: NOW - 5_000 }), job('c', 'completed')])!.node
    expect(fullText(node)).toBe('● jobs 2')
  })

  it('holds a closing line once the last live job settles: `✓` or, when one failed, `✕`', () => {
    expect(summary([], { done: { total: 3, failed: false } })!.node).toBeDefined()
    expect(fullText(summary([], { done: { total: 3, failed: false } })!.node)).toBe('✓ jobs 3/3')
    const failed = summary([], { done: { total: 5, failed: true } })!.node
    expect(fullText(failed)).toBe('✕ jobs 5/5')
    expect(spansOf(failed)[0]).toEqual({ text: '✕', tone: 'danger' })
    // A live job outranks a held closing line.
    expect(fullText(summary([job('a', 'running', { startedAt: NOW - 1_000 })], { done: { total: 3, failed: false } })!.node)).toBe('● jobs 1')
  })

  it('shows nothing with no live job and no closing line', () => {
    expect(summary([])).toBeNull()
    expect(summary([job('a', 'completed'), job('b', 'failed')])).toBeNull()
  })
})

describe('listedJobs and jobsPanel', () => {
  const t = transcriptTranslatorFake
  const mixed = [
    job('done-old', 'completed', { startedAt: 1, finishedAt: 10_000, detail: 'exit code: 0' }),
    job('live-late', 'running', { startedAt: 30_000, progress: 'rebuilt 2' }),
    job('failed-new', 'failed', { startedAt: 2, finishedAt: 50_000, detail: 'exit code: 1' }),
    job('live-early', 'running', { startedAt: 20_000 }),
  ]

  it('lists live jobs oldest first, and settled ones newest first only with the viewHistory setting', () => {
    expect(jobsItem.listedJobs({ jobs: mixed, now: NOW, history: false }).map(entry => String(entry.id))).toEqual(['live-early', 'live-late'])
    expect(jobsItem.listedJobs({ jobs: mixed, now: NOW, history: true }).map(entry => String(entry.id))).toEqual(['live-early', 'live-late', 'failed-new', 'done-old'])
  })

  it('has no panel when nothing is listed', () => {
    expect(jobsItem.jobsPanel({ jobs: [job('done', 'completed')], now: NOW, history: false }, t, () => ({}))).toBeNull()
  })

  /** The rows of the panel's list. */
  const rowsOf = (panel: unknown): MayflyListItem[] => {
    const found: MayflyListItem[] = []
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== 'object') return
      const record = value as { readonly kind?: string, readonly items?: MayflyListItem[] }
      if (record.kind === 'list') found.push(...record.items!)
      for (const child of Object.values(value)) walk(child)
    }
    walk(panel)
    return found.filter(row => !row.id.startsWith('jobs-list-pad-'))
  }

  it('draws one aligned row per job: the mark, the label, the producer line, the state word, and the time last', () => {
    const state: jobsItem.JobsState = { jobs: mixed, now: NOW, history: true, stoppedByUser: new Set(['live-late']) }
    const rows = rowsOf(jobsItem.jobsPanel(state, t, () => ({})))
    expect(rows.map(row => row.id)).toEqual(['live-early', 'live-late', 'failed-new', 'done-old'])
    const cells = (row: MayflyListItem): string[] => (row.cells ?? []).map(cell => cell.spans.map(span => span.text).join(''))
    expect(cells(rows[0]!)).toEqual(['live-early', '', ''])
    expect(cells(rows[1]!)).toEqual(['live-late', 'rebuilt 2', 'stopped'])
    expect(cells(rows[2]!)).toEqual(['failed-new', 'exit code: 1', ''])
    expect(cells(rows[3]!)).toEqual(['done-old', 'exit code: 0', ''])
    // The marks say how each ended; the time is the right edge; the producer column is the one that sheds.
    expect(rows.map(row => row.labelSpans![0])).toEqual([{ text: '●', tone: 'accent' }, { text: '●', tone: 'accent' }, { text: '✕', tone: 'danger' }, { text: '✓', tone: 'success' }])
    expect(rows[0]!.right).toEqual([{ text: '1m 20s', tone: 'muted' }])
    // A job the user stopped reads `stopped` at once and is marked `⊘` once the registry says it ended.
    const ended = rowsOf(jobsItem.jobsPanel({ jobs: [job('x', 'killed', { startedAt: 1, finishedAt: 2 })], now: NOW, history: true }, t, () => ({})))
    expect(ended[0]!.labelSpans![0]).toEqual({ text: '⊘', tone: 'muted' })
    expect(rows[0]!.cells![1]).toMatchObject({ shed: 2 })
    // A job that is not running says why `x` cannot act on it.
    const withReasons = rowsOf(jobsItem.jobsPanel(state, t, entry => entry.status === 'running' ? {} : { 'jobs-stop': 'Already finished' }))
    expect(withReasons[2]!.unavailableActions).toEqual({ 'jobs-stop': 'Already finished' })
    expect(withReasons[0]!.unavailableActions).toEqual({})
  })

  it('carries the stop key hidden, behind the shared Yes/No, selecting from the list', () => {
    const panel = JSON.stringify(jobsItem.jobsPanel({ jobs: mixed, now: NOW, history: false }, t, () => ({})))
    expect(panel).toContain('"id":"jobs-stop"')
    expect(panel).toContain('"hidden":true')
    expect(panel).toContain('"confirm"')
    expect(panel).toContain('"controlId":"jobs-list"')
  })
})

function fakeJobs(initial: readonly JobView[] = []) {
  let rows = [...initial]
  let throwOnList: unknown
  /** When set, only this Agent's id lists the rows, as the registry lists by owner. */
  let ownerOnly: string | undefined
  const listeners = new Set<JobEventListener>()
  const service = {
    list: vi.fn((owner?: unknown) => {
      if (throwOnList !== undefined) throw throwOnList
      return ownerOnly === undefined || String(owner) === ownerOnly ? [...rows] : []
    }),
    get: vi.fn((id: unknown) => {
      const found = rows.find(row => String(row.id) === String(id))
      if (found === undefined) throw new Error(`no job ${String(id)}`)
      return found
    }),
    kill: vi.fn(),
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
      const event: JobEvent = { type: 'registered', job: job('changed', 'running', owner === undefined ? {} : { owner }) }
      for (const listener of listeners) listener(event)
    },
    output(owner?: SessionId) {
      const event: JobEvent = { type: 'output', id: JobId('changed'), total: 1, ...owner === undefined ? {} : { owner } } as JobEvent
      for (const listener of listeners) listener(event)
    },
    fail(error: unknown) { throwOnList = error },
    ownedBy(id: unknown) { ownerOnly = String(id) },
  }
}

function currentAgentService(initial: Agent | null) {
  let current = initial
  const listeners = new Set<(agent: Agent | null, revision: number) => void>()
  return {
    service: {
      current: () => current,
      revision: () => 0,
      subscribe(listener: (agent: Agent | null, revision: number) => void) {
        listeners.add(listener)
        listener(current, 0)
        return () => { listeners.delete(listener) }
      },
    },
    switchTo(agent: Agent | null) {
      current = agent
      for (const listener of listeners) listener(agent, 1)
    },
  }
}

async function bootJobs(agent: Agent | null, registry: ReturnType<typeof fakeJobs>, selected = currentAgentService(agent), extras: Record<string, unknown> = {}) {
  const tick = new HandTick()
  const screen = { leaveViews: vi.fn(), enterViews: vi.fn() }
  const harness = await bootPanePlugin(jobsItem, agent as never, { mayflyTick: tick, mayflyCurrentAgent: selected.service, jobs: registry.service, mayflyScreen: screen, mayflyOverlays: {}, ...extras })
  const entry = () => harness.ctx.mayflyPanes.list().find(candidate => candidate.id === 'mayfly.view.jobs')!
  const act = async (event: Record<string, unknown>, signal: AbortSignal = new AbortController().signal): Promise<unknown> => {
    const current = entry()
    const context = { surfaceId: current.id, operationId: 'jobs-test', source: current.source, revision: current.revision, signal, report: vi.fn() } as unknown as MayflyUiEventContext
    return current.definition.onEvent!.action!({ pagePath: [], ...event } as unknown as MayflyUiActionEvent, context)
  }
  const stop = (id: string) => act({ kind: 'activate', controlId: 'jobs-stop', actionId: 'jobs-stop', inputs: { selections: [{ pagePath: [], controlId: 'jobs-list', selectedIds: [id] }] } })
  return { ...harness, tick, entry, act, stop, screen, selected }
}

describe('mayfly-status-jobs', () => {
  it('tracks the exact current Agent and refreshes only on its events', async () => {
    const current = fakeAgent([])
    const foreign = fakeAgent([]) as unknown as Agent
    const registry = fakeJobs()
    const harness = await bootJobs(current as unknown as Agent, registry)
    expect(harness.entry().definition).toMatchObject({ placement: 'views', priority: 12 })
    expect(harness.entry().summary).toBeNull()
    registry.publish([job('a', 'running', { startedAt: Date.now() })], foreign.id)
    expect(harness.entry().summary).toBeNull()
    registry.publish([job('a', 'running', { startedAt: Date.now() })], current.id)
    expect(fullText(harness.entry().summary!.node)).toMatch(/^● jobs 1/u)
    registry.publish([job('a', 'running', { startedAt: Date.now() }), job('b', 'stopping', { startedAt: Date.now() })])
    expect(fullText(harness.entry().summary!.node)).toMatch(/^● jobs 2/u)
    await harness.dispose()
    expect(registry.listenerCount()).toBe(0)
    expect(harness.ctx.mayflyPanes.list().some(candidate => candidate.id === 'mayfly.view.jobs')).toBe(false)
  })

  it('lists every job kind, including a producer that names itself a subagent', async () => {
    const current = fakeAgent([]) as unknown as Agent
    const registry = fakeJobs([job('watch', 'running', { startedAt: Date.now() }), job('reviewer', 'running', { kind: 'subagent', startedAt: Date.now() })])
    const harness = await bootJobs(current, registry)
    expect(fullText(harness.entry().summary!.node)).toMatch(/^● jobs 2/u)
    expect(JSON.stringify(harness.entry().node)).toContain('reviewer')
    await harness.dispose()
  })

  it('ignores output chunks entirely: no registry list per output event', async () => {
    const current = fakeAgent([])
    const foreign = fakeAgent([]) as unknown as Agent
    const registry = fakeJobs()
    const harness = await bootJobs(current as unknown as Agent, registry)
    const baseline = registry.service.list.mock.calls.length
    registry.output(foreign.id)
    registry.output(current.id)
    registry.output()
    expect(registry.service.list.mock.calls.length).toBe(baseline)
    await harness.dispose()
  })

  it('holds the closing line for the jobs that ran together, five seconds, then leaves; a new job starts a new group', async () => {
    const current = fakeAgent([]) as unknown as Agent
    const registry = fakeJobs()
    const harness = await bootJobs(current, registry)
    const start = Date.now()
    registry.publish([job('build', 'running', { startedAt: start - 3_000 }), job('test', 'running', { startedAt: start - 2_000 })])
    expect(harness.tick.subscribers).toBe(1)
    const before = Date.now()
    registry.publish([job('build', 'completed', { startedAt: start - 3_000, finishedAt: start }), job('test', 'failed', { startedAt: start - 2_000, finishedAt: start, detail: 'exit code: 1' })])
    expect(fullText(harness.entry().summary!.node)).toBe('✕ jobs 2/2')
    harness.tick.fire(before + DONE_LINGER_MS - 1)
    expect(harness.entry().summary).not.toBeNull()
    harness.tick.fire(Date.now() + DONE_LINGER_MS + 1_000)
    expect(harness.entry().summary).toBeNull()
    expect(harness.tick.subscribers).toBe(0)
    registry.publish([job('lint', 'running', { startedAt: Date.now() })])
    expect(fullText(harness.entry().summary!.node)).toMatch(/^● jobs 1/u)
    await harness.dispose()
  })

  it('lists settled jobs only when the viewHistory setting is on', async () => {
    const current = fakeAgent([]) as unknown as Agent
    const registry = fakeJobs([job('live', 'running', { startedAt: Date.now() }), job('done', 'completed', { startedAt: 1, finishedAt: 2 })])
    const settings = { value: { viewHistory: false } as Record<string, unknown> }
    const harness = await bootJobs(current, registry, undefined, { mayflyInteractionState: { settingsSource: () => settings.value } })
    expect(JSON.stringify(harness.entry().node)).not.toContain('"id":"done"')
    settings.value = { viewHistory: true }
    harness.ctx.emit('settings/document-updated', 'mayfly' as never, 1)
    expect(JSON.stringify(harness.entry().node)).toContain('"id":"done"')
    await harness.dispose()
  })

  it('keeps settled jobs from the durable job records when the registry no longer lists them', async () => {
    const current = fakeAgent([]) as unknown as Agent
    const owner = current.id
    const id = JobId('bash-0123456789abcdef')
    const registered = {
      jobId: id, owner, kind: 'bash', label: 'old build', startedAt: 1_000,
    }
    const events = [
      { type: 'job/registered', seq: 1, time: 1_000, data: registered },
      { type: 'job/settled', seq: 2, time: 2_000, data: { ...registered, finishedAt: 2_000, status: 'completed', cause: 'producer', producerReported: true, detail: 'exit code: 0' } },
      // A registration without a settlement stays incomplete: never a made-up finish.
      { type: 'job/registered', seq: 3, time: 3_000, data: { ...registered, jobId: JobId('bash-fedcba9876543210'), label: 'incomplete', startedAt: 3_000 } },
    ]
    ;(current.session as unknown as { events: unknown[] }).events.push(...events)
    const registry = fakeJobs()
    const settings = { value: { viewHistory: true } as Record<string, unknown> }
    const harness = await bootJobs(current, registry, undefined, { mayflyInteractionState: { settingsSource: () => settings.value } })
    const panel = JSON.stringify(harness.entry().node)
    expect(panel).toContain('old build')
    expect(panel).toContain('exit code: 0')
    expect(panel).not.toContain('incomplete')
    // A live registry record wins over the same durable settlement, once.
    registry.publish([job('bash-0123456789abcdef', 'completed', { startedAt: 1_000, finishedAt: 2_000, detail: 'exit code: 0' })])
    const rows = JSON.stringify(harness.entry().node).match(/"id":"bash-0123456789abcdef"/gu) ?? []
    expect(rows).toHaveLength(1)
    await harness.dispose()
  })

  it('contains list failures and treats a missing current Agent as empty', async () => {
    const registry = fakeJobs([job('a', 'running')])
    registry.fail(new Error('registry offline'))
    const absent = await bootJobs(null, registry)
    expect(absent.entry().summary).toBeNull()
    await absent.dispose()
    const current = fakeAgent([]) as unknown as Agent
    for (const failure of [new Error('registry offline'), 'registry string failure']) {
      registry.fail(failure)
      const failing = await bootJobs(current, registry)
      expect(failing.entry().summary).toBeNull()
      await failing.dispose()
    }
  })

  it('republishes when the language changes, and answers nothing once it is unloaded', async () => {
    const current = fakeAgent([]) as unknown as Agent
    const registry = fakeJobs([job('a', 'running', { startedAt: Date.now() })])
    const harness = await bootJobs(current, registry)
    await harness.ctx.plugin({ name: 'item-locale', apply(owner: Context) { const service = new MayflyLocaleService(owner, { systemLocale: 'en' }); owner.effect(() => () => service.dispose()) } })
    harness.ctx.mayflyLocale.setPreference('zh')
    expect(harness.entry().summary).not.toBeNull()
    await harness.dispose()
    // The registry may still call a listener that outlived its Fiber: it changes nothing.
    expect(() => registry.publish([])).not.toThrow()
  })

  it('shows the group a refresh found already settled as its closing line: the longest time that ran, from the registry\'s own end', async () => {
    const current = fakeAgent([]) as unknown as Agent
    const registry = fakeJobs()
    const harness = await bootJobs(current, registry)
    const start = Date.now()
    registry.publish([job('a', 'running', { startedAt: start - 9_000 })])
    // One job ends with no end time reported: its time runs to now.
    registry.publish([{ ...job('a', 'completed', { startedAt: start - 9_000 }) }])
    expect(fullText(harness.entry().summary!.node)).toMatch(/^✓ jobs 1\/1$/u)
    await harness.dispose()
  })

  it('ignores a settled list nobody saw working: no closing line for a job that was already done', async () => {
    const current = fakeAgent([]) as unknown as Agent
    const registry = fakeJobs([job('a', 'completed', { startedAt: 1, finishedAt: 2 })])
    const harness = await bootJobs(current, registry)
    registry.publish([job('a', 'completed', { startedAt: 1, finishedAt: 2 }), job('b', 'failed', { startedAt: 1, finishedAt: 2 })])
    expect(harness.entry().summary).toBeNull()
    await harness.dispose()
  })

  describe('the keys', () => {
    const live = (id = 'a') => job(id, 'running', { startedAt: Date.now() })

    it('opens a job\'s output in the reader and returns to the view when it closes', async () => {
      const current = fakeAgent([]) as unknown as Agent
      const registry = fakeJobs([live()])
      const harness = await bootJobs(current, registry)
      openJobOutput.mockImplementationOnce(async (...args: unknown[]) => { (args[5] as () => void)() })
      await expect(harness.act({ kind: 'selection-accept', controlId: 'jobs-list', selectedIds: ['a'] })).resolves.toEqual({ kind: 'completed' })
      expect(harness.screen.leaveViews).toHaveBeenCalledTimes(1)
      const [, agent, id, signal] = openJobOutput.mock.calls.at(-1)!
      expect(agent).toBe(current)
      expect(String(id)).toBe('a')
      expect(signal).toBeInstanceOf(AbortSignal)
      await new Promise<void>(resolve => { setImmediate(resolve) })
      expect(harness.screen.enterViews).toHaveBeenCalledTimes(1)
      await harness.dispose()
    })

    it('does not return to the view once the Agent changed or the item unloaded', async () => {
      const current = fakeAgent([]) as unknown as Agent
      const registry = fakeJobs([live()])
      const harness = await bootJobs(current, registry)
      openJobOutput.mockImplementationOnce(async (...args: unknown[]) => { (args[5] as () => void)(); harness.selected.switchTo(fakeAgent([]) as unknown as Agent) })
      await harness.act({ kind: 'selection-accept', controlId: 'jobs-list', selectedIds: ['a'] })
      await new Promise<void>(resolve => { setImmediate(resolve) })
      expect(harness.screen.enterViews).not.toHaveBeenCalled()
      await harness.dispose()
    })

    it('stops a running job after rechecking the registry, fenced to the exact Agent', async () => {
      const current = fakeAgent([]) as unknown as Agent
      const registry = fakeJobs([live('a'), job('b', 'completed', { startedAt: 1, finishedAt: 2 })])
      const harness = await bootJobs(current, registry)
      const reply = await harness.stop('a')
      expect(reply).toMatchObject({ kind: 'completed', feedback: { severity: 'success', message: 'Stopping a' } })
      expect(registry.service.get).toHaveBeenCalledWith('a', current.id)
      expect(registry.service.kill).toHaveBeenCalledWith('a', current.id, 'stopped from the Mayfly jobs view')
      // The row remembers it was the user who stopped it.
      registry.publish([job('a', 'killed', { startedAt: 1, finishedAt: 2 })])
      await expect(harness.stop('b')).resolves.toMatchObject({ kind: 'failed', message: 'Select a job first' })
      registry.service.kill.mockClear()
      // Stopped, it is not running: a second stop is refused without a second kill.
      await expect(harness.stop('a')).resolves.toMatchObject({ kind: 'failed', message: 'Already finished' })
      expect(registry.service.kill).not.toHaveBeenCalled()
      await harness.dispose()
    })

    it('refuses a job that is no longer running, an unknown selection, and an event from another Agent', async () => {
      const current = fakeAgent([]) as unknown as Agent
      const registry = fakeJobs([live('a')])
      registry.ownedBy(current.id)
      const harness = await bootJobs(current, registry)
      // The registry says it is already finished although the row has not caught up.
      registry.service.get.mockReturnValueOnce(job('a', 'completed', { startedAt: 1, finishedAt: 2 }))
      await expect(harness.stop('a')).resolves.toMatchObject({ kind: 'failed', message: 'Already finished' })
      registry.service.get.mockReturnValueOnce(job('a', 'stopping', { startedAt: 1 }))
      await expect(harness.stop('a')).resolves.toMatchObject({ kind: 'failed', message: 'Already stopping' })
      await expect(harness.stop('missing')).resolves.toMatchObject({ kind: 'failed', message: 'Select a job first' })
      await expect(harness.act({ kind: 'activate', controlId: 'jobs-stop', actionId: 'jobs-stop' })).resolves.toMatchObject({ kind: 'failed', message: 'Select a job first' })
      expect(registry.service.kill).not.toHaveBeenCalled()
      // Another Agent became current: the rows of this one are dropped, so a selection made on them finds no job.
      harness.selected.switchTo(fakeAgent([]) as unknown as Agent)
      await expect(harness.stop('a')).resolves.toMatchObject({ kind: 'failed', message: 'Select a job first' })
      expect(registry.service.kill).not.toHaveBeenCalled()
      // No Agent at all: nothing to act on.
      harness.selected.switchTo(null)
      await expect(harness.stop('a')).resolves.toMatchObject({ kind: 'failed', message: 'The agent changed; open it again' })
      await harness.dispose()
    })

    it('shows no closing line for a group that vanished from the registry', async () => {
      const current = fakeAgent([]) as unknown as Agent
      const registry = fakeJobs()
      const harness = await bootJobs(current, registry)
      registry.publish([live('a')])
      registry.publish([])
      expect(harness.entry().summary).toBeNull()
      await harness.dispose()
    })

    it('answers a failure while opening the output with its text', async () => {
      const current = fakeAgent([]) as unknown as Agent
      const registry = fakeJobs([live('a')])
      const harness = await bootJobs(current, registry)
      registry.service.get.mockImplementationOnce(() => { throw 'registry string failure' })
      await expect(harness.act({ kind: 'selection-accept', controlId: 'jobs-list', selectedIds: ['a'] })).resolves.toMatchObject({ kind: 'failed', message: 'registry string failure' })
      await harness.dispose()
    })

    it('reports a failing kill, answers a cancelled stop quietly, and ignores other events', async () => {
      const current = fakeAgent([]) as unknown as Agent
      const registry = fakeJobs([live('a')])
      const harness = await bootJobs(current, registry)
      registry.service.kill.mockImplementationOnce(() => { throw new Error('already gone') })
      await expect(harness.stop('a')).resolves.toMatchObject({ kind: 'failed', message: 'already gone' })
      const aborted = new AbortController()
      aborted.abort()
      await expect(harness.act({ kind: 'activate', controlId: 'jobs-stop', actionId: 'jobs-stop', inputs: { selections: [{ pagePath: [], controlId: 'jobs-list', selectedIds: ['a'] }] } }, aborted.signal)).resolves.toEqual({ kind: 'cancelled' })
      await expect(harness.act({ kind: 'dismiss' })).resolves.toEqual({ kind: 'completed' })
      await harness.dispose()
    })
  })
})
