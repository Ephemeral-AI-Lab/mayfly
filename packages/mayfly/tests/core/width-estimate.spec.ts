/**
 * `estimateColumns` (core/width-estimate.ts): the cheap pre-pass the content index prices lines with. It must track
 * pi-tui's `visibleWidth` closely enough that a row map drifts only a little — exact on ASCII and the common wide
 * blocks, and never so far off that a window lands in the wrong document region.
 *
 * @module @ephemeral-ai/mayfly/core/tests/width-estimate
 */

import { describe, expect, it } from 'vitest'
import { estimateColumns } from '../../src/core/width-estimate.ts'
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

  it('tracks the measure on mixed and emoji text, counting each member of a ZWJ cluster', () => {
    // The estimate prices code points, so a four-person family cluster estimates as four emoji while the measure
    // answers two columns; under-estimates are the dangerous direction and stay inside one cell.
    for (const text of ['a🙂b', 'family 👨‍👩‍👧‍👦 here', 'café', 'naïve résumé', 'flag 🇨🇳 pair', 'é composed']) {
      expect(estimate(text) - visibleWidth(text), JSON.stringify(text)).toBeGreaterThanOrEqual(-1)
      expect(estimate(text) - visibleWidth(text), JSON.stringify(text)).toBeLessThanOrEqual(8)
    }
  })

  it('reads only the asked range', () => {
    const text = 'xx中文yy'
    expect(estimateColumns(text, 2, 4)).toBe(4)
    expect(estimateColumns(text, 0, 2)).toBe(2)
  })

  it.each(ADVERSARIAL)('keeps the $name fixture within an error the row map can absorb', ({ text }) => {
    // Estimates may drift a little either way — a ZWJ sequence counts its members, a rare wide block counts one — but
    // never by more than the text's own length, which would corrupt the segment map instead of nudging it.
    expect(Math.abs(estimate(text) - visibleWidth(text)), JSON.stringify(text.slice(0, 40))).toBeLessThanOrEqual(Math.max(8, text.length))
  })
})
