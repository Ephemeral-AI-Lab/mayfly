/** Real local Job registry controls, retained output and exact-Agent reader/browser lifetimes. @module */
import { Context } from '@deepseek-ai/cordis'
import { JobId, type JobView, type JobOutputRead } from '@deepseek-ai/dsh-jobs'
import { ui, type MayflyTranslate, type MayflyOverlayHandle } from '@ephemeral-ai/mayfly-ui'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { formatJobDuration, jobHistory, sortJobs, jobItems, jobDetailsNode, jobOutputNode, openJobOutput, JOB_OUTPUT_FEED_CHUNKS } from '../../src/interaction/jobs.ts'
import { jobsFixture } from './jobs-fixture.ts'
import { nativeAction, activate, select } from './native-action-fixture.ts'
import { flushRequests } from './request-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { vi.restoreAllMocks(); vi.useRealTimers(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const t: MayflyTranslate = (key, values) => key.replace(/\{([^}]+)\}/gu, (_whole, name: string) => String(values?.[name] ?? ''))
const view = (id: string, status: JobView['status'] = 'completed', options: Partial<JobView> = {}): JobView => ({ id: JobId(id), kind: 'bash', label: id, status, startedAt: 100, output: { total: 0, earliest: 0 }, ...options })
async function setup() {
  const ctx = new Context(); contexts.push(ctx)
  const f = await jobsFixture(ctx)
  const model = (id = 'mayfly.jobs') => ctx.mayflyUiInteraction.get('overlay', id)!
  const text = (id?: string) => JSON.stringify(model(id).registration.node)
  const open = async () => { const result = await f.run('/jobs'); await flushRequests(); return result }
  const act = (action: string, signal?: AbortSignal) => nativeAction(model(), activate(action, 'job-actions'), signal)
  const choose = (id?: string) => nativeAction(model(), select('jobs', ...id === undefined ? [] : [id]))
  return { ...f, model, text, open, act, choose }
}

describe('native Jobs readonly facts', () => {
  it('formats durations and sorts active-first then newest-settled, with valid absent completion times', () => {
    expect([formatJobDuration(10, 0), formatJobDuration(0, 59_999), formatJobDuration(0, 120_000), formatJobDuration(0, 7_200_000), formatJobDuration(0, 7_260_000)]).toEqual(['0s', '59s', '2m', '2h', '2h 1m'])
    const jobs = [view('done-old', 'completed', { finishedAt: 300 }), view('running-late', 'running', { startedAt: 200 }), view('stopping', 'stopping', { startedAt: 100 }), view('done-new', 'failed', { finishedAt: 400, detail: 'failed detail' }), view('done-no-finish', 'killed', { startedAt: 50 })]
    expect(sortJobs(jobs).map(job => job.id)).toEqual(['stopping', 'running-late', 'done-new', 'done-old', 'done-no-finish'])
    expect(sortJobs(jobs.toReversed()).map(job => job.id)).toEqual(['stopping', 'running-late', 'done-new', 'done-old', 'done-no-finish'])
    expect(jobItems(jobs, 1000, t).find(item => item.id === 'done-new')).toMatchObject({ detail: 'failed detail' })
    expect(JSON.stringify(jobDetailsNode(jobs[1]!, t))).toContain('Stop job')
    expect(JSON.stringify(jobDetailsNode(jobs[3]!, t))).toContain('failed detail')
    expect(JSON.stringify(jobOutputNode(jobs[0]!, { dropped: false, chunks: [] }, t))).toContain('(no output)')
    expect(JSON.stringify(jobOutputNode(jobs[1]!, { dropped: true, chunks: [] }, t))).toContain('(no output yet)')
  })

  it('uses real durable registration/settlement facts in registration order and omits unfinished jobs', async () => {
    const f = await setup()
    const data = { jobId: JobId('durable'), owner: f.session.id, kind: 'bash', label: 'durable', startedAt: 10 }
    f.session.append('job/registered', data)
    f.session.append('job/registered', { ...data, jobId: JobId('pending') })
    f.session.append('job/settled', { ...data, finishedAt: 20, status: 'completed', cause: 'producer' as never, producerReported: true })
    f.session.append('job/settled', { ...data, jobId: JobId('settled-only'), finishedAt: 30, status: 'failed', detail: 'late', cause: 'producer' as never, producerReported: true })
    f.session.append('turn/start', { turn: 1 })
    expect(jobHistory(f.session)).toMatchObject([{ id: 'durable', status: 'completed' }, { id: 'settled-only', detail: 'late' }])
  })
})

describe('native Jobs browser ownership', () => {
  it('browses only the selected Agent roster, focuses an existing panel and unregisters on unload', async () => {
    const f = await setup()
    const mine = f.start({ label: 'my-job', output: 'one\n' })
    const foreign = f.start({ owner: f.other, label: 'other-job' })
    await f.open()
    expect(f.text()).toContain('my-job')
    expect(f.text()).not.toContain('other-job')
    const model = f.model()
    await f.open()
    expect(f.model()).toBe(model)
    await mine.finish({ status: 'completed' })
    await foreign.finish({ status: 'completed' })
    await f.consumer.dispose()
    expect(model.disposed).toBe(true)
    expect(f.ctx.commands.find(f.agent, 'jobs')).toBeUndefined()
  })

  it('reports an empty/unavailable registry and recovers on explicit refresh', async () => {
    const f = await setup()
    const list = vi.spyOn(f.registry, 'list').mockImplementation(() => { throw new Error('list denied') })
    await f.open()
    expect(f.text()).toContain('Job registry unavailable')
    list.mockRestore()
    await f.act('refresh')
    expect(f.text()).toContain('no background jobs')
  })

  it('selects detail, reads only on explicit output action, follows new output, and backs through each page', async () => {
    const f = await setup()
    const job = f.start({ output: 'first\n' })
    const read = vi.spyOn(f.registry, 'readAt')
    await f.open()
    expect(read).not.toHaveBeenCalled()
    await f.choose(job.id)
    expect(f.text()).toContain('Read output')
    expect(read).not.toHaveBeenCalled()
    await f.act('read')
    expect(f.text()).toContain('first')
    job.append('second\n')
    await flushRequests()
    expect(f.text()).toContain('second')
    expect(await nativeAction(f.model(), { kind: 'dismiss', pagePath: [] })).toMatchObject({ kind: 'completed', dismiss: false })
    expect(f.text()).toContain('Read output')
    expect(await nativeAction(f.model(), { kind: 'dismiss', pagePath: [] })).toMatchObject({ kind: 'completed', dismiss: false })
    expect(f.text()).toContain('"title":"Jobs"')
    expect(await nativeAction(f.model(), { kind: 'dismiss', pagePath: [] })).toMatchObject({ kind: 'completed' })
    await job.finish({ status: 'completed' })
  })

  it('stops only an explicitly selected running job and rechecks native liveness before another stop', async () => {
    const f = await setup()
    const job = f.start()
    await f.open()
    await f.choose(job.id)
    expect(await f.act('stop')).toMatchObject({ kind: 'completed' })
    await flushRequests()
    expect(job.cancel).toHaveBeenCalledOnce()
    expect(await f.act('stop')).toMatchObject({ kind: 'completed' })
    expect(job.cancel).toHaveBeenCalledOnce()
  })

  it('reports unavailable selections, forwards native read/stop failures and ignores unrelated controls', async () => {
    const f = await setup()
    const job = f.start()
    await f.open()
    expect(await f.choose(undefined)).toMatchObject({ kind: 'failed', message: 'The job is no longer available' })
    expect(await nativeAction(f.model(), select('foreign', String(job.id)))).toMatchObject({ kind: 'completed' })
    expect(await f.act('unknown')).toMatchObject({ kind: 'completed' })
    await f.choose(job.id)
    const read = vi.spyOn(f.registry, 'readAt')
    for (const error of [new Error('read denied'), 'string failure']) {
      read.mockImplementationOnce(() => { throw error })
      expect(await f.act('read')).toMatchObject({ kind: 'failed', message: error instanceof Error ? error.message : error })
    }
    const kill = vi.spyOn(f.registry, 'kill')
    for (const error of [new Error('stop denied'), 'string stop']) {
      kill.mockImplementationOnce(() => { throw error })
      expect(await f.act('stop')).toMatchObject({ kind: 'failed', message: error instanceof Error ? error.message : error })
    }
    await job.finish({ status: 'completed' })
  })

  it('uses a timer only while jobs remain live and retires it after native completion or registry failure', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const f = await setup()
    const job = f.start()
    await f.open()
    await vi.advanceTimersByTimeAsync(1000)
    const list = vi.spyOn(f.registry, 'list').mockImplementationOnce(() => { throw new Error('refresh denied') })
    await f.act('refresh')
    expect(f.text()).toContain('Job registry unavailable')
    list.mockRestore()
    await f.act('refresh')
    await job.finish({ status: 'completed' })
    await f.act('refresh')
    await vi.advanceTimersByTimeAsync(1000)
    expect(f.text()).toContain('completed')
  })

  it('returns to the list if the currently displayed job leaves the native roster and retains output on failed catch-up', async () => {
    const f = await setup()
    const job = f.start({ output: 'held output' })
    await f.open()
    await f.choose(job.id)
    await f.act('read')
    const read = vi.spyOn(f.registry, 'readAt').mockImplementationOnce(() => { throw new Error('catch-up denied') })
    await f.act('refresh')
    expect(f.text()).toContain('held output')
    read.mockRestore()
    const list = vi.spyOn(f.registry, 'list').mockReturnValue([])
    await f.act('refresh')
    expect(f.text()).toContain('no background jobs')
    list.mockRestore()
    await job.finish({ status: 'completed' })
  })

  it('does not mount for cancelled or stale invocations and ignores cancellation during a synchronous native output read', async () => {
    const f = await setup()
    const definition = f.ctx.commands.find(f.agent, 'jobs')!
    expect(await definition.handler({ agent: f.other, signal: new AbortController().signal, rawInput: '' } as never)).toEqual({ kind: 'success' })
    expect(await definition.handler({ agent: f.agent, signal: AbortSignal.abort(), rawInput: '' } as never)).toEqual({ kind: 'success' })
    const job = f.start({ output: 'data' })
    await f.open()
    await f.choose(job.id)
    const original = f.registry.readAt.bind(f.registry)
    const read = vi.spyOn(f.registry, 'readAt')
    read.mockImplementationOnce((...args) => { const result = original(...args); f.ctx.mayflyConversations.selectPrimary(f.other); return result })
    expect(await f.act('read')).toBeUndefined()
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(0)
    await job.finish({ status: 'completed' })
  })

  it('retires publication when its invocation ends during a roster read and cancels a callback queued before closure', async () => {
    const f = await setup()
    const caller = new AbortController()
    const definition = f.ctx.commands.find(f.agent, 'jobs')!
    await definition.handler({ agent: f.agent, signal: caller.signal, rawInput: '' } as never)
    const model = f.model()
    const queued = f.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.jobs')!.definition.onEvent!.action!
    const context = { surfaceId: model.id, source: model.source, revision: model.revision, operationId: 'queued-before-close', signal: new AbortController().signal, report: vi.fn() }
    const read = f.registry.list.bind(f.registry)
    vi.spyOn(f.registry, 'list').mockImplementationOnce((...args) => { const rows = read(...args); caller.abort(); return rows })
    expect(await f.act('refresh')).toBeUndefined()
    expect(model.disposed).toBe(true)
    expect(await queued({ kind: 'dismiss', pagePath: [] }, context)).toMatchObject({ kind: 'cancelled', dismiss: true })
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(0)
  })
})

describe('native standalone Job output reader', () => {
  it('reads the exact owner, appends native output without consuming another cursor, refreshes locale and closes once', async () => {
    const f = await setup()
    const job = f.start({ output: 'initial\n' })
    const closed = vi.fn()
    const caller = new AbortController()
    await openJobOutput(f.ctx, f.agent, job.id, caller.signal, t, closed)
    const model = f.model('mayfly.jobs.output')
    expect(f.text('mayfly.jobs.output')).toContain('initial')
    job.append('later\n')
    await flushRequests()
    expect(f.text('mayfly.jobs.output')).toContain('later')
    f.ctx.mayflyLocale.setPreference('zh')
    f.ctx.mayflyLocale.setPreference('en')
    expect(await nativeAction(model, { kind: 'submit', pagePath: [], formId: 'unused', fields: {} } as never)).toMatchObject({ kind: 'cancelled' })
    expect(await nativeAction(model, activate('unused'))).toMatchObject({ kind: 'completed' })
    f.ctx.mayflyOverlays.open({ id: 'foreign-output' }, { kind: 'text', text: 'foreign' } as never).close()
    expect(closed).not.toHaveBeenCalled()
    f.ctx.mayflyOverlays.close('mayfly.jobs.output')
    expect(closed).toHaveBeenCalledOnce()
    expect(model.disposed).toBe(true)
    caller.abort()
    expect(closed).toHaveBeenCalledOnce()
    await job.finish({ status: 'completed' })
  })

  it('catches output appended during the initial read/mount gap and safely compacts more than 256 retained chunks', async () => {
    const f = await setup()
    const job = f.start()
    const original = f.registry.readAt.bind(f.registry)
    const read = vi.spyOn(f.registry, 'readAt').mockImplementationOnce((...args) => { const result = original(...args); job.append('between read and mount\n'); return result })
    await openJobOutput(f.ctx, f.agent, job.id, new AbortController().signal, t)
    expect(f.text('mayfly.jobs.output')).toContain('between read and mount')
    read.mockRestore()
    for (let index = 0; index < JOB_OUTPUT_FEED_CHUNKS + 3; index += 1) job.append(index === 0 ? 'longer chunk first\n' : 'a\n')
    await flushRequests()
    expect(f.text('mayfly.jobs.output')).toContain('longer chunk first')
    expect(f.model('mayfly.jobs.output').node?.kind).toBe('surface')
    await job.finish({ status: 'completed' })
  })

  it('uses lossy native reads as a new retained window and ignores already consumed chunk offsets', async () => {
    const f = await setup()
    const job = f.start({ output: 'old output' })
    await openJobOutput(f.ctx, f.agent, job.id, new AbortController().signal, t)
    const read = vi.spyOn(f.registry, 'readAt')
    read.mockReturnValueOnce({ chunks: [{ at: 0, text: 'duplicate old' }, { at: 50, text: 'retained new' }], next: 62, lossy: true } as JobOutputRead)
    job.append('event\n')
    await flushRequests()
    expect(f.text('mayfly.jobs.output')).toContain('retained new')
    expect(f.text('mayfly.jobs.output')).not.toContain('old output')
    expect(f.text('mayfly.jobs.output')).not.toContain('duplicate old')
    expect(f.text('mayfly.jobs.output')).toContain('earlier output was dropped')
    await job.finish({ status: 'completed' })
  })

  it('keeps the close callback silent when the caller aborts and supports readers without callbacks', async () => {
    const f = await setup()
    const job = f.start()
    await openJobOutput(f.ctx, f.agent, job.id, new AbortController().signal, t)
    const closed = vi.fn()
    const caller = new AbortController()
    await openJobOutput(f.ctx, f.agent, job.id, caller.signal, t, closed)
    caller.abort()
    await flushRequests()
    expect(closed).not.toHaveBeenCalled()
    expect(f.model('mayfly.jobs.output')?.disposed ?? true).toBe(true)
    await openJobOutput(f.ctx, f.agent, job.id, AbortSignal.abort(), t, closed)
    f.ctx.mayflyConversations.selectPrimary(f.other)
    await openJobOutput(f.ctx, f.agent, job.id, new AbortController().signal, t, closed)
    expect(closed).not.toHaveBeenCalled()
    await job.finish({ status: 'completed' })
  })

  it('does not overwrite a foreign document installed through the live reader handle during a locale update', async () => {
    const f = await setup()
    const job = f.start({ output: 'owned output' })
    let reader!: MayflyOverlayHandle
    const open = f.ctx.mayflyOverlays.open.bind(f.ctx.mayflyOverlays)
    vi.spyOn(f.ctx.mayflyOverlays, 'open').mockImplementation((definition, node) => { const handle = open(definition, node); if (definition.id === 'mayfly.jobs.output') reader = handle; return handle })
    await openJobOutput(f.ctx, f.agent, job.id, new AbortController().signal, t)
    for (const node of [ui.text('foreign document'), ui.surface({ child: ui.text('foreign document') }), ui.surface({ child: ui.stack.column([ui.text('foreign document')]) })]) {
      reader.set(node)
      f.ctx.mayflyLocale.setPreference('zh')
      f.ctx.mayflyLocale.setPreference('en')
      expect(f.text('mayfly.jobs.output')).toContain('foreign document')
      expect(f.text('mayfly.jobs.output')).not.toContain('owned output')
    }
    await job.finish({ status: 'completed' })
  })

  it('keeps the close callback silent when cancellation wins an in-progress reader mount', async () => {
    const f = await setup()
    const job = f.start()
    const caller = new AbortController()
    const closed = vi.fn()
    const pending = openJobOutput(f.ctx, f.agent, job.id, caller.signal, t, closed)
    caller.abort()
    await pending
    expect(closed).not.toHaveBeenCalled()
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(0)
    await job.finish({ status: 'completed' })
  })

  it('calls close once if an Agent replacement prevents an in-progress reader mount', async () => {
    const f = await setup()
    const job = f.start()
    const closed = vi.fn()
    const opening = openJobOutput(f.ctx, f.agent, job.id, new AbortController().signal, t, closed)
    f.ctx.mayflyConversations.selectPrimary(f.other)
    await opening
    expect(closed).toHaveBeenCalledOnce()
    await job.finish({ status: 'completed' })
  })
})
