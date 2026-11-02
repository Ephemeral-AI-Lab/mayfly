/**
 * Bounded activity details: the upstream argument key order, the name
 * fallback cards use, and control stripping.
 *
 * @module @ephemeral-ai/mayfly/tests/conversation/activity-detail
 */
import { describe, expect, it } from 'vitest'
import {
  argumentDetail,
  LIVE_DETAIL_MAX_CHARS,
  normalizeDetail,
  toolDetail,
} from '../../src/conversation/activity-detail.ts'

describe('activity detail', () => {
  it('extracts bounded details in the upstream key order', () => {
    expect(toolDetail('bash', { command: '  pnpm   test ', description: 'Run tests' })).toBe('Run tests')
    expect(toolDetail('web_search', { queries: ['a', 'b'] })).toBe('a, b')
    expect(toolDetail('ask', { questions: [null, { question: '' }, { question: 'Which?' }] })).toBe('Which?')
    expect(toolDetail('ask', { questions: 'bad' })).toBe('ask')
    expect(toolDetail('ask', { questions: [{ question: '  ' }] })).toBe('ask')
    expect(toolDetail('grep', { pattern: 'x', path: 'src' })).toBe('x')
    expect(toolDetail('tool', { other: 1 })).toBe('tool')
    expect(toolDetail('tool', undefined)).toBe('tool')
    expect(argumentDetail({ other: 1 })).toBe('')
    expect(argumentDetail(null)).toBe('')
    expect(normalizeDetail(42)).toBe('')
    expect(normalizeDetail(['a', 1])).toBe('')
    const long = normalizeDetail('界'.repeat(LIVE_DETAIL_MAX_CHARS + 10))
    expect(Array.from(long)).toHaveLength(LIVE_DETAIL_MAX_CHARS)
    expect(long.endsWith('…')).toBe(true)
  })

  it('reads the salient argument of parsed arguments without a name fallback', () => {
    expect(argumentDetail({ command: 'pnpm test' })).toBe('pnpm test')
    expect(argumentDetail({ todos: [] })).toBe('')
  })

  it('replaces control characters so width math stays exact', () => {
    expect(normalizeDetail('a\x1b[31mb\tc\u0085d')).toBe('a [31mb c d')
  })
})
