/**
 * Bounded activity details: the upstream argument key order, the name
 * fallback cards use, raw-argument parsing for the facts projection, control
 * stripping, and the bounded reasoning tail scan.
 *
 * @module @ephemeral-ai/mayfly/tests/conversation/activity-detail
 */
import { describe, expect, it } from 'vitest'
import {
  argumentDetail,
  callDetail,
  LIVE_DETAIL_MAX_CHARS,
  normalizeDetail,
  REASONING_DETAIL_SCAN_CHARS,
  reasoningDetail,
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

  it('reads committed raw arguments without a name fallback', () => {
    expect(callDetail('{"command":"pnpm test"}')).toBe('pnpm test')
    expect(callDetail('{"todos":[]}')).toBe('')
    expect(callDetail('{not json')).toBe('')
  })

  it('replaces control characters so width math stays exact', () => {
    expect(normalizeDetail('a\x1b[31mb\tc\u0085d')).toBe('a [31mb c d')
  })

  it('picks the latest reasoning paragraph from a bounded tail', () => {
    expect(reasoningDetail('first\n\n**second** idea\n\n  ')).toBe('second idea')
    expect(reasoningDetail(' \n\n ')).toBe('')
    // A paragraph cut by the scan window leads with an ellipsis.
    const cut = reasoningDetail(`start ${'x'.repeat(REASONING_DETAIL_SCAN_CHARS)}`)
    expect(cut.startsWith('…x')).toBe(true)
    expect(cut).not.toContain('start')
    // A whole paragraph inside the window reads without one.
    expect(reasoningDetail(`${'x'.repeat(REASONING_DETAIL_SCAN_CHARS)}\n\nlast`)).toBe('last')
    // The window never starts on a low surrogate.
    const emoji = reasoningDetail(`${'😀'.repeat(REASONING_DETAIL_SCAN_CHARS / 2)}!`)
    expect(emoji.startsWith('…😀')).toBe(true)
  })
})
