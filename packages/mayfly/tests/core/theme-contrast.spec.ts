/**
 * The contrast guard (roadmap slice 1.2, R13): every tone a node can name paints at least 4.5:1 against the canvas its
 * built-in palette is designed for. Themes paint on the terminal's own background, so each palette in `palettes.ts`
 * carries the canvas it was checked against.
 */
import { describe, expect, it } from 'vitest'
import { PALETTES } from '../../src/core/palettes.ts'

/** The palette token each public tone paints with (`paintPluginTone` in core/plugin-view.ts). */
const TONE_TOKENS = { default: 'text', muted: 'muted', primary: 'primary', accent: 'accent', user: 'roleUser', success: 'success', warning: 'warning', danger: 'error' } as const

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

const THEMES = PALETTES.map(palette => ({ name: palette.key, background: palette.canvas, foregrounds: palette.foregrounds }))

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
