import Schema from '@deepseek-ai/schemastery'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HostClient } from '../../src/client/types.ts'
import type { RemoteSettingsController } from '../../src/app/features/settings.ts'
import { RemotePreferencesController } from '../../src/app/features/preferences.ts'
import { resolveMayflySettings } from '../../src/settings.ts'
import { configurationFixture, deferred, namespace, schemaJson } from './configuration-fixture.ts'
const mocks = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('../../src/app/panels/browser.ts', () => ({ openRemoteBrowser: mocks.open }))
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
  it('binds both pickers to their caller with or without a Host and retains a focused picker owner', async () => {
    for (const host of [true, false]) {
      for (const name of ['theme', 'locale'] as const) {
        const test = fixture()
        if (!host) test.detach()
        const open = (signal: AbortSignal) => name === 'theme' ? test.controller.openTheme(undefined, signal) : test.controller.openLocale(undefined, signal)
        const cancelled = new AbortController(); cancelled.abort()
        open(cancelled.signal)
        expect(test.opened).toHaveLength(0)
        expect(test.ctx.mayflyOverlays.focus).not.toHaveBeenCalled()
        const owner = new AbortController()
        open(owner.signal)
        const first = test.opened[0]!
        test.ctx.mayflyOverlays.focus.mockReturnValueOnce(true)
        const second = new AbortController()
        open(second.signal)
        second.abort()
        expect(first.panel.closed).toBe(false)
        owner.abort()
        expect(first.panel.closed).toBe(true)
        expect(await test.act({ kind: 'selection-accept', controlId: name === 'theme' ? 'themes' : 'languages', selectedIds: [name === 'theme' ? 'tide' : 'zh'] })).toEqual({ kind: 'cancelled' })
        expect(test.presentation.applyTheme).not.toHaveBeenCalled()
        expect(test.presentation.setLocale).not.toHaveBeenCalled()
        expect(test.presentationListeners.size).toBe(0)
      }
    }
  })

  it('does not persist a language choice after its caller cancels during settings discovery', async () => {
    const test = fixture()
    const caller = new AbortController()
    const late = deferred<unknown>()
    test.describe.mockReturnValueOnce(late.promise)
    const pending = test.controller.applyLocale(test.client, 'zh', caller.signal)
    caller.abort()
    late.resolve({ ok: true, value: { writable: true, namespaces: [namespace(), namespace('locale')] } })
    await pending
    expect(test.settings.mutate).not.toHaveBeenCalled()
    expect(test.notice.set).not.toHaveBeenCalled()
  })

  it('keeps language and every onboarding default live when their independent Host writes fail', async () => {
    const test = fixture()
    test.settings.mutate.mockRejectedValue(new Error('Host store is readonly'))
    test.controller.openLocale()
    expect(await test.act({ kind: 'selection-accept', controlId: 'languages', selectedIds: ['zh'] })).toMatchObject({ kind: 'completed', dismiss: true })
    expect(test.presentation.snapshot.locale).toBe('zh')
    expect(test.settings.mutate.mock.calls.map(call => Reflect.get(call, 1))).toEqual(['mayfly', 'locale'])
    await test.controller.persistMayfly(test.client, [{ op: 'set', path: ['startup'], value: 'splash' }])
    expect(test.notice.set).toHaveBeenCalledWith('Host store is readonly')
    expect(test.settings.mutate).toHaveBeenCalledTimes(3)
  })

  it('skips readonly stores and missing optional locale descriptors while identifying a missing Mayfly schema', async () => {
    const test = fixture()
    test.setSettings({ writable: false, hasDocument: true, namespaces: [namespace(), namespace('locale')] })
    await test.controller.applyLocale(test.client, 'zh')
    expect(test.settings.mutate).not.toHaveBeenCalled()
    test.setSettings({ writable: true, hasDocument: true, namespaces: [] })
    await test.controller.applyLocale(test.client, 'en')
    expect(test.notice.set).toHaveBeenCalledOnce()
    expect(test.notice.set).toHaveBeenCalledWith(expect.stringContaining('mayfly-host must register'))
    expect(test.presentation.snapshot.locale).toBe('en')
  })

  it('handles wrong controls, missing rows, aborted scopes, presentation failures, and a disappearing selected palette', async () => {
    const test = fixture()
    test.presentation.snapshot.theme = 'custom'
    test.controller.openTheme()
    expect(test.render()).toContain('"selectedIds":[]')
    expect(await test.act({ kind: 'activate', actionId: 'other' })).toEqual({ kind: 'completed' })
    expect(await test.act({ kind: 'selection-accept', controlId: 'other', selectedIds: ['tide'] })).toEqual({ kind: 'completed' })
    expect(await test.act({ kind: 'selection-accept', controlId: 'themes', selectedIds: [] })).toMatchObject({ kind: 'failed', message: 'unknown theme ""' })
    const abort = new AbortController(); abort.abort()
    expect(await test.act({ kind: 'selection-accept', controlId: 'themes', selectedIds: ['tide'] }, abort.signal)).toEqual({ kind: 'cancelled' })
    test.presentation.applyTheme.mockRejectedValueOnce(new Error('palette unreadable'))
    expect(await test.act({ kind: 'selection-accept', controlId: 'themes', selectedIds: ['tide'] })).toMatchObject({ kind: 'failed', message: 'palette unreadable' })
    test.controller.openLocale()
    expect(await test.act({ kind: 'selection-accept', controlId: 'other', selectedIds: ['en'] })).toEqual({ kind: 'completed' })
    test.presentation.setLocale.mockImplementationOnce(() => { throw new Error('locale unavailable') })
    expect(await test.act({ kind: 'selection-accept', controlId: 'languages', selectedIds: ['zh'] })).toMatchObject({ kind: 'failed', message: 'locale unavailable' })
    test.select(undefined)
    test.active({ ...test.client, key: 'other-host' } as HostClient)
    expect(await test.act({ kind: 'selection-accept', controlId: 'themes', selectedIds: ['tide'] }, undefined, 0)).toEqual({ kind: 'cancelled' })
  })

  it('refuses detached explicit Hosts but supports custom themes and language without a Host', async () => {
    const test = fixture()
    test.detach()
    const before = test.opened.length
    test.controller.openTheme(test.client)
    test.controller.openLocale(test.client)
    await test.controller.applyTheme(test.client, 'tide')
    await test.controller.applyCustomTheme(test.client, '/palette.json')
    await test.controller.applyLocale(test.client, 'zh')
    await test.controller.persistMayfly(test.client, [])
    expect(test.opened).toHaveLength(before)
    expect(test.presentation.applyTheme).not.toHaveBeenCalled()
    const abort = new AbortController()
    await test.controller.applyCustomTheme(undefined, '/palette.json', 'tide', abort.signal)
    await test.controller.applyLocale(undefined, 'zh')
    expect(test.presentation.applyCustomTheme).toHaveBeenCalledWith('/palette.json', 'tide')
    expect(test.presentation.snapshot.locale).toBe('zh')
    abort.abort()
    await test.controller.applyCustomTheme(undefined, '/ignored.json', 'tide', abort.signal)
    expect(test.presentation.applyCustomTheme).toHaveBeenCalledOnce()
  })

  it('cleans a reentrantly closed theme picker and never displays late persistence failures', async () => {
    const test = fixture()
    test.presentation.subscribe.mockImplementationOnce(() => { test.opened.at(-1)!.close(); return () => {} })
    test.controller.openTheme()
    expect(test.presentationListeners.size).toBe(0)
    const pending = Promise.withResolvers<never>()
    test.settings.mutate.mockReturnValueOnce(pending.promise)
    const saving = test.controller.persistMayfly(test.client, [{ op: 'set', path: ['startup'], value: 'splash' }])
    await vi.waitFor(() => { expect(test.settings.mutate).toHaveBeenCalledOnce() })
    test.reconnect()
    pending.reject(new Error('old Host failure'))
    await saving
    expect(test.notice.set).not.toHaveBeenCalled()
  })
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
    expect(test.settings.mutate).not.toHaveBeenCalled()
    expect(test.describe).not.toHaveBeenCalled()
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

  it('completes a live theme pick with readonly or overridden Host defaults and no persistence', async () => {
    const test = fixture()
    test.setSettings({ writable: false, hasDocument: true, namespaces: [namespace()] })
    test.settings.mutate.mockRejectedValueOnce(new Error('Host refused write'))
    test.controller.openTheme()
    expect(await test.act({ kind: 'selection-accept', controlId: 'themes', selectedIds: ['light'] })).toMatchObject({ kind: 'completed', dismiss: true })
    expect(test.presentation.snapshot.theme).toBe('light')
    expect(test.describe).not.toHaveBeenCalled()
    expect(test.settings.mutate).not.toHaveBeenCalled()
    test.setSettings({ writable: true, hasDocument: true, namespaces: [] })
    await test.controller.applyTheme(test.client, 'tide')
    expect(test.presentation.snapshot.theme).toBe('tide')
    expect(test.notice.set).not.toHaveBeenCalledWith(expect.stringContaining('mayfly-host must register'))
  })

  it('loads custom themes on the Frontend while the Host is readonly and never writes Host settings', async () => {
    const test = fixture()
    test.setSettings({ writable: false, hasDocument: true, namespaces: [namespace()] })
    await test.controller.applyCustomTheme(test.client, '/local/palette.json', 'tide')
    expect(test.presentation.applyCustomTheme).toHaveBeenCalledExactlyOnceWith('/local/palette.json', 'tide')
    expect(test.presentation.snapshot.theme).toBe('custom')
    expect(test.describe).not.toHaveBeenCalled()
    expect(test.settings.mutate).not.toHaveBeenCalled()
  })

  it('fences local theme completion and explicit default persistence when the caller aborts', async () => {
    const test = fixture()
    const applyingTheme = deferred<void>()
    test.presentation.applyTheme.mockImplementationOnce(async () => applyingTheme.promise)
    test.controller.openTheme()
    const abort = new AbortController()
    const applying = test.act({ kind: 'selection-accept', controlId: 'themes', selectedIds: ['tide'] }, abort.signal)
    abort.abort()
    applyingTheme.resolve()
    expect(await applying).toMatchObject({ kind: 'cancelled' })
    expect(test.settings.mutate).not.toHaveBeenCalled()
    const pending = deferred<unknown>()
    test.describe.mockReturnValueOnce(pending.promise)
    const scope = new AbortController()
    const persisting = test.controller.persistMayfly(test.client, [{ op: 'set', path: ['theme'], value: 'tide' }], scope.signal)
    scope.abort()
    pending.resolve({ ok: true, value: { writable: true, namespaces: [namespace()] } })
    await persisting
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
  it('fences palette application that finishes after a newer read or active Host switch', async () => {
    const test = fixture()
    test.setSettings({ writable: true, hasDocument: true, namespaces: [namespace('mayfly', { value: { theme: 'tide' } })] })
    const pending = deferred<void>()
    test.presentation.applyTheme.mockReturnValueOnce(pending.promise)
    const reading = test.controller.applyHostPreferences(test.client)
    await vi.waitFor(() => { expect(test.presentation.applyTheme).toHaveBeenCalledOnce() })
    test.reconnect()
    pending.resolve()
    await reading
    expect(test.presentation.reloadTheme).not.toHaveBeenCalled()
    test.select(undefined)
    test.hosts.active = () => undefined
    await test.controller.applyHostPreferences(test.client)
    expect(test.describe).toHaveBeenCalledTimes(2)
  })
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

  it('keeps a live /theme choice across unrelated Host writes until its persisted default changes', async () => {
    const test = fixture()
    await test.controller.applyHostPreferences(test.client)
    await test.controller.applyTheme(test.client, 'tide')
    test.presentation.applyTheme.mockClear()
    test.setSettings({ writable: true, hasDocument: true, namespaces: [namespace('mayfly', { revision: 8, value: { theme: 'dark', quietHints: 'off' } })] })
    await test.controller.applyHostPreferences(test.client)
    expect(test.presentation.snapshot.theme).toBe('tide')
    expect(test.presentation.applyTheme).not.toHaveBeenCalled()
    test.setSettings({ writable: true, hasDocument: true, namespaces: [namespace('mayfly', { revision: 9, value: { theme: 'light' } })] })
    await test.controller.applyHostPreferences(test.client)
    expect(test.presentation.applyTheme).toHaveBeenCalledExactlyOnceWith('light')
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
