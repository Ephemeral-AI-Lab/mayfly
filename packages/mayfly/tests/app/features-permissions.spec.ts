import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyPermissionSpec } from '@ephemeral-ai/mayfly-host/types'
import { RemotePermissionsController, remotePermissionSelection, type RemotePermissionDetailSource } from '../../src/app/features/permissions.ts'
import type { RemoteSettingsController } from '../../src/app/features/settings.ts'
import { configurationFixture, deferred, namespace, permissionCatalog } from './configuration-fixture.ts'
const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../../src/app/panels/browser.ts', () => ({ openRemoteBrowser: mocks.open }))
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function fixture(options: Parameters<typeof configurationFixture>[1] & { readonly withSource?: boolean } = {}) {
  const test = configurationFixture(mocks.open, options)
  const execute = vi.fn(async (): Promise<unknown> => ({ ok: true, value: { result: { kind: 'success' } } }))
  Object.assign(test.client.remote, { commands: { execute } })
  const settings = { revision: vi.fn(() => ({ descriptor: 7, fields: 'revision' })), mutate: vi.fn(async () => ({})) }
  const specs: Record<string, MayflyPermissionSpec> = {
    safe: { sandbox: 'read-only', approval: 'ask' }, review: { sandbox: 'danger-full-access', approval: 'ask' },
    unrestricted: { sandbox: 'danger-full-access', approval: 'never' },
  }
  const source: RemotePermissionDetailSource = { resolve: vi.fn(async () => ({ yolo: false,
    spec: (value: string) => specs[value], detail: (value: string) => specs[value] === undefined ? undefined : `sandbox ${specs[value].sandbox} · approval ${specs[value].approval}`,
  })) }
  const controller = new RemotePermissionsController(test.context, settings as unknown as RemoteSettingsController, options.withSource === false ? undefined : source)
  cleanups.push(() => { controller.dispose(); test.dispose() })
  return { ...test, execute, settings, source, specs, controller }
}

describe('Remote permission reference UI', () => {
  it('keeps readonly permission browsing but refuses direct and picker writes', async () => {
    const test = fixture()
    test.select({ ...test.selection, access: 'readonly' })
    await expect(test.controller.select(test.selection.ref, 'review')).rejects.toThrow('read-only')
    await test.controller.open()
    expect(test.render()).toContain('Permissions')
    expect(await test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['review'] })).toMatchObject({ kind: 'failed', message: expect.stringContaining('read-only') })
    expect(test.execute).not.toHaveBeenCalled()
    expect(test.settings.mutate).not.toHaveBeenCalled()
  })

  it('retires a pending permission write when access becomes readonly during catalog discovery', async () => {
    const test = fixture()
    const gate = deferred<unknown>()
    test.catalog.mockReturnValueOnce(gate.promise)
    const pending = test.controller.select(test.selection.ref, 'review')
    test.select({ ...test.selection, access: 'readonly' })
    gate.resolve({ ok: true, value: permissionCatalog() })
    await pending
    expect(test.execute).not.toHaveBeenCalled()
  })
  it('retires the command caller across catalog discovery and mounted permission actions', async () => {
    const test = fixture()
    const cancelled = new AbortController(); cancelled.abort()
    await test.controller.open(cancelled.signal)
    expect(test.catalog).not.toHaveBeenCalled()
    const pending = deferred<unknown>()
    test.catalog.mockReturnValueOnce(pending.promise)
    const reading = new AbortController()
    const opening = test.controller.open(reading.signal)
    reading.abort()
    pending.resolve({ ok: true, value: permissionCatalog() })
    await opening
    expect(test.opened).toHaveLength(0)
    expect(test.notice.set).not.toHaveBeenCalled()
    const mounted = new AbortController()
    await test.controller.open(mounted.signal)
    mounted.abort()
    expect(test.opened[0]!.panel.closed).toBe(true)
    expect(test.projectionListeners.size).toBe(0)
    expect(await test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['review'] })).toMatchObject({ kind: 'cancelled' })
    expect(test.execute).not.toHaveBeenCalled()
  })

  it('retains a wizard caller through nested Session permission discovery', async () => {
    const test = fixture()
    const cancelled = new AbortController(); cancelled.abort()
    await test.controller.select(test.selection.ref, 'review', cancelled.signal)
    expect(test.catalog).not.toHaveBeenCalled()
    const gate = deferred<unknown>()
    test.catalog.mockReturnValueOnce(gate.promise)
    const caller = new AbortController()
    const selecting = test.controller.select(test.selection.ref, 'review', caller.signal)
    caller.abort(); gate.resolve({ ok: true, value: permissionCatalog() })
    await selecting
    expect(test.execute).not.toHaveBeenCalled()
    expect(test.notice.set).not.toHaveBeenCalled()
  })

  it('reads only native string selection and catalogs an attached Host without a Session', async () => {
    expect(remotePermissionSelection({ currentValue: 'safe' })).toBe('safe')
    for (const value of [undefined, null, {}, { currentValue: 42 }, 'safe']) expect(remotePermissionSelection(value)).toBeUndefined()
    const test = fixture({ session: false })
    await expect(test.controller.catalog()).resolves.toEqual(permissionCatalog())
    test.detach()
    await expect(test.controller.catalog()).resolves.toBeUndefined()
  })

  it('opens the exact numbered shared decision lane with native consequences and confirmations', async () => {
    const test = fixture()
    await test.controller.open()
    expect(test.browser()).toMatchObject({ id: 'mayfly.permission', scope: { kind: 'app', targetId: 'permission' } })
    const wire = test.render()
    expect(wire).toContain('sandbox read-only · approval ask')
    expect(wire).toContain('Enable Full access?')
    expect(wire).toContain('Requests that still require approval will be rejected without prompting.')
    expect(wire).toContain('Requests that require approval will still prompt.')
    expect(wire).toContain('"numbered":true')
    expect(wire).toContain('"selectedIds":["safe"]')
    expect(test.execute).not.toHaveBeenCalled()
    test.locale.setPreference('zh')
    expect(test.render()).toContain('权限')
    expect(test.render()).toContain('启用 Full access？')
  })

  it('shows derived custom as disabled and follows the exact Session projection', async () => {
    const test = fixture()
    await test.controller.open()
    test.project({ currentValue: 'custom' })
    expect(test.render()).toContain('custom is the derived state — pick a preset')
    expect(test.render()).toContain('"selectedIds":[]')
    expect(test.render()).toContain('"disabled":true')
    expect(test.opened[0]!.refresh).toHaveBeenCalledOnce()
  })

  it('commits one structured selection and dismisses only after the native command succeeds', async () => {
    const test = fixture()
    await test.controller.open()
    expect(await test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['review'] })).toEqual({ kind: 'completed', dismiss: true })
    expect(test.execute).toHaveBeenCalledExactlyOnceWith(test.selection.ref.sessionId, '/permission review', [], expect.any(AbortSignal))
    expect(test.command).not.toHaveBeenCalled()
    expect(test.notice.set).toHaveBeenCalledWith('Permission preset: Review', 'success')
    expect(test.settings.mutate).not.toHaveBeenCalled()
  })

  it('keeps a failed command visible, ignores unrelated actions, and refuses unknown presets', async () => {
    const test = fixture()
    await test.controller.open()
    test.execute.mockResolvedValueOnce({ ok: false, error: { message: 'gone' } })
    expect(await test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['safe'] })).toEqual({ kind: 'failed', message: 'permission dispatch failed: gone' })
    expect(test.notice.set).toHaveBeenCalledExactlyOnceWith('permission dispatch failed: gone', 'error')
    expect(await test.act({ kind: 'selection-accept', controlId: 'other', selectedIds: ['safe'] })).toEqual({ kind: 'completed' })
    expect(await test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['custom'] })).toEqual({ kind: 'completed' })
    expect(test.execute).toHaveBeenCalledOnce()
    await expect(test.controller.select(test.selection.ref, 'missing')).rejects.toThrow('permission command is unavailable')
    test.execute.mockResolvedValueOnce({ ok: true, value: undefined })
    await expect(test.controller.select(test.selection.ref, 'safe')).rejects.toThrow('permission command is unavailable')
  })

  it('writes the default setting with captured revisions when no Session exists', async () => {
    const test = fixture({ session: false, namespaces: [namespace('permission')] })
    await test.controller.open()
    expect(await test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['review'] })).toMatchObject({ kind: 'completed', dismiss: true })
    expect(test.settings.mutate).toHaveBeenCalledWith(test.client, 'permission', [{ op: 'set', path: ['defaultPreset'], value: 'review' }], { descriptor: 7, fields: 'revision' }, expect.any(AbortSignal))
    expect(test.execute).not.toHaveBeenCalled()
  })

  it('fences a delayed catalog before dispatch after exact binding replacement or abort', async () => {
    const test = fixture()
    await test.controller.open()
    const pending = deferred<unknown>()
    test.catalog.mockReturnValueOnce(pending.promise)
    const action = test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['review'] })
    test.select({ ...test.selection, binding: {} } as typeof test.selection)
    pending.resolve({ ok: true, value: permissionCatalog() })
    expect(await action).toMatchObject({ kind: 'cancelled' })
    expect(test.execute).not.toHaveBeenCalled()
    expect(test.notice.set).not.toHaveBeenCalled()
    expect(test.opened[0]!.close).toHaveBeenCalled()
  })

  it('does not dispatch when the structured action aborts during catalog validation', async () => {
    const test = fixture()
    await test.controller.open()
    const pending = deferred<unknown>()
    test.catalog.mockReturnValueOnce(pending.promise)
    const abort = new AbortController()
    const selecting = test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['review'] }, abort.signal)
    abort.abort()
    pending.resolve({ ok: true, value: permissionCatalog() })
    expect(await selecting).toMatchObject({ kind: 'cancelled' })
    expect(test.execute).not.toHaveBeenCalled()
  })

  it('drops late opens and retired catalog refreshes, releases every listener, and opens no default without its namespace', async () => {
    const test = fixture()
    const pending = deferred<unknown>()
    test.catalog.mockReturnValueOnce(pending.promise)
    const opening = test.controller.open()
    test.reconnect()
    pending.resolve({ ok: true, value: permissionCatalog() })
    await opening
    expect(test.opened).toHaveLength(0)
    await test.controller.open()
    const earlier = deferred<unknown>()
    test.catalog.mockReturnValueOnce(earlier.promise)
    test.emit('permission-presets/catalog-changed')
    test.catalog.mockResolvedValueOnce({ ok: true, value: { ...permissionCatalog(), options: [] } })
    test.emit('permission-presets/catalog-changed')
    await vi.waitFor(() => { expect(test.render()).not.toContain('Full access') })
    earlier.resolve({ ok: true, value: permissionCatalog() })
    await Promise.resolve(); await Promise.resolve()
    expect(test.render()).not.toContain('Full access')
    test.controller.dispose()
    expect(test.projectionListeners.size).toBe(0)
    expect(test.events.get('permission-presets/catalog-changed')?.size).toBe(0)
    await test.controller.open()
    expect(test.opened).toHaveLength(1)
    const empty = fixture({ session: false })
    await empty.controller.open()
    expect(empty.opened).toHaveLength(0)
  })

  it('refuses missing or foreign Session scopes and catalogs retired Host generations without publishing late reads', async () => {
    const test = fixture()
    const pending = deferred<unknown>()
    test.catalog.mockReturnValueOnce(pending.promise)
    const reading = test.controller.catalog(test.selection)
    test.reconnect()
    pending.resolve({ ok: true, value: permissionCatalog() })
    expect(await reading).toBeUndefined()
    await test.controller.select({ ...test.selection.ref, sessionId: 'foreign' as typeof test.selection.ref.sessionId }, 'safe')
    await test.controller.select({ ...test.selection.ref, host: 'foreign' as typeof test.selection.ref.host }, 'safe')
    test.select(undefined)
    await test.controller.select(test.selection.ref, 'safe')
    test.detach()
    await test.controller.open()
    expect(await test.controller.catalog(test.selection)).toBeUndefined()
    expect(test.execute).not.toHaveBeenCalled()
    expect(test.opened).toEqual([])
    const disposed = fixture()
    disposed.controller.dispose()
    expect(await disposed.controller.catalog()).toBeUndefined()
    await disposed.controller.select(disposed.selection.ref, 'safe')
    expect(disposed.execute).not.toHaveBeenCalled()
  })

  it('keeps native-only options when optional consequences are unavailable or fail to load', async () => {
    const bare = fixture({ withSource: false })
    await bare.controller.open()
    expect(bare.render()).not.toContain('sandbox read-only')
    expect(bare.render()).not.toContain('confirmLabel')
    bare.project(undefined)
    expect(bare.render()).toContain('"selectedIds":[]')
    const failed = fixture()
    vi.mocked(failed.source.resolve).mockRejectedValueOnce(new Error('optional spec unavailable'))
    await failed.controller.open()
    expect(failed.render()).not.toContain('sandbox read-only')
    expect(failed.notice.set).not.toHaveBeenCalled()
  })

  it('reports only current opening failures and leaves stale catalog errors silent', async () => {
    const test = fixture()
    test.catalog.mockRejectedValueOnce(new Error('current catalog failed'))
    await test.controller.open()
    expect(test.notice.set).toHaveBeenCalledExactlyOnceWith('current catalog failed', 'error')
    const pending = Promise.withResolvers<unknown>()
    test.catalog.mockReturnValueOnce(pending.promise)
    const opening = test.controller.open()
    test.reconnect()
    pending.reject(new Error('retired catalog failed'))
    await opening
    expect(test.notice.set).toHaveBeenCalledOnce()
    expect(test.opened).toEqual([])
  })

  it('rejects cancelled actions before any native read and ignores missing selections and unrelated events', async () => {
    const test = fixture()
    await test.controller.open()
    expect(test.browser().isCurrent!()).toBe(true)
    expect(await test.act({ kind: 'activate', controlId: 'permissions' })).toEqual({ kind: 'completed' })
    expect(await test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: [] })).toEqual({ kind: 'completed' })
    const cancelled = new AbortController(); cancelled.abort()
    expect(await test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['safe'] }, cancelled.signal)).toEqual({ kind: 'cancelled', dismiss: true })
    expect(test.catalog).toHaveBeenCalledOnce()
    const notify = [...test.projectionListeners][0]!
    test.opened[0]!.close()
    notify()
    expect(test.browser().isCurrent!()).toBe(false)
    expect(await test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['safe'] })).toEqual({ kind: 'cancelled', dismiss: true })
    expect(test.execute).not.toHaveBeenCalled()
  })

  it.each([false, true])('fences a native permission command settling after reconnect (reject=%s)', async rejected => {
    const test = fixture()
    await test.controller.open()
    const response = Promise.withResolvers<unknown>()
    test.execute.mockReturnValueOnce(response.promise)
    const action = test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['review'] })
    await vi.waitFor(() => { expect(test.execute).toHaveBeenCalledOnce() })
    test.reconnect()
    if (rejected) response.reject(new Error('obsolete permission result'))
    else response.resolve({ ok: true, value: { result: { kind: 'success' } } })
    expect(await action).toEqual({ kind: 'cancelled', dismiss: true })
    expect(test.notice.set).not.toHaveBeenCalled()
  })

  it('refreshes native default options and its selected preset without retaining a Session', async () => {
    const test = fixture({ session: false, namespaces: [namespace('permission')] })
    await test.controller.open()
    test.catalog.mockResolvedValueOnce({ ok: true, value: { ...permissionCatalog(), defaultPreset: 'review', defaultOptions: permissionCatalog().options.slice(1) } })
    test.emit('permission-presets/catalog-changed')
    await vi.waitFor(() => { expect(test.opened[0]!.refresh).toHaveBeenCalledOnce() })
    expect(test.render()).toContain('"selectedIds":["review"]')
    expect(test.render()).not.toContain('"id":"safe"')
    test.settings.mutate.mockRejectedValueOnce(new Error('native settings conflict'))
    expect(await test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['review'] })).toEqual({ kind: 'failed', message: 'permission dispatch failed: native settings conflict' })
    expect(test.settings.revision).toHaveBeenCalledWith(expect.objectContaining({ ns: 'permission' }), true)
    expect(test.execute).not.toHaveBeenCalled()
  })

  it('surfaces current refresh failures and rejects errors from older refreshes or closed panels', async () => {
    const test = fixture()
    await test.controller.open()
    const pending = Promise.withResolvers<unknown>()
    test.catalog.mockReturnValueOnce(pending.promise)
    test.emit('permission-presets/catalog-changed')
    test.emit('permission-presets/catalog-changed')
    await vi.waitFor(() => { expect(test.opened[0]!.refresh).toHaveBeenCalledOnce() })
    pending.reject(new Error('obsolete refresh failed'))
    await Promise.resolve(); await Promise.resolve()
    expect(test.notice.set).not.toHaveBeenCalled()
    test.catalog.mockRejectedValueOnce(new Error('current refresh failed'))
    test.emit('permission-presets/catalog-changed')
    await vi.waitFor(() => { expect(test.notice.set).toHaveBeenCalledWith('current refresh failed', 'error') })
    const retired = Promise.withResolvers<unknown>()
    test.catalog.mockReturnValueOnce(retired.promise)
    test.emit('permission-presets/catalog-changed')
    test.opened[0]!.close()
    retired.reject(new Error('closed refresh failed'))
    await Promise.resolve(); await Promise.resolve()
    expect(test.notice.set).toHaveBeenCalledOnce()
  })

  it('uses the full native outcome to refuse preset errors and never publishes success from an ACK', async () => {
    const test = fixture()
    await test.controller.open()
    for (const text of ['native preset refused', undefined]) {
      test.execute.mockResolvedValueOnce({ ok: true, value: { result: { kind: 'error', ...text === undefined ? {} : { text } } } })
      const message = `permission dispatch failed: ${text ?? 'permission command is unavailable'}`
      expect(await test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['safe'] })).toEqual({ kind: 'failed', message })
      expect(test.notice.set).toHaveBeenLastCalledWith(message, 'error')
    }
    expect(test.notice.set).toHaveBeenCalledTimes(2)
    expect(test.command).not.toHaveBeenCalled()
    expect(test.opened[0]!.panel.closed).toBe(false)
  })

  it.each([false, true])('retires a pending native command after action cancellation (reject=%s)', async reject => {
    const test = fixture()
    await test.controller.open()
    const pending = Promise.withResolvers<unknown>()
    test.execute.mockReturnValueOnce(pending.promise)
    const caller = new AbortController()
    const action = test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['safe'] }, caller.signal)
    await vi.waitFor(() => { expect(test.execute).toHaveBeenCalledOnce() })
    const signal = (test.execute.mock.calls[0] as unknown as readonly unknown[])[3] as AbortSignal
    caller.abort()
    expect(signal.aborted).toBe(true)
    if (reject) pending.reject(new Error('caller cancelled'))
    else pending.resolve({ ok: true, value: { result: { kind: 'success' } } })
    expect(await action).toEqual({ kind: 'cancelled', dismiss: true })
    expect(test.notice.set).not.toHaveBeenCalled()
  })
})
