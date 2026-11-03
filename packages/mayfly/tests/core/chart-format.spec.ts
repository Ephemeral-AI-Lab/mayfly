/** Axis number text shared by the chart painters: plain integers, compact
 * decimal units, and scientific values that must not be corrupted.
 * @module @ephemeral-ai/mayfly/tests/core/chart-format
 */
import { describe, expect, it } from 'vitest'
import { compactChartNumber, formatChartNumber } from '../../src/core/chart-format.ts'

describe('formatChartNumber', () => {
  it('keeps integers exact and rounds a fraction to four significant digits', () => {
    expect(formatChartNumber(0)).toBe('0')
    expect(formatChartNumber(-7)).toBe('-7')
    expect(formatChartNumber(1000)).toBe('1000')
    expect(formatChartNumber(1.23456)).toBe('1.235')
    expect(formatChartNumber(-1.23456)).toBe('-1.235')
    expect(formatChartNumber(0.0123456)).toBe('0.01235')
    expect(formatChartNumber(42.5)).toBe('42.5')
  })

  it('does not turn a small scientific value into zero or a long decimal', () => {
    expect(formatChartNumber(1.23456e-100)).toBe('1.235e-100')
    expect(formatChartNumber(-1.23456e-100)).toBe('-1.235e-100')
    expect(formatChartNumber(1e21)).toBe('1e+21')
  })
})

describe('compactChartNumber', () => {
  it('formats each unit with one decimal from ten of the unit and two below it', () => {
    expect(compactChartNumber(420_800_000)).toBe('420.8M')
    expect(compactChartNumber(12_340)).toBe('12.3k')
    expect(compactChartNumber(1234)).toBe('1.23k')
    expect(compactChartNumber(1_500_000)).toBe('1.5M')
    expect(compactChartNumber(2_500_000_000)).toBe('2.5B')
    expect(compactChartNumber(2_500_000_000_000)).toBe('2.5T')
  })

  it('rounds a value that fills the next unit and keeps the sign', () => {
    expect(compactChartNumber(9_999)).toBe('10k')
    expect(compactChartNumber(-1234)).toBe('-1.23k')
    expect(compactChartNumber(-12_340)).toBe('-12.3k')
  })

  it('falls back to plain number text below one thousand and at zero', () => {
    expect(compactChartNumber(0)).toBe('0')
    expect(compactChartNumber(7)).toBe('7')
    expect(compactChartNumber(999)).toBe('999')
    expect(compactChartNumber(999.5)).toBe('999.5')
    expect(compactChartNumber(-7)).toBe('-7')
  })
})
