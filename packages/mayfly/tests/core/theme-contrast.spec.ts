/**
 * The contrast guard (roadmap slice 1.2, R13): every tone a node can name paints at least 4.5:1 against its theme's
 * background in every built-in theme. The themes paint on the terminal's own background, so each is checked against
 * the canvas it is designed for: the brand canvas of the website shots for dark, white for light, a blue-grey for
 * ocean, and cream for paper. `auto` resolves to dark or light, so the four palettes cover all five theme choices.
 */
import { describe, expect, it } from 'vitest'
import { DARK_FOREGROUNDS } from '../../src/core/theme-dark.ts'
import { LIGHT_FOREGROUNDS } from '../../src/core/theme-light.ts'
import { OCEAN_COLORS } from '../../src/core/theme-ocean.ts'
import { PAPER_COLORS } from '../../src/core/theme-paper.ts'
import type { MayflySemanticColors } from '../../src/core/types.ts'

/** The palette token each public tone paints with (`paintPluginTone` in core/plugin-view.ts). */
const TONE_TOKENS = { default: 'text', muted: 'muted', primary: 'primary', accent: 'accent', user: 'roleUser', success: 'success', warning: 'warning', danger: 'error' } as const

/** The foreground hex a palette's color function emits. */
function hexOf(paint: (text: string) => string): string {
  const match = /\x1b\[38;2;(\d+);(\d+);(\d+)m/u.exec(paint('x'))!
  return `#${match.slice(1).map(value => Number(value).toString(16).padStart(2, '0')).join('')}`
}

function luminance(hex: string): number {
  const channel = (value: number): number => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  const [r, g, b] = [1, 3, 5].map(index => channel(Number.parseInt(hex.slice(index, index + 2), 16)))
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
}

/** The WCAG contrast ratio of two colors. */
function contrast(left: string, right: string): number {
  const [light, dark] = [luminance(left), luminance(right)].toSorted((a, b) => b - a)
  return (light! + 0.05) / (dark! + 0.05)
}

const THEMES: readonly { readonly name: string, readonly background: string, readonly foregrounds: Readonly<Record<string, string>> }[] = [
  { name: 'dark', background: '#0A0A0C', foregrounds: DARK_FOREGROUNDS },
  { name: 'light', background: '#FFFFFF', foregrounds: LIGHT_FOREGROUNDS },
  { name: 'ocean', background: '#0E1A2B', foregrounds: hexes(OCEAN_COLORS) },
  { name: 'paper', background: '#F6F0E4', foregrounds: hexes(PAPER_COLORS) },
]

function hexes(colors: MayflySemanticColors): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.values(TONE_TOKENS).map(token => [token, hexOf(colors[token])]))
}

describe('theme contrast guard', () => {
  it('computes the WCAG ratio', () => {
    expect(contrast('#FFFFFF', '#000000')).toBeCloseTo(21, 5)
    expect(contrast('#000000', '#FFFFFF')).toBeCloseTo(21, 5)
    expect(contrast('#777777', '#777777')).toBe(1)
  })

  for (const theme of THEMES) {
    it(`keeps every tone of ${theme.name} at 4.5:1 or more against ${theme.background}`, () => {
      const failing = Object.entries(TONE_TOKENS)
        .map(([tone, token]) => ({ tone, ratio: contrast(theme.foregrounds[token]!, theme.background) }))
        .filter(entry => entry.ratio < 4.5)
        .map(entry => `${entry.tone} ${entry.ratio.toFixed(2)}`)
      expect(failing).toEqual([])
    })
  }
})
