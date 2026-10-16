/**
 * `mayfly-theme-dark` plugin: the default palette, Mayfly Dark, providing the
 * `mayflyTheme` service contract declared in `types.ts`. Ships as a subpath
 * entry because it is the bundle's baseline patch row; `/theme` replaces it
 * fiber-for-fiber with `mayfly-theme-builtin`, `-auto`, or `-custom`. Its values
 * are the `dark` entry of `palettes.ts`: pale slate ink on near-black with the
 * brand violet (`#9A86E6`) as the primary accent.
 *
 * @module @ephemeral-ai/mayfly/core/theme-dark
 */

import type { Context } from '@deepseek-ai/cordis'
import { paletteColors, paletteModel, paletteOf } from './palettes.ts'
import { defineThemeService } from './theme-palette.ts'
import type { MayflySemanticColors } from './types.ts'

/** The default palette's foreground hexes. */
export const DARK_FOREGROUNDS = paletteOf('dark').foregrounds

/** The default palette's background hexes. */
export const DARK_BACKGROUNDS = paletteOf('dark').backgrounds

/** The default palette as a frozen semantic color table. */
export const DARK_COLORS: MayflySemanticColors = paletteColors('dark')

/**
 * The default `mayflyTheme` provider. Exposes the frozen semantic color
 * table; unregistered automatically when the plugin's fiber unloads.
 */
export class MayflyThemeService extends defineThemeService(DARK_COLORS, paletteModel('dark')) {}

/** Stable Cordis plugin name. */
export const name = 'mayfly-theme-dark'

/**
 * Provide the default palette as `ctx.mayflyTheme`.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(MayflyThemeService)
}
