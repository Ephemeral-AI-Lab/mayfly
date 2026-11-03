/**
 * How a theme key reads to people: the `/theme` picker's names, lines, and groups, and the labels of the `/settings`
 * and first-run theme fields. A palette's name is a proper noun and stays as it is; `Auto`, the lines, the group
 * headings, and the dark or light tag are translated by the interaction locale.
 *
 * @module @ephemeral-ai/mayfly/interaction/theme-names
 */

import type { MayflyTranslate } from '../frontend/locale.ts'
import { isPaletteKey, paletteOf } from '../core/palettes.ts'

/** The display name of `auto`; it is not a palette, so it is translated. */
const AUTO_NAME = 'Auto'

/** The picker's line for `auto`. */
const AUTO_IDEA = 'Mayfly Dark or Light, as the terminal'

/** The picker's group headings: where a palette reads as designed. */
const GROUP_DARK = 'For dark terminals'
const GROUP_LIGHT = 'For light terminals'

/** The display name of a theme key: a palette's name, `Auto` translated, or the key itself. */
export function themeName(key: string, t: MayflyTranslate): string {
  if (key === 'auto') return t(AUTO_NAME)
  return isPaletteKey(key) ? paletteOf(key).name : key
}

/** The picker's line under a theme key's name, translated; empty for a key that is neither a palette nor `auto`. */
export function themeIdea(key: string, t: MayflyTranslate): string {
  if (key === 'auto') return t(AUTO_IDEA)
  return isPaletteKey(key) ? t(paletteOf(key).idea) : ''
}

/** The picker's group of a theme key: dark or light terminals for a palette; none (a blank row) for `auto`. */
export function themeGroup(key: string, t: MayflyTranslate): string {
  if (!isPaletteKey(key)) return ''
  return t(paletteOf(key).dark ? GROUP_DARK : GROUP_LIGHT)
}

/** A theme key's label in a single list (`/settings`, the first-run guide): the name with its dark or light tag. */
export function themeLabel(key: string, t: MayflyTranslate): string {
  if (!isPaletteKey(key)) return themeName(key, t)
  const { name, dark } = paletteOf(key)
  return t(dark ? '{name} (dark)' : '{name} (light)', { name })
}
