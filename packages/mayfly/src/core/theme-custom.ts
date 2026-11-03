/**
 * `mayfly-theme-custom` plugin: a user palette loaded from a JSON file and
 * layered over a built-in base palette (any key of `palettes.ts`). The file
 * maps semantic token names to `#rrggbb` hexes, and `logoInks` to the banner
 * mark's five inks; entries that name unknown tokens or carry invalid
 * colors are dropped (with a warning) and fall back to the base palette
 * entry, and an unreadable or malformed file falls back to the whole base
 * palette. Ships as a subpath entry so it can replace `mayfly-theme-dark`
 * fiber-for-fiber in the bundle patch.
 *
 * @module @ephemeral-ai/mayfly/core/theme-custom
 */

import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PALETTE_KEYS, paletteColors, paletteOf, type MayflyPaletteKey } from './palettes.ts'
import { BACKGROUND_TOKENS, LOGO_INK_COUNT, backgroundColor, defineThemeService, foregroundColor, themeModel } from './theme-palette.ts'
import type { MayflyColorFn, MayflySemanticColors } from './types.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-theme-custom'

/** Plugin config: the palette file and the base palette beneath it. */
export interface Config {
  /** Path to the JSON palette file. */
  path: string
  /** Built-in palette for tokens the file does not override. Defaults to `'dark'`. */
  base: MayflyPaletteKey
}

/** Validated plugin config; `base` defaults to `'dark'`. */
export const Config: z<Config> = z.object({
  path: z.string().required(),
  base: z.union(PALETTE_KEYS.map(key => z.const(key))).default('dark'),
})

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

/**
 * Provide the file-defined palette as `ctx.mayflyTheme`, falling back to the
 * base palette wherever the file does not supply a valid token.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const logger = ctx.logger(name)
  const palette = paletteOf(config.base)
  const base = paletteColors(config.base)
  const baseModel = themeModel('custom', 'Custom', palette.dark, palette.foregrounds, palette.backgrounds)
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(config.path, 'utf8'))
  } catch {
    logger.warn('cannot load theme file %s; using the %s base palette', config.path, config.base)
    ctx.plugin(defineThemeService(base, baseModel))
    return
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.warn('theme file %s is not a token object; using the %s base palette', config.path, config.base)
    ctx.plugin(defineThemeService(base, baseModel))
    return
  }
  const overrides: Record<string, MayflyColorFn | readonly MayflyColorFn[]> = {}
  const rawOverrides: Record<string, string> = {}
  for (const [token, value] of Object.entries(parsed)) {
    if (!Object.hasOwn(base, token)) {
      logger.warn('ignoring unknown theme token %s', token)
      continue
    }
    if (token === 'logoInks') {
      if (!Array.isArray(value) || value.length !== LOGO_INK_COUNT || value.some(entry => typeof entry !== 'string' || !HEX_COLOR.test(entry))) {
        logger.warn('ignoring invalid inks for theme token %s (%d hexes expected); using the base palette entry', token, LOGO_INK_COUNT)
        continue
      }
      overrides[token] = Object.freeze(value.map(entry => foregroundColor(entry)))
      continue
    }
    if (typeof value !== 'string' || !HEX_COLOR.test(value)) {
      logger.warn('ignoring invalid color for theme token %s; using the base palette entry', token)
      continue
    }
    overrides[token] = BACKGROUND_TOKENS.has(token) ? backgroundColor(value) : foregroundColor(value)
    rawOverrides[token] = value
  }
  ctx.plugin(defineThemeService(Object.freeze({ ...base, ...overrides }) as MayflySemanticColors, { ...baseModel, colors: Object.freeze({ ...baseModel.colors, ...rawOverrides }) }))
}
