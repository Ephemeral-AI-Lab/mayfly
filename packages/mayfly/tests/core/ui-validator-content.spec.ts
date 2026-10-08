/** Admission of the optional content, layout, and motion fields of slice 1.3. */
import { describe, expect, it } from 'vitest'
import { ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import { validateMayflyEditorShellNode, validateMayflyStatusNode, validateMayflyUiNode } from '../../src/core/ui-validator.ts'
import { SCROLL_HEIGHT_MAX } from '../../src/core/ui-validator-content.ts'

function accepted(value: unknown): MayflyUiNode {
  const result = validateMayflyUiNode(value)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

function rejected(value: unknown, mode: 'ui' | 'status' | 'editor' = 'ui'): string {
  const result = mode === 'status' ? validateMayflyStatusNode(value) : mode === 'editor' ? validateMayflyEditorShellNode(value) : validateMayflyUiNode(value)
  if (result.ok) throw new Error('expected a rejection')
  return result.message
}

describe('text and rich text', () => {
  it('admits middle and start ellipsis and the styles of a text node, and only wrap or truncate in rich text', () => {
    expect(accepted(ui.text('a/b/c', { overflow: 'middle', styles: ['strong', 'italic'] }))).toMatchObject({ overflow: 'middle', styles: ['strong', 'italic'] })
    expect(accepted(ui.text('a/b/c', { overflow: 'start' }))).toMatchObject({ overflow: 'start' })
    expect(rejected({ kind: 'text', content: 'x', overflow: 'end' })).toContain('overflow')
    expect(rejected({ kind: 'rich-text', spans: [{ text: 'x' }], overflow: 'middle' })).toContain('overflow')
    expect(rejected({ kind: 'text', content: 'x', styles: ['strong', 'strong'] })).toContain('duplicates')
    expect(rejected({ kind: 'text', content: 'x', styles: ['bold'] })).toContain('styles[0]')
  })
})

describe('inline motion', () => {
  const rich = (...spans: unknown[]) => ({ kind: 'rich-text', spans })

  it('admits one shimmer or one loader cell in a rich-text row', () => {
    expect(accepted(rich({ text: 'Running commands', motion: 'shimmer' }, { text: ' · 12s', tone: 'muted' }))).toMatchObject({ spans: [{ motion: 'shimmer' }, { tone: 'muted' }] })
    expect(accepted(rich({ text: '', motion: 'loader', variant: 'breath' }, { text: ' Waiting' }))).toMatchObject({ spans: [{ motion: 'loader', variant: 'breath' }, { text: ' Waiting' }] })
    expect(accepted(rich({ text: '', motion: 'loader' }))).toMatchObject({ spans: [{ motion: 'loader' }] })
  })

  it('rejects the shapes that are not one channel', () => {
    expect(rejected(rich({ text: '', motion: 'loader' }, { text: 'label', motion: 'shimmer' }))).toContain('more than one motion channel')
    expect(rejected(rich({ text: '', motion: 'loader' }, { text: '', motion: 'loader' }))).toContain('more than one motion channel')
    expect(rejected(rich({ text: 'x', motion: 'loader' }))).toContain('must be empty')
    expect(rejected(rich({ text: '', motion: 'shimmer' }))).toContain('shimmer needs text')
    expect(rejected(rich({ text: 'x', motion: 'shimmer', variant: 'gap' }))).toContain('shimmer needs text')
    expect(rejected(rich({ text: 'x', variant: 'gap' }))).toContain('needs a loader motion')
    expect(rejected(rich({ text: '', motion: 'pulse' }))).toContain('motion')
    expect(rejected(rich({ text: '', motion: 'loader', variant: 'braille' }))).toContain('variant')
  })

  it('rejects motion anywhere but rich text, and in any status node', () => {
    expect(rejected(ui.fields([{ label: 'a', value: [{ text: 'x', motion: 'shimmer' }] }]))).toContain('only supported in rich text')
    expect(rejected(ui.surface({ badges: [{ text: 'x', motion: 'shimmer' }], child: ui.text('x') }))).toContain('only supported in rich text')
    expect(rejected(rich({ text: 'x', motion: 'shimmer' }), 'status')).toContain('only supported in rich text')
    expect(rejected({ kind: 'stack', direction: 'row', children: [{ node: rich({ text: '', motion: 'loader' }) }] }, 'status')).toContain('only supported in rich text')
    const result = validateMayflyEditorShellNode({ kind: 'stack', direction: 'column', children: [{ node: { kind: 'editor-control' } }, { node: rich({ text: 'x', motion: 'shimmer' }) }] })
    expect(result.ok).toBe(true)
  })
})

describe('row admission fields', () => {
  it('admits priority, band, and overflow on a child, in a status stack too', () => {
    const row = ui.stack.row([ui.child(ui.text('a'), { priority: 0, band: 'left' }), ui.child(ui.text('b'), { priority: 4, band: 'right', overflow: 'hide' }), ui.child(ui.text('c'), { priority: 5, band: 'center', overflow: 'truncate' })])
    expect(accepted(row)).toMatchObject({ children: [{ priority: 0, band: 'left' }, { priority: 4, band: 'right', overflow: 'hide' }, { priority: 5, band: 'center', overflow: 'truncate' }] })
    const status = validateMayflyStatusNode({ kind: 'stack', direction: 'row', children: [{ node: { kind: 'text', content: 'a' }, priority: 1, overflow: 'hide' }] })
    expect(status).toMatchObject({ ok: true })
  })

  it('rejects a negative priority and unknown bands and overflows', () => {
    expect(rejected({ kind: 'stack', direction: 'row', children: [{ node: { kind: 'text', content: 'a' }, priority: -1 }] })).toContain('priority')
    expect(rejected({ kind: 'stack', direction: 'row', children: [{ node: { kind: 'text', content: 'a' }, priority: 1.5 }] })).toContain('priority')
    expect(rejected({ kind: 'stack', direction: 'row', children: [{ node: { kind: 'text', content: 'a' }, band: 'top' }] })).toContain('band')
    expect(rejected({ kind: 'stack', direction: 'row', children: [{ node: { kind: 'text', content: 'a' }, overflow: 'wrap' }] })).toContain('overflow')
  })
})

describe('surface and scroll fields', () => {
  it('admits the surface chrome fields', () => {
    const node = ui.surface({ title: 'Compose', titleAlign: 'right', border: 'warning', escapeLabel: 'reject', hint: 'completions', child: ui.text('x') })
    expect(accepted(node)).toMatchObject({ titleAlign: 'right', border: 'warning', escapeLabel: 'reject', hint: 'completions' })
    expect(accepted(ui.surface({ hint: 'none', escapeLabel: 'back', child: ui.text('x') }))).toMatchObject({ hint: 'none', escapeLabel: 'back' })
    expect(rejected({ kind: 'surface', titleAlign: 'center', child: { kind: 'spacer' } })).toContain('titleAlign')
    expect(rejected({ kind: 'surface', border: 'blue', child: { kind: 'spacer' } })).toContain('border')
    expect(rejected({ kind: 'surface', escapeLabel: 'exit', child: { kind: 'spacer' } })).toContain('escapeLabel')
    expect(rejected({ kind: 'surface', hint: 'always', child: { kind: 'spacer' } })).toContain('hint')
  })

  it('admits a declared viewport and bounds it', () => {
    expect(accepted(ui.scroll(ui.text('x'), { id: 'log', height: 6, expandedHeight: 14, fit: true, pill: true, follow: 'end' }))).toMatchObject({ height: 6, expandedHeight: 14, fit: true, pill: true })
    expect(accepted(ui.scroll(ui.text('x'), { expandedHeight: 9 }))).toMatchObject({ expandedHeight: 9 })
    expect(rejected({ kind: 'scroll', child: { kind: 'spacer' }, height: 0 })).toContain('height')
    expect(rejected({ kind: 'scroll', child: { kind: 'spacer' }, height: SCROLL_HEIGHT_MAX + 1 })).toContain('at most')
    expect(rejected({ kind: 'scroll', child: { kind: 'spacer' }, height: 8, expandedHeight: 4 })).toContain('expandedHeight')
    expect(rejected({ kind: 'scroll', child: { kind: 'spacer' }, fit: 'yes' })).toContain('fit')
  })
})

describe('code, diff, and heatmap fields', () => {
  it('admits numbered code and the diff options', () => {
    expect(accepted(ui.code('a', { language: 'ts', numbered: true }))).toMatchObject({ numbered: true })
    expect(accepted(ui.diff('a', 'b', { start: 41, numbered: false, hunkHeader: true, context: 3, maxRows: 12 }))).toMatchObject({ start: 41, numbered: false, hunkHeader: true, context: 3, maxRows: 12 })
    expect(accepted(ui.diff('a', 'b'))).toEqual({ kind: 'diff', before: 'a', after: 'b' })
    expect(rejected({ kind: 'diff', before: 'a', after: 'b', context: 4 })).toContain('at most 3')
    expect(rejected({ kind: 'diff', before: 'a', after: 'b', start: -1 })).toContain('start')
    expect(rejected({ kind: 'diff', before: 'a', after: 'b', maxRows: 0 })).toContain('maxRows')
    expect(rejected({ kind: 'code', code: 'a', numbered: 1 })).toContain('numbered')
  })

  it('admits one-cell mode and one label per column', () => {
    const levels = [{ value: 0, label: 'none' }, { value: 1, label: 'some' }]
    const heat = { kind: 'chart', chart: 'heatmap', columns: ['a', 'b'], rows: ['r'], values: [[0, 1]], levels }
    expect(accepted({ ...heat, cell: 1, columnLabels: ['Jan', ''] })).toMatchObject({ cell: 1, columnLabels: ['Jan', ''] })
    expect(accepted({ ...heat, cell: 2 })).toMatchObject({ cell: 2 })
    expect(rejected({ ...heat, cell: 3 })).toContain('cell')
    expect(rejected({ ...heat, columnLabels: ['Jan'] })).toContain('columnLabels must match columns')
  })
})

describe('loader and progress fields', () => {
  it('admits a bare loader glyph and every variant, the old ones included', () => {
    expect(accepted(ui.loader({ variant: 'breath' }))).toEqual({ kind: 'loader', variant: 'breath' })
    for (const variant of ['bloom', 'fill', 'gap', 'breath', 'braille', 'tide'] as const) expect(accepted(ui.loader({ message: 'x', variant }))).toMatchObject({ variant })
    expect(rejected({ kind: 'loader', message: 'x', variant: 'spin' })).toContain('variant')
  })

  it('admits the progress style, size, tone, labels, and transition', () => {
    const node = ui.progress({ label: 'Compacting', value: 9, max: 100, style: 'cells', width: 12, tone: 'warning', showCount: false, showPercent: true, transition: { from: 91, ms: 800, rev: 3 } })
    expect(accepted(node)).toMatchObject({ style: 'cells', width: 12, tone: 'warning', showCount: false, showPercent: true, transition: { from: 91, ms: 800, rev: 3 } })
    expect(accepted(ui.progress({ value: 1, max: 8, style: 'rule' }))).toMatchObject({ style: 'rule' })
    expect(accepted(ui.progress({ value: 9, max: 100, transition: { from: 500, ms: 10, rev: 0 } }))).toMatchObject({ transition: { from: 100 } })
    expect(rejected({ kind: 'progress', value: 1, max: 2, style: 'ring' })).toContain('style')
    expect(rejected({ kind: 'progress', value: 1, max: 2, width: 0 })).toContain('width')
    expect(rejected({ kind: 'progress', value: 1, max: 2, tone: 'blue' })).toContain('tone')
    expect(rejected({ kind: 'progress', value: 1, max: 2, showCount: 'yes' })).toContain('showCount')
    expect(rejected({ kind: 'progress', value: 1, max: 2, transition: 5 })).toContain('transition')
    expect(rejected({ kind: 'progress', value: 1, max: 2, transition: { from: 1, rev: 0 } })).toContain('ms')
    expect(rejected({ kind: 'progress', value: 1, max: 2, transition: { from: 1, ms: 0, rev: 0 } })).toContain('ms')
    expect(rejected({ kind: 'progress', value: 1, max: 2, transition: { ms: 5, rev: 0 } })).toContain('from')
    expect(rejected({ kind: 'progress', value: 1, max: 2, transition: { from: 1, ms: 5 } })).toContain('rev')
  })

  it('allows a status progress bar but no transition in it', () => {
    expect(validateMayflyStatusNode({ kind: 'progress', value: 1, max: 2, style: 'rule', width: 20 })).toMatchObject({ ok: true })
    expect(rejected({ kind: 'progress', value: 1, max: 2, transition: { from: 0, ms: 100, rev: 1 } }, 'status')).toContain('not supported in a status node')
  })
})
