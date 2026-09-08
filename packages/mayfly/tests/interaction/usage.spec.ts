/**
 * Unit tests for the `/usage` read layer: the 1024-base token formatting,
 * percentages, ratios, severities, and disjoint provider totals.
 */

import { describe, expect, it } from 'vitest'
import {
  formatTokens,
  ratioSeverity,
  totalTokens,
  usagePercent,
  usageRatio,
} from '../../src/interaction/usage.ts'

describe('formatTokens', () => {
  it('formats the sub-1024 count as a plain integer', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(512)).toBe('512')
  })

  it('formats k above 1024 with one decimal, rounded at 100k', () => {
    expect(formatTokens(1536)).toBe('1.5k')
    expect(formatTokens(1024)).toBe('1k')
    expect(formatTokens(262144)).toBe('256k')
    expect(formatTokens(99942)).toBe('97.6k')
    expect(formatTokens(100352)).toBe('98k')
  })

  it('formats M above 1 MiB and degrades non-finite or negative input to 0', () => {
    expect(formatTokens(1024 * 1024)).toBe('1M')
    expect(formatTokens(1.5 * 1024 * 1024)).toBe('1.5M')
    expect(formatTokens(Number.NaN)).toBe('0')
    expect(formatTokens(-5)).toBe('0')
  })
})

describe('usagePercent / usageRatio', () => {
  it('rounds the share up, clamps to [0, 100], and floors a non-zero share at 1', () => {
    expect(usagePercent(1, 8192)).toBe(1)
    expect(usagePercent(4096, 8192)).toBe(50)
    expect(usagePercent(8192, 8192)).toBe(100)
    expect(usagePercent(9000, 8192)).toBe(100)
  })

  it('reports 0 for non-positive or non-finite inputs', () => {
    expect(usagePercent(0, 8192)).toBe(0)
    expect(usagePercent(10, 0)).toBe(0)
    expect(usagePercent(Number.NaN, 8192)).toBe(0)
    expect(usageRatio(-1, 8192)).toBe(0)
  })

  it('clamps the ratio to [0, 1]', () => {
    expect(usageRatio(4096, 8192)).toBe(0.5)
    expect(usageRatio(16384, 8192)).toBe(1)
  })
})

describe('ratioSeverity / totalTokens', () => {

  it('maps the ratio onto the kimi severity thresholds', () => {
    expect(ratioSeverity(0.49)).toBe('ok')
    expect(ratioSeverity(0.5)).toBe('warn')
    expect(ratioSeverity(0.84)).toBe('warn')
    expect(ratioSeverity(0.85)).toBe('danger')
  })

  it('sums all disjoint provider buckets', () => {
    expect(totalTokens({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4 })).toBe(10)
  })
})
