/** Find-in-view marks: the pattern's flags, the matches on painted lines (styles between letters, wide characters, zero-width matches), and the current match. */
import { describe, expect, it } from 'vitest'
import type { MayflyListHighlight } from '../../../ui/src/index.ts'
import { countMatches, highlightLine, highlightPattern } from '../../src/core/ui-find.ts'
import { visibleWidth } from '../../src/core/width.ts'

const REVERSE_ON = '\x1b[7m'
const REVERSE_OFF = '\x1b[27m'
const CURRENT_ON = '\x1b[7m\x1b[1m\x1b[4m'
const CURRENT_OFF = '\x1b[24m\x1b[22m\x1b[27m'
const stripAnsi = (line: string): string => line.replace(/\x1b\[[0-9;]*[A-Za-z]/gu, '')

describe('highlightPattern', () => {
  it('reads the pattern case-insensitively unless the list asks for case, and marks nothing for an empty or invalid pattern', () => {
    const h = (highlight: MayflyListHighlight) => highlightPattern(highlight)
    expect(h({ pattern: 'foo' })!.flags).toBe('giu')
    expect(h({ pattern: 'foo', caseSensitive: true })!.flags).toBe('gu')
    expect(h({ pattern: 'foo', caseSensitive: false })!.flags).toBe('giu')
    expect(highlightPattern(undefined)).toBeUndefined()
    expect(highlightPattern({ pattern: '' })).toBeUndefined()
    expect(highlightPattern({ pattern: '(' })).toBeUndefined()
  })
})

describe('countMatches and highlightLine on a painted line', () => {
  const find = (pattern: string, caseSensitive?: boolean) => highlightPattern({ pattern, ...caseSensitive === undefined ? {} : { caseSensitive } })!

  it('counts every occurrence, ignoring the escape sequences between letters', () => {
    expect(countMatches('Foo foo FOO', find('foo'))).toBe(3)
    expect(countMatches('Foo foo FOO', find('Foo', true))).toBe(1)
    // A style change inside a word does not hide the match: the visible text is what matches.
    expect(countMatches('\x1b[1mfo\x1b[22mo and \x1b[31mfoo\x1b[39m', find('foo'))).toBe(2)
    expect(countMatches('nothing here', find('zzz'))).toBe(0)
  })

  it('marks a match in reverse video and keeps the rest of the line as it was', () => {
    const line = `\x1b[31mred\x1b[39m plain foo`
    expect(highlightLine(line, find('foo'))).toBe(`\x1b[31mred\x1b[39m plain ${REVERSE_ON}foo${REVERSE_OFF}`)
    expect(stripAnsi(highlightLine(line, find('foo')))).toBe('red plain foo')
  })

  it('draws a match that a style cuts open with the reverse on again after each style sequence', () => {
    // A reset inside the match would end the reverse video; the mark re-asserts it after the sequence.
    expect(highlightLine('c\x1b[0md', find('cd'))).toBe(`${REVERSE_ON}c\x1b[0m${REVERSE_ON}d${REVERSE_OFF}`)
  })

  it('marks each match, and draws the current one stronger', () => {
    const line = 'hit one hit two hit'
    expect(highlightLine(line, find('hit'))).toBe(`${REVERSE_ON}hit${REVERSE_OFF} one ${REVERSE_ON}hit${REVERSE_OFF} two ${REVERSE_ON}hit${REVERSE_OFF}`)
    expect(highlightLine(line, find('hit'), 1)).toBe(`${REVERSE_ON}hit${REVERSE_OFF} one ${CURRENT_ON}hit${CURRENT_OFF} two ${REVERSE_ON}hit${REVERSE_OFF}`)
  })

  it('returns the same line object when nothing matches', () => {
    const line = '\x1b[1mbold\x1b[22m'
    expect(highlightLine(line, find('zzz'))).toBe(line)
  })

  it('skips a zero-width match (an empty alternation between letters) and marks nothing for it', () => {
    expect(countMatches('bab', find('a*'))).toBe(1)
    expect(highlightLine('xyz', find('a*'))).toBe('xyz')
  })

  it('keeps wide characters whole: a match in CJK text marks its own columns and the width stays the same', () => {
    const line = '中文 foo 字'
    const marked = highlightLine(line, find('foo'))
    expect(marked).toBe(`中文 ${REVERSE_ON}foo${REVERSE_OFF} 字`)
    expect(visibleWidth(marked)).toBe(visibleWidth(line))
    // A pattern that names a CJK character marks that character alone.
    expect(highlightLine(line, find('文'))).toBe(`中${REVERSE_ON}文${REVERSE_OFF} foo 字`)
  })

  it('marks a surrogate pair as one character, not a broken half', () => {
    expect(highlightLine('a😀b', find('😀'))).toBe(`a${REVERSE_ON}😀${REVERSE_OFF}b`)
  })

  it('leaves an escape sequence standing in the middle of a styled match open for the mark to close', () => {
    // A link opened inside the match: OSC 8 is an escape too and must not be marked as text.
    const link = '\x1b]8;;https://x.dev\x07go\x1b]8;;\x07'
    const marked = highlightLine(link, find('go'))
    expect(stripAnsi(marked.replace(/\x1b\]8;;[^\x07]*\x07/gu, ''))).toBe('go')
    expect(marked).toContain(`${REVERSE_ON}`)
    expect(marked).toContain(REVERSE_OFF)
  })
})
