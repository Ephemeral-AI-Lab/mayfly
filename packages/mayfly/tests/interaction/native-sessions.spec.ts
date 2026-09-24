import { nativeAction, activate, select as selection } from './native-action-fixture.ts'
/** Native session management preserves archive admission and child ownership.
 * @module @ephemeral-ai/mayfly/tests/interaction/native-sessions
 */
import { Context } from '@deepseek-ai/cordis'
import { WorkspaceActiveSessionError } from '@deepseek-ai/dsh-workspace'
import { afterEach, expect, it, vi } from 'vitest'
import { informationFixture } from './information-fixture.ts'
import { flushRequests as flushOneRequest } from './request-fixture.ts'
import { openSessions } from '../../src/interaction/native-sessions.ts'

const flushRequests = async () => { await flushOneRequest(); await flushOneRequest() }
const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() {
  const ctx = new Context(); contexts.push(ctx)
  const bench = await informationFixture(ctx)
  const controller = {
    list: vi.fn(async () => ({ items: [
      { sessionId: 'current', cwd: '/repo', running: false, projections: { values: { title: 'Current' } } },
      { sessionId: 'other', running: true },
      { sessionId: 'child', origin: 'subagent', parentSessionId: 'current', running: false },
    ] })),
    search: vi.fn(async () => ({ items: [{ sessionId: 'other', snippet: 'matching text' }], hasMore: true })),
  }
  const registry = { archivedSessionIds: [] as string[], archiveSession: vi.fn(async (id: string, _options: unknown) => { registry.archivedSessionIds.push(id) }), unarchiveSession: vi.fn(async (id: string) => { registry.archivedSessionIds = registry.archivedSessionIds.filter(item => item !== id) }) }
  const subagents = { listDescendants: vi.fn(async () => [{ kind: 'child', id: 'child', parentId: 'current', mode: 'continuable', label: 'Worker' }]) }
  ctx.provide('sessionController', controller as never)
  ctx.provide('workspaceRegistry', registry as never)
  ctx.provide('subagents', subagents as never)
  const open = () => openSessions(ctx, new AbortController().signal)
  const model = (id = 'mayfly.sessions') => ctx.mayflyUiInteraction.get('overlay', id)!
  const select = async (id: string) => { model().emit({ kind: 'selection-accept', pagePath: [], controlId: 'sessions', selectedIds: [id] }); await flushRequests() }
  const act = async (id: string, detail = true) => { model(detail ? 'mayfly.sessions.detail' : 'mayfly.sessions').invoke(id); await flushRequests() }
  const confirm = async () => { model('mayfly.sessions.detail').answerDecision(true); await flushRequests() }
  return { ...bench, controller, registry, subagents, open, model, select, act, confirm }
}
it('lists native summaries, searches explicitly, and preserves title filtering on search refusal', async () => {
  const bench = await setup()
  expect(await bench.open()).toEqual({ kind: 'success' })
  expect(JSON.stringify(bench.model().node)).toContain('Current')
  expect(bench.controller.search).not.toHaveBeenCalled()
  await bench.act('search', false)
  expect(bench.controller.search).not.toHaveBeenCalled()
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'needle')
  await bench.act('search', false)
  expect(bench.controller.search).toHaveBeenCalledWith({ query: 'needle' }, expect.any(AbortSignal))
  expect(JSON.stringify(bench.model().node)).toContain('matching text')
  await bench.act('refresh', false)
  bench.controller.search.mockRejectedValueOnce(new Error('SESSION_QUERY_SEARCH_DISABLED'))
  await bench.act('search', false)
  expect(bench.model().feedbackSnapshot().some(item => item.message.includes('SESSION_QUERY_SEARCH_DISABLED'))).toBe(true)
  expect(JSON.stringify(bench.model().node)).toContain('Current')
})
it('uses native archive admission before offering explicit stop-and-archive', async () => {
  const bench = await setup()
  await bench.open(); await bench.select('other')
  bench.registry.archiveSession.mockRejectedValueOnce(new WorkspaceActiveSessionError('other' as never, [{ kind: 'turn' }]))
  await bench.act('archive'); await bench.confirm()
  expect(JSON.stringify(bench.model('mayfly.sessions.detail').node)).toContain('Stop activity and archive')
  await bench.act('stop-archive'); await bench.confirm()
  expect(bench.registry.archiveSession).toHaveBeenLastCalledWith('other', { stopActivity: true })
  await bench.select('other')
  expect(JSON.stringify(bench.model('mayfly.sessions.detail').node)).toContain('Restore the session first')
  await bench.act('restore'); await bench.confirm()
  expect(bench.registry.unarchiveSession).toHaveBeenCalledWith('other')
})
it('opens roots by native resume and children through descendant addresses', async () => {
  const bench = await setup()
  const resume = vi.fn(); bench.ctx.on('mayfly/request-resume', resume)
  await bench.open(); await bench.select('current'); await bench.act('open')
  expect(resume).toHaveBeenCalledWith('current')
  await bench.open(); await bench.select('child'); await bench.act('open')
  expect(bench.ctx.mayflyCurrentAgent.view().auxiliary).toMatchObject({ sessionId: 'child', parentSessionId: 'current', access: 'resumable' })
  bench.subagents.listDescendants.mockResolvedValueOnce([])
  await bench.open(); await bench.select('child'); await bench.act('open')
  expect(bench.model('mayfly.sessions.detail').feedbackSnapshot().some(item => item.message.includes('lead session'))).toBe(true)
})
it('contains read failures and cancels a late opening', async () => {
  const bench = await setup()
  bench.controller.list.mockRejectedValueOnce(new Error('disk unavailable'))
  expect(await bench.open()).toMatchObject({ kind: 'error', text: expect.stringContaining('disk unavailable') })
  const gate = Promise.withResolvers<Awaited<ReturnType<typeof bench.controller.list>>>()
  bench.controller.list.mockReturnValueOnce(gate.promise)
  const abort = new AbortController()
  const opening = openSessions(bench.ctx, abort.signal)
  abort.abort(); gate.resolve({ items: [] })
  await opening
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it('contains stale selections, unknown actions, and archive failures without redirecting a child', async () => {
  const bench = await setup()
  await bench.open()
  expect(await nativeAction(bench.model(), selection('sessions', 'missing'))).toMatchObject({ kind: 'failed' })
  expect(await nativeAction(bench.model(), { kind: 'dismiss', pagePath: [] } as never)).toMatchObject({ kind: 'completed' })
  await nativeAction(bench.model(), activate('unknown'))
  await bench.select('other')
  let detail = bench.model('mayfly.sessions.detail')
  expect(await nativeAction(detail, selection('none'))).toMatchObject({ kind: 'completed' })
  expect(await nativeAction(detail, activate('unknown'))).toMatchObject({ kind: 'completed' })
  bench.registry.archivedSessionIds.push('other')
  expect(await nativeAction(detail, activate('open'))).toMatchObject({ kind: 'failed' })
  bench.registry.archiveSession.mockRejectedValueOnce(new Error('persistence failed'))
  await expect(nativeAction(detail, activate('archive'))).rejects.toThrow('persistence failed')
  bench.ctx.mayflyOverlays.close('mayfly.sessions.detail')
  await bench.select('child')
  detail = bench.model('mayfly.sessions.detail')
  bench.ctx.mayflyCurrentAgent.select(null)
  expect(await nativeAction(detail, activate('open'))).toMatchObject({ kind: 'failed' })
})
it('shows complete search results and ignores a late archive repaint after closing', async () => {
  const bench = await setup()
  bench.controller.search.mockResolvedValueOnce({ items: [{ sessionId: 'current', snippet: 'hit' }], hasMore: false })
  await bench.open()
  bench.model().edit({ pagePath: [], formId: 'content-search', fieldId: 'query' }, 'text')
  await bench.act('search', false)
  expect(JSON.stringify(bench.model().node)).toContain('Current')
  await bench.act('refresh', false)
  const gate = Promise.withResolvers<void>()
  bench.registry.archiveSession.mockReturnValueOnce(gate.promise)
  await bench.select('other')
  const call = nativeAction(bench.model('mayfly.sessions.detail'), activate('archive'))
  await flushRequests()
  bench.ctx.mayflyOverlays.close('mayfly.sessions')
  gate.resolve(); await call
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it('uses the native child id when no label is available', async () => {
  const bench = await setup()
  bench.subagents.listDescendants.mockResolvedValueOnce([{ kind: 'child', id: 'child', parentId: 'current', mode: 'continuable' }] as never)
  await bench.open(); await bench.select('child'); await bench.act('open')
  expect(bench.ctx.mayflyCurrentAgent.view().auxiliary?.label).toBe('child')
})
