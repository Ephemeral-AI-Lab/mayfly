/**
 * `mayfly-theme-custom` plugin entry: JSON palette files layered over the
 * built-in base palettes, with per-token and whole-file fallback behavior.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ThemeModelService } from '../../src/frontend/index.ts'
import { DARK_COLORS } from '../../src/core/theme-dark.ts'
import { LIGHT_COLORS } from '../../src/core/theme-light.ts'
import { apply, Config, name } from '../../src/core/theme-custom.ts'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mayfly-theme-custom-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/**
 * Register an exporter collecting the plugin's warnings; Cordis's built-in
 * buffer exporter filters at INFO level, which drops warnings. Register
 * before mounting so the mount-time warnings are captured.
 */
function recordWarnings(ctx: Context): string[] {
  const messages: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => {
      if (message.type === 'warn') messages.push(String(message.args[0]))
    },
  })
  return messages
}

/** Write a palette file and mount the plugin against it. */
async function mount(ctx: Context, content: string | undefined, base?: 'dark' | 'light') {
  const path = join(dir, 'theme.json')
  if (content !== undefined) await writeFile(path, content)
  const fiber = ctx.plugin({ name, Config, apply }, base === undefined ? { path } : { path, base })
  await fiber
  return fiber
}

describe('mayfly-theme-custom plugin', () => {
  it('registers the file-defined palette and unregisters when the fiber disposes', async () => {
    expect(name).toBe('mayfly-theme-custom')
    const ctx = new Context()
    const fiber = await mount(ctx, JSON.stringify({ text: '#112233', selectedBg: '#445566' }))
    const theme = ctx.get('mayflyTheme')
    expect(theme).toBeDefined()
    expect(Object.isFrozen(theme!.colors)).toBe(true)
    expect(Object.keys(theme!.colors).sort()).toEqual(Object.keys(DARK_COLORS).sort())
    // text #112233 → rgb(17, 34, 51); selectedBg #445566 → rgb(68, 85, 102)
    expect(theme!.colors.text('hi')).toBe('\x1b[38;2;17;34;51mhi\x1b[39m')
    expect(theme!.colors.selectedBg('hi')).toBe('\x1b[48;2;68;85;102mhi\x1b[49m')
    // Untouched tokens fall back to the dark base (the Config default).
    expect(theme!.colors.muted).toBe(DARK_COLORS.muted)
    await fiber.dispose()
    expect(ctx.get('mayflyTheme')).toBeUndefined()
  })

  it('layers overrides over the light base when configured', async () => {
    const ctx = new Context()
    await mount(ctx, JSON.stringify({ accent: '#112233' }), 'light')
    const { colors } = ctx.mayflyTheme
    expect(colors.accent('hi')).toBe('\x1b[38;2;17;34;51mhi\x1b[39m')
    expect(colors.muted).toBe(LIGHT_COLORS.muted)
  })

  it('accepts a valid logo gradient and freezes its color functions', async () => {
    const ctx = new Context()
    await mount(ctx, JSON.stringify({ logoGradient: ['#112233', '#aabbcc'] }))
    const gradient = ctx.mayflyTheme.colors.logoGradient
    expect(gradient).toHaveLength(2)
    expect(Object.isFrozen(gradient)).toBe(true)
    expect(gradient[0]!('hi')).toBe('\x1b[38;2;17;34;51mhi\x1b[39m')
    expect(gradient[1]!('hi')).toBe('\x1b[38;2;170;187;204mhi\x1b[39m')
  })

  it('publishes custom semantic tokens to the frontend registry', async () => {
    const ctx = new Context()
    await ctx.plugin(ThemeModelService)
    await mount(ctx, JSON.stringify({ text: '#112233' }))
    expect(ctx.mayflyThemeModels.current?.id).toBe('custom')
    expect(ctx.mayflyThemeModels.current?.colors.text).toBe('#112233')
    expect(ctx.mayflyThemeModels.current?.colors.muted).toBe('#9AA3B8')
  })

  it('drops invalid entries and falls back to the base palette entry', async () => {
    const ctx = new Context()
    const warns = recordWarnings(ctx)
    await mount(ctx, JSON.stringify({ text: 'red', accent: 123, roleUser: '#0a7ea4', logoGradient: ['#112233', 'nope'] }))
    const { colors } = ctx.mayflyTheme
    expect(colors.text).toBe(DARK_COLORS.text)
    expect(colors.accent).toBe(DARK_COLORS.accent)
    expect(colors.roleUser('hi')).toBe('\x1b[38;2;10;126;164mhi\x1b[39m')
    expect(warns).toHaveLength(3)
  })

  it.each([
    ['not an array', '"logoGradient":"#112233"'],
    ['empty', '"logoGradient":[]'],
  ])('ignores an invalid %s logo gradient', async (_label, json) => {
    const ctx = new Context()
    const warns = recordWarnings(ctx)
    await mount(ctx, `{${json}}`)
    expect(ctx.mayflyTheme.colors.logoGradient).toBe(DARK_COLORS.logoGradient)
    expect(warns).toHaveLength(1)
  })

  it('ignores unknown token names with a warning', async () => {
    const ctx = new Context()
    const warns = recordWarnings(ctx)
    await mount(ctx, JSON.stringify({ nope: '#112233' }))
    const { colors } = ctx.mayflyTheme
    for (const role of Object.keys(DARK_COLORS) as (keyof typeof DARK_COLORS)[]) {
      expect(colors[role]).toBe(DARK_COLORS[role])
    }
    expect(warns).toHaveLength(1)
  })

  it('falls back to the whole base palette when the file is unreadable', async () => {
    const ctx = new Context()
    const warns = recordWarnings(ctx)
    await mount(ctx, undefined)
    expect(ctx.get('mayflyTheme')?.colors).toBe(DARK_COLORS)
    expect(warns).toHaveLength(1)
  })

  it('falls back to the whole base palette when the file is not valid JSON', async () => {
    const ctx = new Context()
    const warns = recordWarnings(ctx)
    await mount(ctx, '{ not json')
    expect(ctx.get('mayflyTheme')?.colors).toBe(DARK_COLORS)
    expect(warns).toHaveLength(1)
  })

  it.each(['"just a string"', 'null', '[]'])(
    'falls back to the whole base palette when the file is %s',
    async (content) => {
      const ctx = new Context()
      const warns = recordWarnings(ctx)
      await mount(ctx, content)
      expect(ctx.get('mayflyTheme')?.colors).toBe(DARK_COLORS)
      expect(warns).toHaveLength(1)
    },
  )
})
