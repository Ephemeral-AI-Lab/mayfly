/**
 * How the renderer presents its vocabulary on this terminal: the glyph mode, monochrome, and reduced motion. The values
 * come from the `mayfly` settings namespace (`glyphs`, `monochrome`, `reducedMotion`) and the environment (`NO_COLOR`,
 * the locale's charset). Theme providers and the components service read them once when they are built; a settings
 * change that alters them reloads the live theme provider, which rebuilds every consumer, so no painted row or cache
 * outlives the presentation it was painted for.
 *
 * @module @ephemeral-ai/mayfly/core/presentation
 */

import type { Context } from '@deepseek-ai/cordis'
import { localeGlyphMode, type MayflyGlyphMode } from './glyphs.ts'
import type { MayflyColorFn, MayflySemanticColors } from './types.ts'

/** The resolved presentation. */
export interface MayflyPresentation {
  /** The glyph vocabulary (§2.2 or its one-cell ASCII fallback). */
  readonly glyphs: MayflyGlyphMode
  /** Weight only: `primary`, `warning`, and `danger` bold, `muted` dim, no color and no background. */
  readonly monochrome: boolean
  /** Every animation channel freezes on its first frame. */
  readonly reducedMotion: boolean
}

/** The settings fields the presentation reads; anything else is ignored. */
export interface MayflyPresentationSettings {
  readonly glyphs?: unknown
  readonly monochrome?: unknown
  readonly reducedMotion?: unknown
}

type Env = Readonly<Record<string, string | undefined>>

/**
 * Whether the environment asks for no color (https://no-color.org: any non-empty `NO_COLOR`).
 * @param env - the process environment.
 * @returns true when color must be off.
 */
export function noColor(env: Env): boolean {
  return env.NO_COLOR !== undefined && env.NO_COLOR !== ''
}

/**
 * Resolve the presentation from settings and the environment. `glyphs: 'auto'` (or a missing value) follows the
 * locale's charset; `NO_COLOR` forces monochrome whatever the setting says.
 * @param settings - the `mayfly` settings, or undefined before they are readable.
 * @param env - the process environment.
 * @returns the frozen presentation.
 */
export function resolvePresentation(settings: MayflyPresentationSettings | undefined, env: Env = process.env): MayflyPresentation {
  const glyphs = settings?.glyphs === 'unicode' || settings?.glyphs === 'ascii' ? settings.glyphs : localeGlyphMode(env)
  return Object.freeze({ glyphs, monochrome: settings?.monochrome === true || noColor(env), reducedMotion: settings?.reducedMotion === true })
}

/**
 * Read the presentation from the tree's `mayfly` settings source; a tree without one (a bare test host, a provider
 * that loads before the frontend) resolves from the environment alone.
 * @param ctx - any context of the tree.
 * @returns the current presentation.
 */
export function readPresentation(ctx: Context): MayflyPresentation {
  let settings: MayflyPresentationSettings | undefined
  try {
    settings = ctx.get('mayflyInteractionState')?.settingsSource()
  } catch {
    settings = undefined
  }
  return resolvePresentation(settings)
}

/**
 * Whether two presentations paint the same.
 * @param left - one presentation.
 * @param right - the other.
 * @returns true when every field matches.
 */
export function samePresentation(left: MayflyPresentation, right: MayflyPresentation): boolean {
  return left.glyphs === right.glyphs && left.monochrome === right.monochrome && left.reducedMotion === right.reducedMotion
}

const bold: MayflyColorFn = text => `\x1b[1m${text}\x1b[22m`
const dim: MayflyColorFn = text => `\x1b[2m${text}\x1b[22m`
const plain: MayflyColorFn = text => text

/** The weight each token keeps in monochrome; every other token paints plain. */
const MONOCHROME_WEIGHT: Readonly<Partial<Record<keyof MayflySemanticColors, MayflyColorFn>>> = {
  textStrong: bold, primary: bold, warning: bold, error: bold, borderFocus: bold, mdHeading: bold,
  muted: dim, textMuted: dim, border: dim, mdLinkUrl: dim, mdCodeBlockBorder: dim, mdQuoteBorder: dim, mdHr: dim,
  diffGutter: dim, diffMeta: dim,
}

const monochromeCache = new WeakMap<MayflySemanticColors, MayflySemanticColors>()

/**
 * The monochrome form of a palette: the same tokens, painting weight only (spec §2.3: a monochrome terminal keeps
 * weight and glyphs). Backgrounds paint nothing. The result is memoized per palette, so its identity is stable.
 * @param colors - the theme's palette.
 * @returns the frozen weight-only palette.
 */
export function monochromeColors(colors: MayflySemanticColors): MayflySemanticColors {
  const cached = monochromeCache.get(colors)
  if (cached !== undefined) return cached
  const entries = Object.keys(colors).map(token => token === 'logoGradient'
    ? [token, Object.freeze(colors.logoGradient.map(() => plain))]
    : [token, MONOCHROME_WEIGHT[token as keyof MayflySemanticColors] ?? plain])
  const result = Object.freeze(Object.fromEntries(entries)) as MayflySemanticColors
  monochromeCache.set(colors, result)
  return result
}

/**
 * The palette a consumer paints with under a presentation.
 * @param colors - the theme's palette.
 * @param presentation - the active presentation.
 * @returns the theme's palette, or its monochrome form.
 */
export function presentedColors(colors: MayflySemanticColors, presentation: MayflyPresentation): MayflySemanticColors {
  return presentation.monochrome ? monochromeColors(colors) : colors
}
