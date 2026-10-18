/** The remaining optional content fields: the heatmap range legend and the chart labels/formats.
 * @module @ephemeral-ai/mayfly/tests/core/ui-validator-content-charts
 */
import { describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { validateMayflyUiNode } from '../../src/core/ui-validator.ts'

function accepted(value: unknown) {
  const result = validateMayflyUiNode(value)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

function rejected(value: unknown): string {
  const result = validateMayflyUiNode(value)
  if (result.ok) throw new Error('expected a rejection')
  return result.message
}

const levels = [{ value: 0, label: 'none' }, { value: 1, label: 'some' }]
const heat = { kind: 'chart', chart: 'heatmap', columns: ['a', 'b'], rows: ['r'], values: [[0, 1]], levels }

describe('heatmap range legend', () => {
  it('admits the two range words and leaves column labels alone', () => {
    expect(accepted({ ...heat, range: { less: 'Less', more: 'More' } })).toMatchObject({ range: { less: 'Less', more: 'More' } })
    expect(accepted({ ...heat, range: { less: '', more: '' } })).toMatchObject({ range: { less: '', more: '' } })
  })

  it('rejects a non-object range and a missing range word', () => {
    expect(rejected({ ...heat, range: 'Less' })).toContain('range must be an object')
    expect(rejected({ ...heat, range: [] })).toContain('range must be an object')
    expect(rejected({ ...heat, range: null })).toContain('range must be an object')
    expect(rejected({ ...heat, range: { less: 'Less' } })).toContain('range.more')
    expect(rejected({ ...heat, range: { less: 1, more: 'More' } })).toContain('range.less')
  })
})

describe('line and point chart fields', () => {
  const points = [{ x: 0, y: 1 }, { x: 1, y: null }]
  const line = { kind: 'chart', chart: 'line', series: [{ id: 's', points }] }

  it('admits x labels, the compact y format, and the legend switch', () => {
    const node = accepted({ ...line, xLabels: ['Jan', 'Feb'], yFormat: 'compact', legend: false })
    expect(node).toMatchObject({ xLabels: ['Jan', 'Feb'], yFormat: 'compact', legend: false })
    expect(accepted({ ...line, chart: 'point', xLabels: [], legend: true })).toMatchObject({ xLabels: [], legend: true })
  })

  it('rejects a malformed x label, an unknown y format, and a non-boolean legend', () => {
    expect(rejected({ ...line, xLabels: 'Jan' })).toContain('xLabels must be an array')
    expect(rejected({ ...line, xLabels: ['Jan', 2] })).toContain('xLabels[1]')
    expect(rejected({ ...line, yFormat: 'short' })).toContain('yFormat')
    expect(rejected({ ...line, legend: 'yes' })).toContain('legend')
  })
})

describe('bar chart fields', () => {
  const bars = { kind: 'chart', chart: 'bar', categories: ['a'], series: [{ id: 's', values: [1] }] }

  it('admits the compact y format and the legend switch', () => {
    expect(accepted({ ...bars, yFormat: 'compact', legend: true })).toMatchObject({ yFormat: 'compact', legend: true })
    expect(accepted({ ...bars, yFormat: 'compact' })).toMatchObject({ yFormat: 'compact' })
  })

  it('rejects an unknown y format and a non-boolean legend', () => {
    expect(rejected({ ...bars, yFormat: 'percent' })).toContain('yFormat')
    expect(rejected({ ...bars, legend: 1 })).toContain('legend')
  })
})

describe('remaining optional presentation fields', () => {
  it('admits a diff tail and language, a child mark, and a title cut', () => {
    expect(accepted(ui.diff('a', 'b', { tail: '…', language: 'ts' }))).toMatchObject({ tail: '…', language: 'ts' })
    expect(accepted({ kind: 'stack', direction: 'row', children: [{ node: { kind: 'text', content: 'a' }, mark: 'underline' }] }))
      .toMatchObject({ children: [{ mark: 'underline' }] })
    expect(accepted(ui.surface({ title: 'x', titleCut: 'end', escapeLabel: 'leave', child: ui.text('x') })))
      .toMatchObject({ titleCut: 'end', escapeLabel: 'leave' })
    expect(accepted(ui.surface({ title: 'x', titleCut: 'start', border: 'default', child: ui.text('x') })))
      .toMatchObject({ titleCut: 'start', border: 'default' })
    expect(rejected({ kind: 'diff', before: 'a', after: 'b', tail: 2 })).toContain('tail')
    expect(rejected({ kind: 'surface', titleCut: 'middle', child: { kind: 'spacer' } })).toContain('titleCut')
    expect(rejected({ kind: 'stack', direction: 'row', children: [{ node: { kind: 'text', content: 'a' }, mark: 'bold' }] })).toContain('mark')
  })
})
