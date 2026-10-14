/** The search line above the editor: its two rows at 120 and 40 columns (CJK patterns too), the keys it takes while editable, and what freezing it leaves. */
import { describe, expect, it, vi } from 'vitest'
import { CURSOR_MARKER } from '@earendil-works/pi-tui'
import { SearchLine, type MayflySearchLineOptions } from '../../src/core/search-line.ts'
import { visibleWidth } from '../../src/core/width.ts'

const KEY = { enter: '\r', escape: '\x1b', ctrlC: '\x03', backspace: '\x7f' }

function line(prefix: '/' | '?' = '/') {
  const options = { prefix, onChange: vi.fn(), onAccept: vi.fn(), onAbandon: vi.fn() } satisfies MayflySearchLineOptions
  const host = { colors: () => undefined, keymap: () => undefined, requestRender: vi.fn() }
  const search = new SearchLine(options, host)
  return { search, options, host }
}
/** A frame with the terminal cursor marker taken out, so it reads as the text a person sees. */
const shown = (rows: readonly string[]): string[] => rows.map(row => row.split(CURSOR_MARKER).join(''))

describe('SearchLine frames', () => {
  it('draws the prefix, the pattern, and the status on two rows at 120 columns', () => {
    const { search } = line('/')
    search.focused = true
    search.setStatus('Type a regular expression · Enter to select · Esc to cancel')
    const rows = shown(search.render(120))
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatch(/^ {2}\/ /u)
    expect(rows[1]).toBe(`${' '.repeat(4)}Type a regular expression · Enter to select · Esc to cancel`)
    expect(rows.every(row => visibleWidth(row) <= 120)).toBe(true)
  })

  it('uses the question mark prefix for a backward search and keeps the status aligned under the pattern', () => {
    const { search } = line('?')
    search.setStatus('No matches · Esc to cancel')
    const rows = shown(search.render(120))
    expect(rows[0]!.startsWith('  ? ')).toBe(true)
    expect(rows[1]).toBe(`${' '.repeat(4)}No matches · Esc to cancel`)
  })

  it('types a CJK pattern and fits it to 40 columns, truncating the row rather than wrapping it', () => {
    const { search, options } = line('/')
    search.focused = true
    for (const character of '中文搜索结果很长很长很长很长很长很长很长很长') search.handleInput(character)
    expect(options.onChange).toHaveBeenLastCalledWith('中文搜索结果很长很长很长很长很长很长很长很长')
    const rows = shown(search.render(40))
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(40)
    expect(rows[0]!.startsWith('  / ')).toBe(true)
  })

  it('shows the pattern as plain text once frozen: no cursor, no more keys', () => {
    const { search } = line('/')
    search.focused = true
    search.handleInput('a')
    search.setEditable(false)
    expect(search.isEditable).toBe(false)
    const rows = search.render(40)
    expect(rows[0]).not.toContain(CURSOR_MARKER)
    expect(shown(rows)[0]).toBe('  / a')
  })
})

describe('SearchLine keys', () => {
  it('reports each change of the pattern, and ignores a key that changes nothing', () => {
    const { search, options } = line()
    search.focused = true
    search.handleInput('f')
    search.handleInput('o')
    search.handleInput('o')
    expect(options.onChange.mock.calls.map(call => call[0])).toEqual(['f', 'fo', 'foo'])
    // Left arrow moves the cursor, which is not a change of the pattern.
    search.handleInput('\x1b[D')
    expect(options.onChange).toHaveBeenCalledTimes(3)
  })

  it('accepts on Enter, and abandons on Esc, Ctrl+C, or Backspace on an empty pattern', () => {
    const { search, options } = line()
    search.focused = true
    search.handleInput(KEY.enter)
    expect(options.onAccept).toHaveBeenCalledTimes(1)
    expect(options.onAbandon).not.toHaveBeenCalled()
    search.handleInput(KEY.escape)
    search.handleInput(KEY.ctrlC)
    search.handleInput(KEY.backspace)
    expect(options.onAbandon).toHaveBeenCalledTimes(3)
    expect(options.onChange).not.toHaveBeenCalled()
  })

  it('edits a non-empty pattern on Backspace instead of abandoning it', () => {
    const { search, options } = line()
    search.focused = true
    search.handleInput('a')
    search.handleInput(KEY.backspace)
    expect(options.onAbandon).not.toHaveBeenCalled()
    expect(options.onChange.mock.calls.map(call => call[0])).toEqual(['a', ''])
  })

  it('pastes a multi-character batch into the pattern as one change', () => {
    const { search, options } = line()
    search.focused = true
    search.handleInput('中文 abc')
    expect(options.onChange).toHaveBeenLastCalledWith('中文 abc')
    expect(options.onChange).toHaveBeenCalledTimes(1)
  })

  it('takes no keys while it is frozen, so a key after Enter reaches the stream and not the pattern', () => {
    const { search, options } = line()
    search.focused = true
    search.setEditable(false)
    search.handleInput('x')
    search.handleInput(KEY.enter)
    search.handleInput(KEY.escape)
    expect(options.onChange).not.toHaveBeenCalled()
    expect(options.onAccept).not.toHaveBeenCalled()
    expect(options.onAbandon).not.toHaveBeenCalled()
  })

  it('holds the focus only while it is editable: un-freezing hands the cursor back to the line', () => {
    const { search, options } = line()
    search.focused = true
    search.setEditable(false)
    search.setEditable(true)
    search.handleInput('y')
    expect(options.onChange).toHaveBeenCalledWith('y')
  })
})
