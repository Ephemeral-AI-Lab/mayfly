import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MayflyPermissionSpec } from '@ephemeral-ai/mayfly-host/types'
import { RemotePermissionsController, remotePermissionSelection, type RemotePermissionDetailSource } from '../../src/remote/features/permissions.ts'
import type { RemoteSettingsController } from '../../src/remote/features/settings.ts'
import { configurationFixture, deferred, namespace, permissionCatalog } from './configuration-fixture.ts'
const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: mocks.open }))
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })

function fixture(options: Parameters<typeof configurationFixture>[1] = {}) {
  const test = configurationFixture(mocks.open, options)
  const settings = { revision: vi.fn(() => ({ descriptor: 7, fields: 'revision' })), mutate: vi.fn(async () => ({})) }
  const specs: Record<string, MayflyPermissionSpec> = {
    safe: { sandbox: 'read-only', approval: 'ask' }, review: { sandbox: 'danger-full-access', approval: 'ask' },
    unrestricted: { sandbox: 'danger-full-access', approval: 'never' },
  }
  const source: RemotePermissionDetailSource = { resolve: vi.fn(async () => ({ yolo: false,
    spec: (value: string) => specs[value], detail: (value: string) => specs[value] === undefined ? undefined : `sandbox ${specs[value].sandbox} · approval ${specs[value].approval}`,
  })) }
  const controller = new RemotePermissionsController(test.context, settings as unknown as RemoteSettingsController, source)
  cleanups.push(() => { controller.dispose(); test.dispose() })
  return { ...test, settings, source, specs, controller }
}

describe('Remote permission reference UI', () => {
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
    expect(test.command).not.toHaveBeenCalled()
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
    expect(test.command).toHaveBeenCalledExactlyOnceWith('/permission review')
    expect(test.notice.set).toHaveBeenCalledWith('Permission preset: Review')
    expect(test.settings.mutate).not.toHaveBeenCalled()
  })

  it('keeps a failed command visible, ignores unrelated actions, and refuses unknown presets', async () => {
    const test = fixture()
    await test.controller.open()
    test.command.mockResolvedValueOnce({ ok: false, error: { message: 'gone' } })
    expect(await test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['safe'] })).toEqual({ kind: 'failed', message: 'gone' })
    expect(await test.act({ kind: 'selection-accept', controlId: 'other', selectedIds: ['safe'] })).toEqual({ kind: 'completed' })
    expect(await test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['custom'] })).toEqual({ kind: 'completed' })
    expect(test.command).toHaveBeenCalledOnce()
    await expect(test.controller.select(test.selection.ref, 'missing')).rejects.toThrow('permission command is unavailable')
    test.command.mockResolvedValueOnce({ ok: true, value: { matched: false } })
    await expect(test.controller.select(test.selection.ref, 'safe')).rejects.toThrow('permission command is unavailable')
  })

  it('writes the default setting with captured revisions when no Session exists', async () => {
    const test = fixture({ session: false, namespaces: [namespace('permission')] })
    await test.controller.open()
    expect(await test.act({ kind: 'selection-accept', controlId: 'permissions', selectedIds: ['review'] })).toMatchObject({ kind: 'completed', dismiss: true })
    expect(test.settings.mutate).toHaveBeenCalledWith(test.client, 'permission', [{ op: 'set', path: ['defaultPreset'], value: 'review' }], { descriptor: 7, fields: 'revision' }, expect.any(AbortSignal))
    expect(test.command).not.toHaveBeenCalled()
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
    expect(test.command).not.toHaveBeenCalled()
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
    expect(test.command).not.toHaveBeenCalled()
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
})
