/** Exact rc.2 Files workflows over native Remote reads, with unload and late-result fences. @module */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import type { MayflyUiActionEvent, MayflyUiEventContext, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import { RemoteFeatureCommandRegistry } from '../../src/remote/features/commands.ts'
import type { RemoteOperationsContext } from '../../src/remote/operations/support.ts'
import { openRemoteBrowser, type RemoteBrowserOptions } from '../../src/remote/panels/browser.ts'
import { mountRemoteFilesOperations } from '../../src/remote/operations/files.ts'

vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: vi.fn() }))
afterEach(() => { vi.clearAllMocks() })
const ok = (value: unknown) => ({ ok: true as const, value })
const failure = { ok: false, error: { code: 'native/refusal', message: 'native refusal' } }
const delivered = [{ id: '4/0', path: 'report.md', description: 'Report' }, { id: '4/1', path: 'other.txt' }]
const latest = { seq: 8, summary: { turn: 3, cwd: '/host/work', files: [{ path: 'a.ts', display: 'a.ts', added: 2, deleted: 1 }], total: 1, added: 2, deleted: 1 } }
const tick = async () => { for (let index = 0; index < 12; index += 1) await Promise.resolve() }
const deferred = <T,>() => Promise.withResolvers<T>()

function fixture(options: { readonly files?: typeof delivered | null, readonly noCopy?: boolean, readonly closeOnOpen?: boolean } = {}) {
  const listeners = { topology: new Set<() => void>(), state: new Set<() => void>(), projection: new Set<() => void>(), events: new Set<() => void>() }
  const subscribe = (kind: keyof typeof listeners) => (listener: () => void) => { listeners[kind].add(listener); return () => { listeners[kind].delete(listener) } }
  const fire = (kind: keyof typeof listeners) => { for (const listener of [...listeners[kind]]) listener() }
  let files = options.files === null ? undefined : options.files ?? delivered
  let entries: readonly unknown[] = []
  let generation = 1
  const deliveredFile = vi.fn(async (request: { deliveryId: string, preview?: boolean }, _signal?: AbortSignal): Promise<unknown> => ok({ path: `/native/${request.deliveryId}`, displayPath: '~/work/report.md', fileType: 'file', size: 12, ...request.preview === true ? { preview: 'preview line\n第二行' } : {} }))
  const latestWorkspaceChanges = vi.fn(async (): Promise<unknown> => ok(null))
  const workspaceChangesDiff = vi.fn(async (): Promise<unknown> => ok(null))
  const canOpenWorkspacePath = vi.fn(async (): Promise<unknown> => ok(true))
  const openWorkspacePath = vi.fn(async (_request: unknown, _signal?: AbortSignal): Promise<unknown> => ok({}))
  const copy = vi.fn(async (_text: string): Promise<void> => {})
  const binding = { session: { projections: { faceOf: () => ({ getSnapshot: () => files, subscribe: subscribe('projection') }) } }, eventSource: { getSnapshot: () => ({ entries }), subscribe: subscribe('events') } } as unknown as SessionBinding
  const client = { key: HostKey('one'), state: { getSnapshot: () => ({ generation }), subscribe: subscribe('state') }, remote: { mayflyHost: { deliveredFile, latestWorkspaceChanges, workspaceChangesDiff }, session: { canOpenWorkspacePath, openWorkspacePath } } } as unknown as HostClient
  let attached = true
  let current: RemoteFeatureSelection | undefined = { client, binding, ref: { host: HostKey('one'), sessionId: SessionId('lead') } }
  const locale = { register: vi.fn(), subscribe: vi.fn(() => () => {}), translate: vi.fn((_namespace: string, key: string) => key) }
  const focus = vi.fn(() => true)
  const ctx = { effect: (fn: () => unknown) => { fn(); return () => {} }, get: (name: string) => name === 'mayflyLocale' ? locale : undefined, inject: (_keys: unknown, fn: (scope: unknown) => void) => { fn(ctx); return () => {} }, mayflyLocale: locale, mayflyOverlays: { focus } } as unknown as Context
  const commands = new RemoteFeatureCommandRegistry()
  const notice = { set: vi.fn() }
  const context = { base: { ctx, commands, notice, hosts: { list: () => attached ? [client] : [], current: () => current, subscribe: subscribe('topology') }, subscribeLocale: () => () => {} } as unknown as RemoteFeatureContext, options: { localCwd: '/local', ...options.noCopy ? {} : { copy } } } as unknown as RemoteOperationsContext
  let browser: RemoteBrowserOptions | undefined
  let closed = false
  const refresh = vi.fn()
  const close = vi.fn(() => { if (closed) return; closed = true; browser?.onClosed?.() })
  vi.mocked(openRemoteBrowser).mockImplementation((_base, value) => {
    browser = value
    closed = false
    if (options.closeOnOpen) value.onClosed?.()
    return { get closed() { return closed }, refresh, close }
  })
  const unmount = mountRemoteFilesOperations(context)
  const execute = (text = '', signal = new AbortController().signal) => commands.list().find(command => command.name === 'files')!.execute(text, signal)
  const act = (event: object, signal = new AbortController().signal) => browser!.action!(event as MayflyUiActionEvent, { signal } as MayflyUiEventContext)
  const select = (id?: string, controlId = 'files') => act({ kind: 'selection-accept', controlId, selectedIds: id === undefined ? [] : [id] })
  const activate = (actionId: string, signal?: AbortSignal) => act({ kind: 'activate', actionId }, signal)
  return { client, binding, commands, notice, unmount, execute, act, select, activate, deliveredFile, latestWorkspaceChanges, workspaceChangesDiff, canOpenWorkspacePath, openWorkspacePath, copy, refresh, close, focus, listeners,
    browser: () => browser!, view: () => browser!.view(),
    project: (value: typeof files) => { files = value; fire('projection') },
    events: (value: readonly unknown[]) => { entries = value; fire('events') },
    selection: (value: RemoteFeatureSelection | undefined) => { current = value },
    current: () => current!, topology: () => { fire('topology') },
    reconnect: () => { generation += 1; fire('state') }, detach: () => { attached = false; current = undefined; fire('topology') },
  }
}

function nodes(node: MayflyUiNode): readonly Record<string, unknown>[] {
  const output: Record<string, unknown>[] = []
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const child of value) walk(child); return }
    if (typeof value !== 'object' || value === null) return
    const record = value as Record<string, unknown>
    if (typeof record.kind === 'string') output.push(record)
    for (const child of Object.values(record)) walk(child)
  }
  walk(node)
  return output
}
const contains = (node: MayflyUiNode, text: string) => JSON.stringify(node).includes(text)
const items = (node: MayflyUiNode) => nodes(node).find(row => row.kind === 'list' && row.id === 'files')!.items as readonly { id: string, label: string, group?: string }[]

describe('native Files command composition', () => {
  it('keeps cancelled callers from opening or publishing late file reads and releases their exact observers', async () => {
    const f = fixture()
    f.execute('', AbortSignal.abort())
    expect(f.deliveredFile).not.toHaveBeenCalled()
    const pending = deferred<unknown>()
    f.deliveredFile.mockReturnValueOnce(pending.promise)
    const caller = new AbortController()
    f.execute('', caller.signal)
    const signal = f.deliveredFile.mock.calls[0]![1]!
    caller.abort()
    expect(signal.aborted).toBe(true)
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.listeners.projection.size + f.listeners.events.size).toBe(0)
    const paints = f.refresh.mock.calls.length
    pending.resolve(ok({ path: '/stale', displayPath: '/stale', fileType: 'file', size: 9 }))
    await tick()
    expect(f.refresh).toHaveBeenCalledTimes(paints)
    expect(await f.activate('open')).toMatchObject({ kind: 'cancelled' })
    expect(f.openWorkspacePath).not.toHaveBeenCalled()
    f.unmount()
  })

  it('registers the command, shows rc.2 Files chrome and details, and releases reads and registration on unload', async () => {
    const f = fixture()
    expect(f.commands.list().map(command => command.name)).toEqual(['files'])
    await f.execute()
    await tick()
    expect(await f.activate('open', AbortSignal.abort())).toEqual({ kind: 'cancelled' })
    expect(f.openWorkspacePath).not.toHaveBeenCalled()
    expect(f.browser().id).toBe('remote.operations.files')
    expect(f.browser().scope).toEqual({ kind: 'session', sessionId: 'lead' })
    expect(f.browser().isCurrent()).toBe(true)
    expect(items(f.view())).toEqual([{ id: '4/0', label: 'report.md', group: 'Delivered', detail: 'Report' }, { id: '4/1', label: 'other.txt', group: 'Delivered' }])
    expect(contains(f.view(), '12 bytes')).toBe(true)
    expect(contains(f.view(), 'Preview text')).toBe(true)
    expect(contains(f.view(), 'Open')).toBe(true)
    f.unmount()
    expect(f.commands.list()).toEqual([])
    expect(f.close).toHaveBeenCalledOnce()
    for (const listener of Object.values(f.listeners)) expect(listener.size).toBe(0)
    f.unmount()
  })

  it('ignores reference arguments and reports a missing Session before opening anything', async () => {
    const f = fixture()
    f.selection(undefined)
    f.execute('extra')
    expect(f.notice.set).toHaveBeenCalledWith('No current session', 'error')
    expect(f.deliveredFile).not.toHaveBeenCalled()
    f.unmount()
  })

  it('uses the frozen empty state for an unavailable projection and selects new delivery rows automatically', async () => {
    const f = fixture({ files: null })
    f.execute()
    await tick()
    expect(items(f.view())).toEqual([])
    expect(contains(f.view(), 'No files')).toBe(true)
    f.project(delivered)
    await tick()
    expect(f.deliveredFile).toHaveBeenCalledWith({ sessionId: 'lead', deliveryId: '4/0' }, expect.any(AbortSignal))
    f.project([delivered[1]!])
    await tick()
    expect(f.deliveredFile).toHaveBeenLastCalledWith({ sessionId: 'lead', deliveryId: '4/1' }, expect.any(AbortSignal))
    f.unmount()
  })

  it('discards queued projection and event callbacks after retirement and handles an unpublished replacement snapshot', async () => {
    const f = fixture()
    f.execute()
    await tick()
    f.project(undefined)
    expect(items(f.view())).toEqual([])
    const projection = [...f.listeners.projection][0]!
    const events = [...f.listeners.events][0]!
    f.unmount()
    const paints = f.refresh.mock.calls.length
    projection()
    events()
    expect(f.refresh).toHaveBeenCalledTimes(paints)
  })

  it('keeps details on delivery updates, opens narrow details and consumes exactly one back layer', async () => {
    const f = fixture()
    f.execute()
    await tick()
    expect(await f.select(undefined)).toEqual({ kind: 'cancelled' })
    expect(await f.select('4/1', 'foreign')).toEqual({ kind: 'completed' })
    await f.select('4/0')
    expect(f.deliveredFile).toHaveBeenCalledTimes(1)
    f.project([...delivered])
    expect(f.deliveredFile).toHaveBeenCalledTimes(1)
    await f.select('4/1', 'files-narrow')
    expect(contains(f.view(), 'Loading file…')).toBe(true)
    expect((f.view() as { title?: string }).title).toBe('other.txt')
    await tick()
    expect(f.browser().back?.()).toBe(true)
    expect((f.view() as { title?: string }).title).toBe('Files')
    expect(f.browser().back?.()).toBe(false)
    expect(await f.act({ kind: 'dismiss' })).toEqual({ kind: 'completed' })
    expect(await f.activate('foreign')).toEqual({ kind: 'completed' })
    await f.select('absent')
    expect(contains(f.view(), 'Select a file')).toBe(true)
    f.unmount()
  })

  it('copies the native process path, asks the native Host application to open it, and toggles bounded previews', async () => {
    const f = fixture()
    f.execute()
    await tick()
    expect(await f.activate('copy')).toEqual({ kind: 'completed', feedback: { severity: 'success', message: 'Path copied' } })
    expect(f.copy).toHaveBeenCalledWith('/native/4/0')
    expect(await f.activate('open')).toEqual({ kind: 'completed', feedback: { severity: 'info', message: 'Open request handed to the host application' } })
    expect(f.openWorkspacePath).toHaveBeenCalledWith({ path: '/native/4/0' }, expect.any(AbortSignal))
    expect(await f.activate('preview')).toEqual({ kind: 'completed' })
    expect(f.deliveredFile).toHaveBeenLastCalledWith({ sessionId: 'lead', deliveryId: '4/0', preview: true }, expect.any(AbortSignal))
    expect(contains(f.view(), 'preview line')).toBe(true)
    await f.activate('preview')
    expect(contains(f.view(), 'preview line')).toBe(false)
    f.unmount()
  })

  it('keeps unavailable metadata, missing clipboard and absent native Open capability explicit', async () => {
    const f = fixture({ noCopy: true })
    f.canOpenWorkspacePath.mockResolvedValueOnce(ok(false))
    f.execute()
    expect(await f.activate('copy')).toEqual({ kind: 'failed', message: 'File unavailable' })
    await tick()
    expect(await f.activate('copy')).toEqual({ kind: 'failed', message: 'Clipboard unavailable' })
    expect(await f.activate('open')).toEqual({ kind: 'failed', message: 'Open unavailable' })
    expect(contains(f.view(), '"id":"open"')).toBe(false)
    f.deliveredFile.mockResolvedValueOnce(ok({ path: '/dir', displayPath: '/dir', fileType: 'directory' }))
    await f.select('4/1')
    await tick()
    expect(await f.activate('preview')).toEqual({ kind: 'failed', message: 'File unavailable' })
    f.unmount()
  })

  it('adds native latest changed files, selects initial changed rows, and reads the exact announced comparison', async () => {
    const f = fixture({ files: [] })
    f.latestWorkspaceChanges.mockResolvedValueOnce(ok(latest))
    f.workspaceChangesDiff.mockResolvedValueOnce(ok({ kind: 'binary', path: 'a.ts', display: 'a.ts' }))
    f.execute()
    await tick()
    expect(items(f.view()).map(row => row.id)).toEqual(['changes:8:0'])
    expect(f.workspaceChangesDiff).toHaveBeenCalledWith({ sessionId: 'lead', seq: 8, index: 0 }, expect.any(AbortSignal))
    expect(contains(f.view(), 'Binary file; no text comparison.')).toBe(true)
    expect(await f.activate('copy')).toEqual({ kind: 'failed', message: 'File unavailable' })
    await f.select('changes:8:0')
    expect(f.workspaceChangesDiff).toHaveBeenCalledTimes(1)
    f.unmount()
  })

  it('observes only new workspace/changes facts and ignores repeats and ordinary stream entries', async () => {
    const f = fixture()
    f.execute()
    await tick()
    const event = { type: 'event', event: { type: 'workspace/changes', seq: 8 } }
    f.events([{ type: 'transient', data: {} }, { type: 'event', event: { type: 'turn/end', seq: 9 } }])
    expect(f.latestWorkspaceChanges).toHaveBeenCalledTimes(1)
    f.latestWorkspaceChanges.mockResolvedValueOnce(ok(latest))
    f.events([event])
    await tick()
    expect(items(f.view())).toHaveLength(3)
    f.events([event, { type: 'transient', data: {} }])
    expect(f.latestWorkspaceChanges).toHaveBeenCalledTimes(2)
    await f.select('changes:8:0')
    await tick()
    expect(contains(f.view(), 'No comparison is available for this turn.')).toBe(true)
    f.unmount()
  })

  it('shows native metadata/comparison failures, keeps capability discovery advisory, and reports latest-summary failures', async () => {
    const f = fixture()
    f.canOpenWorkspacePath.mockRejectedValueOnce(new Error('cannot discover'))
    f.latestWorkspaceChanges.mockResolvedValueOnce(failure)
    f.deliveredFile.mockRejectedValueOnce(new Error('file denied'))
    f.execute()
    await tick()
    expect(contains(f.view(), 'file denied')).toBe(true)
    expect(f.notice.set).toHaveBeenCalledWith('native refusal', 'error')
    f.latestWorkspaceChanges.mockResolvedValueOnce(ok(latest))
    f.events([{ type: 'event', event: { type: 'workspace/changes', seq: 8 } }])
    await tick()
    f.workspaceChangesDiff.mockRejectedValueOnce(new Error('comparison denied'))
    await f.select('changes:8:0')
    await tick()
    expect(contains(f.view(), 'comparison denied')).toBe(true)
    f.unmount()
  })

  it.each(['copy', 'open', 'preview'])('returns a structured native %s failure', async action => {
    const f = fixture()
    f.execute()
    await tick()
    const error = new Error('action denied')
    if (action === 'copy') f.copy.mockRejectedValueOnce(error)
    else if (action === 'open') f.openWorkspacePath.mockRejectedValueOnce(error)
    else f.deliveredFile.mockRejectedValueOnce(error)
    expect(await f.activate(action)).toEqual({ kind: 'failed', message: 'action denied' })
    f.unmount()
  })
})

describe('Files browser operation retirement', () => {
  it('refocuses the original selected narrow preview without replacing its caller or duplicating reads and listeners', async () => {
    const f = fixture()
    const original = new AbortController()
    f.execute('', original.signal)
    await tick()
    await f.select('4/1', 'files-narrow')
    await tick()
    await f.activate('preview')
    const browser = f.browser()
    const view = f.view()
    const reads = f.deliveredFile.mock.calls.length
    expect(contains(view, 'preview line')).toBe(true)
    expect((view as { title?: string }).title).toBe('other.txt')
    const later = new AbortController()
    f.execute('', later.signal)
    expect(f.focus).toHaveBeenCalledExactlyOnceWith('remote.operations.files')
    expect(f.browser()).toBe(browser)
    expect(f.view()).toEqual(view)
    expect(f.deliveredFile).toHaveBeenCalledTimes(reads)
    expect(f.latestWorkspaceChanges).toHaveBeenCalledOnce()
    expect(f.canOpenWorkspacePath).toHaveBeenCalledOnce()
    expect(f.listeners.projection.size).toBe(1)
    expect(f.listeners.events.size).toBe(1)
    expect(f.close).not.toHaveBeenCalled()
    later.abort()
    expect(browser.isCurrent()).toBe(true)
    f.execute('', AbortSignal.abort())
    expect(f.focus).toHaveBeenCalledOnce()
    expect(browser.isCurrent()).toBe(true)
    original.abort()
    expect(browser.isCurrent()).toBe(false)
    expect(f.close).toHaveBeenCalledOnce()
    expect(f.listeners.projection.size + f.listeners.events.size).toBe(0)
    f.unmount()
  })

  it('keeps the original pending read on refocus and starts a fresh owner after that caller retires', async () => {
    const f = fixture()
    const pending = deferred<unknown>()
    f.deliveredFile.mockReturnValueOnce(pending.promise)
    const caller = new AbortController()
    f.execute('', caller.signal)
    const original = f.browser()
    f.execute()
    expect(f.deliveredFile).toHaveBeenCalledOnce()
    expect(original.isCurrent()).toBe(true)
    pending.resolve(ok({ path: '/original', displayPath: '/original', fileType: 'file' }))
    await tick()
    expect(contains(f.view(), '/original')).toBe(true)
    caller.abort()
    f.execute()
    expect(original.isCurrent()).toBe(false)
    expect(f.browser()).not.toBe(original)
    await tick()
    expect(f.deliveredFile).toHaveBeenCalledTimes(2)
    expect(f.browser().isCurrent()).toBe(true)
    f.unmount()
  })

  it.each(['reconnect', 'detach', 'binding', 'unmount', 'close', 'missing-overlay'] as const)('retires listeners and ignores an old metadata success on %s', async retirement => {
    const f = fixture()
    const pending = deferred<unknown>()
    f.deliveredFile.mockReturnValueOnce(pending.promise)
    f.execute()
    await tick()
    const old = f.browser()
    if (retirement === 'reconnect') f.reconnect()
    else if (retirement === 'detach') f.detach()
    else if (retirement === 'binding') { f.selection({ ...f.current(), binding: { ...f.binding } }); f.topology() }
    else if (retirement === 'unmount') f.unmount()
    else if (retirement === 'close') old.onClosed?.()
    else { f.focus.mockReturnValueOnce(false); f.execute() }
    await tick()
    expect(old.isCurrent()).toBe(false)
    const paints = f.refresh.mock.calls.length
    pending.resolve(ok({ path: '/late', displayPath: '/late', fileType: 'file' }))
    await tick()
    expect(f.refresh).toHaveBeenCalledTimes(paints)
    f.unmount()
  })

  it('fences old selection reads and failures when another file is focused', async () => {
    const f = fixture()
    const old = deferred<unknown>()
    f.deliveredFile.mockReturnValueOnce(old.promise)
    f.execute()
    await f.select('4/1')
    await tick()
    old.reject(new Error('old failure'))
    await tick()
    expect(contains(f.view(), 'old failure')).toBe(false)
    await f.activate('copy')
    expect(f.copy).toHaveBeenCalledWith('/native/4/1')
    f.unmount()
  })

  it('fences late changed comparisons when focus leaves their row', async () => {
    const f = fixture()
    const old = deferred<unknown>()
    f.latestWorkspaceChanges.mockResolvedValueOnce(ok(latest))
    f.execute()
    await tick()
    f.workspaceChangesDiff.mockReturnValueOnce(old.promise)
    await f.select('changes:8:0')
    await f.select('4/1')
    await tick()
    old.resolve(ok({ kind: 'binary', path: 'late', display: 'late' }))
    await tick()
    expect(contains(f.view(), 'Binary file;')).toBe(false)
    f.unmount()
  })

  it.each(['resolve', 'reject'] as const)('ignores an older latest-summary %s after a newer event', async settlement => {
    const f = fixture()
    const old = deferred<unknown>()
    f.latestWorkspaceChanges.mockReturnValueOnce(old.promise)
    f.execute()
    f.latestWorkspaceChanges.mockResolvedValueOnce(ok(latest))
    f.events([{ type: 'event', event: { type: 'workspace/changes', seq: 8 } }])
    await tick()
    if (settlement === 'resolve') old.resolve(ok(null))
    else old.reject(new Error('old latest'))
    await tick()
    expect(items(f.view())).toHaveLength(3)
    expect(f.notice.set).not.toHaveBeenCalled()
    f.unmount()
  })

  it('ignores late capability and summary reads after closure, including late failures', async () => {
    const f = fixture()
    const capability = deferred<unknown>()
    const changes = deferred<unknown>()
    f.canOpenWorkspacePath.mockReturnValueOnce(capability.promise)
    f.latestWorkspaceChanges.mockReturnValueOnce(changes.promise)
    f.execute()
    f.unmount()
    capability.resolve(ok(true))
    changes.reject(new Error('old changes'))
    await tick()
    expect(f.notice.set).not.toHaveBeenCalled()
  })

  it.each(['copy', 'open', 'preview'] as const)('does not acknowledge a late %s result after selection replacement', async action => {
    const f = fixture()
    f.execute()
    await tick()
    const pending = deferred<unknown>()
    if (action === 'copy') f.copy.mockReturnValueOnce(pending.promise as Promise<void>)
    else if (action === 'open') f.openWorkspacePath.mockReturnValueOnce(pending.promise)
    else f.deliveredFile.mockReturnValueOnce(pending.promise)
    const result = f.activate(action)
    await f.select('4/1')
    pending.resolve(ok({ path: '/late', displayPath: '/late', fileType: 'file', preview: 'late preview' }))
    expect(await result).toEqual({ kind: 'cancelled' })
    await tick()
    expect(contains(f.view(), 'late preview')).toBe(false)
    f.unmount()
  })

  it('returns cancellation when a failing clipboard continuation belongs to an aborted action', async () => {
    const f = fixture()
    f.execute()
    await tick()
    const pending = deferred<void>()
    f.copy.mockReturnValueOnce(pending.promise)
    const caller = new AbortController()
    const result = f.activate('copy', caller.signal)
    caller.abort()
    pending.reject(new Error('retired'))
    expect(await result).toEqual({ kind: 'cancelled' })
    f.unmount()
  })

  it('survives an already closed overlay and refuses capture after concurrent Host detach', async () => {
    const f = fixture({ closeOnOpen: true })
    f.execute()
    await tick()
    f.unmount()
    const detached = fixture()
    const selected = detached.current()
    detached.detach()
    detached.selection(selected)
    detached.execute()
    expect(detached.deliveredFile).not.toHaveBeenCalled()
    detached.unmount()
  })
})
