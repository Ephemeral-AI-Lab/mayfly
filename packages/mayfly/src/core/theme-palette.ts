/**
 * Shared palette machinery for the theme plugin family (`mayfly-theme-dark`,
 * `mayfly-theme-light`, `mayfly-theme-auto`, `mayfly-theme-custom`): the hex →
 * ANSI truecolor wrappers, the hex table → frozen semantic color table
 * builder, and the `mayflyTheme` Service subclass factory. Internal module —
 * not a package subpath export; the theme plugins are the public surface.
 *
 * @module @ephemeral-ai/mayfly/core/theme-palette
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { MayflyColorFn, MayflySemanticColors, MayflyTheme } from './types.ts'
import type { ThemeModel } from '../frontend/index.ts'

/**
 * Wrap text in a truecolor foreground.
 * @param hex - the color as `#rrggbb`.
 * @returns a color function emitting `38;2` / `39` sequences.
 */
export function foregroundColor(hex: string): MayflyColorFn {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return text => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`
}

/**
 * Wrap text in a truecolor background.
 * @param hex - the color as `#rrggbb`.
 * @returns a color function emitting `48;2` / `49` sequences.
 */
export function backgroundColor(hex: string): MayflyColorFn {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return text => `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`
}

/**
 * The 27 foreground tokens of a palette as `#rrggbb` hexes. `selectedBg`
 * is excluded: it is the palette's only background token and is passed
 * separately to {@link colorsFromForegrounds}.
 */
export type MayflyForegroundHexes = Record<Exclude<keyof MayflySemanticColors, 'selectedBg' | 'logoGradient'>, string>

/** Build the renderer-neutral companion model for a semantic palette. */
export function themeModel(id: string, name: string, dark: boolean, foregrounds: MayflyForegroundHexes, selectedBg: string): Omit<ThemeModel, 'colors'> & { readonly colors: Readonly<Record<string, string>> } {
  return { kind: 'theme', id, name, dark, colors: Object.freeze({ ...foregrounds, selectedBg }) }
}

/**
 * Build the frozen 28-token semantic color table from palette hexes.
 * @param foregrounds - one hex per foreground token.
 * @param selectedBg - the hex behind the selected list entry.
 * @returns the frozen semantic color table.
 */
export function colorsFromForegrounds(foregrounds: MayflyForegroundHexes, selectedBg: string, logoGradient: readonly string[]): MayflySemanticColors {
  const colors = Object.fromEntries(
    Object.entries(foregrounds).map(([role, hex]) => [role, foregroundColor(hex)]),
  )
  return Object.freeze({
    ...colors,
    selectedBg: backgroundColor(selectedBg),
    logoGradient: Object.freeze(logoGradient.map(hex => foregroundColor(hex))),
  }) as MayflySemanticColors
}

/** Constructor shape of the `mayflyTheme` providers built by {@link defineThemeService}. */
export type MayflyThemeServiceClass = new (ctx: Context) => Service & MayflyTheme

/**
 * Build a `mayflyTheme` Service subclass around one frozen color table. The
 * returned class registers itself on construction and unregisters when its
 * fiber unloads, so theme plugins can swap providers fiber-for-fiber.
 * @param colors - the frozen semantic color table to expose.
 * @returns a Service subclass mountable via `ctx.plugin`.
 */
export function defineThemeService(colors: MayflySemanticColors, model?: Omit<ThemeModel, 'colors'> & { readonly colors: Readonly<Record<string, string>> }): MayflyThemeServiceClass {
  return class extends Service implements MayflyTheme {
    readonly colors = colors

    /**
     * Create and register the service.
     * @param ctx - the owning Cordis context.
     */
    constructor(ctx: Context) {
      super(ctx, 'mayflyTheme')
      const models = ctx.get('mayflyThemeModels')
      if (models !== undefined && model !== undefined) ctx.effect(() => models.register(model))
    }
  }
}
