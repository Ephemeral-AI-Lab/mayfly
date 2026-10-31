/**
 * Decision tests for the bounded one-line details and the identity-memoized
 * admission the projections share.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { argumentDetail, LIVE_DETAIL_MAX_CHARS, normalizeDetail, toolDetail } from '../../src/conversation/activity-detail.ts'
import { everyAdmitted, identityAdmission } from '../../src/conversation/admission.ts'

describe('normalizeDetail', () => {
  it('collapses controls and whitespace into single spaces', () => {
    expect(normalizeDetail('a\tb\nc   d')).toBe('a b c d')
    expect(normalizeDetail(' \x00\x1f hidden \x7f ')).toBe('hidden')
  })

  it('joins string arrays and empties everything else', () => {
    expect(normalizeDetail(['one', 'two'])).toBe('one, two')
    expect(normalizeDetail(42)).toBe('')
    expect(normalizeDetail(['one', 2])).toBe('')
    expect(normalizeDetail({ not: 'a string' })).toBe('')
  })

  it('bounds a detail to the grapheme budget with an ellipsis', () => {
    const long = 'ä'.repeat(LIVE_DETAIL_MAX_CHARS + 10)
    const bounded = normalizeDetail(long)
    expect(bounded.endsWith('…')).toBe(true)
    // The ellipsis is the last grapheme: the budget holds exactly.
    const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(bounded))
    expect(graphemes).toHaveLength(LIVE_DETAIL_MAX_CHARS)
  })
})

describe('argumentDetail', () => {
  it('prefers the earliest salient key that carries a value', () => {
    expect(argumentDetail({ command: 'ls -la', file_path: '/x' })).toBe('ls -la')
    expect(argumentDetail({ file_path: '/work/a.ts' })).toBe('/work/a.ts')
  })

  it('takes the first question of a questions array', () => {
    expect(argumentDetail({ questions: [{ question: 'which colour?' }, { question: 'skip' }] })).toBe('which colour?')
    expect(argumentDetail({ questions: 'not an array' })).toBe('')
  })

  it('answers empty for unparseable or shapeless arguments', () => {
    expect(argumentDetail(undefined)).toBe('')
    expect(argumentDetail('{"broken"')).toBe('')
    expect(argumentDetail({})).toBe('')
  })
})

describe('toolDetail', () => {
  it('falls back to the tool name when no argument carries a detail', () => {
    expect(toolDetail('grep', { pattern: 'mayfly' })).toBe('mayfly')
    expect(toolDetail('grep', {})).toBe('grep')
  })
})

describe('identityAdmission', () => {
  const schema = z.object({ id: z.string() })
  const admit = identityAdmission(schema)

  it('parses a retained identity once and answers later views from the memo', () => {
    let parses = 0
    const counting = identityAdmission(z.custom<Record<string, unknown>>((value): boolean => {
      parses += 1
      return typeof value === 'object' && value !== null && 'id' in value
    }))
    const value = { id: 'a' }
    expect(counting(value)).toBe(true)
    expect(counting(value)).toBe(true)
    expect(counting(value)).toBe(true)
    // The memo exists precisely so a validated object never re-parses.
    expect(parses).toBe(1)
    void admit
  })

  it('refuses non-objects and invalid shapes without memoizing them', () => {
    expect(admit(null)).toBe(false)
    expect(admit('string')).toBe(false)
    expect(admit({ id: 7 })).toBe(false)
    // A later valid parse of the same content is admitted on its own merits.
    expect(admit({ id: 'fine' })).toBe(true)
  })
})

describe('everyAdmitted', () => {
  it('admits arrays whose every element passes and nothing else', () => {
    const isText = (value: unknown): boolean => typeof value === 'string'
    const admit = everyAdmitted(isText)
    expect(admit(['a', 'b'])).toBe(true)
    expect(admit([])).toBe(true)
    expect(admit(['a', 1])).toBe(false)
    expect(admit('a')).toBe(false)
  })
})
