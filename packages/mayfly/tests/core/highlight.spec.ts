/**
 * `CodeHighlighter`: the backend of code nodes and markdown fences —
 * language gating, the palette-only theme, and the never-change-line-count
 * contract including the throw fallback.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('cli-highlight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('cli-highlight')>()
  return { ...actual, highlight: vi.fn(actual.highlight) }
})

import { highlight } from 'cli-highlight'

import { CodeHighlighter, highlightable, type CodePaints } from '../../src/core/highlight.ts'
import type { MayflyColorFn } from '../../src/core/types.ts'

const tag = (name: string): MayflyColorFn => text => `«${name}:${text}»`
const paints: CodePaints = { base: tag('base'), keyword: tag('keyword'), string: tag('string'), comment: tag('comment') }

describe('CodeHighlighter', () => {
  let highlighter: CodeHighlighter
  beforeEach(() => { highlighter = new CodeHighlighter() })
  it('returns the raw split for unknown, empty, or missing languages', () => {
    expect(highlighter.highlight('a\nb', 'notalang', paints)).toEqual(['a', 'b'])
    expect(highlighter.highlight('a\nb', undefined, paints)).toEqual(['a', 'b'])
    expect(highlighter.highlight('a\nb', '', paints)).toEqual(['a', 'b'])
    expect(highlighter.highlight('a\nb', '   ', paints)).toEqual(['a', 'b'])
    expect(highlightable('  TypeScript ')).toBe(true)
    expect(highlightable('notalang')).toBe(false)
    expect(highlightable(undefined)).toBe(false)
  })

  it('paints keywords, strings, and comments in their tones and everything else in the base, line for line', () => {
    const code = "const x = 'one'\n// note\nfoo(1)"
    const lines = highlighter.highlight(code, '  TS ', paints)
    expect(lines).toHaveLength(code.split('\n').length)
    expect(lines[0]).toContain('«keyword:const»')
    expect(lines[0]).toContain("«string:'one'»")
    expect(lines[1]).toContain('«comment:// note»')
    expect(lines[2]).not.toContain('\x1b')
  })

  it('gives every token class a palette paint and keeps illegals on', () => {
    vi.mocked(highlight).mockClear()
    highlighter.highlight('a', 'js', paints)
    const options = vi.mocked(highlight).mock.calls[0]![1]!
    expect(options).toMatchObject({ language: 'js', ignoreIllegals: true })
    const theme = options.theme as Record<string, MayflyColorFn>
    expect(theme.keyword!('k')).toBe('«keyword:k»')
    expect(theme.string!('s')).toBe('«string:s»')
    expect(theme.comment!('c')).toBe('«comment:c»')
    expect(theme.built_in!('b')).toBe('«base:b»')
    // Every run closes on its own line.
    expect(theme.default!('a\n\nb')).toBe('«base:a»\n\n«base:b»')
  })

  it('falls back to the raw split when the highlighter throws', () => {
    vi.mocked(highlight).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    expect(highlighter.highlight('a\nb', 'js', paints)).toEqual(['a', 'b'])
  })

  it('memoizes highlighted blocks by resolved paints, language, and code', () => {
    vi.mocked(highlight).mockClear()
    const first = highlighter.highlight('let memo = 1', 'js', paints)
    first.push('mutated')
    expect(highlighter.highlight('let memo = 1', ' JS', paints)).toEqual(first.slice(0, -1))
    expect(highlight).toHaveBeenCalledTimes(1)
    // A theme switch resolves the paints differently and misses.
    highlighter.highlight('let memo = 1', 'js', { ...paints, keyword: tag('other') })
    expect(highlight).toHaveBeenCalledTimes(2)
    // The oldest entries leave once the memo is full.
    for (let index = 0; index < 64; index += 1) highlighter.highlight(`let n${String(index)} = 1`, 'js', paints)
    vi.mocked(highlight).mockClear()
    highlighter.highlight('let n63 = 1', 'js', paints)
    expect(highlight).not.toHaveBeenCalled()
    highlighter.highlight('let memo = 1', 'js', paints)
    expect(highlight).toHaveBeenCalledTimes(1)
  })

  it('isolates owners and releases syntax colors on disposal', () => {
    vi.mocked(highlight).mockClear()
    const other = new CodeHighlighter()
    highlighter.highlight('const owner = 1', 'js', paints)
    other.highlight('const owner = 1', 'js', paints)
    expect(highlight).toHaveBeenCalledTimes(2)
    highlighter.clear()
    other.highlight('const owner = 1', 'js', paints)
    expect(highlight).toHaveBeenCalledTimes(2)
    highlighter.highlight('const owner = 1', 'js', paints)
    expect(highlight).toHaveBeenCalledTimes(3)
  })
})
