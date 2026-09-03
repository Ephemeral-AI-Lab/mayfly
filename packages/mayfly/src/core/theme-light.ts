/**
 * `mayfly-theme-light` plugin: the built-in light palette, providing the
 * `mayflyTheme` service contract declared in `types.ts`. Ships as a subpath
 * entry so it can replace `mayfly-theme-dark` fiber-for-fiber in the bundle
 * patch and serve `mayfly-theme-auto` / `mayfly-theme-custom` as a base
 * palette. Palette values are tuned for light terminal backgrounds (dark
 * text, muted mid-grays), loosely following GitHub's light primer scale.
 *
 * @module @ephemeral-ai/mayfly/core/theme-light
 */

import type { Context } from '@deepseek-ai/cordis'
import { colorsFromForegrounds, defineThemeService, themeModel } from './theme-palette.ts'
import type { MayflySemanticColors } from './types.ts'

export const LIGHT_FOREGROUNDS = {
  text: '#1f2328',
  textStrong: '#0a0c10',
  muted: '#6a737d',
  textMuted: '#8c959f',
  accent: '#0a9db0',
  primary: '#0969da',
  border: '#6e7781',
  borderFocus: '#9a6700',
  success: '#1a7f37',
  error: '#cf222e',
  warning: '#9a6700',
  roleUser: '#2e3fb8',
  shellMode: '#8250df',
  mdHeading: '#1f2328',
  mdLink: '#0969da',
  mdLinkUrl: '#8c959f',
  mdCode: '#0969da',
  mdCodeBlock: '#24292f',
  mdCodeBlockBorder: '#8c959f',
  mdQuote: '#6a737d',
  mdQuoteBorder: '#6a737d',
  mdHr: '#6e7781',
  mdListBullet: '#1f2328',
  diffAdded: '#1a7f37',
  diffRemoved: '#cf222e',
  diffAddedStrong: '#116329',
  diffRemovedStrong: '#a40e26',
  diffGutter: '#8c959f',
  diffMeta: '#6a737d',
  modelHighlight: '#1d4fd7',
} as const

const LIGHT_LOGO_GRADIENT = [
  '#0a2c6b', '#103581', '#164097', '#1d4ba9',
  '#2f66cd', '#3d77dd', '#4f8ae8', '#63a0f2',
] as const

export const LIGHT_SELECTED_BG = '#d0d7de'

/** The built-in light palette as a frozen semantic color table. */
export const LIGHT_COLORS: MayflySemanticColors = colorsFromForegrounds(LIGHT_FOREGROUNDS, LIGHT_SELECTED_BG, LIGHT_LOGO_GRADIENT)

/**
 * The light `mayflyTheme` provider. Exposes the frozen semantic color table;
 * unregistered automatically when the plugin's fiber unloads.
 */
export class MayflyThemeService extends defineThemeService(LIGHT_COLORS, themeModel('light', 'Light', false, LIGHT_FOREGROUNDS, LIGHT_SELECTED_BG)) {}

/** Stable Cordis plugin name. */
export const name = 'mayfly-theme-light'

/**
 * Provide the built-in light palette as `ctx.mayflyTheme`.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(MayflyThemeService)
}
