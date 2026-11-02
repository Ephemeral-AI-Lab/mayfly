import { describe, expect, it, vi } from 'vitest'
import type { RemoteFeatureContext } from '../../src/remote/features/contracts.ts'
import { CordisRemoteLocalPresentation } from '../../src/remote/features/presentation.ts'

vi.mock('@ephemeral-ai/mayfly/theme-dark', () => ({ name: 'dark', apply: () => {} }))
vi.mock('@ephemeral-ai/mayfly/theme-builtin', () => ({ name: 'builtin', apply: () => {} }))
vi.mock('@ephemeral-ai/mayfly/theme-auto', () => ({ name: 'auto', apply: () => {} }))

function fixture(theme = 'dark') {
  const state = { currentThemeKey: theme, lastAppliedTheme: theme }
  const locale = { snapshot: { locale: 'en' }, setPreference: vi.fn() }
  const old = { restart: vi.fn(async () => {}), dispose: vi.fn(async () => {}) }
  const mounted = { dispose: vi.fn(async () => {}) }
  const plugin = vi.fn(async (_module: unknown, _config?: unknown) => mounted)
  const registry = { get: vi.fn(() => ({ fibers: [old] })), delete: vi.fn(() => ({ fibers: [old] })) }
  const offLocale = vi.fn()
  const context = {
    ctx: {
      get: (name: string) => name === 'mayflyInteractionState' ? state : name === 'mayflyLocale' ? locale : undefined,
      plugin, registry,
    },
    subscribeLocale: vi.fn(() => offLocale),
  } as unknown as Pick<RemoteFeatureContext, 'ctx' | 'subscribeLocale'>
  const presentation = new CordisRemoteLocalPresentation(context)
  return { state, locale, old, mounted, plugin, registry, offLocale, context, presentation }
}

describe('Remote local presentation lifecycle', () => {
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
    expect(test.state).toEqual({ currentThemeKey: 'tide', lastAppliedTheme: 'tide' })
    expect(listener).toHaveBeenCalledTimes(2)
    test.presentation.setLocale('zh')
    expect(test.locale.setPreference).toHaveBeenCalledWith('zh')
    test.presentation.dispose()
    test.presentation.dispose()
    expect(test.offLocale).toHaveBeenCalledOnce()
  })

  it('drops theme work queued before disposal and never activates providers after unload', async () => {
    const test = fixture()
    const first = test.presentation.applyTheme('light')
    const second = test.presentation.applyTheme('auto')
    test.presentation.dispose()
    await Promise.all([first, second, test.presentation.reloadTheme()])
    expect(test.plugin).not.toHaveBeenCalled()
    expect(test.registry.delete).not.toHaveBeenCalled()
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
    test.presentation.dispose()
    finish(test.mounted)
    await pending
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
})
