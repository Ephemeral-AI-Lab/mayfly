/** The first-run guide's language/theme/startup choice: live apply, persistence, and failure containment.
 * @module @ephemeral-ai/mayfly/tests/interaction/onboarding-language
 */
import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  commitLanguage,
  commitStartup,
  initialChoice,
  persist,
  type Language,
  type ThemeKey,
} from '../../src/interaction/onboarding-language.ts'
import { InteractionStateService } from '../../src/interaction/runtime-state.ts'
import { DEFAULT_SETTINGS, type MayflySettings } from '../../src/interaction/settings.ts'

const { applyTheme } = vi.hoisted(() => ({ applyTheme: vi.fn() }))
vi.mock('../../src/interaction/theme-switch.ts', () => ({ applyTheme }))

interface FakeSettings {
  readonly writable: boolean
  readonly describe: () => readonly { readonly ns: string, readonly revision: number }[]
  readonly mutate: ReturnType<typeof vi.fn>
}

function fakeSettings(options: {
  writable?: boolean
  namespaces?: readonly string[]
  reject?: boolean
} = {}): FakeSettings {
  const namespaces = options.namespaces ?? ['mayfly', 'locale']
  const revisions: Record<string, number> = { mayfly: 7, locale: 9 }
  return {
    writable: options.writable ?? true,
    describe: () => namespaces.map(ns => ({ ns, revision: revisions[ns] ?? 1 })),
    mutate: vi.fn(async () => {
      if (options.reject === true) throw new Error('read-only')
    }),
  }
}

function mount(options: {
  settings?: MayflySettings
  withState?: boolean
  withLocale?: boolean
  store?: FakeSettings
} = {}) {
  const ctx = new Context()
  const state = options.withState === false ? undefined : new InteractionStateService(ctx, DEFAULT_SETTINGS)
  if (state !== undefined) state.settingsSource = () => options.settings ?? DEFAULT_SETTINGS
  const locale = { locale: 'en', setPreference: vi.fn() }
  if (options.withLocale !== false) ctx.provide('mayflyLocale', locale as never)
  const store = options.store
  if (store !== undefined) ctx.provide('settings', store as never)
  return { ctx, state, locale, store }
}

beforeEach(() => {
  applyTheme.mockReset()
  applyTheme.mockResolvedValue({ kind: 'success' })
})

describe('initialChoice', () => {
  it('preselects English and dark with no stored or live alternatives', () => {
    const { ctx } = mount()
    expect(initialChoice(ctx)).toEqual({ language: 'en', theme: 'dark', startup: 'conversation' })
  })

  it('prefers a stored non-dark theme over the live one', () => {
    const { ctx, state } = mount({ settings: { ...DEFAULT_SETTINGS, theme: 'tide' } })
    state!.currentThemeKey = 'light'
    expect(initialChoice(ctx).theme).toBe('tide')
  })

  it('falls back to the live theme when the stored one is dark or unknown', () => {
    const dark = mount()
    dark.state!.currentThemeKey = 'light'
    expect(initialChoice(dark.ctx).theme).toBe('light')

    const unknown = mount({ settings: { ...DEFAULT_SETTINGS, theme: 'custom' as MayflySettings['theme'] } })
    expect(initialChoice(unknown.ctx).theme).toBe('dark')

    const liveAuto = mount()
    liveAuto.state!.currentThemeKey = 'auto'
    expect(initialChoice(liveAuto.ctx).theme).toBe('auto')
  })

  it('falls back to dark when neither the stored nor the live key is persistable', () => {
    const unknown = mount({ settings: { ...DEFAULT_SETTINGS, theme: 'custom' as MayflySettings['theme'] } })
    unknown.state!.currentThemeKey = 'custom'
    expect(initialChoice(unknown.ctx).theme).toBe('dark')
  })

  it('preselects the live language and the stored startup', () => {
    const { ctx, locale } = mount({ settings: { ...DEFAULT_SETTINGS, startup: 'splash' } })
    expect(initialChoice(ctx)).toMatchObject({ language: 'en', startup: 'splash' })
    locale.locale = 'zh'
    expect(initialChoice(ctx).language).toBe('zh')
  })
})

describe('persist', () => {
  it('does nothing without a settings service or a writable store', async () => {
    const bare = mount()
    await expect(persist(bare.ctx, 'mayfly', { op: 'set', path: ['language'], value: 'zh' })).resolves.toBeUndefined()

    const readOnly = mount({ store: fakeSettings({ writable: false }) })
    await persist(readOnly.ctx, 'mayfly', { op: 'set', path: ['language'], value: 'zh' })
    expect(readOnly.store!.mutate).not.toHaveBeenCalled()
  })

  it('does nothing when the store does not describe the namespace', async () => {
    const { ctx, store } = mount({ store: fakeSettings({ namespaces: ['locale'] }) })
    await persist(ctx, 'mayfly', { op: 'set', path: ['language'], value: 'zh' })
    expect(store!.mutate).not.toHaveBeenCalled()
  })

  it('writes the operation against the described revision', async () => {
    const { ctx, store } = mount({ store: fakeSettings() })
    await persist(ctx, 'mayfly', { op: 'set', path: ['language'], value: 'zh' })
    expect(store!.mutate).toHaveBeenCalledWith('mayfly', [{ op: 'set', path: ['language'], value: 'zh' }], 7)
  })

  it('contains a rejected write as a warning', async () => {
    const { ctx } = mount({ store: fakeSettings({ reject: true }) })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await persist(ctx, 'mayfly', { op: 'set', path: ['language'], value: 'zh' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('could not persist mayfly setting'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('read-only'))
  })
})

describe('commitStartup', () => {
  it('persists the startup surface', async () => {
    const { ctx, store } = mount({ store: fakeSettings() })
    await commitStartup(ctx, 'splash')
    expect(store!.mutate).toHaveBeenCalledWith('mayfly', [{ op: 'set', path: ['startup'], value: 'splash' }], 7)
  })
})

describe('commitLanguage', () => {
  it('applies the language and theme live, then persists all three choices', async () => {
    const { ctx, state, locale, store } = mount({ store: fakeSettings() })
    await commitLanguage(ctx, 'zh', 'tide')
    expect(locale.setPreference).toHaveBeenCalledWith('zh')
    expect(applyTheme).toHaveBeenCalledWith(ctx, 'tide')
    expect(state!.lastAppliedTheme).toBe('tide')
    expect(store!.mutate.mock.calls).toEqual([
      ['mayfly', [{ op: 'set', path: ['language'], value: 'zh' }], 7],
      ['mayfly', [{ op: 'set', path: ['theme'], value: 'tide' }], 7],
      ['locale', [{ op: 'set', path: ['preference'], value: 'zh' }], 9],
    ])
  })

  it('does not re-apply a theme the live tree already shows', async () => {
    const { ctx, state } = mount({ store: fakeSettings() })
    state!.currentThemeKey = 'tide'
    await commitLanguage(ctx, 'en', 'tide')
    expect(applyTheme).not.toHaveBeenCalled()
    expect(state!.lastAppliedTheme).toBe('dark')
  })

  it('keeps the live choice when the store is read-only', async () => {
    const { ctx, state, locale, store } = mount({ store: fakeSettings({ writable: false }) })
    await commitLanguage(ctx, 'zh', 'tide')
    expect(locale.setPreference).toHaveBeenCalledWith('zh')
    expect(state!.lastAppliedTheme).toBe('tide')
    expect(store!.mutate).not.toHaveBeenCalled()
  })

  it('warns with the theme failure text, or a generated one without text', async () => {
    const first = mount({ store: fakeSettings() })
    const warn = vi.spyOn(first.ctx.logger, 'warn').mockImplementation(() => {})
    applyTheme.mockResolvedValueOnce({ kind: 'error', text: 'palette unavailable' })
    await commitLanguage(first.ctx, 'en', 'tide')
    expect(warn).toHaveBeenCalledWith('palette unavailable')
    expect(first.state!.lastAppliedTheme).toBe('dark')

    applyTheme.mockResolvedValueOnce({ kind: 'error' })
    await commitLanguage(first.ctx, 'en', 'tide')
    expect(warn).toHaveBeenCalledWith('could not apply theme "tide"')
  })

  it('works without interaction state or a locale provider', async () => {
    const bare = mount({ withState: false, withLocale: false, store: fakeSettings() })
    await expect(commitLanguage(bare.ctx, 'zh' as Language, 'tide' as ThemeKey)).resolves.toBeUndefined()
    expect(applyTheme).not.toHaveBeenCalled()
    expect(bare.store!.mutate).toHaveBeenCalledTimes(3)
  })

  it('contains persistence failures while still applying the choice', async () => {
    const { ctx, state } = mount({ store: fakeSettings({ reject: true }) })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    await commitLanguage(ctx, 'zh', 'tide')
    expect(state!.lastAppliedTheme).toBe('tide')
    expect(warn).toHaveBeenCalledTimes(3)
  })
})
