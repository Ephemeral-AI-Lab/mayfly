/** The form field painter: the reading of each field kind, its marks and notes, and the rows under it. */
import { describe, expect, it } from 'vitest'
import type { MayflyFormField } from '../../../ui/src/index.ts'
import type { MayflySemanticColors } from '../../src/core/types.ts'
import { editorWidth, formHeading, formLabelWidth, matchingSuggestions, paintFormField, type FieldDecor, type FormFieldPaint } from '../../src/core/ui-form-paint.ts'
import { visibleWidth } from '../../src/core/width.ts'

const identity = (value: string): string => value
const colors = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : identity }) as MayflySemanticColors
const tagged = new Proxy({ logoGradient: [identity] }, { get: (target, key) => key === 'logoGradient' ? target.logoGradient : (value: string) => `<${String(key)}>${value}</${String(key)}>` }) as MayflySemanticColors
const plain = (rows: readonly string[]): string[] => rows.map(row => row.replace(/\x1b\[[0-9;]*m/gu, ''))
const idle = { key: '', focused: false, marker: '|' }
const focus = (id: string, extra: Partial<FormFieldPaint['focus']> = {}): FormFieldPaint['focus'] => ({ key: id, focused: true, marker: '|', ...extra })

function paint(field: MayflyFormField, width: number, options: { readonly decor?: FieldDecor, readonly focus?: FormFieldPaint['focus'], readonly labelWidth?: number, readonly editing?: readonly string[], readonly suggestions?: readonly string[], readonly colors?: MayflySemanticColors } = {}): string[] {
  return paintFormField({
    field, decor: options.decor ?? {}, width, focus: options.focus ?? idle, colors: options.colors ?? colors, text: key => key,
    labelWidth: options.labelWidth ?? visibleWidth(field.label),
    ...(options.editing === undefined ? {} : { editing: options.editing }),
    ...(options.suggestions === undefined ? {} : { suggestions: options.suggestions }),
  })
}

describe('form headings and shared measures', () => {
  it('draws a muted rule after the group name, at most 44 cells wide', () => {
    expect(plain([formHeading('Connection', 80, colors)])).toEqual([`── Connection ${'─'.repeat(30)}`])
    expect(plain([formHeading('Connection', 30, colors)])).toEqual([`── Connection ${'─'.repeat(16)}`])
    expect(plain([formHeading('A very long group name', 12, colors)])[0]).toHaveLength(12)
    expect(formHeading('Group', 400, tagged)).toBe(`<muted>── Group ${'─'.repeat(35)}</muted>`)
    expect(visibleWidth(formHeading('Group', Number.NaN, colors))).toBe(1)
  })

  it('measures the widest label and the suggestions a typed value is the start of', () => {
    expect(formLabelWidth([])).toBe(0)
    expect(formLabelWidth([{ kind: 'toggle', id: 'a', label: 'Wide label', value: true }, { kind: 'toggle', id: 'b', label: '宽', value: true }])).toBe(10)
    expect(matchingSuggestions(undefined, 'a')).toEqual([])
    expect(matchingSuggestions(['~/a', '~/ab', '~/b'], '~/a')).toEqual(['~/ab'])
    expect(matchingSuggestions(['one', 'two'], '')).toEqual(['one', 'two'])
  })

  it('gives the editor the value column, the whole row under a stacked label, or the textarea box', () => {
    const input: MayflyFormField = { kind: 'input', id: 'a', label: 'Name', value: '' }
    expect(editorWidth(input, 60, 8)).toBe(48)
    expect(editorWidth(input, 20, 8)).toBe(16)
    expect(editorWidth(input, 0, 8)).toBe(1)
    expect(editorWidth({ kind: 'textarea', id: 'a', label: 'Notes', value: '' }, 80, 5)).toBe(41)
    expect(editorWidth({ kind: 'textarea', id: 'a', label: 'Notes', value: '' }, 10, 5)).toBe(3)
    expect(editorWidth({ kind: 'textarea', id: 'a', label: 'Notes', value: '' }, 4, 5)).toBe(1)
  })
})

describe('field readings', () => {
  it('aligns the value of every field after the widest label', () => {
    expect(plain(paint({ kind: 'input', id: 'a', label: 'Name', value: 'x' }, 40, { labelWidth: 9 }))).toEqual(['  Name:      x'])
    expect(plain(paint({ kind: 'toggle', id: 'a', label: 'Streaming', value: true }, 40, { labelWidth: 9 }))).toEqual(['  Streaming: [on]'])
    expect(paint({ kind: 'toggle', id: 'a', label: 'T', value: false }, 400, { colors: tagged })[0]).toContain('<muted>[off]</muted>')
    expect(paint({ kind: 'toggle', id: 'a', label: 'T', value: true }, 400, { colors: tagged })[0]).toContain('<primary>[on]</primary>')
  })

  it('reads a select, a multiselect, and an empty text as muted words', () => {
    const options = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta' }]
    expect(plain(paint({ kind: 'select', id: 's', label: 'S', value: null, options }, 40))).toEqual(['  S: Choose…'])
    expect(plain(paint({ kind: 'select', id: 's', label: 'S', value: 'zz', options }, 40))).toEqual(['  S: zz'])
    expect(plain(paint({ kind: 'select', id: 's', label: 'S', value: 'a', options }, 40))).toEqual(['  S: Alpha'])
    expect(plain(paint({ kind: 'multiselect', id: 's', label: 'M', value: [], options }, 40))).toEqual(['  M: None selected'])
    expect(plain(paint({ kind: 'multiselect', id: 's', label: 'M', value: ['a', 'b'], options }, 40))).toEqual(['  M: Alpha, Beta'])
    expect(plain(paint({ kind: 'input', id: 'i', label: 'I', value: '', placeholder: 'hint' }, 40))).toEqual(['  I: hint'])
    expect(plain(paint({ kind: 'input', id: 'i', label: 'I', value: '' }, 40))).toEqual(['  I: '])
  })

  it('shows a number with its unit, and its range and ‹ › while it holds focus', () => {
    const count = (extra: Partial<Extract<MayflyFormField, { readonly kind: 'number' }>> = {}): MayflyFormField => ({ kind: 'number', id: 'n', label: 'Timeout', value: 30, unit: 's', ...extra })
    expect(plain(paint(count(), 60))).toEqual(['  Timeout: 30 s'])
    expect(plain(paint(count({ value: null }), 60))).toEqual(['  Timeout: '])
    expect(plain(paint(count({ min: 5, max: 120 }), 60, { focus: focus('n') }))).toEqual(['→|Timeout: ‹ 30 › s  5–120'])
    expect(plain(paint(count({ min: 5 }), 60, { focus: focus('n') }))).toEqual(['→|Timeout: ‹ 30 › s  ≥ 5'])
    expect(plain(paint(count({ max: 9 }), 60, { focus: focus('n') }))).toEqual(['→|Timeout: ‹ 30 › s  ≤ 9'])
    expect(plain(paint(count({ unit: undefined as never }), 60, { focus: focus('n') }))).toEqual(['→|Timeout: ‹ 30 ›'])
    expect(plain(paint(count({ value: null }), 60, { focus: focus('n') }))).toEqual(['→|Timeout: ‹  › s'])
    // The text as typed wins over the number the node holds.
    expect(plain(paint(count(), 60, { decor: { draft: '3x' } }))).toEqual(['  Timeout: 3x s'])
    expect(plain(paint(count(), 60, { decor: { draft: '' } }))).toEqual(['  Timeout: '])
  })

  it('reads a secret as bullets, saved when untouched, and never as its text', () => {
    const secret = (value: string, placeholder?: string): MayflyFormField => ({ kind: 'secret', id: 'k', label: 'API key', value, ...(placeholder === undefined ? {} : { placeholder }) })
    expect(plain(paint(secret('sk-live-0123456789abc'), 60, { decor: { saved: true } }))).toEqual(['  API key: •••••••••• (saved)'])
    expect(plain(paint(secret('abc'), 60))).toEqual(['  API key: •••'])
    expect(plain(paint(secret(''), 60))).toEqual(['  API key: not set'])
    expect(plain(paint(secret('', 'paste it'), 60))).toEqual(['  API key: paste it'])
  })

  it('reads a textarea as its first line, and opens a box while it holds focus', () => {
    const notes = (value: string): MayflyFormField => ({ kind: 'textarea', id: 'n', label: 'Notes', value })
    expect(plain(paint(notes(''), 60))).toEqual(['  Notes: empty'])
    expect(plain(paint(notes('one'), 60))).toEqual(['  Notes: one'])
    expect(plain(paint(notes('one\ntwo'), 60))).toEqual(['  Notes: one …'])
    const box = plain(paint(notes('one\ntwo'), 30, { focus: focus('n') }))
    expect(box).toEqual([
      '→|Notes: ',
      `    ┌${'─'.repeat(24)}┐`,
      `    │ one${' '.repeat(20)}│`,
      `    │ two${' '.repeat(20)}│`,
      `    │${' '.repeat(24)}│`,
      `    └${'─'.repeat(24)}┘`,
    ])
    // The box never passes 42 cells, and a long value stops at twelve rows.
    const wide = plain(paint(notes(Array.from({ length: 20 }, (_, index) => `line ${String(index)}`).join('\n')), 100, { focus: focus('n') }))
    expect(wide[1]).toBe(`    ┌${'─'.repeat(42)}┐`)
    expect(wide).toHaveLength(15)
    expect(wide[13]).toMatch(/^ {4}│ … {40}│$/u)
    // While it is edited the box shows the editor's rows, all of them.
    const editing = plain(paint(notes('x'), 30, { focus: focus('n', { editing: true }), editing: ['a', 'b', 'c', 'd', 'e'] }))
    expect(editing).toHaveLength(8)
    expect(editing[6]).toBe(`    │ e${' '.repeat(22)}│`)
    // A box on a very narrow row keeps both bars.
    expect(plain(paint(notes('abcdefgh'), 6, { focus: focus('n') }))[2]).toHaveLength(6)
  })

  it('draws the rows of an edited text field from the editor, indenting continuation rows', () => {
    const input: MayflyFormField = { kind: 'input', id: 'i', label: 'Name', value: 'abc' }
    expect(plain(paint(input, 40, { focus: focus('i', { editing: true }), editing: ['abc▌'] }))).toEqual(['→|Name: abc▌'])
    expect(plain(paint(input, 40, { focus: focus('i', { editing: true }), editing: ['first', 'second'] }))).toEqual(['→|Name: first', '        second'])
    // Under a stacked label every row sits indented below it.
    expect(plain(paint(input, 14, { focus: focus('i', { editing: true }), editing: ['first', 'second'] }))).toEqual(['→|Name:', '    first', '    second'])
    // An unfocused field ignores rows it was given only while editing.
    expect(plain(paint(input, 40, { editing: ['abc'] }))).toEqual(['  Name: abc'])
  })

  it('stacks the value under a label when the row leaves it too little room', () => {
    expect(plain(paint({ kind: 'input', id: 'i', label: 'Endpoint', value: 'https://api.example.com/v1' }, 20))).toEqual(['  Endpoint:', '    https://api.exa…'])
    expect(plain(paint({ kind: 'input', id: 'i', label: 'Endpoint', value: 'short' }, 24))).toEqual(['  Endpoint: short'])
    for (const width of [1, 2, 3, 5, 8, 13, 21]) {
      for (const row of paint({ kind: 'input', id: 'i', label: 'Endpoint', value: 'https://api.example.com/v1', help: 'help text', error: 'bad' }, width, { focus: focus('i') })) expect(visibleWidth(row)).toBeLessThanOrEqual(width)
    }
  })
})

describe('marks and notes', () => {
  const input: MayflyFormField = { kind: 'input', id: 'i', label: 'Name', value: 'a' }

  it('marks the focused field with →, an edited one with •, and a disabled one with neither', () => {
    expect(plain(paint(input, 30, { decor: { edited: true } }))).toEqual(['• Name: a'])
    expect(plain(paint(input, 30, { decor: { edited: true }, focus: focus('i') }))).toEqual(['→|Name: a'])
    expect(plain(paint({ ...input, disabled: true }, 30, { decor: { edited: true } }))).toEqual(['  Name: a'])
    expect(paint({ ...input, disabled: true }, 400, { colors: tagged })[0]).toBe('  <muted>Name: </muted><muted>a</muted>')
    expect(paint(input, 400, { focus: focus('i'), colors: tagged })[0]).toBe('<primary>→</primary>|\x1b[1m<text>Name: </text>\x1b[22m<text>a</text>')
  })

  it('writes (inherited) or (override) after the value of a field with an origin', () => {
    expect(plain(paint(input, 40, { decor: { origin: 'inherited' } }))).toEqual(['  Name: a  (inherited)'])
    expect(plain(paint(input, 40, { decor: { origin: 'override' } }))).toEqual(['  Name: a  (override)'])
    expect(plain(paint({ kind: 'textarea', id: 'n', label: 'Notes', value: 'a' }, 40, { decor: { origin: 'override' }, focus: focus('n') }))[0]).toBe('→|Notes:   (override)')
    expect(plain(paint(input, 12, { decor: { origin: 'inherited' }, focus: focus('i') }))).toEqual(['→|Name:  (i…', '    a'])
  })

  it('draws the error under the field, the help while it holds focus, and the completions of an edit', () => {
    const field: MayflyFormField = { ...input, error: 'Required', help: 'Base URL' }
    expect(plain(paint(field, 40))).toEqual(['  Name: a', '    ! Required'])
    expect(plain(paint(field, 40, { focus: focus('i') }))).toEqual(['→|Name: a', '    ! Required', '    Base URL'])
    expect(paint(field, 400, { colors: tagged })[1]).toBe('    <error>! Required</error>')
    // The help is the first thing a narrow form drops, and a long one is cut to the row.
    expect(plain(paint(field, 39, { focus: focus('i') }))).toEqual(['→|Name: a', '    ! Required'])
    expect(plain(paint({ ...input, help: 'a very long line of help that goes on' }, 40, { focus: focus('i') }))[1]).toBe('    a very long line of help that goes …')
    expect(plain(paint({ ...input, help: 'while editing' }, 40, { focus: focus('i', { editing: true }), editing: ['a▌'] }))).toEqual(['→|Name: a▌', '    while editing'])
    const completions = plain(paint(input, 40, { focus: focus('i', { editing: true }), editing: ['~/w▌'], suggestions: ['~/work/a', '~/work/b', '~/work/c', '~/work/d'] }))
    expect(completions).toEqual(['→|Name: ~/w▌', '    ⇥ ~/work/a', '      ~/work/b', '      ~/work/c'])
    // Completions belong to an edit, not to a field that merely holds focus.
    expect(plain(paint(input, 40, { focus: focus('i'), suggestions: ['x'] }))).toEqual(['→|Name: a'])
  })

  it('opens the picker of a select as option rows under the label', () => {
    const options = [{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Beta', disabled: true, disabledReason: 'not in this plan' }, { id: 'c', label: 'Gamma' }]
    const picking = focus('s', { editing: true })
    expect(plain(paint({ kind: 'select', id: 's', label: 'Model', value: 'c', options }, 40, { focus: picking }))).toEqual([
      '→|Model',
      '      ○ Alpha',
      '      ○ Beta — not in this plan',
      '    → ● Gamma',
    ])
    expect(plain(paint({ kind: 'select', id: 's', label: 'Model', value: 'c', options }, 40, { focus: focus('s', { editing: true, optionId: 'a' }) }))[1]).toBe('    → ○ Alpha')
    expect(plain(paint({ kind: 'multiselect', id: 's', label: 'Tags', value: ['a', 'c'], options }, 40, { focus: picking }))).toEqual([
      '→|Tags',
      '    → ● Alpha',
      '      ○ Beta — not in this plan',
      '      ● Gamma',
    ])
    expect(plain(paint({ kind: 'select', id: 's', label: 'Model', value: null, options }, 40, { focus: picking }))[1]).toBe('    → ○ Alpha')
    expect(paint({ kind: 'select', id: 's', label: 'Model', value: 'a', options }, 400, { focus: picking, colors: tagged })[2]).toBe('      <muted>○ Beta — not in this plan</muted>')
    // A select with nothing to pick stays one row, and so does one that is not focused.
    expect(plain(paint({ kind: 'select', id: 's', label: 'Model', value: null, options: [] }, 40, { focus: picking }))).toEqual(['→|Model: Choose…'])
    expect(plain(paint({ kind: 'select', id: 's', label: 'Model', value: 'a', options }, 40, { focus: { ...picking, focused: false } }))).toEqual(['  Model: Alpha'])
  })
})
