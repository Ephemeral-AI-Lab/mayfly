import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RemoteSettingsController } from '../../src/remote/features/settings.ts'
import { RemoteAgentPresetsController, remoteAgentPresetSelection } from '../../src/remote/features/presets.ts'
import { configurationFixture, deferred, namespace } from './configuration-fixture.ts'
const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: mocks.open }))
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function fixture(options: Parameters<typeof configurationFixture>[1] = {}) {
  const test = configurationFixture(mocks.open, options)
  const roster = { presets: [{ id: 'first', name: 'First', isDefault: true }, { id: 'second', description: 'Other', isDefault: false }, { id: 'broken', broken: 'cannot load', isDefault: false }] }
  test.presets.mockResolvedValue({ ok: true, value: roster })
  const select = vi.fn(async (_id: string, preset: string): Promise<unknown> => ({ ok: true, value: preset }))
  const read = vi.fn(async (): Promise<unknown> => ({ ok: true, value: { agentPreset: 'first', content: 'plugins:\n  dsh: {}' } }))
  Object.assign(test.client.remote.agentPresets, { select, read })
  const settings = { revision: vi.fn(() => ({ descriptor: 7, fields: 'fields' })), mutate: vi.fn(async () => namespace()) }
  const controller = new RemoteAgentPresetsController(test.context, settings as unknown as RemoteSettingsController)
  cleanups.push(() => { controller.dispose(); test.dispose() })
  return { ...test, roster, settings, selectPreset: select, readPreset: read, controller }
}

describe('Remote reference Agent preset surface', () => {
  it('parses only native projection values and uses the exact shared filterable roster', async () => {
    expect(remoteAgentPresetSelection(null)).toBeNull()
    expect(remoteAgentPresetSelection('first')).toBe('first')
    expect(remoteAgentPresetSelection({ id: 'first' })).toBeUndefined()
    const test = fixture()
    test.project('first')
    await test.controller.open()
    expect(test.browser().id).toBe('mayfly.presets')
    expect(test.render()).toContain('"id":"presets"')
    expect(test.render()).toContain('"filterMode":"slash"')
    expect(test.render()).toContain('"selectedIds":["first"]')
    expect(test.render()).toContain('"disabledReason":"cannot load"')
    test.project('second')
    expect(test.render()).toContain('"selectedIds":["second"]')
    expect(test.opened[0]!.refresh).toHaveBeenCalledOnce()
  })

  it('uses the exact native Session selector and acknowledges only confirmed results', async () => {
    const test = fixture()
    await test.controller.open()
    expect(await test.act({ kind: 'selection-accept', controlId: 'presets', selectedIds: ['second'] })).toMatchObject({ kind: 'accepted', source: [], dismiss: true })
    expect(test.selectPreset).toHaveBeenCalledWith(test.selection.ref.sessionId, 'second')
    expect(test.notice.set).toHaveBeenCalledWith('Preset switched to second')
    expect(await test.act({ kind: 'selection-accept', controlId: 'presets', selectedIds: ['broken'] })).toMatchObject({ kind: 'failed' })
    expect(test.selectPreset).toHaveBeenCalledOnce()
    expect(await test.controller.select(test.selection.ref, 'first')).toBe('first')
  })

  it('stores the next-Session default with native source revisions and display label', async () => {
    const test = fixture({ session: false, namespaces: [namespace('agent-preset-registry')] })
    await test.controller.open()
    expect(await test.act({ kind: 'selection-accept', controlId: 'presets', selectedIds: ['first'] })).toMatchObject({ kind: 'accepted', dismiss: true })
    expect(test.settings.mutate).toHaveBeenCalledWith(test.client, 'agent-preset-registry', [{ op: 'set', path: ['selectedDefault'], value: 'first' }], { descriptor: 7, fields: 'fields' }, expect.any(AbortSignal))
    expect(test.notice.set).toHaveBeenCalledWith('Default preset: First')
    expect(test.selectPreset).not.toHaveBeenCalled()
  })

  it('refreshes through native roster reads and drops retired late answers or actions', async () => {
    const test = fixture()
    await test.controller.open()
    test.presets.mockResolvedValueOnce({ ok: true, value: { presets: [] } })
    expect(await test.act({ kind: 'activate', actionId: 'refresh' })).toEqual({ kind: 'completed' })
    expect(test.render()).toContain('No presets composed')
    const late = deferred<unknown>()
    test.presets.mockReturnValueOnce(late.promise)
    const refreshing = test.act({ kind: 'activate', actionId: 'refresh' })
    test.reconnect()
    late.resolve({ ok: true, value: test.roster })
    expect(await refreshing).toMatchObject({ kind: 'cancelled' })
    expect(await test.act({ kind: 'selection-accept', controlId: 'presets', selectedIds: ['first'] })).toMatchObject({ kind: 'cancelled' })
    expect(test.selectPreset).not.toHaveBeenCalled()
    expect(test.projectionListeners.size).toBe(0)
  })

  it('keeps rejected native selection visible and fences late commits after binding replacement', async () => {
    const test = fixture()
    await test.controller.open()
    test.selectPreset.mockResolvedValueOnce({ ok: false, error: { code: 'agent-preset/locked', message: 'session has started' } })
    expect(await test.act({ kind: 'selection-accept', controlId: 'presets', selectedIds: ['first'] })).toEqual({ kind: 'failed', message: 'session has started' })
    const late = deferred<unknown>()
    test.selectPreset.mockReturnValueOnce(late.promise)
    const selecting = test.act({ kind: 'selection-accept', controlId: 'presets', selectedIds: ['first'] })
    test.select({ ...test.selection, binding: {} } as typeof test.selection)
    late.resolve({ ok: true, value: 'first' })
    expect(await selecting).toMatchObject({ kind: 'cancelled' })
    expect(test.notice.set).not.toHaveBeenCalled()
  })

  it('reads complete composition documents without creating an Agent and closes them on detach', async () => {
    const test = fixture()
    await expect(test.controller.list(test.client)).resolves.toEqual(test.roster)
    await expect(test.controller.read(test.client, 'first')).resolves.toMatchObject({ content: 'plugins:\n  dsh: {}' })
    await test.controller.openDocument(test.client, 'first')
    expect(test.render()).toContain('"kind":"code"')
    expect(test.render()).toContain('plugins:')
    test.detach()
    expect(test.opened[0]!.panel.closed).toBe(true)
    await expect(test.controller.list(test.client)).resolves.toBeUndefined()
    await expect(test.controller.read(test.client, 'first')).resolves.toBeUndefined()
  })
})
