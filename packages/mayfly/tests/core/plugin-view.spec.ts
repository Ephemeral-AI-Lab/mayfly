/**
 * Canonical basic-content leaf tests: sanitization, every variant, limits,
 * semantic paints, and width containment.
 *
 * @module @ephemeral-ai/mayfly/core/tests/plugin-view
 */

import { describe, expect, it } from 'vitest'
import type { MayflySectionContentNode } from '../../../ui/src/contracts.ts'
import {
  PLUGIN_VIEW_MAX_CHARS,
  PLUGIN_VIEW_MAX_DEPTH,
  paintPluginTone,
  renderCanonicalView,
  sanitizePluginText,
  summarizePluginView,
} from '../../src/core/plugin-view.ts'
import { DARK_COLORS } from '../../src/core/theme-dark.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from './width-scan.ts'

const colors = new Proxy({}, {
  get: (_target, role: string) => (text: string) => `<${role}>${text}</${role}>`,
}) as MayflySemanticColors

const components = {
  visibleWidth,
  wrapText: wrapTextWithAnsi,
  truncateToWidth,
} as MayflyComponents

function renderView(view: MayflySectionContentNode, width: number, maxRows = 20): string[] {
  return renderCanonicalView(view, width, components, colors, maxRows)
}

describe('canonical basic-content leaf renderer', () => {
  it('strips ANSI, OSC, and unsafe controls while retaining layout whitespace', () => {
    expect(sanitizePluginText('\x1b[31mred\x1b[0m\x1b]0;bad\x07\x00\nnext\t')).toBe('red\nnext\t')
  })

  it('maps every public tone to the owner palette', () => {
    expect(paintPluginTone(colors, undefined)('x')).toBe('<text>x</text>')
    expect(paintPluginTone(colors, 'default')('x')).toBe('<text>x</text>')
    expect(paintPluginTone(colors, 'muted')('x')).toBe('<muted>x</muted>')
    expect(paintPluginTone(colors, 'primary')('x')).toBe('<primary>x</primary>')
    expect(paintPluginTone(colors, 'accent')('x')).toBe('<accent>x</accent>')
    expect(paintPluginTone(colors, 'user')('x')).toBe('<roleUser>x</roleUser>')
    expect(paintPluginTone(colors, 'success')('x')).toBe('<success>x</success>')
    expect(paintPluginTone(colors, 'warning')('x')).toBe('<warning>x</warning>')
    expect(paintPluginTone(colors, 'danger')('x')).toBe('<error>x</error>')
  })

  it('renders text, fields, code, diff, and nested sections through width helpers', () => {
    expect(renderView({ kind: 'text', content: 'hello', tone: 'accent' }, 80)).toEqual(['<accent>hello</accent>'])
    expect(renderView({
      kind: 'fields',
      rows: [{ label: 'state', value: [
        { text: 'ready', tone: 'success', styles: ['strong'] },
        { text: ' softly', styles: ['italic'] },
        { text: ' retired', styles: ['strike'] },
        { text: ' now' },
      ] }],
    }, 80)[0]).toContain('<muted>state: </muted>')
    expect(renderView({ kind: 'code', language: 'ts', code: 'const x = 1\nnext' }, 80)).toEqual([
      '<muted>ts</muted>',
      '<mdCodeBlock>const x = 1</mdCodeBlock>',
      '<mdCodeBlock>next</mdCodeBlock>',
    ])
    expect(renderView({ kind: 'code', code: 'plain' }, 80)).toEqual(['<mdCodeBlock>plain</mdCodeBlock>'])
    // Changes sit on full-width bands: the sign keeps its diff color, the
    // text the body color. Real SGR keeps the padded band measurable.
    const { diffAdded, diffAddedBg, diffRemoved, diffRemovedBg, text } = DARK_COLORS
    const removed = (lead: string, body: string, fill: number): string => diffRemovedBg(`${lead}${text(body)}${' '.repeat(fill)}`)
    const added = (lead: string, body: string, fill: number): string => diffAddedBg(`${lead}${text(body)}${' '.repeat(fill)}`)
    const renderDiff = (before: string, after: string, width: number): string[] =>
      renderCanonicalView({ kind: 'diff', before, after }, width, components, DARK_COLORS)
    expect(renderDiff('old', 'new', 12)).toEqual([removed(diffRemoved('- '), 'old', 7), added(diffAdded('+ '), 'new', 7)])
    // The shared alignment renders context once between removal and addition.
    expect(renderDiff('a\nb', 'a\nc', 6)).toEqual(['  a', removed(diffRemoved('- '), 'b', 3), added(diffAdded('+ '), 'c', 3)])
    // Long lines wrap under the gutter instead of re-wrapping painted rows.
    expect(renderDiff('', 'one two', 5)).toEqual([added(diffAdded('+ '), 'one', 0), added('  ', 'two', 0)])
    expect(renderView({
      kind: 'sections',
      sections: [
        { title: 'open', body: { kind: 'text', content: 'body' } },
        { title: 'closed', body: { kind: 'text', content: 'hidden' }, collapsed: true },
        { body: { kind: 'text', content: 'hidden' }, collapsed: true },
      ],
    }, 80)).toEqual([
      '\x1b[1m<primary>open</primary>\x1b[22m',
      '<text>body</text>',
      '\x1b[1m<primary>closed</primary>\x1b[22m',
      '<muted>...</muted>',
    ])
  })

  it('rejects malformed and oversized view data without trusting casts', () => {
    expect(() => renderView(null as never, 20)).toThrow('view must be an object')
    expect(() => renderView({ kind: 'unknown' } as never, 20)).toThrow('unknown basic content kind')
    expect(() => renderView({ kind: 'text', content: 1 } as never, 20)).toThrow('must be a string')
    expect(() => renderView({ kind: 'text', content: 'x'.repeat(PLUGIN_VIEW_MAX_CHARS + 1) }, 20)).toThrow('exceeds')
    expect(() => renderView({ kind: 'fields', rows: null } as never, 20)).toThrow('fields rows')
    expect(() => renderView({ kind: 'fields', rows: [null] } as never, 20)).toThrow('field row')
    expect(() => renderView({ kind: 'fields', rows: [{ label: 'x', value: [null] }] } as never, 20)).toThrow('field span')
    expect(() => renderView({ kind: 'sections', sections: null } as never, 20)).toThrow('sections must')
    expect(() => renderView({ kind: 'sections', sections: [null] } as never, 20)).toThrow('section is invalid')

    let nested: MayflySectionContentNode = { kind: 'text', content: 'deep' }
    for (let i = 0; i <= PLUGIN_VIEW_MAX_DEPTH; i += 1) nested = { kind: 'sections', sections: [{ body: nested }] }
    expect(() => renderView(nested, 20)).toThrow('view nesting exceeds')
  })

  it('caps rows, summarizes every view kind, and rejects invalid summaries', () => {
    const fields: MayflySectionContentNode = { kind: 'fields', rows: [{ label: 'a', value: [{ text: 'b' }] }] }
    const sections: MayflySectionContentNode = { kind: 'sections', sections: [
      { title: 'named', body: { kind: 'text', content: 'ignored' } },
      { body: fields },
    ] }
    expect(renderView({ kind: 'text', content: 'a\nb\nc' }, 20, 2)).toHaveLength(2)
    expect(renderView({ kind: 'text', content: 'a' }, 20, -1)).toEqual([])
    expect(summarizePluginView({ kind: 'text', content: ' a\n b ' })).toBe('a b')
    expect(summarizePluginView(fields)).toBe('a: b')
    expect(summarizePluginView({ kind: 'code', code: 'a\n b' })).toBe('a b')
    expect(summarizePluginView({ kind: 'diff', before: '', after: '' })).toBe('diff contribution')
    expect(summarizePluginView(sections)).toBe('named · a: b')
    expect(() => summarizePluginView(null as never)).toThrow('view must be an object')
    expect(() => summarizePluginView({ kind: 'unknown' } as never)).toThrow('unknown basic content kind')
  })

  for (const fixture of ADVERSARIAL) {
    it(`keeps canonical ${fixture.name} rows inside every scanned width`, () => {
      for (const width of SCAN_WIDTHS) {
        const rows = renderView({ kind: 'text', content: fixture.text, tone: 'accent' }, width)
        expectLinesFit(`content/${fixture.name}`, rows, width)
      }
    })
  }
})
