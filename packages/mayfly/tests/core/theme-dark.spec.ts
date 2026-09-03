/**
 * `mayfly-theme-dark` plugin entry: registration and disposal on the fiber,
 * and the built-in dark semantic color table (28 tokens).
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ThemeModelService } from '../../src/frontend/index.ts'
import { apply, MayflyThemeService, name } from '../../src/core/theme-dark.ts'
import type { MayflySemanticColors } from '../../src/core/types.ts'

const EXPECTED_ROLES: (keyof MayflySemanticColors)[] = [
  'text',
  'textStrong',
  'muted',
  'textMuted',
  'accent',
  'primary',
  'border',
  'borderFocus',
  'success',
  'error',
  'warning',
  'selectedBg',
  'roleUser',
  'shellMode',
  'mdHeading',
  'mdLink',
  'mdLinkUrl',
  'mdCode',
  'mdCodeBlock',
  'mdCodeBlockBorder',
  'mdQuote',
  'mdQuoteBorder',
  'mdHr',
  'mdListBullet',
  'diffAdded',
  'diffRemoved',
  'diffAddedStrong',
  'diffRemovedStrong',
  'diffGutter',
  'diffMeta',
  'modelHighlight',
  'logoGradient',
]

describe('mayfly-theme-dark plugin', () => {
  it('registers as ctx.mayflyTheme and unregisters when the fiber disposes', async () => {
    expect(name).toBe('mayfly-theme-dark')
    const ctx = new Context()
    const fiber = ctx.plugin({ name, apply })
    await fiber
    expect(ctx.get('mayflyTheme')).toBeInstanceOf(MayflyThemeService)
    await fiber.dispose()
    expect(ctx.get('mayflyTheme')).toBeUndefined()
  })

  it('exposes a frozen table covering every semantic role', async () => {
    const ctx = new Context()
    await ctx.plugin({ name, apply })
    const { colors } = ctx.mayflyTheme
    expect(Object.isFrozen(colors)).toBe(true)
    expect(Object.keys(colors).sort()).toEqual([...EXPECTED_ROLES].sort())
    for (const role of EXPECTED_ROLES) {
      if (role === 'logoGradient') expect(colors.logoGradient.every(entry => typeof entry === 'function')).toBe(true)
      else expect(typeof colors[role]).toBe('function')
    }
  })

  it('publishes the semantic companion model when the frontend registry is present', async () => {
    const ctx = new Context()
    await ctx.plugin(ThemeModelService)
    await ctx.plugin({ name, apply })
    expect(ctx.mayflyThemeModels.current?.id).toBe('dark')
    expect(ctx.mayflyThemeModels.current?.colors.primary).toBe('#9A86E6')
  })

  it('wraps text in truecolor foreground and background sequences', async () => {
    const ctx = new Context()
    await ctx.plugin({ name, apply })
    const { colors } = ctx.mayflyTheme
    // accent #C9C0F0 → rgb(201, 192, 240)
    expect(colors.accent('hi')).toBe('\x1b[38;2;201;192;240mhi\x1b[39m')
    // primary #9A86E6 → rgb(154, 134, 230)
    expect(colors.primary('hi')).toBe('\x1b[38;2;154;134;230mhi\x1b[39m')
    // textMuted #5C6476 → rgb(92, 100, 118)
    expect(colors.textMuted('hi')).toBe('\x1b[38;2;92;100;118mhi\x1b[39m')
    // selectedBg #221E38 → rgb(34, 30, 56)
    expect(colors.selectedBg('hi')).toBe('\x1b[48;2;34;30;56mhi\x1b[49m')
    // shellMode #C9C0F0 → rgb(201, 192, 240)
    expect(colors.shellMode('hi')).toBe('\x1b[38;2;201;192;240mhi\x1b[39m')
  })
})
