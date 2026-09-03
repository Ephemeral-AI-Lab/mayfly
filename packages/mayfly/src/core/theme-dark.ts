/**
 * `mayfly-theme-dark` plugin: the built-in dark palette, providing the
 * `mayflyTheme` service contract declared in `types.ts`. Ships as a subpath
 * entry so the composing bundle lists it as its own patch row and other
 * theme plugins (light/auto/custom) can replace it fiber-for-fiber.
 * Palette values are the Mayfly brand dark scheme — pale slate ink on deep
 * navy with the hero's brand violet (`#9A86E6`) as the primary accent and
 * violet-tinted borders that keep frames and dividers legible — so the
 * default theme reads as one brand unit with the banner mark.
 * The palette construction lives in `theme-palette.ts`, shared with the rest
 * of the theme plugin family.
 *
 * @module @ephemeral-ai/mayfly/core/theme-dark
 */

import type { Context } from '@deepseek-ai/cordis'
import { colorsFromForegrounds, defineThemeService, themeModel } from './theme-palette.ts'
import type { MayflySemanticColors } from './types.ts'

export const DARK_FOREGROUNDS = {
  text: '#EDEDF2',
  textStrong: '#F5F5F7',
  muted: '#9AA3B8',
  textMuted: '#5C6476',
  accent: '#C9C0F0',
  primary: '#9A86E6',
  border: '#45406B',
  borderFocus: '#DCD7F2',
  success: '#4ec87e',
  error: '#e85454',
  warning: '#e8a838',
  roleUser: '#9A86E6',
  shellMode: '#C9C0F0',
  mdHeading: '#F5F5F7',
  mdLink: '#B9A9F0',
  mdLinkUrl: '#5C6476',
  mdCode: '#C9C0F0',
  mdCodeBlock: '#EDEDF2',
  mdCodeBlockBorder: '#45406B',
  mdQuote: '#9AA3B8',
  mdQuoteBorder: '#5C6476',
  mdHr: '#45406B',
  mdListBullet: '#C9C0F0',
  diffAdded: '#4ec87e',
  diffRemoved: '#e85454',
  diffAddedStrong: '#7ad99b',
  diffRemovedStrong: '#f08585',
  diffGutter: '#5C6476',
  diffMeta: '#9AA3B8',
  modelHighlight: '#E9E6F4',
} as const

const DARK_LOGO_GRADIENT = [
  '#F5F5F7', '#E9E5F6', '#DBD3F0', '#C9BEEA',
  '#B2A1EC', '#9A86E6', '#8371D6', '#6C5BBF',
] as const

export const DARK_SELECTED_BG = '#221E38'

/** The built-in dark palette as a frozen semantic color table. */
export const DARK_COLORS: MayflySemanticColors = colorsFromForegrounds(DARK_FOREGROUNDS, DARK_SELECTED_BG, DARK_LOGO_GRADIENT)

/**
 * The built-in `mayflyTheme` provider. Exposes the frozen semantic color
 * table; unregistered automatically when the plugin's fiber unloads.
 */
export class MayflyThemeService extends defineThemeService(DARK_COLORS, themeModel('dark', 'Dark', true, DARK_FOREGROUNDS, DARK_SELECTED_BG)) {}

/** Stable Cordis plugin name. */
export const name = 'mayfly-theme-dark'

/**
 * Provide the built-in dark palette as `ctx.mayflyTheme`.
 * @param ctx - plugin context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(MayflyThemeService)
}
