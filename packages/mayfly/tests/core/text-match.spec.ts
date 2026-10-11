/** Block-wise prefix and suffix matching (core/text-match.ts) against the unit-by-unit definition.
 * @module @ephemeral-ai/mayfly/core/tests/text-match
 */

import { describe, expect, it } from 'vitest'
import { commonPrefix, commonSuffix } from '../../src/core/text-match.ts'

const naivePrefix = (a: string, b: string, limit: number): number => {
  let length = 0
  while (length < limit && a[length] === b[length]) length += 1
  return length
}
const naiveSuffix = (a: string, b: string, limit: number): number => {
  let length = 0
  while (length < limit && a[a.length - length - 1] === b[b.length - length - 1]) length += 1
  return length
}

describe('commonPrefix and commonSuffix', () => {
  it('stop at the first differing unit wherever it falls against the block size', () => {
    const base = 'abcdefghij'.repeat(1_700)
    for (const at of [0, 1, 4_095, 4_096, 4_097, 8_191, 8_192, 8_193, 12_000, base.length - 1]) {
      const changed = `${base.slice(0, at)}!${base.slice(at + 1)}`
      const limit = base.length
      expect(commonPrefix(base, changed, limit), `prefix, change at ${String(at)}`).toBe(at)
      expect(commonSuffix(base, changed, limit), `suffix, change at ${String(at)}`).toBe(limit - at - 1)
    }
  })

  it('agree with the unit-by-unit definition on equal, shifted, and unequal-length texts', () => {
    const base = 'line of output\n'.repeat(1_200)
    const cases: [string, string][] = [
      [base, base],
      [base, `${base}more`],
      [`more${base}`, base],
      [base.slice(7), base],
      [base, base.slice(0, 9_000)],
      ['', base],
    ]
    for (const [a, b] of cases) {
      const limit = Math.min(a.length, b.length)
      expect(commonPrefix(a, b, limit)).toBe(naivePrefix(a, b, limit))
      expect(commonSuffix(a, b, limit)).toBe(naiveSuffix(a, b, limit))
      for (const part of [0, 5, 4_096, limit >> 1]) {
        expect(commonPrefix(a, b, part)).toBe(naivePrefix(a, b, part))
        expect(commonSuffix(a, b, part)).toBe(naiveSuffix(a, b, part))
      }
    }
  })
})
