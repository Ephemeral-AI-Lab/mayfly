/**
 * `highlightCodeLines`: the markdown `highlightCode` hook's backend —
 * language gating, red-scope resetting, and the never-change-line-count
 * contract including the throw fallback.
 */

import { describe, expect, it, vi } from 'vitest'

vi.mock('cli-highlight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cli-highlight')>()
  return { ...actual, highlight: vi.fn(actual.highlight) }
})

import { highlight } from 'cli-highlight'

import { highlightCodeLines } from '../../src/core/highlight.ts'
import type { MayflyColorFn } from '../../src/core/types.ts'

const base: MayflyColorFn = (text) => `«base:${text}»`

describe('highlightCodeLines', () => {
  it('returns the raw split for unknown, empty, or missing languages', () => {
    expect(highlightCodeLines('a\nb', 'notalang', base)).toEqual(['a', 'b'])
    expect(highlightCodeLines('a\nb', undefined, base)).toEqual(['a', 'b'])
    expect(highlightCodeLines('a\nb', '', base)).toEqual(['a', 'b'])
    expect(highlightCodeLines('a\nb', '   ', base)).toEqual(['a', 'b'])
  })

  it('highlights a known language, normalizing case and whitespace, without changing the line count', () => {
    const code = 'const x = 1\n// note'
    const lines = highlightCodeLines(code, '  JS ', base)
    expect(lines).toHaveLength(code.split('\n').length)
    expect(lines.join('\n')).toContain('const')
  })

  it('resets the red scopes to the palette base and keeps illegals on', () => {
    vi.mocked(highlight).mockClear()
    highlightCodeLines('a', 'js', base)
    expect(highlight).toHaveBeenCalledWith('a', {
      language: 'js',
      ignoreIllegals: true,
      theme: { default: base, string: base, regexp: base, deletion: base },
    })
  })

  it('falls back to the raw split when the highlighter throws', () => {
    vi.mocked(highlight).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(highlightCodeLines('a\nb', 'js', base)).toEqual(['a', 'b'])
  })

  it('memoizes highlighted blocks by resolved base color, language, and code', () => {
    vi.mocked(highlight).mockClear()
    const first = highlightCodeLines('let memo = 1', 'js', base)
    first.push('mutated')
    expect(highlightCodeLines('let memo = 1', ' JS', base)).toEqual(first.slice(0, -1))
    expect(highlight).toHaveBeenCalledTimes(1)
    // A theme switch resolves the base differently and misses.
    highlightCodeLines('let memo = 1', 'js', text => `«other:${text}»`)
    expect(highlight).toHaveBeenCalledTimes(2)
    // The oldest entries leave once the memo is full.
    for (let index = 0; index < 64; index += 1) highlightCodeLines(`let n${String(index)} = 1`, 'js', base)
    vi.mocked(highlight).mockClear()
    highlightCodeLines('let n63 = 1', 'js', base)
    expect(highlight).not.toHaveBeenCalled()
    highlightCodeLines('let memo = 1', 'js', base)
    expect(highlight).toHaveBeenCalledTimes(1)
  })
})
