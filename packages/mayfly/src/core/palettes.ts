/**
 * The ten built-in palettes, by key: Mayfly Dark (the default) and Mayfly Light, Tide, Dusk, and Graphite (dark),
 * Linen, Mist, and Heather (light), and the high-contrast Obsidian and Porcelain. Each has a name and a one-line idea
 * for the `/theme` picker, the canvas it is designed and checked on, and its token tables. The values come from
 * `docs/design/prototypes/theme-palettes.mjs`, whose `--check` holds them to one recipe: four neutral inks of one quiet
 * hue, one brand hue for `primary` and the tokens around it, the status hues fixed and 45° or more from `primary`.
 * Data only; `theme-dark.ts` and `theme-builtin.ts` provide them as `mayflyTheme`.
 *
 * @module @ephemeral-ai/mayfly/core/palettes
 */

import { colorsFromForegrounds, themeModel, type MayflyBackgroundHexes, type MayflyForegroundHexes } from './theme-palette.ts'
import type { MayflySemanticColors } from './types.ts'

/** One built-in palette. */
export interface MayflyPalette {
  /** The `/theme` key and the `mayfly.theme` setting value. */
  readonly key: string
  /** The display name. A proper noun, never translated. */
  readonly name: string
  /** The picker's one-line description, in English (the interaction locale translates it). */
  readonly idea: string
  /** Whether the palette is drawn for a dark terminal background. */
  readonly dark: boolean
  /** `high` for the palettes whose tones reach 7:1. */
  readonly contrast?: 'high'
  /** The terminal background the palette is designed and checked on. Themes paint no background. */
  readonly canvas: string
  readonly foregrounds: MayflyForegroundHexes
  readonly backgrounds: MayflyBackgroundHexes
  /** The banner mark's inks: body, wings, and the trail from nearest to farthest. */
  readonly logoInks: readonly string[]
}

type OwnHexes = Pick<MayflyForegroundHexes, 'text' | 'textStrong' | 'muted' | 'textMuted' | 'accent' | 'primary' | 'border' | 'success' | 'error' | 'warning' | 'mdLink' | 'modelHighlight'>

/** The tokens every palette but the default repeats from its own: the recipe's aliases. */
function aliased(own: OwnHexes): MayflyForegroundHexes {
  return {
    ...own,
    roleUser: own.primary,
    shellMode: own.accent,
    mdHeading: own.textStrong,
    mdLinkUrl: own.textMuted,
    mdCode: own.accent,
    mdCodeBlock: own.text,
    mdCodeBlockBorder: own.border,
    mdQuote: own.muted,
    mdQuoteBorder: own.textMuted,
    mdHr: own.border,
    mdListBullet: own.accent,
    diffAdded: own.success,
    diffRemoved: own.error,
    diffMeta: own.muted,
  }
}

/** The built-in palettes in picker order. */
export const PALETTES = [
  {
    key: 'dark',
    name: 'Mayfly Dark',
    idea: 'the default violet',
    dark: true,
    canvas: '#0A0A0C',
    foregrounds: {
      text: '#EDEDF2', textStrong: '#F5F5F7', muted: '#9AA3B8', textMuted: '#5C6476', accent: '#C9C0F0',
      primary: '#9A86E6', border: '#45406B', success: '#4EC87E', error: '#E85454', warning: '#E8A838',
      roleUser: '#9A86E6', shellMode: '#C9C0F0', mdHeading: '#F5F5F7', mdLink: '#B9A9F0', mdLinkUrl: '#5C6476',
      mdCode: '#C9C0F0', mdCodeBlock: '#EDEDF2', mdCodeBlockBorder: '#45406B', mdQuote: '#9AA3B8',
      mdQuoteBorder: '#5C6476', mdHr: '#45406B', mdListBullet: '#C9C0F0', diffAdded: '#4EC87E',
      diffRemoved: '#E85454', diffMeta: '#9AA3B8', modelHighlight: '#E9E6F4',
    },
    backgrounds: { selectedBg: '#2B2B30', diffAddedBg: '#1E3A2B', diffRemovedBg: '#43232A' },
    logoInks: ['#9A86E6', '#CFC6F5', '#7D6BCB', '#5F519F', '#433A73'],
  },
  {
    key: 'light',
    name: 'Mayfly Light',
    idea: 'the default on white',
    dark: false,
    canvas: '#FFFFFF',
    foregrounds: aliased({
      text: '#2A2A33', textStrong: '#15151B', muted: '#626270', textMuted: '#838391', accent: '#4F417E',
      primary: '#6D52BC', border: '#B7B3D0', success: '#137738', error: '#BE2E31', warning: '#935F01',
      mdLink: '#5E499D', modelHighlight: '#36314D',
    }),
    backgrounds: { selectedBg: '#E7E7F0', diffAddedBg: '#DCF9E1', diffRemovedBg: '#FFEDEC' },
    logoInks: ['#6D52BC', '#ACA0E5', '#8F7ADC', '#AC9EEC', '#CBC3F7'],
  },
  {
    key: 'tide',
    name: 'Tide',
    idea: 'deep water, an aqua brand',
    dark: true,
    canvas: '#08191D',
    foregrounds: aliased({
      text: '#EAEFF0', textStrong: '#F4F6F6', muted: '#91A8AE', textMuted: '#5D7177', accent: '#9CD3D9',
      primary: '#0DABB9', border: '#215C63', success: '#4EC87E', error: '#E85454', warning: '#E8A838',
      mdLink: '#6EC6D0', modelHighlight: '#DDECED',
    }),
    backgrounds: { selectedBg: '#313738', diffAddedBg: '#274334', diffRemovedBg: '#4E2D34' },
    logoInks: ['#0DABB9', '#A5D8DE', '#038D99', '#036C76', '#014E55'],
  },
  {
    key: 'dusk',
    name: 'Dusk',
    idea: 'warm plum, an orchid brand',
    dark: true,
    canvas: '#1B1118',
    foregrounds: aliased({
      text: '#F0ECEF', textStrong: '#F6F5F6', muted: '#AE9EA8', textMuted: '#766870', accent: '#E0BAD7',
      primary: '#C47BB5', border: '#66445F', success: '#4EC87E', error: '#E85454', warning: '#E8A838',
      mdLink: '#D8A1CB', modelHighlight: '#EFE4EC',
    }),
    backgrounds: { selectedBg: '#363335', diffAddedBg: '#254132', diffRemovedBg: '#4C2B32' },
    logoInks: ['#C47BB5', '#E5C1DC', '#A76099', '#834777', '#5E3355'],
  },
  {
    key: 'linen',
    name: 'Linen',
    idea: 'ink on paper',
    dark: false,
    canvas: '#F8F3E9',
    foregrounds: aliased({
      text: '#302A23', textStrong: '#191510', muted: '#6B6256', textMuted: '#8C8378', accent: '#2E4D7B',
      primary: '#3268B6', border: '#AAB9CE', success: '#137738', error: '#BE2E31', warning: '#935F01',
      mdLink: '#305A98', modelHighlight: '#28364B',
    }),
    backgrounds: { selectedBg: '#E1DBD4', diffAddedBg: '#D0EED5', diffRemovedBg: '#FDDEDD' },
    logoInks: ['#3268B6', '#8AADE1', '#5C8DD6', '#85ADE7', '#B3CDF3'],
  },
  {
    key: 'mist',
    name: 'Mist',
    idea: 'teal on a pale blue-white',
    dark: false,
    canvas: '#F3F8FA',
    foregrounds: aliased({
      text: '#252D2F', textStrong: '#111719', muted: '#59666A', textMuted: '#7B878B', accent: '#05585F',
      primary: '#047781', border: '#A1BEC1', success: '#137738', error: '#BE2E31', warning: '#935F01',
      mdLink: '#016770', modelHighlight: '#193B3F',
    }),
    backgrounds: { selectedBg: '#D9E2E4', diffAddedBg: '#D4F1D9', diffRemovedBg: '#FEE2E1' },
    logoInks: ['#047781', '#82B5BB', '#4A9AA3', '#7CB6BD', '#ADD2D7'],
  },
  {
    key: 'graphite',
    name: 'Graphite',
    idea: 'neutral greys, a cobalt brand',
    dark: true,
    canvas: '#141414',
    foregrounds: aliased({
      text: '#EEEEEE', textStrong: '#F5F5F5', muted: '#A3A3A3', textMuted: '#6C6C6C', accent: '#ADCAF4',
      primary: '#5F98EC', border: '#375178', success: '#4EC87E', error: '#E85454', warning: '#E8A838',
      mdLink: '#8DB7F6', modelHighlight: '#E1E9F5',
    }),
    backgrounds: { selectedBg: '#333333', diffAddedBg: '#244131', diffRemovedBg: '#4B2A32' },
    logoInks: ['#5F98EC', '#B3CFF9', '#457CCE', '#305FA3', '#214476'],
  },
  {
    key: 'heather',
    name: 'Heather',
    idea: 'lilac-grey, a plum brand',
    dark: false,
    canvas: '#F8F4F9',
    foregrounds: aliased({
      text: '#2E2930', textStrong: '#181419', muted: '#68606A', textMuted: '#8A818C', accent: '#693A5F',
      primary: '#974688', border: '#C6B0C0', success: '#137738', error: '#BE2E31', warning: '#935F01',
      mdLink: '#804073', modelHighlight: '#432D3E',
    }),
    backgrounds: { selectedBg: '#E2DCE3', diffAddedBg: '#D3F0D7', diffRemovedBg: '#FEE0DF' },
    logoInks: ['#974688', '#CD97C0', '#BA6EAA', '#D194C3', '#E5BCDB'],
  },
  {
    key: 'obsidian',
    name: 'Obsidian',
    idea: 'high contrast on black',
    dark: true,
    contrast: 'high',
    canvas: '#000000',
    foregrounds: aliased({
      text: '#FFFFFF', textStrong: '#FFFFFF', muted: '#CFCFE1', textMuted: '#A2A2B7', accent: '#DED8FF',
      primary: '#B9A9FF', border: '#7B70AB', success: '#61E293', error: '#FF7E79', warning: '#FFC252',
      mdLink: '#CBC1FF', modelHighlight: '#EEECFB',
    }),
    backgrounds: { selectedBg: '#34353B', diffAddedBg: '#143525', diffRemovedBg: '#421F27' },
    logoInks: ['#B9A9FF', '#D7D1FB', '#9D8DE1', '#7F71B7', '#61578B'],
  },
  {
    key: 'porcelain',
    name: 'Porcelain',
    idea: 'high contrast on white',
    dark: false,
    contrast: 'high',
    canvas: '#FFFFFF',
    foregrounds: aliased({
      text: '#0D0D11', textStrong: '#030306', muted: '#3C3C47', textMuted: '#595967', accent: '#362365',
      primary: '#5330A0', border: '#8179A7', success: '#0B5D2A', error: '#971A20', warning: '#6F4606',
      mdLink: '#472D85', modelHighlight: '#201C31',
    }),
    backgrounds: { selectedBg: '#DDDDE6', diffAddedBg: '#D1F2D7', diffRemovedBg: '#FEDFDE' },
    logoInks: ['#5330A0', '#8D80C7', '#7259BF', '#8E7ECF', '#ABA3D8'],
  },
] as const satisfies readonly MayflyPalette[]

/** A built-in palette's key. */
export type MayflyPaletteKey = typeof PALETTES[number]['key']

/** The built-in palette keys in picker order. */
export const PALETTE_KEYS: readonly MayflyPaletteKey[] = PALETTES.map(palette => palette.key)

const BY_KEY: ReadonlyMap<string, MayflyPalette> = new Map(PALETTES.map(palette => [palette.key, palette]))

/** Whether a string names a built-in palette. */
export function isPaletteKey(key: string): key is MayflyPaletteKey {
  return BY_KEY.has(key)
}

/** The built-in palette of a key. */
export function paletteOf(key: MayflyPaletteKey): MayflyPalette {
  return BY_KEY.get(key)!
}

/** Every built-in palette as a frozen semantic color table, built once. */
const COLORS: ReadonlyMap<string, MayflySemanticColors> = new Map(PALETTES.map(palette => [palette.key, colorsFromForegrounds(palette.foregrounds, palette.backgrounds, palette.logoInks)]))

/** A built-in palette as a frozen semantic color table; the same table on every call. */
export function paletteColors(key: MayflyPaletteKey): MayflySemanticColors {
  return COLORS.get(key)!
}

/** The renderer-neutral model of a built-in palette, registered in `mayflyThemeModels` by its provider. */
export function paletteModel(key: MayflyPaletteKey): ReturnType<typeof themeModel> {
  const palette = paletteOf(key)
  return themeModel(palette.key, palette.name, palette.dark, palette.foregrounds, palette.backgrounds)
}
