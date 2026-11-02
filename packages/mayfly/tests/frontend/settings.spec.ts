/** Renderer preference resolution over native values and volatile cells. */
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS, resolveMayflySettings, settingsOverrides } from '../../src/frontend/settings.ts'

describe('frontend settings resolution', () => {
  it('layers declared native fields over defaults and ignores absent and unknown fields', () => {
    expect(resolveMayflySettings(undefined)).toEqual(DEFAULT_SETTINGS)
    expect(resolveMayflySettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(resolveMayflySettings('not a settings record')).toEqual(DEFAULT_SETTINGS)
    expect(settingsOverrides({ theme: undefined, unknown: 'ignored' })).toEqual({})
    const resolved = resolveMayflySettings({ theme: 'light', reducedMotion: true, updateCheck: false, unknown: 'ignored' })
    expect(resolved).toEqual({ ...DEFAULT_SETTINGS, theme: 'light', reducedMotion: true, updateCheck: false })
    expect(resolved).not.toBe(DEFAULT_SETTINGS)
    expect(DEFAULT_SETTINGS.theme).toBe('dark')
  })

  it('reads volatile cells on each resolution and preserves structured preference values', () => {
    let language = 'en'
    const get = vi.fn(() => language)
    const keybindings = { 'ui.copy': { keys: ['ctrl+k'], label: 'Copy' } }
    const value = { language: { get }, keybindings }
    expect(settingsOverrides(value)).toEqual({ language: 'en', keybindings })
    expect(resolveMayflySettings(value).keybindings).toBe(keybindings)
    language = 'zh'
    expect(resolveMayflySettings(value).language).toBe('zh')
    expect(get).toHaveBeenCalledTimes(3)
  })
})
