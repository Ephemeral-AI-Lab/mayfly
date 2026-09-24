import { nativeAction, activate, select as selection } from './native-action-fixture.ts'
/** Recorded delivery projection and explicit file actions in the selected filesystem.
 * @module @ephemeral-ai/mayfly/tests/interaction/deliverables-command
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import * as deliverables from '../../src/interaction/deliverables-command.ts'
import { deliverablesProjection } from '../../src/conversation/deliverables.ts'
import { informationFixture } from './information-fixture.ts'
import { flushRequests } from './request-fixture.ts'
import { setClipboardTextWriter, setClipboardOsc52Emitter } from '../../src/interaction/clipboard-write.ts'

const contexts: Context[] = []
afterEach(async () => { setClipboardTextWriter(undefined); setClipboardOsc52Emitter(undefined); vi.restoreAllMocks(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
async function setup() {
  const ctx = new Context(); contexts.push(ctx)
  const bench = await informationFixture(ctx)
  ctx.sessionProjections.register(deliverablesProjection)
  const fs = {
    resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })),
    stat: vi.fn(async () => ({ type: 'file', size: 20 })),
    processPath: vi.fn(() => '/repo/result.txt'),
    readBytes: vi.fn(async () => new TextEncoder().encode('Delivered text')),
  }
  bench.agent.ctx.provide('fs', fs as never)
  const changed: ((session: unknown, key: string) => void)[] = []
  const onChanged = ctx.sessionProjections.onChanged.bind(ctx.sessionProjections)
  vi.spyOn(ctx.sessionProjections, 'onChanged').mockImplementation(callback => { changed.push(callback as never); return onChanged(callback) })
  const controller = { canOpenWorkspacePath: vi.fn(() => true), openWorkspacePath: vi.fn(async () => ({ opened: true })) }
  ctx.provide('sessionController', controller as never)
  await ctx.plugin(deliverables)
  const model = (id = 'mayfly.files') => ctx.mayflyUiInteraction.get('overlay', id)!
  const select = async () => { model().emit({ kind: 'selection-accept', pagePath: [], controlId: 'files', selectedIds: [ctx.sessionProjections.snapshot(bench.session, ['mayflyDeliverables']).values.mayflyDeliverables![0]!.id] }); await flushRequests() }
  const publish = () => bench.session.append('deliverables/presented', { turn: 1, callId: 'call' as never, files: [{ path: 'result.txt', description: 'Result' }] })
  return { ...bench, fs, controller, changed, model, select, publish }
}
it('records successful native deliveries and loads file bytes only on Preview', async () => {
  const bench = await setup()
  await bench.run('/files')
  expect(JSON.stringify(bench.model().node)).toContain('No delivered files')
  bench.publish(); await flushRequests()
  expect(JSON.stringify(bench.model().node)).toContain('result.txt')
  await bench.select()
  expect(bench.fs.readBytes).not.toHaveBeenCalled()
  bench.model('mayfly.files.detail').invoke('preview'); await flushRequests()
  expect(JSON.stringify(bench.model('mayfly.files.preview').node)).toContain('Delivered text')
  await nativeAction(bench.model('mayfly.files.preview'), activate('close'))
  expect(bench.fs.resolve).toHaveBeenCalledWith('result.txt', { cwd: '/repo/current', signal: expect.any(AbortSignal) })
  bench.ctx.mayflyOverlays.close('mayfly.files.preview')
  bench.model('mayfly.files.detail').invoke('open'); await flushRequests()
  expect(bench.controller.openWorkspacePath).toHaveBeenCalledWith({ path: '/repo/result.txt' }, expect.any(AbortSignal))
  bench.ctx.mayflyCurrentAgent.select(bench.other)
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
})
it('reports unavailable and binary files without presenting binary bytes as text', async () => {
  const bench = await setup()
  bench.publish()
  bench.fs.stat.mockResolvedValueOnce(undefined as never)
  await bench.run('/files'); await bench.select()
  expect(JSON.stringify(bench.model('mayfly.files.detail').node)).toContain('File unavailable')
  bench.ctx.mayflyOverlays.close('mayfly.files.detail')
  await bench.select()
  bench.fs.readBytes.mockResolvedValueOnce(new Uint8Array([0, 1, 2]))
  bench.model('mayfly.files.detail').invoke('preview'); await flushRequests()
  expect(JSON.stringify(bench.model('mayfly.files.preview').node)).toContain('Binary file')
})
it('ignores unrelated native facts in the delivery projection', () => {
  const initial = deliverablesProjection.init()
  expect(deliverablesProjection.apply(initial, { type: 'turn/start' } as never)).toBe(initial)
  expect(deliverablesProjection.wire.view(initial)).toBe(initial)
})
it('copies paths explicitly and reports a missing preview as a failed action', async () => {
  const bench = await setup()
  const clipboard = vi.fn(async () => {})
  setClipboardTextWriter(clipboard); setClipboardOsc52Emitter(() => false)
  bench.publish(); await bench.run('/files'); await bench.select()
  bench.model('mayfly.files.detail').invoke('copy'); await flushRequests()
  expect(clipboard).toHaveBeenCalledWith('/repo/result.txt')
  bench.fs.readBytes.mockRejectedValueOnce(new Error('File removed'))
  bench.model('mayfly.files.detail').invoke('preview'); await flushRequests()
  expect(bench.model('mayfly.files.detail').feedbackSnapshot().some(item => item.message.includes('File removed'))).toBe(true)
})

it('handles empty actions, unavailable current Agent, and late file resolution', async () => {
  const bench = await setup()
  bench.publish(); await bench.run('/files')
  expect(await nativeAction(bench.model(), activate('unknown'))).toMatchObject({ kind: 'completed' })
  expect(await nativeAction(bench.model(), selection('files', 'missing'))).toMatchObject({ kind: 'cancelled' })
  await bench.select()
  const detail = bench.model('mayfly.files.detail')
  expect(await nativeAction(detail, selection('none'))).toMatchObject({ kind: 'completed' })
  expect(await nativeAction(detail, activate('unknown'))).toMatchObject({ kind: 'completed' })
  bench.ctx.mayflyOverlays.close('mayfly.files.detail')
  const pending = Promise.withResolvers<{ targetKey: string, displayPath: string }>()
  bench.fs.resolve.mockReturnValueOnce(pending.promise)
  const call = nativeAction(bench.model(), selection('files', bench.ctx.sessionProjections.snapshot(bench.session, ['mayflyDeliverables']).values.mayflyDeliverables![0]!.id))
  await vi.waitFor(() => expect(bench.fs.resolve).toHaveBeenCalledTimes(2))
  bench.ctx.mayflyCurrentAgent.select(bench.other)
  pending.resolve({ targetKey: 'result', displayPath: 'result' })
  await call
  expect(bench.ctx.mayflyOverlays.list()).toHaveLength(0)
  expect((await bench.run('/files'))?.result).toMatchObject({ kind: 'error' })
})
it('supports missing optional file metadata and suppresses unavailable host Open', async () => {
  const bench = await setup()
  Object.assign(bench.agent, { session: bench.ctx.sessions.create('missing-cwd' as never) })
  vi.spyOn(bench.ctx.sessionProjections, 'snapshot').mockReturnValue({ asOfSeq: 0, values: {} } as never)
  await bench.run('/files')
  expect(JSON.stringify(bench.model().node)).toContain('No delivered files')
  vi.mocked(bench.ctx.sessionProjections.snapshot).mockReturnValue({ asOfSeq: 0, values: { mayflyDeliverables: [{ id: '0/0', path: 'file' }] } } as never)
  bench.controller.canOpenWorkspacePath.mockReturnValue(false)
  bench.fs.stat.mockResolvedValueOnce({ type: 'file' } as never)
  bench.ctx.mayflyOverlays.close('mayfly.files')
  await bench.run('/files'); await bench.select()
  const detail = bench.model('mayfly.files.detail')
  expect(JSON.stringify(detail.node)).toContain('unknown bytes')
  expect(JSON.stringify(detail.node)).not.toContain('"id":"open"')
  bench.changed.forEach(callback => { callback(bench.session, 'mayflyDeliverables'); callback(bench.agent.session, 'other') })
  bench.session.append('turn/start', { turn: 1 }); await flushRequests()
})
