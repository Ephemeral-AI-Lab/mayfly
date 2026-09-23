/** Native jobs and shared UI behavior without consumer-owned panel controllers.
 * @module @ephemeral-ai/mayfly/tests/interaction/jobs
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { JobId, type JobView } from '@deepseek-ai/dsh-jobs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ui, type MayflyUiEvent } from '@ephemeral-ai/mayfly-ui'
import * as agentOverlay from '../../src/interaction/agent-overlay.ts'
import { formatJobDuration, isLiveJob, jobDetailsNode, jobItems, jobOutputNode, sortJobs } from '../../src/interaction/jobs.ts'
import { documentPages } from '../../src/interaction/document-pages.ts'
import type { UiSurfaceModel } from '../../src/core/ui-interaction-surface.ts'
import { validateMayflyUiNode } from '../../src/core/ui-validator.ts'
import { jobsFixture } from './jobs-fixture.ts'
import { flushRequests, renderRequest } from './request-fixture.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  vi.useRealTimers()
})
async function setup() { const ctx = new Context(); contexts.push(ctx); return jobsFixture(ctx) }
const action = (model: UiSurfaceModel, id: string, controlId = 'job-actions') => model.emit({ kind: 'activate', pagePath: [], controlId, actionId: id })
const select = (model: UiSurfaceModel, id: string) => model.emit({ kind: 'selection-accept', pagePath: [], controlId: 'jobs', selectedIds: [id] })
const pageAddress = { pagePath: [], formId: 'output-page' } as const
const job = (id: string, status: JobView['status'], options: Partial<JobView> = {}): JobView => ({ id: JobId(id), kind: 'bash', label: `Job ${id}`, startedAt: 1_000, status, output: { total: 0, earliest: 0 }, ...options })
async function prepare(model: UiSurfaceModel, event: MayflyUiEvent) {
  const abort = new AbortController()
  try { return (await model.endpoint.prepare(event, { surfaceId: model.id, source: model.source, revision: model.revision, operationId: 'test-request', signal: abort.signal, report: vi.fn() })).reply }
  finally { abort.abort() }
}

describe('shared jobs browsing', () => {
  it('keeps the browser usable when an overlay opening is withdrawn before returning a handle', async () => {
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const source = bench.start()
    await bench.run('/jobs')
    const browser = bench.model('mayfly.jobs')
    vi.spyOn(agentOverlay, 'openAgentOverlay').mockResolvedValueOnce(undefined)
    select(browser, source.id)
    await flushRequests()
    expect(browser.disposed).toBe(false)
    expect(bench.ctx.mayflyOverlays.list().map(entry => entry.id)).toEqual(['mayfly.jobs'])
    select(browser, source.id)
    await flushRequests()
    expect(bench.model('mayfly.jobs.detail')).toBeDefined()
    expect(readAt).not.toHaveBeenCalled()
  })

  it.each([ui.text('Content unavailable'), ui.surface({ child: ui.text('Content unavailable') })])('does not overwrite an unexpected registry document during locale refresh', async replacement => {
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const source = bench.start({ output: 'original output' })
    await bench.run('/jobs')
    select(bench.model('mayfly.jobs'), source.id)
    await flushRequests()
    action(bench.model('mayfly.jobs.detail'), 'read')
    await flushRequests()
    const output = bench.model('mayfly.jobs.output')
    const entries = bench.ctx.mayflyOverlays.list()
    const node = output.node
    vi.spyOn(bench.ctx.mayflyOverlays, 'list').mockReturnValueOnce(entries.map(entry => entry.id === output.id ? { ...entry, node: replacement } : entry))
    bench.ctx.mayflyLocale.setPreference('zh')
    await flushRequests()
    expect(output.node).toBe(node)
    expect(readAt).toHaveBeenCalledOnce()
  })

  it.each([false, true])('relocalizes output without resetting its published page or reading again (paged=%s)', async paged => {
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const source = bench.start({ output: paged ? 'x'.repeat(36_001) : 'only page' })
    await bench.run('/jobs')
    select(bench.model('mayfly.jobs'), source.id)
    await flushRequests()
    action(bench.model('mayfly.jobs.detail'), 'read')
    await flushRequests()
    const output = bench.model('mayfly.jobs.output')
    if (paged) {
      action(output, 'next', 'page-actions'); await flushRequests()
      output.edit({ ...pageAddress, fieldId: 'page' }, '3')
    }
    bench.ctx.mayflyLocale.setPreference('zh')
    await flushRequests()
    expect(JSON.stringify(output.node)).toContain('\u8bfb\u53d6\u65f6\u72b6\u6001')
    if (paged) expect(output.form(pageAddress)!.fields.page).toMatchObject({ baseline: 2, value: '3', change: 'set' })
    expect(readAt).toHaveBeenCalledOnce()
  })

  it('marks a retained-tail read when the ring dropped earlier output', async () => {
    const bench = await setup()
    vi.spyOn(bench.registry, 'readAt').mockReturnValueOnce({ chunks: [{ at: 0, text: 'tail' }], next: 4, lossy: true })
    const source = bench.start()
    await bench.run('/jobs')
    select(bench.model('mayfly.jobs'), source.id)
    await flushRequests()
    action(bench.model('mayfly.jobs.detail'), 'read')
    await flushRequests()
    expect(JSON.stringify(bench.model('mayfly.jobs.output').node)).toContain('earlier output was dropped by retention')
  })

  it('rejects malformed output submissions and ignores obsolete inspector actions at the registration boundary', async () => {
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const source = bench.start({ output: 'x'.repeat(24_001) })
    await bench.run('/jobs')
    const browser = bench.model('mayfly.jobs')
    await expect(prepare(browser, { kind: 'selection-accept', pagePath: [], controlId: 'jobs', selectedIds: [] })).rejects.toThrow()
    select(browser, source.id)
    await flushRequests()
    const detail = bench.model('mayfly.jobs.detail')
    expect(await prepare(detail, { kind: 'activate', pagePath: [], controlId: 'job-actions', actionId: 'unknown' })).toMatchObject({ kind: 'completed' })
    action(detail, 'read')
    await flushRequests()
    const output = bench.model('mayfly.jobs.output')
    for (const fields of [[], [{ id: 'page', change: 'set' as const, value: 'invalid' }], [{ id: 'page', change: 'set' as const, value: 1.5 }]]) {
      const reply = await prepare(output, { kind: 'submit', pagePath: [], controlId: 'output-page', submission: { actionId: 'go', draftRevision: 0, source: [], forms: [{ ...pageAddress, draftRevision: 0, fields }] } })
      expect(reply).toMatchObject({ kind: 'failed', message: 'Invalid page' })
    }
    await source.finish({ status: 'completed' })
    expect(await prepare(detail, { kind: 'activate', pagePath: [], controlId: 'job-actions', actionId: 'stop' })).toMatchObject({ kind: 'completed' })
    expect(source.cancel).not.toHaveBeenCalled()
    expect(readAt).toHaveBeenCalledOnce()
  })

  it('does not open detail after the exact Agent changes during native inspection', async () => {
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const source = bench.start()
    await bench.run('/jobs')
    const get = bench.registry.get.bind(bench.registry)
    vi.spyOn(bench.registry, 'get').mockImplementationOnce((id, caller) => {
      const view = get(id, caller)
      bench.ctx.mayflyCurrentAgent.select(bench.other)
      return view
    })
    select(bench.model('mayfly.jobs'), source.id)
    await flushRequests()
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
    expect(readAt).not.toHaveBeenCalled()
  })

  it('keeps native dispatch for a different selected Agent from opening stale UI', async () => {
    const bench = await setup()
    bench.ctx.mayflyCurrentAgent.select(bench.other)
    await bench.run('/jobs')
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
  })

  it('recovers from native list failure through Refresh without reading output', async () => {
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const source = bench.start()
    const list = vi.spyOn(bench.registry, 'list').mockImplementation(() => { throw new Error('Registry unavailable') })
    await bench.run('/jobs')
    const browser = bench.model('mayfly.jobs')
    expect(JSON.stringify(browser.node)).toContain('Job registry unavailable')
    list.mockRestore()
    action(browser, 'refresh', 'jobs-actions')
    await flushRequests()
    expect(JSON.stringify(browser.node)).not.toContain('Job registry unavailable')
    expect(browser.choice({ pagePath: [], controlId: 'jobs' })!.definition.items.map(item => item.id)).toEqual([source.id])
    expect(readAt).not.toHaveBeenCalled()
  })

  it('ignores foreign changes and retires a detail when native owner teardown removes its record', async () => {
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const source = bench.start()
    await bench.run('/jobs')
    const browser = bench.model('mayfly.jobs')
    const revision = browser.registration.revision
    bench.start({ owner: bench.other })
    expect(browser.registration.revision).toBe(revision)
    bench.start({ owner: null, label: 'Unowned' })
    expect(browser.registration.revision).toBeGreaterThan(revision)
    select(browser, source.id)
    await flushRequests()
    const detail = bench.model('mayfly.jobs.detail')
    await bench.agent.ctx.fiber.dispose()
    await flushRequests()
    expect(detail.disposed).toBe(true)
    expect(browser.choice({ pagePath: [], controlId: 'jobs' })!.definition.items.map(item => item.label)).toEqual(['Unowned'])
    expect(readAt).not.toHaveBeenCalled()
  })

  it('withdraws an in-flight read when the read itself changes the selected Agent', async () => {
    const bench = await setup()
    const source = bench.start()
    const readAt = vi.spyOn(bench.registry, 'readAt').mockImplementationOnce(() => {
      bench.ctx.mayflyCurrentAgent.select(bench.other)
      return { chunks: [{ at: 0, text: 'old Agent output' }], next: 16, lossy: false }
    })
    await bench.run('/jobs')
    select(bench.model('mayfly.jobs'), source.id)
    await flushRequests()
    const detail = bench.model('mayfly.jobs.detail')
    action(detail, 'read')
    await flushRequests()
    expect(detail.disposed).toBe(true)
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
    expect(readAt).toHaveBeenCalledOnce()
  })

  it('cancels the full UI tree when its command signal aborts and can reopen independently', async () => {
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const source = bench.start()
    const signal = new AbortController()
    await bench.ctx.commands.execute(bench.agent, '/jobs', [], signal.signal)
    const old = bench.model('mayfly.jobs')
    select(old, source.id)
    signal.abort()
    await flushRequests()
    expect(old.disposed).toBe(true)
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
    await bench.run('/jobs')
    expect(bench.model('mayfly.jobs').instanceId).not.toBe(old.instanceId)
    expect(readAt).not.toHaveBeenCalled()
  })

  it('relocalizes live job metadata without replacing the inspection state', async () => {
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const source = bench.start()
    await bench.run('/jobs')
    const browser = bench.model('mayfly.jobs')
    select(browser, source.id)
    await flushRequests()
    const detail = bench.model('mayfly.jobs.detail')
    action(detail, 'stop')
    bench.ctx.mayflyLocale.setPreference('zh')
    await flushRequests()
    expect(bench.model('mayfly.jobs.detail')).toBe(detail)
    expect(JSON.stringify(detail.node)).toContain('\u8bfb\u53d6\u8f93\u51fa')
    expect(JSON.stringify(browser.node)).toContain('\u8fd0\u884c\u4e2d')
    expect(detail.decisionNode).toBeDefined()
    expect(readAt).not.toHaveBeenCalled()
  })

  it('lists only accessible jobs and opens non-consuming inspectors through native commands', async () => {
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const own = bench.start({ label: 'Owned', output: 'unread' })
    bench.start({ label: 'Foreign', owner: bench.other })
    bench.start({ label: 'Shared', owner: null })
    await bench.run('/jobs')
    const browser = bench.model('mayfly.jobs')
    expect(browser.choice({ pagePath: [], controlId: 'jobs' })!.definition.items.map(item => item.label)).toEqual(['Owned', 'Shared'])
    select(browser, own.id)
    await flushRequests()
    const detail = bench.model('mayfly.jobs.detail')
    expect(JSON.stringify(detail.node)).toContain('Read output')
    expect(readAt).not.toHaveBeenCalled()
    detail.requestClose()
    await flushRequests()
    await bench.run('/jobs')
    expect(bench.model('mayfly.jobs')).toBe(browser)
    expect(readAt).not.toHaveBeenCalled()
  })

  it('serves explicit reads without touching the model cursor and leaves browsing and rendering passive', async () => {
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const source = bench.start({ output: 'first delta' })
    await bench.run('/jobs')
    select(bench.model('mayfly.jobs'), source.id)
    await flushRequests()
    const detail = bench.model('mayfly.jobs.detail')
    action(detail, 'read')
    await flushRequests()
    const output = bench.model('mayfly.jobs.output')
    expect(JSON.stringify(output.node)).toContain('first delta')
    source.append('second delta')
    const rendered = renderRequest(output)
    rendered.component.render(80)
    rendered.component.render(40)
    rendered.runtime.dispose()
    expect(readAt).toHaveBeenCalledOnce()
    output.requestClose()
    await flushRequests()
    action(detail, 'read')
    await flushRequests()
    const second = bench.model('mayfly.jobs.output')
    expect(JSON.stringify(second.node)).toContain('first delta')
    expect(JSON.stringify(second.node)).toContain('second delta')
    expect(readAt).toHaveBeenCalledTimes(2)
    const modelRead = bench.registry.read(source.id, bench.agent.id)
    expect(modelRead.chunks.map(chunk => chunk.text).join('')).toBe('first deltasecond delta')
  })

  it('keeps a terminal result for the model read while observer reads stay non-consuming', async () => {
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const source = bench.start({ finalOnly: true })
    await source.finish({ status: 'completed', result: 'final result', detail: 'exit 0' })
    await bench.run('/jobs')
    select(bench.model('mayfly.jobs'), source.id)
    await flushRequests()
    const detail = bench.model('mayfly.jobs.detail')
    for (let index = 0; index < 2; index += 1) {
      action(detail, 'read')
      await flushRequests()
      const output = bench.model('mayfly.jobs.output')
      expect(JSON.stringify(output.node)).toContain('(no output)')
      output.requestClose()
      await flushRequests()
    }
    expect(readAt).toHaveBeenCalledTimes(2)
    const modelRead = bench.registry.read(source.id, bench.agent.id)
    expect(modelRead.result).toBe('final result')
    expect(modelRead.chunks).toEqual([])
  })

  it('leaves the model cursor untouched by reads after terminal settlement', async () => {
    const bench = await setup()
    const source = bench.start({ output: 'last chunk' })
    await source.finish({ status: 'failed', detail: 'exit 3' })
    await bench.run('/jobs')
    select(bench.model('mayfly.jobs'), source.id)
    await flushRequests()
    const detail = bench.model('mayfly.jobs.detail')
    action(detail, 'read')
    await flushRequests()
    expect(JSON.stringify(bench.model('mayfly.jobs.output').node)).toContain('last chunk')
    const modelRead = bench.registry.read(source.id, bench.agent.id)
    expect(modelRead.chunks.map(chunk => chunk.text).join('')).toBe('last chunk')
  })

  it.each([
    Array.from({ length: 500 }, (_, index) => `row ${String(index).padStart(3, '0')} ${'x'.repeat(60)}`).join('\n'),
    `start${'x'.repeat(11_994)}\u{1F680}${'y'.repeat(24_000)}end`,
    '中文'.repeat(12_001),
  ])('reconstructs full large output using shared page submissions without rereading', async text => {
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const source = bench.start({ output: text })
    await bench.run('/jobs')
    select(bench.model('mayfly.jobs'), source.id)
    await flushRequests()
    action(bench.model('mayfly.jobs.detail'), 'read')
    await flushRequests()
    const output = bench.model('mayfly.jobs.output')
    const pages = documentPages(text)
    let restored = ''
    for (let page = 0; page < pages.length; page += 1) {
      expect(output.form(pageAddress)!.fields.page!.baseline).toBe(page + 1)
      const node = output.node
      expect(validateMayflyUiNode(node).ok).toBe(true)
      if (node?.kind !== 'surface' || node.child.kind !== 'stack') throw new Error('Missing output surface')
      const scroll = node.child.children.find(child => child.node.kind === 'scroll')!.node
      if (scroll.kind !== 'scroll' || scroll.child.kind !== 'code') throw new Error('Missing output text')
      expect(scroll.id).toBe(`job-output-document/${String(page + 1)}`)
      expect(output.document({ pagePath: [], controlId: scroll.id })).toBeDefined()
      expect(scroll.child.code).toBe(pages[page])
      expect(scroll.child.code.isWellFormed()).toBe(true)
      restored += scroll.child.code
      const renderer = renderRequest(output)
      renderer.component.render(80)
      renderer.input('\x1b[F')
      expect(renderer.component.render(80).join('\n')).toContain(scroll.child.code.trimEnd().slice(-10))
      renderer.runtime.dispose()
      action(output, 'next', 'page-actions')
      await flushRequests()
    }
    expect(restored).toBe(text)
    expect(output.form(pageAddress)!.fields.page!.baseline).toBe(pages.length)
    action(output, 'first', 'page-actions'); await flushRequests()
    expect(output.form(pageAddress)!.fields.page!.baseline).toBe(1)
    output.edit({ ...pageAddress, fieldId: 'page' }, '2')
    action(output, 'go', 'page-actions'); await flushRequests()
    expect(output.form(pageAddress)!.fields.page!.baseline).toBe(2)
    action(output, 'previous', 'page-actions'); await flushRequests()
    expect(output.form(pageAddress)!.fields.page!.baseline).toBe(1)
    action(output, 'last', 'page-actions'); await flushRequests()
    expect(output.form(pageAddress)!.fields.page!.baseline).toBe(pages.length)
    output.edit({ ...pageAddress, fieldId: 'page' }, '0')
    action(output, 'go', 'page-actions'); await flushRequests()
    expect(output.form(pageAddress)!.fields.page!.error).toBeDefined()
    expect(readAt).toHaveBeenCalledOnce()
  })

  it('confirms Stop with No selected, preserves cancellation, and follows native terminal status', async () => {
    const bench = await setup()
    const source = bench.start()
    await bench.run('/jobs')
    select(bench.model('mayfly.jobs'), source.id)
    await flushRequests()
    const detail = bench.model('mayfly.jobs.detail')
    action(detail, 'stop')
    expect(detail.decisionNode).toMatchObject({ child: { items: [{ label: 'No', defaultFocus: true }, { label: 'Yes' }] } })
    detail.answerDecision(false)
    expect(source.cancel).not.toHaveBeenCalled()
    action(detail, 'stop')
    detail.answerDecision(true)
    detail.answerDecision(true)
    await flushRequests()
    expect(source.cancel).toHaveBeenCalledOnce()
    expect(bench.registry.get(source.id, bench.agent.id).status).toBe('killed')
    expect(JSON.stringify(detail.node)).toContain('killed')
    expect(detail.operationSnapshot().at(-1)?.phase).toBe('succeeded')
    action(detail, 'stop')
    expect(detail.decisionNode).toBeUndefined()
    expect(source.cancel).toHaveBeenCalledOnce()
  })

  it('invalidates Stop confirmation when the producer finishes before Yes', async () => {
    const bench = await setup()
    const source = bench.start()
    await bench.run('/jobs')
    select(bench.model('mayfly.jobs'), source.id)
    await flushRequests()
    const detail = bench.model('mayfly.jobs.detail')
    action(detail, 'stop')
    await source.finish({ status: 'completed' })
    expect(detail.decisionNode).toBeUndefined()
    detail.answerDecision(true)
    expect(source.cancel).not.toHaveBeenCalled()
    expect(JSON.stringify(detail.node)).toContain('completed')
  })

  it('shows Stop failure in the inspector and allows an explicit retry', async () => {
    const bench = await setup()
    const source = bench.start()
    source.cancel.mockImplementationOnce(() => { throw new Error('Stop failed') })
    await bench.run('/jobs')
    select(bench.model('mayfly.jobs'), source.id)
    await flushRequests()
    const detail = bench.model('mayfly.jobs.detail')
    action(detail, 'stop'); detail.answerDecision(true)
    await flushRequests()
    expect(detail.disposed).toBe(false)
    expect(detail.feedbackSnapshot()).toContainEqual(expect.objectContaining({ message: 'Stop failed', severity: 'error' }))
    expect(bench.registry.get(source.id, bench.agent.id).status).toBe('running')
    action(detail, 'stop'); detail.answerDecision(true)
    await flushRequests()
    expect(bench.registry.get(source.id, bench.agent.id).status).toBe('killed')
  })

  it('contains output read failures without closing the inspector', async () => {
    const bench = await setup()
    const source = bench.start({ output: 'retained' })
    vi.spyOn(bench.registry, 'readAt').mockImplementationOnce(() => { throw new Error('Read failed') })
    await bench.run('/jobs')
    select(bench.model('mayfly.jobs'), source.id)
    await flushRequests()
    const detail = bench.model('mayfly.jobs.detail')
    action(detail, 'read'); await flushRequests()
    expect(detail.feedbackSnapshot()).toContainEqual(expect.objectContaining({ message: 'Read failed' }))
    expect(bench.ctx.mayflyOverlays.list().some(entry => entry.id === 'mayfly.jobs.output')).toBe(false)
    action(detail, 'read'); await flushRequests()
    expect(JSON.stringify(bench.model('mayfly.jobs.output').node)).toContain('retained')
  })

  it.each(['agent', 'same-id', 'parent', 'consumer', 'provider'] as const)('releases the view tree on %s withdrawal without retaining active confirmation', async reason => {
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const source = bench.start({ output: 'owned output' })
    await bench.run('/jobs')
    const browser = bench.model('mayfly.jobs')
    select(browser, source.id); await flushRequests()
    const detail = bench.model('mayfly.jobs.detail')
    action(detail, 'read'); await flushRequests()
    const output = bench.model('mayfly.jobs.output')
    action(detail, 'stop')
    if (reason === 'agent') bench.ctx.mayflyCurrentAgent.select(bench.other)
    else if (reason === 'same-id') {
      const replacement = { ...bench.agent } as Agent
      bench.agents.set(bench.agent.id, replacement)
      bench.ctx.mayflyCurrentAgent.select(replacement)
    } else if (reason === 'parent') browser.requestClose()
    else await (reason === 'provider' ? bench.provider : bench.consumer).dispose()
    await flushRequests()
    expect(browser.disposed).toBe(true)
    expect(detail.disposed).toBe(true)
    expect(output.disposed).toBe(true)
    detail.answerDecision(true)
    expect(source.cancel).toHaveBeenCalledTimes(reason === 'provider' ? 1 : 0)
    expect(readAt).toHaveBeenCalledOnce()
  })

  it('updates elapsed labels only while jobs are live and preserves search and confirmation', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const bench = await setup()
    const readAt = vi.spyOn(bench.registry, 'readAt')
    const source = bench.start({ label: 'Searchable job' })
    await bench.run('/jobs')
    const browser = bench.model('mayfly.jobs')
    browser.updateChoice({ pagePath: [], controlId: 'jobs' }, { kind: 'query', query: 'Searchable' })
    select(browser, source.id); await flushRequests()
    const detail = bench.model('mayfly.jobs.detail')
    action(detail, 'stop')
    vi.advanceTimersByTime(61_000)
    expect(JSON.stringify(browser.node)).toContain('1m')
    expect(browser.choice({ pagePath: [], controlId: 'jobs' })!.query).toBe('Searchable')
    expect(detail.decisionNode).toBeDefined()
    await source.finish({ status: 'completed' })
    const revision = browser.registration.revision
    vi.advanceTimersByTime(120_000)
    expect(browser.registration.revision).toBe(revision)
    expect(readAt).not.toHaveBeenCalled()
  })
})

describe('jobs readonly projections', () => {
  it.each([[1_000, 1_000, '0s'], [0, 59_999, '59s'], [0, 60_000, '1m'], [0, 3_599_000, '59m'], [0, 3_600_000, '1h'], [0, 3_660_000, '1h 1m']] as const)('formats elapsed time %s to %s', (start, now, expected) => {
    expect(formatJobDuration(start, now)).toBe(expected)
  })
  it('orders live oldest first and terminal newest first without mutating snapshots', () => {
    const rows = [job('done', 'completed', { finishedAt: 4_000 }), job('running', 'running', { startedAt: 3_000 }), job('stopping', 'stopping'), job('failed', 'failed', { startedAt: 9_000, detail: 'exit 3' })]
    expect(sortJobs(rows).map(row => row.id)).toEqual(['stopping', 'running', 'failed', 'done'])
    expect(rows.map(row => row.id)).toEqual(['done', 'running', 'stopping', 'failed'])
    expect(rows.map(isLiveJob)).toEqual([false, true, true, false])
    expect(jobItems(rows, 61_000, key => key)).toContainEqual(expect.objectContaining({ id: 'failed', badge: 'failed', detail: expect.stringContaining('exit 3') }))
    expect(sortJobs([job('old', 'completed', { startedAt: 2_000 }), job('new', 'completed', { startedAt: 9_000 })]).map(row => row.id)).toEqual(['new', 'old'])
  })
  it('keeps empty results and arbitrary line lengths within the wire quota', () => {
    expect(documentPages('')).toEqual([''])
    for (const text of ['', '\n'.repeat(24_001), 'x'.repeat(12_000), 'x'.repeat(11_999) + '\u{1F680}', '\u{1F680}'.repeat(20_000)]) {
      const pages = documentPages(text)
      expect(pages.join('')).toBe(text)
      for (const page of pages) { expect(page.length).toBeLessThanOrEqual(12_000); expect(page.isWellFormed()).toBe(true) }
    }
    const emptyRead = { chunks: [], next: 0, lossy: false }
    expect(JSON.stringify(jobOutputNode(job('empty', 'completed'), emptyRead, [''], 1, key => key))).toContain('(no output)')
    expect(JSON.stringify(jobOutputNode(job('live', 'running'), emptyRead, [''], 1, key => key))).toContain('(no output yet)')
    expect(validateMayflyUiNode(jobDetailsNode(job('done', 'completed'), key => key)).ok).toBe(true)
  })
})
