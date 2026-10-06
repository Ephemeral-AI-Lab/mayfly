/** Presentation resolution: settings and environment, the monochrome palette, and the theme provider that applies it. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DARK_COLORS } from '../../src/core/theme-dark.ts'
import { LIGHT_COLORS, MayflyThemeService as LightTheme } from '../../src/core/theme-light.ts'
import { monochromeColors, noColor, presentedColors, readPresentation, resolvePresentation, samePresentation } from '../../src/core/presentation.ts'

afterEach(() => { vi.unstubAllEnvs() })

describe('resolvePresentation', () => {
  it('reads glyphs, monochrome, and reduced motion from the settings', () => {
    expect(resolvePresentation({ glyphs: 'ascii', monochrome: true, reducedMotion: true }, {})).toEqual({ glyphs: 'ascii', monochrome: true, reducedMotion: true })
    expect(resolvePresentation({ glyphs: 'unicode' }, { LANG: 'C' })).toEqual({ glyphs: 'unicode', monochrome: false, reducedMotion: false })
    expect(Object.isFrozen(resolvePresentation(undefined, {}))).toBe(true)
  })

  it('follows the locale for auto glyphs and NO_COLOR for monochrome', () => {
    expect(resolvePresentation({ glyphs: 'auto', monochrome: false }, { LANG: 'C', NO_COLOR: '1' })).toEqual({ glyphs: 'ascii', monochrome: true, reducedMotion: false })
    expect(resolvePresentation({ glyphs: 'bogus' }, { NO_COLOR: '' }).monochrome).toBe(false)
    expect(noColor({ NO_COLOR: '0' })).toBe(true)
    expect(noColor({})).toBe(false)
  })

  it('compares presentations field by field', () => {
    const base = resolvePresentation(undefined, {})
    expect(samePresentation(base, resolvePresentation({}, {}))).toBe(true)
    expect(samePresentation(base, { ...base, glyphs: 'ascii' })).toBe(false)
    expect(samePresentation(base, { ...base, monochrome: true })).toBe(false)
    expect(samePresentation(base, { ...base, reducedMotion: true })).toBe(false)
  })
})

describe('readPresentation', () => {
  it('reads the tree settings source and falls back to the environment', () => {
    vi.stubEnv('NO_COLOR', '')
    vi.stubEnv('LC_ALL', 'en_US.UTF-8')
    const bare = new Context()
    expect(readPresentation(bare)).toEqual({ glyphs: 'unicode', monochrome: false, reducedMotion: false })
    const ctx = new Context()
    ctx.provide('mayflyInteractionState', { settingsSource: () => ({ glyphs: 'ascii', reducedMotion: true }) } as never)
    expect(readPresentation(ctx)).toEqual({ glyphs: 'ascii', monochrome: false, reducedMotion: true })
    const broken = new Context()
    broken.provide('mayflyInteractionState', { settingsSource: () => { throw new Error('not ready') } } as never)
    expect(readPresentation(broken).glyphs).toBe('unicode')
  })
})

describe('monochrome palette', () => {
  it('keeps weight only and is stable per palette', () => {
    const mono = monochromeColors(DARK_COLORS)
    expect(monochromeColors(DARK_COLORS)).toBe(mono)
    expect(Object.isFrozen(mono)).toBe(true)
    expect(Object.keys(mono).sort()).toEqual(Object.keys(DARK_COLORS).sort())
    expect(mono.primary('p')).toBe('\x1b[1mp\x1b[22m')
    expect(mono.warning('w')).toBe('\x1b[1mw\x1b[22m')
    expect(mono.error('e')).toBe('\x1b[1me\x1b[22m')
    expect(mono.muted('m')).toBe('\x1b[2mm\x1b[22m')
    expect(mono.border('b')).toBe('\x1b[2mb\x1b[22m')
    expect(mono.text('t')).toBe('t')
    expect(mono.success('s')).toBe('s')
    expect(mono.diffAddedBg('g')).toBe('g')
    expect(mono.logoGradient.map(paint => paint('x'))).toEqual(DARK_COLORS.logoGradient.map(() => 'x'))
  })

  it('applies only under a monochrome presentation', () => {
    expect(presentedColors(DARK_COLORS, resolvePresentation(undefined, {}))).toBe(DARK_COLORS)
    expect(presentedColors(DARK_COLORS, resolvePresentation({ monochrome: true }, {}))).toBe(monochromeColors(DARK_COLORS))
  })

  it('is what a theme provider exposes under NO_COLOR', async () => {
    vi.stubEnv('NO_COLOR', '1')
    const ctx = new Context()
    await ctx.plugin(LightTheme)
    expect(ctx.mayflyTheme.colors).toBe(monochromeColors(LIGHT_COLORS))
  })
})
