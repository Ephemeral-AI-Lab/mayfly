import Schema from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostClient } from '../../src/client/types.ts'
import type { RemoteSettingsController } from '../../src/remote/features/settings.ts'
import { RemotePreferencesController } from '../../src/remote/features/preferences.ts'
import { resolveMayflySettings } from '@ephemeral-ai/mayfly/settings'
import { configurationFixture, deferred, namespace, schemaJson } from './configuration-fixture.ts'
const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../../src/remote/panels/browser.ts', () => ({ openRemoteBrowser: mocks.open }))
const cleanups: (() => void)[] = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
function fixture() {
  const test = configurationFixture(mocks.open, { namespaces: [namespace(), namespace('locale')] })
  const settings = { revision: vi.fn(() => ({ descriptor: 7, fields: 'fields' })), mutate: vi.fn(async () => namespace()) }
  const controller = new RemotePreferencesController(test.context, settings as unknown as RemoteSettingsController)
  cleanups.push(() => { controller.dispose(); test.dispose() })
  return { ...test, settings, controller }
}

describe('Remote reference theme and language pickers', () => {
  it('uses exact shared wire names/groups and preserves the picker across presentation refresh', async () => {
    const test = fixture()
    test.controller.openTheme()
    expect(test.browser()).toMatchObject({ id: 'mayfly.theme', scope: { kind: 'app', targetId: 'theme' } })
    expect(test.render()).toContain('Select a theme')
    expect(test.render()).toContain('"id":"themes"')
    expect(test.render()).toContain('Mayfly Dark')
    expect(test.render()).toContain('the default violet')
    expect(test.render()).toContain('"selectedIds":["dark"]')
    expect(await test.act({ kind: 'selection-accept', controlId: 'themes', selectedIds: ['tide'] })).toMatchObject({ kind: 'completed', dismiss: true })
    expect(test.presentation.applyTheme).toHaveBeenCalledExactlyOnceWith('tide')
    expect(test.settings.mutate).toHaveBeenCalledWith(test.client, 'mayfly', [{ op: 'set', path: ['theme'], value: 'tide' }], { descriptor: 7, fields: 'fields' }, expect.any(AbortSignal))
    expect(test.opened[0]!.refresh).toHaveBeenCalled()
    test.opened[0]!.close()
    expect(test.presentationListeners.size).toBe(0)
  })

  it('uses native language labels, applies immediately, and persists both native namespaces', async () => {
    const test = fixture()
    test.controller.openLocale()
    expect(test.browser()).toMatchObject({ id: 'mayfly.language', scope: { kind: 'app', targetId: 'language' } })
    expect(test.render()).toContain('English')
    expect(test.render()).toContain('简体中文')
    expect(await test.act({ kind: 'selection-accept', controlId: 'languages', selectedIds: ['zh'] })).toMatchObject({ kind: 'completed', dismiss: true })
    expect(test.presentation.setLocale).toHaveBeenCalledWith('zh')
    expect(test.settings.mutate.mock.calls).toEqual([
      [test.client, 'mayfly', [{ op: 'set', path: ['language'], value: 'zh' }], { descriptor: 7, fields: 'fields' }, expect.any(AbortSignal)],
      [test.client, 'locale', [{ op: 'set', path: ['preference'], value: 'zh' }], { descriptor: 7, fields: 'fields' }, expect.any(AbortSignal)],
    ])
  })

  it('keeps local choices working with zero Hosts and refuses stale action or unknown rows', async () => {
    const test = fixture()
    test.detach()
    test.controller.openTheme()
    expect(await test.act({ kind: 'selection-accept', controlId: 'themes', selectedIds: ['light'] })).toMatchObject({ kind: 'completed', dismiss: true })
    expect(test.settings.mutate).not.toHaveBeenCalled()
    expect(await test.act({ kind: 'selection-accept', controlId: 'themes', selectedIds: ['unknown'] })).toMatchObject({ kind: 'failed' })
    expect(await test.act({ kind: 'selection-accept', controlId: 'themes', selectedIds: ['light'] })).toMatchObject({ kind: 'completed', dismiss: true })
    test.controller.openLocale()
    expect(await test.act({ kind: 'selection-accept', controlId: 'languages', selectedIds: ['unknown'] })).toMatchObject({ kind: 'failed' })
    expect(await test.act({ kind: 'activate', actionId: 'other' })).toEqual({ kind: 'completed' })
    const abort = new AbortController(); abort.abort()
    expect(await test.act({ kind: 'selection-accept', controlId: 'languages', selectedIds: ['zh'] }, abort.signal)).toMatchObject({ kind: 'cancelled' })
  })

  it('preserves a local pick on persistence failure and reports the missing Host schema honestly', async () => {
    const test = fixture()
    test.settings.mutate.mockRejectedValueOnce(new Error('Host refused write'))
    test.controller.openTheme()
    expect(await test.act({ kind: 'selection-accept', controlId: 'themes', selectedIds: ['light'] })).toEqual({ kind: 'failed', message: 'Host refused write' })
    expect(test.presentation.snapshot.theme).toBe('light')
    test.setSettings({ writable: true, hasDocument: true, namespaces: [] })
    await test.controller.applyTheme(test.client, 'tide')
    expect(test.notice.set).toHaveBeenCalledWith(expect.stringContaining('mayfly-host must register'))
    expect(test.presentation.snapshot.theme).toBe('tide')
  })

  it('drops persistence when the picker action aborts during the native describe read', async () => {
    const test = fixture()
    const pending = deferred<unknown>()
    test.describe.mockReturnValueOnce(pending.promise)
    test.controller.openTheme()
    const abort = new AbortController()
    const applying = test.act({ kind: 'selection-accept', controlId: 'themes', selectedIds: ['tide'] }, abort.signal)
    await vi.waitFor(() => { expect(test.describe).toHaveBeenCalledOnce() })
    abort.abort()
    pending.resolve({ ok: true, value: { writable: true, namespaces: [namespace()] } })
    expect(await applying).toMatchObject({ kind: 'cancelled' })
    expect(test.settings.mutate).not.toHaveBeenCalled()
  })

  it('retires open pickers and late writes on Host switch and controller unload', async () => {
    const test = fixture()
    const pending = deferred<unknown>()
    test.describe.mockReturnValueOnce(pending.promise)
    test.controller.openLocale()
    const applying = test.act({ kind: 'selection-accept', controlId: 'languages', selectedIds: ['zh'] })
    test.select(undefined)
    const second = { ...test.client, key: 'host-b' } as HostClient
    test.active(second)
    pending.resolve({ ok: true, value: { writable: true, namespaces: [namespace(), namespace('locale')] } })
    expect(await applying).toMatchObject({ kind: 'cancelled' })
    expect(test.settings.mutate).not.toHaveBeenCalled()
    test.controller.dispose()
    const count = test.opened.length
    test.controller.openTheme()
    test.controller.openLocale()
    await test.controller.applyTheme(undefined, 'dark')
    await test.controller.applyLocale(undefined, 'en')
    expect(test.opened).toHaveLength(count)
    expect(test.presentationListeners.size).toBe(0)
  })
})

describe('Host settings to Frontend readonly presentation bridge', () => {
  it('applies the selected Host source, key preferences, locale, and live theme without writes', async () => {
    const test = fixture()
    test.setSettings({ writable: true, hasDocument: true, namespaces: [namespace('mayfly', { schema: schemaJson(Schema.object({ theme: Schema.string() })), value: { language: 'zh', theme: 'tide', quietHints: 'off', glyphs: 'ascii', preferPlainKeys: true, keybindings: { 'ui.copy': { keys: ['ctrl+k'] } } } })] })
    await test.controller.applyHostPreferences(test.client)
    expect(test.interactionState.settingsSource()).toMatchObject({ language: 'zh', theme: 'tide', quietHints: 'off', glyphs: 'ascii' })
    expect(test.ctx.emit).toHaveBeenCalledWith('mayfly/settings-source-ready', test.interactionState.settingsSource())
    expect(test.keymap.setPreferPlain).toHaveBeenCalledWith(true)
    expect(test.keymap.applyOverrides).toHaveBeenCalledWith({ 'ui.copy': { keys: ['ctrl+k'] } })
    expect(test.presentation.applyTheme).toHaveBeenCalledWith('tide')
    expect(test.presentation.setLocale).toHaveBeenCalledWith('zh')
    expect(test.settings.mutate).not.toHaveBeenCalled()
  })

  it('reloads the existing palette only when glyph/monochrome/motion presentation changes', async () => {
    const test = fixture()
    test.interactionState.settingsSource = () => resolveMayflySettings({ theme: 'dark' })
    test.setSettings({ writable: true, hasDocument: true, namespaces: [namespace('mayfly', { value: { theme: 'dark', glyphs: 'ascii', monochrome: true, reducedMotion: true } })] })
    await test.controller.applyHostPreferences(test.client)
    expect(test.presentation.reloadTheme).toHaveBeenCalledOnce()
    await test.controller.applyHostPreferences(test.client)
    expect(test.presentation.reloadTheme).toHaveBeenCalledOnce()
    await test.controller.reloadLocalPresentation()
    expect(test.presentation.reloadTheme).toHaveBeenCalledTimes(2)
  })

  it('drops background Hosts, older reads, reconnect answers, and results after disposal', async () => {
    const test = fixture()
    const old = deferred<unknown>()
    test.describe.mockReturnValueOnce(old.promise)
    const pending = test.controller.applyHostPreferences(test.client)
    test.setSettings({ writable: true, hasDocument: true, namespaces: [namespace('mayfly', { value: { theme: 'light' } })] })
    await test.controller.applyHostPreferences(test.client)
    old.resolve({ ok: true, value: { writable: true, namespaces: [namespace('mayfly', { value: { theme: 'tide' } })] } })
    await pending
    expect(test.presentation.applyTheme).toHaveBeenCalledExactlyOnceWith('light')
    const background = { ...test.client, key: 'host-b' } as HostClient
    test.active(background)
    const calls = test.describe.mock.calls.length
    await test.controller.applyHostPreferences(background)
    expect(test.describe.mock.calls.length).toBe(calls)
    const stale = deferred<unknown>()
    test.describe.mockReturnValueOnce(stale.promise)
    const late = test.controller.applyHostPreferences(test.client)
    test.reconnect()
    stale.resolve({ ok: true, value: { writable: true, namespaces: [namespace('mayfly', { value: { theme: 'tide' } })] } })
    await late
    expect(test.presentation.applyTheme).toHaveBeenCalledOnce()
    test.controller.dispose()
    await test.controller.applyHostPreferences(test.client)
    expect(test.describe.mock.calls.length).toBe(calls + 1)
  })
})
