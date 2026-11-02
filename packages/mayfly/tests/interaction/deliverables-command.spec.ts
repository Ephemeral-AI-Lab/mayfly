/** Real native command, projection and shared UI lifetime for the private Files controller. @module */
import { Context } from '@deepseek-ai/cordis'
import type { FsInfo } from '@deepseek-ai/dsh-fs'
import type { WorkspaceFileDiff } from '@deepseek-ai/dsh-workspace-changes/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { deliverablesProjection } from '../../src/conversation/deliverables.ts'
import * as filesCommand from '../../src/interaction/deliverables-command.ts'
import { copyTextToClipboard } from '../../src/interaction/clipboard-write.ts'
import { informationFixture } from './information-fixture.ts'
import { flushRequests } from './request-fixture.ts'
import { activate, nativeAction, select } from './native-action-fixture.ts'

vi.mock('../../src/interaction/clipboard-write.ts', () => ({ copyTextToClipboard: vi.fn(async () => 'native') }))
const contexts: Context[] = []
afterEach(async () => { vi.clearAllMocks(); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const changed = { path: 'a.ts', display: 'a.ts', added: 3, deleted: 1 }
const summary = { turn: 2, cwd: '/repo/current', files: [changed], total: 1, added: 3, deleted: 1 }
const binary: WorkspaceFileDiff = { kind: 'binary', path: 'a.ts', display: 'a.ts' }
const deferred = <T,>() => Promise.withResolvers<T>()

async function setup(options: { readonly empty?: boolean, readonly noService?: boolean, readonly latest?: boolean, readonly noSummary?: boolean, readonly emptyChanges?: boolean } = {}) {
  const ctx = new Context(); contexts.push(ctx)
  const bench = await informationFixture(ctx)
  const unregisterDeliveries = ctx.sessionProjections.register(deliverablesProjection)
  ctx.effect(() => unregisterDeliveries)
  ctx.effect(() => () => bench.agent.ctx.fiber.dispose())
  if (!options.empty) bench.session.append('deliverables/presented', { files: [{ path: 'report.md', description: 'Report' }, { path: 'other.txt' }] })
  const target = { targetKey: 'opaque' as never, displayPath: '/repo/current/report.md' }
  const fs = {
    resolve: vi.fn(async () => target), stat: vi.fn(async (): Promise<FsInfo | undefined> => ({ type: 'file', version: 'v1' as never, size: 12 })),
    processPath: vi.fn(() => '/native/report.md'), readBytes: vi.fn(async (..._args: unknown[]): Promise<Uint8Array> => new TextEncoder().encode('preview 第二行')),
  }
  bench.agent.ctx.provide('fs', fs as never)
  const controller = { canOpenWorkspacePath: vi.fn(() => true), openWorkspacePath: vi.fn(async () => ({})) }
  ctx.provide('sessionController', controller as never)
  const changes = { summary: vi.fn(() => options.noSummary ? undefined : { ...summary, files: options.emptyChanges ? [] : summary.files }), diff: vi.fn(async (..._args: unknown[]): Promise<WorkspaceFileDiff | undefined> => binary) }
  if (!options.noService) ctx.provide('workspaceChanges', changes as never)
  if (options.latest) bench.session.append('workspace/changes', { turn: 2 })
  const fiber = await ctx.plugin(filesCommand)
  const model = () => ctx.mayflyUiInteraction.get('overlay', 'mayfly.files')!
  const text = () => JSON.stringify(model().registration.node)
  const rows = () => ctx.sessionProjections.snapshot(bench.session, ['mayflyDeliverables']).values.mayflyDeliverables ?? []
  const open = async () => { const result = await bench.run('/files'); await flushRequests(); return result }
  const act = (action: string, signal?: AbortSignal) => nativeAction(model(), activate(action, 'file-actions'), signal)
  const choose = (id: string | undefined, control = 'files') => nativeAction(model(), select(control, ...id === undefined ? [] : [id]))
  return { ...bench, fs, target, controller, changes, fiber, model, text, rows, open, act, choose, unregisterDeliveries }
}

describe('native private Files controller', () => {
  it('uses the real delivery projection, exact Agent filesystem and frozen actions without leaking its opaque target', async () => {
    const f = await setup()
    expect((await f.open())?.result).toEqual({ kind: 'success' })
    expect(f.fs.resolve).toHaveBeenCalledWith('report.md', { cwd: '/repo/current', signal: expect.any(AbortSignal) })
    expect(f.fs.stat).toHaveBeenCalledWith(f.target, expect.any(AbortSignal))
    expect(f.text()).toContain('12 bytes')
    expect(f.text()).not.toContain('targetKey')
    expect(await f.act('copy')).toMatchObject({ kind: 'completed', feedback: { severity: 'success', message: 'Path copied' } })
    expect(copyTextToClipboard).toHaveBeenCalledWith('/native/report.md')
    expect(await f.act('open')).toMatchObject({ kind: 'completed', feedback: { message: 'Open request handed to the host application' } })
    expect(f.controller.openWorkspacePath).toHaveBeenCalledWith({ path: '/native/report.md' }, expect.any(AbortSignal))
    await f.act('preview')
    expect(f.fs.readBytes).toHaveBeenCalledWith(f.target, expect.any(AbortSignal), 256 * 1024)
    expect(f.text()).toContain('preview 第二行')
    await f.act('preview')
    expect(f.text()).not.toContain('preview 第二行')
  })

  it('keeps an empty list honest with no native change service, no event, no retained summary or no changed files', async () => {
    for (const options of [{ noService: true }, {}, { latest: true, noSummary: true }, { latest: true, emptyChanges: true }]) {
      const f = await setup({ ...options, empty: true })
      await f.open()
      expect(f.text()).toContain('No files')
      expect(f.fs.resolve).not.toHaveBeenCalled()
      expect(await f.act('copy')).toMatchObject({ kind: 'failed', message: 'File unavailable' })
      expect(await f.act('open')).toMatchObject({ kind: 'failed', message: 'File unavailable' })
      expect(await f.act('preview')).toMatchObject({ kind: 'failed', message: 'File unavailable' })
    }
  })

  it('refuses a stale invoking Agent and focuses an already opened panel without a second filesystem read', async () => {
    const f = await setup()
    expect((await f.ctx.commands.execute(f.other, '/files', [], new AbortController().signal))?.result).toEqual({ kind: 'error', text: 'No current Agent' })
    await f.open()
    const old = f.model()
    await f.open()
    expect(f.model()).toBe(old)
    expect(f.fs.resolve).toHaveBeenCalledTimes(1)
  })

  it('preserves file selection across deliveries, filters unrelated facts, and advances focus after a withdrawn row', async () => {
    const f = await setup()
    await f.open()
    const id = f.rows()[0]!.id
    expect(await f.choose(id)).toMatchObject({ kind: 'completed' })
    expect(f.fs.resolve).toHaveBeenCalledTimes(1)
    expect(await f.choose(undefined)).toMatchObject({ kind: 'cancelled' })
    await f.choose(f.rows()[1]!.id, 'foreign')
    expect(f.fs.resolve).toHaveBeenCalledTimes(1)
    f.session.append('deliverables/presented', { files: [{ path: 'new.txt' }] })
    f.otherSession.append('deliverables/presented', { files: [{ path: 'foreign.txt' }] })
    f.otherSession.append('workspace/changes', { turn: 1 })
    f.session.append('turn/start', { turn: 1 })
    await flushRequests()
    expect(f.text()).toContain('new.txt')
    expect(f.text()).not.toContain('foreign.txt')
    expect(f.fs.resolve).toHaveBeenCalledTimes(1)
    await f.choose('absent')
    expect(f.text()).toContain('Select a file')
    f.session.append('deliverables/presented', { files: [{ path: 'newer.txt' }] })
    await flushRequests()
    expect(f.fs.resolve).toHaveBeenCalledTimes(2)
  })

  it('opens narrow file details and backs out one layer before dismissal', async () => {
    const f = await setup()
    await f.open()
    await f.choose(f.rows()[1]!.id, 'files-narrow')
    await flushRequests()
    expect((f.model().node as { title: string }).title).toBe('other.txt')
    expect(await nativeAction(f.model(), { kind: 'dismiss', pagePath: [] })).toMatchObject({ kind: 'completed', dismiss: false })
    expect((f.model().node as { title: string }).title).toBe('Files')
    expect(await nativeAction(f.model(), { kind: 'dismiss', pagePath: [] })).toMatchObject({ kind: 'completed' })
  })

  it('keeps unavailable size/type values and binary previews faithful to the native answers', async () => {
    const f = await setup()
    f.fs.stat.mockResolvedValueOnce(undefined)
    await f.open()
    expect(f.text()).toContain('unknown')
    f.fs.stat.mockResolvedValueOnce({ type: 'file', version: 'v2' as never })
    await f.choose(f.rows()[1]!.id)
    await flushRequests()
    expect(f.text()).toContain('unknown')
    f.fs.readBytes.mockResolvedValueOnce(Uint8Array.of(0))
    await f.act('preview')
    expect(f.text()).toContain('Binary file; use Open in an external application.')
  })

  it('starts on the latest changed row, reads its exact native comparison and refreshes on later turn facts', async () => {
    const f = await setup({ empty: true, latest: true })
    await f.open()
    expect(f.changes.diff).toHaveBeenCalledWith(f.session.id, expect.any(Number), 0, expect.any(AbortSignal))
    expect(f.text()).toContain('Binary file; no text comparison.')
    const latestEvent = f.session.snapshotEvents().findLast(event => event.type === 'workspace/changes')!
    await f.choose(`changes:${String(latestEvent.seq)}:0`)
    expect(f.changes.diff).toHaveBeenCalledTimes(1)
    f.changes.diff.mockResolvedValueOnce(undefined)
    f.session.append('workspace/changes', { turn: 3 })
    await flushRequests()
    expect(f.text()).toContain('No comparison is available for this turn.')
    expect(f.changes.diff).toHaveBeenCalledTimes(2)
  })

  it.each([new Error('file denied'), 'string failure'])('shows a filesystem failure as file detail: %s', async failure => {
    const f = await setup()
    f.fs.stat.mockRejectedValueOnce(failure)
    await f.open()
    expect(f.text()).toContain(failure instanceof Error ? failure.message : failure)
    expect(f.text()).toContain('File unavailable')
  })

  it('shows a native comparison failure without replacing the list or activating another Agent', async () => {
    const f = await setup({ empty: true, latest: true })
    f.changes.diff.mockRejectedValueOnce(new Error('comparison denied'))
    await f.open()
    expect(f.text()).toContain('comparison denied')
    expect(f.text()).toContain('Changed · turn 2')
  })

  it('ignores unrelated non-action observations and unknown actions', async () => {
    const f = await setup()
    await f.open()
    expect(await nativeAction(f.model(), { kind: 'focus', pagePath: [], controlId: 'files' } as never)).toMatchObject({ kind: 'completed' })
    expect(await f.act('unknown')).toMatchObject({ kind: 'completed' })
  })
})

describe('native Files read cancellation and replacement', () => {
  it.each(['resolve', 'reject'] as const)('discards old delivered-file %s after selecting another row', async settlement => {
    const f = await setup()
    const pending = deferred<FsInfo | undefined>()
    f.fs.stat.mockReturnValueOnce(pending.promise)
    await f.open()
    await f.choose(f.rows()[1]!.id)
    await flushRequests()
    if (settlement === 'resolve') pending.resolve({ type: 'file', version: 'old' as never, size: 123456 })
    else pending.reject(new Error('retired failure'))
    await flushRequests()
    expect(f.text()).not.toContain('123456')
    expect(f.text()).not.toContain('retired failure')
  })

  it.each(['selection', 'unload'] as const)('discards file details and late failures after %s', async retirement => {
    for (const settle of ['resolve', 'reject']) {
      const f = await setup()
      const pending = deferred<FsInfo | undefined>()
      f.fs.stat.mockReturnValueOnce(pending.promise)
      await f.open()
      const model = f.model()
      if (retirement === 'selection') f.ctx.mayflyConversations.selectPrimary(f.other)
      else await f.fiber.dispose()
      if (settle === 'resolve') pending.resolve({ type: 'file', version: 'old' as never, size: 123456 })
      else pending.reject(new Error('retired failure'))
      await flushRequests()
      expect(model.disposed).toBe(true)
    }
  })

  it('discards a late changed comparison after delivered files take its focus', async () => {
    const f = await setup({ empty: true, latest: true })
    const pending = deferred<WorkspaceFileDiff | undefined>()
    f.changes.diff.mockReturnValueOnce(pending.promise)
    await f.open()
    f.session.append('deliverables/presented', { files: [{ path: 'new.txt' }] })
    await flushRequests()
    await f.choose(f.rows()[0]!.id)
    pending.resolve(binary)
    await flushRequests()
    expect(f.text()).not.toContain('Binary file; no text comparison.')
  })

  it('does not publish a preview that settles after its action signal aborts', async () => {
    const f = await setup()
    await f.open()
    const pending = deferred<Uint8Array>()
    f.fs.readBytes.mockReturnValueOnce(pending.promise)
    const caller = new AbortController()
    const result = f.act('preview', caller.signal)
    await flushRequests()
    caller.abort()
    pending.resolve(new TextEncoder().encode('retired preview'))
    expect(await result).toBeUndefined()
    expect(f.text()).not.toContain('retired preview')
  })
})

it('handles an unloaded delivery projection and a retired native changed-file summary without inventing a row', async () => {
  const unpublished = await setup({ empty: true })
  unpublished.unregisterDeliveries()
  await unpublished.open()
  expect(unpublished.text()).toContain('No files')
  const changedOnly = await setup({ empty: true, latest: true })
  await changedOnly.open()
  changedOnly.changes.summary.mockReturnValue(undefined)
  changedOnly.session.append('workspace/changes', { turn: 3 })
  await flushRequests()
  expect(changedOnly.text()).toContain('No files')
})

it('does not republish a successful native file read after its overlay closed', async () => {
  const f = await setup()
  const pending = deferred<FsInfo | undefined>()
  f.fs.stat.mockReturnValueOnce(pending.promise)
  await f.open()
  f.ctx.mayflyOverlays.close('mayfly.files')
  pending.resolve({ type: 'file', version: 'late' as never, size: 123456 })
  await flushRequests()
  expect(f.ctx.mayflyOverlays.list()).toHaveLength(0)
})

it('handles native workspace comparison service removal while the first overlay owner is mounting', async () => {
  const f = await setup({ empty: true, latest: true })
  const definition = f.ctx.commands.find(f.agent, 'files')!
  const opened = definition.handler({ agent: f.agent, rawInput: '', signal: new AbortController().signal } as never)
  f.ctx.set('workspaceChanges', undefined as never)
  await opened
  await flushRequests()
  expect(f.changes.diff).not.toHaveBeenCalled()
  expect(f.text()).toContain('No files')
})
