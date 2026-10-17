/**
 * `mayfly-theme-custom` plugin entry: JSON palette files layered over the
 * built-in base palettes, with per-token and whole-file fallback behavior.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ThemeModelService } from '../../src/frontend/theme.ts'
import { DARK_COLORS } from '../../src/core/theme-dark.ts'
import { paletteColors } from '../../src/core/palettes.ts'
import { apply, Config, name } from '../../src/core/theme-custom.ts'

const LIGHT_COLORS = paletteColors('light')

let dir: string

beforeEach(async () => {
  vi.stubEnv('NO_COLOR', '')
  dir = await mkdtemp(join(tmpdir(), 'mayfly-theme-custom-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
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
  // Without a base the schema supplies its default; the plugin's config type is the validated one.
  const fiber = ctx.plugin({ name, Config, apply }, base === undefined ? { path } as Config : { path, base })
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

  it('accepts valid logo inks and freezes their color functions', async () => {
    const ctx = new Context()
    await mount(ctx, JSON.stringify({ logoInks: ['#112233', '#445566', '#778899', '#aabbcc', '#ddeeff'] }))
    const inks = ctx.mayflyTheme.colors.logoInks
    expect(inks).toHaveLength(5)
    expect(Object.isFrozen(inks)).toBe(true)
    expect(inks[0]!('hi')).toBe('\x1b[38;2;17;34;51mhi\x1b[39m')
    expect(inks[4]!('hi')).toBe('\x1b[38;2;221;238;255mhi\x1b[39m')
  })

  it('publishes custom semantic tokens to the frontend registry', async () => {
    const ctx = new Context()
    await ctx.plugin(ThemeModelService)
    await mount(ctx, JSON.stringify({ text: '#112233' }))
    expect(ctx.mayflyThemeModels.current?.id).toBe('custom')
    expect(ctx.mayflyThemeModels.current?.colors.text).toBe('#112233')
    expect(ctx.mayflyThemeModels.current?.colors.muted).toBe('#9AA3B8')
    expect(ctx.mayflyThemeModels.current?.colors.diffAddedBg).toBe('#1E3A2B')
  })

  it('paints diff band overrides as backgrounds', async () => {
    const ctx = new Context()
    await ctx.plugin(ThemeModelService)
    await mount(ctx, JSON.stringify({ diffAddedBg: '#112233', diffRemovedBg: '#445566' }), 'light')
    const { colors } = ctx.mayflyTheme
    // diffAddedBg #112233 → rgb(17, 34, 51); diffRemovedBg #445566 → rgb(68, 85, 102)
    expect(colors.diffAddedBg('hi')).toBe('\x1b[48;2;17;34;51mhi\x1b[49m')
    expect(colors.diffRemovedBg('hi')).toBe('\x1b[48;2;68;85;102mhi\x1b[49m')
    expect(colors.diffAdded).toBe(LIGHT_COLORS.diffAdded)
    expect(ctx.mayflyThemeModels.current?.colors.diffAddedBg).toBe('#112233')
    expect(ctx.mayflyThemeModels.current?.colors.selectedBg).toBe('#E7E7F0')
  })

  it('drops invalid entries and falls back to the base palette entry', async () => {
    const ctx = new Context()
    const warns = recordWarnings(ctx)
    await mount(ctx, JSON.stringify({ text: 'red', accent: 123, roleUser: '#0a7ea4', logoInks: ['#112233', 'nope'] }))
    const { colors } = ctx.mayflyTheme
    expect(colors.text).toBe(DARK_COLORS.text)
    expect(colors.accent).toBe(DARK_COLORS.accent)
    expect(colors.roleUser('hi')).toBe('\x1b[38;2;10;126;164mhi\x1b[39m')
    expect(warns).toHaveLength(3)
  })

  it.each([
    ['not an array', '"logoInks":"#112233"'],
    ['empty', '"logoInks":[]'],
    ['short', '"logoInks":["#112233","#445566"]'],
  ])('ignores an invalid %s logo ink list', async (_label, json) => {
    const ctx = new Context()
    const warns = recordWarnings(ctx)
    await mount(ctx, `{${json}}`)
    expect(ctx.mayflyTheme.colors.logoInks).toBe(DARK_COLORS.logoInks)
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
