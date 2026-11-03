/** Native tool scopes, live catalog changes and exact-Agent browser/standalone detail lifetimes. @module */
import { Context } from '@deepseek-ai/cordis'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as toolsCommand from '../../src/interaction/tools-commands.ts'
import { firstSentence, toolItems, toolDetailBody, openToolDetail } from '../../src/interaction/tools-commands.ts'
import { catalogFixture } from './catalog-fixture.ts'
import { activate, nativeAction, select } from './native-action-fixture.ts'
import { flushRequests } from './request-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const schema = (name: string, description = 'First sentence. More detail.'): ToolSchema => ({ name, description, parameters: { type: 'object', properties: { path: { type: 'string' } } } })

async function setup(empty = false) {
  const ctx = new Context(); contexts.push(ctx)
  const f = await catalogFixture(ctx)
  const providers = []
  if (!empty) {
    providers.push(await f.register(schema('beta')))
    providers.push(await f.register(schema('alpha', 'Alpha。第二句')))
  }
  const fiber = [...ctx.registry.get(toolsCommand)!.fibers][0]!
  await fiber
  const model = (id = 'mayfly.tools') => ctx.mayflyUiInteraction.get('overlay', id)!
  const text = (id?: string) => JSON.stringify(model(id).registration.node)
  const open = async () => { const result = await f.run('/tools'); await flushRequests(); return result }
  return { ...f, fiber, model, text, open, providers }
}

describe('native tool presentation facts', () => {
  it('extracts first nonblank sentences and preserves complete descriptions and schemas in details', () => {
    expect(firstSentence(' \n \r\n ')).toBe('')
    expect(firstSentence(' \n First line without stop\nsecond')).toBe('First line without stop')
    expect(firstSentence('Question? Answer')).toBe('Question?')
    expect(firstSentence('你好！再见')).toBe('你好！')
    expect(firstSentence('好。')).toBe('好。')
    const items = toolItems([schema('zeta'), schema('alpha', 'Alpha。其他')])
    expect(items.map(item => [item.id, item.detail])).toEqual([['alpha', 'Alpha。'], ['zeta', 'First sentence.']])
    const body = JSON.stringify(toolDetailBody(schema('zeta'), key => key))
    expect(body).toContain('More detail.')
    expect(body).toContain('path')
    expect(JSON.stringify(toolDetailBody({ name: 'bare', description: '', parameters: {} }, key => key))).toContain('(no description)')
  })
})

describe('native tool catalog command', () => {
  it('shows sorted exact-Agent native schemas, focuses a live panel and restores it across locale changes', async () => {
    const f = await setup()
    expect((await f.open())?.result).toEqual({ kind: 'success' })
    expect(f.text().indexOf('alpha')).toBeLessThan(f.text().indexOf('beta'))
    const model = f.model()
    await f.open()
    expect(f.model()).toBe(model)
    f.ctx.mayflyLocale.setPreference('zh')
    expect(f.text()).toContain('工具')
    f.ctx.mayflyLocale.setPreference('en')
    expect(f.text()).toContain('Tools')
  })

  it('keeps selection, enters narrow details and consumes the back layer before close', async () => {
    const f = await setup()
    await f.open()
    expect(await nativeAction(f.model(), select('tools'))).toMatchObject({ kind: 'cancelled' })
    expect(await nativeAction(f.model(), select('tools', 'missing'))).toMatchObject({ kind: 'failed', message: 'The tool is no longer available' })
    expect(await nativeAction(f.model(), select('tools', 'beta'))).toMatchObject({ kind: 'completed' })
    await nativeAction(f.model(), select('tools-narrow', 'beta'))
    expect((f.model().node as { title: string }).title).toBe('beta')
    expect(await nativeAction(f.model(), { kind: 'dismiss', pagePath: [] })).toMatchObject({ kind: 'completed', dismiss: false })
    expect((f.model().node as { title: string }).title).toBe('Tools')
    expect(await nativeAction(f.model(), { kind: 'dismiss', pagePath: [] })).toMatchObject({ kind: 'completed' })
    expect(await nativeAction(f.model(), select('foreign', 'alpha'))).toMatchObject({ kind: 'completed' })
    expect(await nativeAction(f.model(), activate('unrelated', 'catalog-actions'))).toMatchObject({ kind: 'completed' })
    expect(await nativeAction(f.model(), { kind: 'focus', pagePath: [], controlId: 'tools' } as never)).toMatchObject({ kind: 'completed' })
    expect(await nativeAction(f.model(), activate('refresh', 'catalog-actions'))).toMatchObject({ kind: 'completed' })
  })

  it('follows native tool registration, coalesces change bursts, and backs out when the detail tool disappears', async () => {
    const f = await setup()
    await f.open()
    await nativeAction(f.model(), select('tools-narrow', 'beta'))
    f.ctx.emit('tools/change')
    f.ctx.emit('tools/change')
    await flushRequests()
    expect((f.model().node as { title: string }).title).toBe('beta')
    await f.providers[0]!.dispose()
    await flushRequests()
    expect(f.text()).not.toContain('"title":"beta"')
    await f.providers[1]!.dispose()
    await flushRequests()
    expect(f.text()).toContain('No tools visible to this session')
    expect((f.model().node as { title: string }).title).toBe('Tools')
    await f.register(schema('new-tool'))
    await flushRequests()
    expect(f.text()).toContain('new-tool')
  })

  it('shows native catalog failures as unavailable and recovers on an explicit refresh', async () => {
    const f = await setup()
    const read = vi.spyOn(f.ctx.tools, 'schemas')
    read.mockImplementation(() => { throw new Error('unavailable') })
    await f.open()
    expect(f.text()).toContain('Tool catalog unavailable')
    read.mockRestore()
    await nativeAction(f.model(), activate('refresh', 'catalog-actions'))
    expect(f.text()).toContain('alpha')
    expect(f.text()).not.toContain('Tool catalog unavailable')
  })

  it('rejects a stale invoking Agent and refuses a cancelled invocation before mounting UI', async () => {
    const f = await setup()
    const definition = f.ctx.commands.find(f.agent, 'tools')!
    expect(await definition.handler({ agent: f.other, signal: new AbortController().signal, rawInput: '' } as never)).toEqual({ kind: 'error', text: 'no session is live yet' })
    expect(await definition.handler({ agent: f.agent, signal: AbortSignal.abort(), rawInput: '' } as never)).toEqual({ kind: 'success' })
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(0)
  })

  it('releases queued changes after closing and retires opening work on caller cancellation', async () => {
    const f = await setup()
    await f.open()
    const model = f.model()
    f.ctx.emit('tools/change')
    f.ctx.mayflyOverlays.close('mayfly.tools')
    await flushRequests()
    expect(model.disposed).toBe(true)
    const caller = new AbortController()
    const definition = f.ctx.commands.find(f.agent, 'tools')!
    const pending = definition.handler({ agent: f.agent, signal: caller.signal, rawInput: '' } as never)
    caller.abort()
    await pending
    await flushRequests()
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(0)
    await f.fiber.dispose()
    expect(f.ctx.commands.find(f.agent, 'tools')).toBeUndefined()
  })

  it('keeps already queued back and selection callbacks from publishing after their native registration closes', async () => {
    const f = await setup()
    await f.open()
    const model = f.model()
    await nativeAction(model, select('tools-narrow', 'beta'))
    const queued = f.ctx.mayflyOverlays.list().find(entry => entry.id === 'mayfly.tools')!.definition.onEvent!.action!
    const context = { surfaceId: model.id, source: model.source, revision: model.revision, operationId: 'queued-before-close', signal: new AbortController().signal, report: vi.fn() }
    f.ctx.mayflyOverlays.close('mayfly.tools')
    const revision = model.revision
    expect(await queued({ kind: 'dismiss', pagePath: [] }, context)).toMatchObject({ kind: 'completed', dismiss: false })
    expect(await queued({ kind: 'selection-accept', pagePath: [], controlId: 'tools-narrow', selectedIds: ['alpha'] }, context)).toMatchObject({ kind: 'completed' })
    expect(model.revision).toBe(revision)
    expect(model.disposed).toBe(true)
    expect(f.ctx.mayflyOverlays.list()).toHaveLength(0)
  })
})

describe('native independently owned tool detail', () => {
  it('refuses missing services, cancelled callers and absent native tool names without creating an owner', async () => {
    const f = await setup()
    const empty = new Context(); contexts.push(empty)
    expect(await openToolDetail(empty, f.agent, { id: 'detail', name: 'alpha', signal: new AbortController().signal })).toBe(false)
    empty.provide('tools', f.ctx.tools)
    expect(await openToolDetail(empty, f.agent, { id: 'detail', name: 'alpha', signal: new AbortController().signal })).toBe(false)
    expect(await openToolDetail(f.ctx, f.agent, { id: 'detail', name: 'alpha', signal: AbortSignal.abort() })).toBe(false)
    expect(await openToolDetail(f.ctx, f.agent, { id: 'detail', name: 'missing', signal: new AbortController().signal })).toBe(false)
  })

  it('refreshes only changed native schemas, coalesces change bursts, and releases itself when its tool unloads', async () => {
    const f = await setup()
    const caller = new AbortController()
    expect(await openToolDetail(f.ctx, f.agent, { id: 'detail', name: 'alpha', signal: caller.signal })).toBe(true)
    const model = f.model('detail')
    const revision = model.revision
    f.ctx.emit('tools/change')
    f.ctx.emit('tools/change')
    await flushRequests()
    expect(model.revision).toBe(revision)
    expect(await nativeAction(model, activate('refresh', 'tool-actions'))).toMatchObject({ kind: 'completed' })
    expect(await nativeAction(model, activate('unrelated', 'tool-actions'))).toMatchObject({ kind: 'completed' })
    f.ctx.mayflyLocale.setPreference('zh')
    expect(f.text('detail')).toContain('名称')
    f.ctx.mayflyLocale.setPreference('en')
    await f.providers[1]!.dispose()
    await flushRequests()
    expect(model.disposed).toBe(true)
  })

  it('publishes a native schema lookup failure in its own detail and recovers without discarding its owner', async () => {
    const f = await setup()
    await openToolDetail(f.ctx, f.agent, { id: 'detail', name: 'alpha', signal: new AbortController().signal })
    const read = vi.spyOn(f.ctx.tools, 'schemas').mockImplementation(() => { throw new Error('registry unavailable') })
    f.ctx.emit('tools/change')
    await flushRequests()
    expect(f.text('detail')).toContain('Tool catalog unavailable')
    read.mockRestore()
    await nativeAction(f.model('detail'), activate('refresh', 'tool-actions'))
    expect(f.text('detail')).toContain('Alpha。第二句')
  })

  it('fences a detail opened for another Agent, a queued refresh after closure and caller cancellation during mount', async () => {
    const f = await setup()
    expect(await openToolDetail(f.ctx, f.other, { id: 'detail', name: 'alpha', signal: new AbortController().signal })).toBe(false)
    await openToolDetail(f.ctx, f.agent, { id: 'detail', name: 'alpha', signal: new AbortController().signal })
    const model = f.model('detail')
    f.ctx.emit('tools/change')
    f.ctx.mayflyOverlays.close('detail')
    await flushRequests()
    expect(model.disposed).toBe(true)
    const caller = new AbortController()
    const opening = openToolDetail(f.ctx, f.agent, { id: 'detail', name: 'alpha', signal: caller.signal })
    caller.abort()
    expect(await opening).toBe(false)
  })
})
