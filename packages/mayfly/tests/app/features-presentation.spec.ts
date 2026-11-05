import { describe, expect, it, vi } from 'vitest'
import type { RemoteFeatureContext } from '../../src/app/features/contracts.ts'
import { CordisRemoteLocalPresentation, remoteThemeName } from '../../src/app/features/presentation.ts'

vi.mock('../../src/theme-dark.ts', () => ({ name: 'dark', apply: () => {} }))
vi.mock('../../src/theme-builtin.ts', () => ({ name: 'builtin', apply: () => {} }))
vi.mock('../../src/theme-auto.ts', () => ({ name: 'auto', apply: () => {} }))
vi.mock('../../src/theme-custom.ts', () => ({ name: 'custom', apply: () => {} }))

function fixture(theme = 'dark') {
  const state = { currentThemeKey: theme }
  const locale = { snapshot: { locale: 'en' }, setPreference: vi.fn() }
  const old = { restart: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
  const mounted = { dispose: vi.fn(async () => {}) }
  const plugin = vi.fn(async (_module: unknown, _config?: unknown) => mounted)
  const runtime = (): { readonly fibers: readonly (typeof old)[] } | undefined => ({ fibers: [old] })
  const registry = { get: vi.fn(runtime) }
  const offLocale = vi.fn()
  const services = new Map<string, unknown>([['mayflyInteractionState', state], ['mayflyLocale', locale]])
  let onLocale = () => {}
  const context = {
    ctx: {
      get: (name: string) => services.get(name),
      plugin, registry,
    },
    subscribeLocale: vi.fn((listener: () => void) => { onLocale = listener; return offLocale }),
  } as unknown as Pick<RemoteFeatureContext, 'ctx' | 'subscribeLocale'>
  const presentation = new CordisRemoteLocalPresentation(context)
  return { state, locale, old, mounted, plugin, registry, offLocale, context, presentation, services, notifyLocale: () => onLocale() }
}

describe('Remote local presentation lifecycle', () => {
  it('names known themes and keeps unknown names readable', () => {
    expect(remoteThemeName('dark')).toBe('Mayfly Dark')
    expect(remoteThemeName('external-palette')).toBe('external-palette')
  })

  it('reports locale changes, removes observers, and keeps absent services optional', async () => {
    const test = fixture()
    expect(test.presentation.snapshot).toEqual({ locale: 'en', theme: 'dark' })
    const listener = vi.fn()
    const off = test.presentation.subscribe(listener)
    test.notifyLocale()
    expect(listener).toHaveBeenCalledOnce()
    off()
    test.notifyLocale()
    expect(listener).toHaveBeenCalledOnce()
    test.services.clear()
    expect(test.presentation.snapshot).toEqual({ locale: 'en', theme: 'dark' })
    test.presentation.setLocale('en')
    expect(test.locale.setPreference).not.toHaveBeenCalled()
    await test.presentation.applyTheme('dark')
    expect(test.plugin).not.toHaveBeenCalled()
    test.registry.get.mockReturnValueOnce(undefined)
    await test.presentation.reloadTheme()
    test.registry.get.mockReturnValueOnce(undefined)
    await test.presentation.applyTheme('light')
    expect(test.plugin).toHaveBeenCalledOnce()
    test.presentation.dispose()
    test.presentation.subscribe(listener)()
    test.notifyLocale()
    expect(listener).toHaveBeenCalledOnce()
  })

  it('serializes swaps and reloads, reports complete changes, and preserves the selected theme', async () => {
    const test = fixture()
    const listener = vi.fn()
    test.presentation.subscribe(listener)
    const first = test.presentation.applyTheme('tide')
    const second = test.presentation.reloadTheme()
    await Promise.all([first, second])
    expect(test.plugin).toHaveBeenCalledOnce()
    expect(test.plugin).toHaveBeenCalledWith(expect.objectContaining({ name: 'builtin' }), { palette: 'tide' })
    expect(test.old.dispose).toHaveBeenCalledOnce()
    expect(test.old.restart).toHaveBeenCalledOnce()
    expect(test.state).toEqual({ currentThemeKey: 'tide' })
    expect(listener).toHaveBeenCalledTimes(2)
    test.presentation.setLocale('zh')
    expect(test.locale.setPreference).toHaveBeenCalledWith('zh')
    test.presentation.dispose()
    test.presentation.dispose()
    expect(test.offLocale).toHaveBeenCalledOnce()
  })

  it('mounts local custom palettes, reloads their provider and releases it before a builtin swap', async () => {
    const test = fixture()
    await test.presentation.applyCustomTheme('/local/theme.json', 'tide')
    expect(test.plugin).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'custom' }), { path: '/local/theme.json', base: 'tide' })
    expect(test.state.currentThemeKey).toBe('custom')
    await test.presentation.reloadTheme()
    expect(test.registry.get).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'custom' }))
    await test.presentation.applyCustomTheme('/local/second.json')
    expect(test.registry.get).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'custom' }))
    expect(test.plugin).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'custom' }), { path: '/local/second.json', base: 'dark' })
    await test.presentation.applyTheme('light')
    expect(test.registry.get).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'custom' }))
    expect(test.state.currentThemeKey).toBe('light')
    test.presentation.dispose()
    await test.presentation.applyCustomTheme('/local/ignored.json')
    expect(test.state.currentThemeKey).toBe('light')
  })

  it('restores dark if a custom provider rejects its base or fails to mount', async () => {
    const test = fixture()
    test.plugin.mockRejectedValueOnce(new Error('Invalid custom base'))
    await expect(test.presentation.applyCustomTheme('/local/theme.json', 'invalid')).rejects.toThrow('Invalid custom base')
    expect(test.plugin).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'dark' }))
    expect(test.state.currentThemeKey).toBe('dark')
    test.presentation.dispose()
  })

  it('drops theme work queued before disposal and never activates providers after unload', async () => {
    const test = fixture()
    const first = test.presentation.applyTheme('light')
    const second = test.presentation.applyTheme('auto')
    test.presentation.dispose()
    await Promise.all([first, second, test.presentation.reloadTheme()])
    expect(test.plugin).not.toHaveBeenCalled()
    expect(test.registry.get).not.toHaveBeenCalled()
    test.presentation.setLocale('zh')
    await test.presentation.applyTheme('tide')
    expect(test.locale.setPreference).not.toHaveBeenCalled()
    expect(test.plugin).not.toHaveBeenCalled()
  })

  it('releases a theme that settles after disposal and does not publish it as current', async () => {
    const test = fixture()
    let finish!: (value: typeof test.mounted) => void
    test.plugin.mockImplementationOnce(() => new Promise(done => { finish = done }))
    const listener = vi.fn()
    test.presentation.subscribe(listener)
    const pending = test.presentation.applyTheme('light')
    await vi.waitFor(() => { expect(finish).toBeDefined() })
    const reloading = test.presentation.reloadTheme()
    test.presentation.dispose()
    finish(test.mounted)
    await Promise.all([pending, reloading])
    expect(test.mounted.dispose).toHaveBeenCalledOnce()
    expect(test.state.currentThemeKey).toBe('dark')
    expect(listener).not.toHaveBeenCalled()
  })

  it('restores dark after a failed provider and permits a later choice', async () => {
    const test = fixture('tide')
    test.plugin.mockRejectedValueOnce(new Error('theme failed'))
    await expect(test.presentation.applyTheme('light')).rejects.toThrow('theme failed')
    expect(test.plugin).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'dark' }))
    expect(test.state.currentThemeKey).toBe('dark')
    await test.presentation.applyTheme('auto')
    expect(test.state.currentThemeKey).toBe('auto')
    await expect(test.presentation.applyTheme('missing')).rejects.toThrow('Unknown theme')
    expect(() => test.presentation.setLocale('missing')).toThrow('Unknown locale')
    test.presentation.dispose()
  })

  it('restarts a custom provider whose configuration was installed outside this owner', async () => {
    const test = fixture('custom')
    await test.presentation.reloadTheme()
    expect(test.registry.get).toHaveBeenCalledWith(expect.objectContaining({ name: 'custom' }))
    expect(test.old.restart).toHaveBeenCalledOnce()
    test.presentation.dispose()
  })

  it.each(['custom', 'reload'] as const)('permits %s after an earlier provider failure', async kind => {
    const test = fixture()
    test.plugin.mockRejectedValueOnce(new Error('failed palette'))
    await expect(test.presentation.applyTheme('light')).rejects.toThrow('failed palette')
    if (kind === 'custom') await test.presentation.applyCustomTheme('/local/recovered.json')
    else await test.presentation.reloadTheme()
    test.presentation.dispose()
  })

  it.each(['reload', 'swap'] as const)('retires %s while a provider module is loading', async kind => {
    const test = fixture()
    const pending = kind === 'reload' ? test.presentation.reloadTheme() : test.presentation.applyTheme('light')
    await Promise.resolve(); await Promise.resolve()
    test.presentation.dispose()
    await pending
    expect(test.plugin).not.toHaveBeenCalled()
    expect(test.registry.get).not.toHaveBeenCalled()
  })

  it.each(['restart', 'dispose'] as const)('does not continue after an in-flight provider %s is retired', async kind => {
    const test = fixture()
    const gate = Promise.withResolvers<void>()
    test.old[kind].mockReturnValueOnce(gate.promise)
    const listener = vi.fn()
    test.presentation.subscribe(listener)
    const pending = kind === 'restart' ? test.presentation.reloadTheme() : test.presentation.applyTheme('light')
    await vi.waitFor(() => { expect(test.old[kind]).toHaveBeenCalledOnce() })
    test.presentation.dispose()
    gate.resolve()
    await pending
    expect(listener).not.toHaveBeenCalled()
    expect(test.plugin).not.toHaveBeenCalled()
  })

  it('does not restore a provider after its failed mount already retired the owner', async () => {
    const test = fixture()
    test.plugin.mockImplementationOnce(async () => { test.presentation.dispose(); throw new Error('late mount failure') })
    await test.presentation.applyTheme('light')
    expect(test.plugin).toHaveBeenCalledOnce()
    expect(test.state.currentThemeKey).toBe('dark')
  })

  it('releases a fallback provider that settles after unload', async () => {
    const test = fixture('tide')
    test.plugin.mockRejectedValueOnce(new Error('palette failed')).mockImplementationOnce(async () => { test.presentation.dispose(); return test.mounted })
    await test.presentation.applyTheme('light')
    expect(test.mounted.dispose).toHaveBeenCalledOnce()
    expect(test.state.currentThemeKey).toBe('tide')
  })

  it('can restore the dark provider when the interaction service is absent', async () => {
    const test = fixture()
    test.services.delete('mayflyInteractionState')
    test.plugin.mockRejectedValueOnce(new Error('palette failed'))
    await expect(test.presentation.applyTheme('light')).rejects.toThrow('palette failed')
    expect(test.plugin).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'dark' }))
    test.presentation.dispose()
  })

  it('does not mount a fallback whose module finishes loading after unload', async () => {
    const loading = Promise.withResolvers<void>()
    const factory = vi.fn(async () => { await loading.promise; return { name: 'dark', apply: () => {} } })
    vi.doMock('../../src/theme-dark.ts', factory)
    vi.resetModules()
    const test = fixture('light')
    test.plugin.mockRejectedValueOnce(new Error('palette failed'))
    const pending = test.presentation.applyTheme('tide')
    try {
      await vi.waitFor(() => { expect(factory).toHaveBeenCalledOnce() })
      test.presentation.dispose()
      loading.resolve()
      await pending
      expect(test.plugin).toHaveBeenCalledOnce()
    } finally {
      loading.resolve()
      test.presentation.dispose()
      vi.doMock('../../src/theme-dark.ts', () => ({ name: 'dark', apply: () => {} }))
      vi.resetModules()
    }
  })
})
