/**
 * `mayfly-theme-builtin` plugin: any built-in palette of `palettes.ts` by its
 * key, providing the `mayflyTheme` service contract declared in `types.ts`.
 * `/theme <key>` and the `mayfly.theme` setting mount it with the palette in
 * its config, replacing the live provider fiber-for-fiber; the default palette
 * keeps its own baseline row, `mayfly-theme-dark`.
 *
 * @module @ephemeral-ai/mayfly/core/theme-builtin
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { PALETTE_KEYS, paletteColors, paletteModel, type MayflyPaletteKey } from './palettes.ts'
import { defineThemeService } from './theme-palette.ts'

/** Stable Cordis plugin name. */
export const name = 'mayfly-theme-builtin'

/** Plugin config: which built-in palette to provide. */
export interface Config {
  palette: MayflyPaletteKey
}

/** Validated plugin config; `palette` defaults to the default palette. */
export const Config: z<Config> = z.object({
  palette: z.union(PALETTE_KEYS.map(key => z.const(key))).default('dark'),
})

/**
 * Provide the configured built-in palette as `ctx.mayflyTheme`.
 * @param ctx - plugin context.
 * @param config - validated plugin config.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.plugin(defineThemeService(paletteColors(config.palette), paletteModel(config.palette)))
}
