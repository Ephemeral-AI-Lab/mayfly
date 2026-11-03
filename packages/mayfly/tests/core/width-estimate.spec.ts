/**
 * `estimateColumns` (core/width-estimate.ts): the cheap pre-pass the content index prices lines with. It must track
 * pi-tui's `visibleWidth` closely enough that a row map drifts only a little — exact on ASCII and the common wide
 * blocks, and never so far off that a window lands in the wrong document region.
 *
 * @module @ephemeral-ai/mayfly/core/tests/width-estimate
 */

import { describe, expect, it } from 'vitest'
import { estimateColumns, startColumnWalk, walkColumns } from '../../src/core/width-estimate.ts'
import { visibleWidth } from '../../src/core/width.ts'
import { ADVERSARIAL } from './width-scan.ts'

const estimate = (text: string): number => estimateColumns(text, 0, text.length)

describe('estimateColumns', () => {
  it('is exact on printable ASCII, counts a tab as three columns, and ignores controls', () => {
    expect(estimate('hello world')).toBe(11)
    expect(estimate('a\tb')).toBe(5)
    expect(estimate('a\x00b\x7f')).toBe(2)
    expect(estimate('')).toBe(0)
  })

  it('matches the measure on the common wide blocks and surrogate pairs', () => {
    for (const text of ['中文测试', 'こんにちは', '한국어', 'ｆｕｌｌｗｉｄｔｈ', 'a中b', '𝕏𝕐𝕑', '你好，世界！']) {
      expect(estimate(text), JSON.stringify(text)).toBe(visibleWidth(text))
    }
  })

  it('tracks the measure on mixed text', () => {
    for (const text of ['a🙂b', 'café', 'naïve résumé', 'é composed']) {
      expect(estimate(text), JSON.stringify(text)).toBe(visibleWidth(text))
    }
  })

  it('counts an emoji sequence once, as the measure does', () => {
    // A ZWJ family, a flag, a toned person, a pictograph with its selector, a keycap, and a joined profession are two cells each.
    for (const text of ['👨‍👩‍👧‍👦', '🇨🇳', '🏳️‍🌈', '👍🏽', '✌🏽', '❤️', '☀️', '1️⃣', '🏃‍♀️', '🧑‍💻', 'family 👨‍👩‍👧‍👦 here', 'flag 🇨🇳 pair', '🇺🇸🇯🇵', '🇯']) {
      expect(estimate(text), JSON.stringify(text)).toBe(visibleWidth(text))
    }
    // Every other joiner use stays priced by its code points: a ZWJ between letters joins nothing.
    expect(estimate('x\u200dy')).toBe(visibleWidth('x\u200dy'))
  })

  it('agrees with the measure over random strings of those pieces', () => {
    const pieces = ['a', 'ab', ' ', '中', '你好', '🙂', '😀', '👨‍👩‍👧‍👦', '👩🏽', '👍🏻', '🇨🇳', '🇺🇸', '🇯', '❤️', '☀️', '1️⃣', '🏃‍♀️', 'é', 'e\u0301', '🧑‍💻', '🏳️‍🌈', 'x\u200dy', '©', '™️']
    let seed = 5
    const random = (limit: number): number => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed % limit }
    for (let round = 0; round < 500; round += 1) {
      const text = Array.from({ length: 1 + random(8) }, () => pieces[random(pieces.length)]!).join('')
      expect(estimate(text), JSON.stringify(text)).toBe(visibleWidth(text))
    }
  })

  it('carries a cluster across the ranges of one walk and starts every line afresh', () => {
    // The cut and seek loops price a line one code point at a time with one walk; a fresh range prices from the start.
    const family = '👨‍👩‍👧‍👦'
    const walk = startColumnWalk()
    let total = 0
    for (let index = 0; index < family.length; index += family.codePointAt(index)! > 0xffff ? 2 : 1) total += walkColumns(walk, family, index, index + (family.codePointAt(index)! > 0xffff ? 2 : 1))
    expect(total).toBe(visibleWidth(family))
    expect(estimateColumns(family, 0, 2) + estimateColumns(family, 2, family.length)).toBeGreaterThan(visibleWidth(family))
  })

  it('prices CJK Extension B points and lone surrogates safely', () => {
    // U+20000 lands in the Extension B range, one cell past the last common block.
    expect(estimate('𠀀')).toBe(visibleWidth('𠀀'))
    // A high surrogate with no low partner prices as its own code point, never a hang.
    expect(estimate('a\ud800b')).toBe(visibleWidth('a\ud800b'))
    expect(estimate('x\udfffy')).toBe(visibleWidth('x\udfffy'))
  })

  it('reads only the asked range', () => {
    const text = 'xx中文yy'
    expect(estimateColumns(text, 2, 4)).toBe(4)
    expect(estimateColumns(text, 0, 2)).toBe(2)
  })

  it.each(ADVERSARIAL)('keeps the $name fixture within an error the row map can absorb', ({ text }) => {
    // Estimates may drift a little either way — a rare wide block counts one, an escape sequence counts its letters — but
    // never by more than the text's own length, which would corrupt the segment map instead of nudging it.
    expect(Math.abs(estimate(text) - visibleWidth(text)), JSON.stringify(text.slice(0, 40))).toBeLessThanOrEqual(Math.max(8, text.length))
  })
})
