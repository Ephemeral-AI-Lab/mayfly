/** Additional `/files` decisions: changed-file details and diff bodies, cancellation, stale ids, and live
 * workspace-change rereads.
 * @module @ephemeral-ai/mayfly/tests/interaction/deliverables-command-extra
 */
import { Context } from '@deepseek-ai/cordis'
import type { WorkspaceChangesSummary, WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import { afterEach, expect, it, vi } from 'vitest'
import * as deliverables from '../../src/interaction/deliverables-command.ts'
import { deliverablesProjection } from '../../src/conversation/deliverables.ts'
import { informationFixture } from './information-fixture.ts'
import { flushRequests } from './request-fixture.ts'
import { activate, nativeAction, select as selection } from './native-action-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })

function fakeWorkspaceChanges() {
  const summary = vi.fn((): WorkspaceChangesSummary | undefined => undefined)
  const diff = vi.fn(async (): Promise<WorkspaceFileDiff | undefined> => undefined)
  return { summary, diff }
}

async function setup() {
  const ctx = new Context(); contexts.push(ctx)
  const bench = await informationFixture(ctx)
  ctx.sessionProjections.register(deliverablesProjection)
  const workspaceChanges = fakeWorkspaceChanges()
  ctx.provide('workspaceChanges', workspaceChanges as never)
  const fs = {
    resolve: vi.fn(async (path: string) => ({ targetKey: path, displayPath: path })),
    stat: vi.fn(async () => ({ type: 'file', size: 20 })),
    processPath: vi.fn(() => '/repo/result.txt'),
    readBytes: vi.fn(async () => new TextEncoder().encode('Delivered text')),
  }
  bench.agent.ctx.provide('fs', fs as never)
  ctx.provide('sessionController', { canOpenWorkspacePath: vi.fn(() => true), openWorkspacePath: vi.fn(async () => ({ opened: true })) } as never)
  await ctx.plugin(deliverables)
  const model = (id = 'mayfly.files') => ctx.mayflyUiInteraction.get('overlay', id)!
  const publishDelivered = () => bench.session.append('deliverables/presented', { turn: 1, callId: 'call' as never, files: [{ path: 'result.txt', description: 'Result' }] })
  const changedId = (seq: number, index: number) => `changes:${String(seq)}:${String(index)}`
  return { ...bench, fs, workspaceChanges, model, publishDelivered, changedId }
}

const TEXT_DIFF: WorkspaceFileDiff = {
  kind: 'text', path: 'src/a.ts', display: 'src/a.ts', before: true, after: true,
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old', '+new', '+more'] }],
  coarse: false,
}

it('describes every changed-file detail and turn total', async () => {
  const bench = await setup()
  bench.publishDelivered()
  const event = bench.session.append('workspace/changes', { turn: 3 })
  bench.workspaceChanges.summary.mockReturnValue({
    turn: 3, cwd: '/repo/current',
    files: [
      { path: 'a.ts', display: 'a.ts', added: 0, deleted: 0 },
      { path: 'b.ts', display: 'b.ts', added: 0, deleted: 0, oversized: true },
      { path: 'c.ts', display: 'c.ts', added: 2, deleted: 0 },
      { path: 'd.ts', display: 'd.ts', added: 0, deleted: 3 },
    ],
    total: 9, added: 0, deleted: 0,
  })
  await bench.run('/files')
  const node = JSON.stringify(bench.model().node)
  expect(node).toContain('Changed · turn 3 · 4 of 9 files')
  expect(node).toContain('"detail":"changed"')
  expect(node).toContain('"detail":"oversized"')
  expect(node).toContain('"detail":"+2"')
  expect(node).toContain('"detail":"-3"')
  expect(bench.workspaceChanges.summary).toHaveBeenCalledWith(bench.session.id, event.seq)
})

it('renders missing, oversized, coarse, and empty comparisons', async () => {
  const bench = await setup()
  bench.publishDelivered()
  const event = bench.session.append('workspace/changes', { turn: 3 })
  bench.workspaceChanges.summary.mockReturnValue({
    turn: 3, cwd: '/repo', total: 1, added: 1, deleted: 0,
    files: [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 0 }],
  })
  await bench.run('/files')
  const open = async (diff: WorkspaceFileDiff | undefined) => {
    bench.workspaceChanges.diff.mockResolvedValueOnce(diff)
    bench.ctx.mayflyOverlays.close('mayfly.files.changes')
    expect(await nativeAction(bench.model(), selection('files', bench.changedId(event.seq, 0)))).toMatchObject({ kind: 'completed' })
    return JSON.stringify(bench.model('mayfly.files.changes').node)
  }
  expect(await open(undefined)).toContain('No comparison is available for this turn.')
  expect(await open({ kind: 'oversized', path: 'a.ts', display: 'a.ts' } as WorkspaceFileDiff)).toContain('File too large to compare.')
  const coarse = await open({ ...TEXT_DIFF, coarse: true, hunks: [] })
  expect(coarse).toContain('Large change; showing whole-file replacement.')
  expect(coarse).toContain('No line changes.')
  const empty = await open({ ...TEXT_DIFF, hunks: [] })
  expect(empty).toContain('No line changes.')
  expect(empty).not.toContain('Large change')
})

it('reports a non-Error comparison failure and cancels after the Agent changes', async () => {
  const bench = await setup()
  bench.publishDelivered()
  const event = bench.session.append('workspace/changes', { turn: 3 })
  bench.workspaceChanges.summary.mockReturnValue({
    turn: 3, cwd: '/repo', total: 1, added: 1, deleted: 0,
    files: [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 0 }],
  })
  await bench.run('/files')
  bench.workspaceChanges.diff.mockRejectedValueOnce('disk gone')
  expect(await nativeAction(bench.model(), selection('files', bench.changedId(event.seq, 0)))).toEqual({ kind: 'failed', message: 'disk gone' })
  bench.workspaceChanges.diff.mockRejectedValueOnce(new Error('diff failed'))
  expect(await nativeAction(bench.model(), selection('files', bench.changedId(event.seq, 0)))).toEqual({ kind: 'failed', message: 'diff failed' })

  const pending = Promise.withResolvers<WorkspaceFileDiff | undefined>()
  bench.workspaceChanges.diff.mockReturnValueOnce(pending.promise)
  let current = bench.agent
  vi.spyOn(bench.ctx.mayflyCurrentAgent, 'current').mockImplementation(() => current)
  const call = nativeAction(bench.model(), selection('files', bench.changedId(event.seq, 0)))
  await vi.waitFor(() => { expect(bench.workspaceChanges.diff).toHaveBeenCalledTimes(2) })
  current = bench.other
  pending.resolve(TEXT_DIFF)
  expect(await call).toMatchObject({ kind: 'cancelled' })
  expect(bench.ctx.mayflyOverlays.list().some(entry => entry.id === 'mayfly.files.changes')).toBe(false)
})

it('handles a comparison whose Host service and surface action have gone away', async () => {
  const bench = await setup()
  bench.publishDelivered()
  const event = bench.session.append('workspace/changes', { turn: 3 })
  bench.workspaceChanges.summary.mockReturnValue({
    turn: 3, cwd: '/repo', total: 1, added: 1, deleted: 0,
    files: [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 0 }],
  })
  await bench.run('/files')
  let calls = 0
  const original = bench.ctx.get.bind(bench.ctx)
  vi.spyOn(bench.ctx, 'get').mockImplementation(((name: never) => {
    if (String(name) !== 'workspaceChanges') return original(name)
    calls += 1
    return calls === 1 ? bench.workspaceChanges : undefined
  }) as never)
  expect(await nativeAction(bench.model(), selection('files', bench.changedId(event.seq, 0)))).toMatchObject({ kind: 'completed' })
  vi.restoreAllMocks()

  bench.ctx.mayflyOverlays.close('mayfly.files')
  await bench.run('/files')
  bench.workspaceChanges.diff.mockResolvedValueOnce(TEXT_DIFF)
  bench.workspaceChanges.diff.mockResolvedValueOnce(TEXT_DIFF)
  await nativeAction(bench.model(), selection('files', bench.changedId(event.seq, 0)))
  const change = bench.model('mayfly.files.changes')
  expect(await nativeAction(change, activate('copy'))).toMatchObject({ kind: 'completed' })
})

it('omits a turn whose Host summary is no longer served', async () => {
  const bench = await setup()
  bench.publishDelivered()
  bench.session.append('workspace/changes', { turn: 9 })
  await bench.run('/files')
  const node = JSON.stringify(bench.model().node)
  expect(node).toContain('result.txt')
  expect(node).not.toContain('Changed ·')
  expect(bench.workspaceChanges.summary).toHaveBeenCalledOnce()
})

it('treats an empty selection and a stale changed id as cancellations', async () => {
  const bench = await setup()
  bench.publishDelivered()
  const event = bench.session.append('workspace/changes', { turn: 3 })
  bench.workspaceChanges.summary.mockReturnValue({ turn: 3, cwd: '/repo', total: 1, added: 1, deleted: 0, files: [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 0 }] })
  await bench.run('/files')
  expect(await nativeAction(bench.model(), selection('files'))).toMatchObject({ kind: 'cancelled' })
  expect(await nativeAction(bench.model(), selection('files', bench.changedId(event.seq + 1, 0)))).toMatchObject({ kind: 'cancelled' })
  expect(bench.workspaceChanges.diff).not.toHaveBeenCalled()
})

it('rereads the Host summary when a new workspace/changes event lands, ignoring other events', async () => {
  const bench = await setup()
  bench.publishDelivered()
  const first = bench.session.append('workspace/changes', { turn: 3 })
  bench.workspaceChanges.summary.mockReturnValue({ turn: 3, cwd: '/repo', total: 1, added: 1, deleted: 0, files: [{ path: 'a.ts', display: 'a.ts', added: 1, deleted: 0 }] })
  await bench.run('/files')
  expect(bench.workspaceChanges.summary).toHaveBeenCalledWith(bench.session.id, first.seq)
  bench.session.append('workspace/changes', { turn: 4 })
  bench.workspaceChanges.summary.mockReturnValue({ turn: 4, cwd: '/repo', total: 1, added: 1, deleted: 0, files: [{ path: 'b.ts', display: 'b.ts', added: 1, deleted: 0 }] })
  bench.session.append('workspace/changes', { turn: 4 })
  const third = bench.session.snapshotEvents().at(-1)!
  await flushRequests()
  expect(bench.workspaceChanges.summary).toHaveBeenLastCalledWith(bench.session.id, third.seq)
  expect(JSON.stringify(bench.model().node)).toContain('b.ts')
  bench.session.append('turn/start', { turn: 5 })
  await flushRequests()
  expect(JSON.stringify(bench.model().node)).toContain('b.ts')
})
