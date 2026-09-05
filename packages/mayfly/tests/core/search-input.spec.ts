/** Native search input and its two list consumers share Unicode and paste semantics. */
import { Context } from '@deepseek-ai/cordis'
import { CURSOR_MARKER, stripTerminalSequences, TuiMainScreen } from '@earendil-works/pi-tui'
import { renderLayoutFrame } from '@earendil-works/pi-tui/dist/layout.js'
import { describe, expect, it, vi } from 'vitest'
import { MayflyComponentsService } from '../../src/core/components.ts'
import { SearchInput } from '../../src/core/search-input.ts'
import { CanonicalSelectController } from '../../src/interaction/select-list.ts'
import { CanonicalDocumentController } from '../../src/interaction/frontend-panel.ts'
import { CanonicalFormController } from '../../src/interaction/form-panel.ts'
import { FakeTheme, FakeKeymap, KEY } from '../interaction/fakes.ts'
import { FakeTerminal } from './fake-terminal.ts'
import { visibleWidth } from '../../src/core/width.ts'

function display() {
  const theme = new FakeTheme()
  return { theme, keymap: new FakeKeymap(), components: new MayflyComponentsService(new Context(), { theme, tui: new TuiMainScreen(new FakeTerminal()) }) }
}

describe('SearchInput', () => {
  it('accepts batches and graphemes, removes a whole grapheme, and rejects control input', () => {
    const input = new SearchInput(display().components)
    expect(input.handleInput('中文😀e\u0301')).toBe(true)
    expect(input.text).toBe('中文😀e\u0301')
    input.handleInput('backspace', true)
    expect(input.text).toBe('中文😀')
    for (const key of ['', '\r', '\t', '\x1b[A', '\x00', '\x7f', '\x9b31m']) expect(input.handleInput(key)).toBe(false)
    input.clear()
    expect(input.text).toBe('')
    input.handleInput('\x1b[200~stale')
    input.clear()
    expect(input.pending).toBe(false)
    input.handleInput('\x1b[200~fresh\x1b[201~')
    expect(input.text).toBe('fresh')
  })

  it('buffers split paste endings and normalizes pasted newlines and terminal controls', () => {
    const input = new SearchInput(display().components)
    input.handleInput('\x1b[200~中文\n')
    expect(input.pending).toBe(true)
    expect(input.text).toBe('')
    input.handleInput('😀\r\n\t\x1b[31mred\x1b[0m\x01\x1b[20')
    input.handleInput('1~')
    expect(input.pending).toBe(false)
    expect(input.text).toBe('中文 😀 red')
    input.handleInput('\x1b[200~done\x1b[201~')
    expect(input.text).toBe('中文 😀 reddone')
  })

  it.each(['select', 'document'] as const)('keeps pasted navigation and cancel keys inside the %s search', kind => {
    const onCancel = vi.fn()
    const onSelect = vi.fn()
    const common = display()
    const panel = kind === 'select'
      ? new CanonicalSelectController({ ...common, filter: true, rows: [{ value: 'x', label: '中文😀' }], onCancel, onSelect })
      : new CanonicalDocumentController({ ...common, model: () => ({ mode: 'select', title: 'Search', filterable: true, items: [{ id: 'x', label: '中文😀' }] }), onClose: onCancel, onAction: onSelect })
    panel.focused = true
    panel.handleInput('\x1b[200~')
    panel.handleInput('中文😀')
    panel.handleInput('\x1b[201~')
    expect(panel.render(60).join('\n')).toContain('中文😀')
    expect(JSON.stringify(panel.currentNode())).toContain('"filter":"中文😀"')
    expect(onCancel).not.toHaveBeenCalled()
    panel.handleInput(KEY.escape)
    expect(onCancel).not.toHaveBeenCalled()
  })

  it.each([20, 40, 80])('keeps long-label field values visible and delete inside the editor at width %i', width => {
    const onDelete = vi.fn()
    const onSubmit = vi.fn()
    const panel = new CanonicalFormController({ ...display(), title: 'Form', fields: [{ id: 'key', label: '很长的字段标签 '.repeat(8), initial: 'abc' }], onDelete, onSubmit, onCancel: vi.fn() })
    panel.focused = true
    panel.handleInput(KEY.enter)
    panel.handleInput('\x01')
    panel.handleInput('\x1b[3~')
    panel.handleInput('\x04')
    expect(onDelete).not.toHaveBeenCalled()
    expect(panel.currentNode()).toMatchObject({ child: { fields: [{ id: 'key', value: 'c' }] } })
    const rows = panel.render(width)
    const cursorRows = rows.filter(row => row.includes(CURSOR_MARKER))
    expect(rows.join('').split(CURSOR_MARKER)).toHaveLength(2)
    expect(cursorRows).toHaveLength(1)
    expect(stripTerminalSequences(cursorRows[0]!)).toContain('c')
    expect(rows.every(row => visibleWidth(row) <= width)).toBe(true)
    const frame = renderLayoutFrame({ render: columns => panel.render(columns), invalidate: () => panel.invalidate() }, width, 1, () => {})
    expect(frame.lines).toHaveLength(1)
    expect(stripTerminalSequences(frame.lines[0]!)).toContain('c')
    expect(frame.lines[0]).toContain(CURSOR_MARKER)
    panel.handleInput(KEY.escape)
    panel.handleInput('\x04')
    expect(onDelete).toHaveBeenCalledOnce()
  })
})
