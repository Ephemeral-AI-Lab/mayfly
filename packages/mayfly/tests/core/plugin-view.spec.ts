/**
 * Canonical basic-content leaf tests: sanitization, every variant, limits,
 * semantic paints, and width containment. The windowed kinds render through
 * `contentNodeRows`; `diff` stays eager until slice 2c.5.
 *
 * @module @ephemeral-ai/mayfly/core/tests/plugin-view
 */

import { describe, expect, it } from 'vitest'
import type { MayflySectionContentNode } from '../../../ui/src/contracts.ts'
import {
  CODE_HIGHLIGHT_MAX_BYTES,
  CODE_HIGHLIGHT_MAX_ROWS,
  PLUGIN_VIEW_MAX_DEPTH,
  paintPluginTone,
  sanitizePluginText,
  summarizePluginView,
} from '../../src/core/plugin-view.ts'
import { contentNodeSource, type ContentRowsEnv, type WindowedContentNode } from '../../src/core/content-rows.ts'
import { virtualRows } from '../../src/core/ui-rows.ts'
import { MayflyContentCache } from '../../src/core/ui-content-cache.ts'
import { DARK_COLORS } from '../../src/core/theme-dark.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'
import { ADVERSARIAL, SCAN_WIDTHS, expectLinesFit } from './width-scan.ts'

/** The leaf's rows materialized through its production row source. */
const contentNodeRows = (node: WindowedContentNode, width: number, env: ContentRowsEnv): string[] =>
  virtualRows(contentNodeSource(node, width, env))

const colors = new Proxy({}, {
  get: (_target, role: string) => (text: string) => `<${role}>${text}</${role}>`,
}) as MayflySemanticColors

const components = {
  visibleWidth,
  wrapText: wrapTextWithAnsi,
  truncateToWidth,
} as MayflyComponents

function env(bound?: number, palette: MayflySemanticColors = colors): ContentRowsEnv {
  return {
    components,
    colors: palette,
    cache: new MayflyContentCache(),
    bounded: bound !== undefined,
    viewportRows: () => bound ?? 0,
    elide: hidden => `  … +${String(hidden)} more rows`,
    errorRows: message => [`<error>${message}</error>`],
  }
}

function renderView(view: WindowedContentNode, width: number, bound?: number, palette: MayflySemanticColors = colors): string[] {
  return [...contentNodeRows(view, width, env(bound, palette))]
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
    }, 80)[0]).toContain('<muted>state:</muted> ')
    // Code is highlighted by language: keywords primary, strings success, everything else the text color.
    expect(renderView({ kind: 'code', language: 'ts', code: "const x = 'y'\nnext" }, 80)).toEqual([
      '<muted>ts</muted>',
      "<primary>const</primary><text> x = </text><success>'y'</success>",
      '<text>next</text>',
    ])
    expect(renderView({ kind: 'code', code: 'plain' }, 80)).toEqual(['<text>plain</text>'])
    // Highlighting stops after twelve rows and for blocks over 32 KB.
    const long = Array.from({ length: CODE_HIGHLIGHT_MAX_ROWS + 1 }, () => 'const a = 1').join('\n')
    expect(renderView({ kind: 'code', language: 'ts', code: long }, 80).at(-1)).toBe('<text>const a = 1</text>')
    expect(renderView({ kind: 'code', language: 'ts', code: `const a = 1\n${'中'.repeat(Math.ceil(CODE_HIGHLIGHT_MAX_BYTES / 3))}` }, 80)[1]).toBe('<text>const a = 1</text>')
    // A change is numbered and keeps its band behind the code only; a long line ends in an ellipsis.
    const { diffAdded, diffAddedBg, diffRemoved, diffRemovedBg, muted, text } = DARK_COLORS
    const renderDiff = (before: string, after: string, width: number): string[] =>
      renderView({ kind: 'diff', before, after }, width, undefined, DARK_COLORS)
    // The gutter numbers the modified file (muted); a removed line's cell is blank, and the tint stops four columns short.
    expect(renderDiff('a\nb', 'a\nc', 20)).toEqual([
      `  ${muted('1 │')}   ${text('a')}`,
      `  ${muted('  │')} ${diffRemovedBg(`${diffRemoved('−')} ${diffRemoved('b')}       `)}`,
      `  ${muted('2 │')} ${diffAddedBg(`${diffAdded('+')} ${diffAdded('c')}       `)}`,
    ])
    expect(visibleWidth(renderDiff('', 'one two three four', 18)[0]!)).toBe(14)
    expect(renderView({
      kind: 'sections',
      sections: [
        { title: 'open', body: { kind: 'text', content: 'body' } },
        { title: 'closed', body: { kind: 'text', content: 'hidden' }, collapsed: true },
        { body: { kind: 'text', content: 'hidden' }, collapsed: true },
      ],
    }, 80)).toEqual([
      '\x1b[1m<primary>open</primary>\x1b[22m',
      '  <text>body</text>',
      '\x1b[1m<primary>closed</primary>\x1b[22m',
      '<muted>  …</muted>',
      '<muted>...</muted>',
    ])
  })

  it('rejects malformed view data without trusting casts', () => {
    expect(() => renderView(null as never, 20)).toThrow('view must be an object')
    expect(() => renderView({ kind: 'unknown' } as never, 20)).toThrow('unknown basic content kind')
    expect(() => renderView({ kind: 'text', content: 1 } as never, 20)).toThrow('must be a string')
    expect(() => renderView({ kind: 'fields', rows: null } as never, 20)).toThrow('fields rows')
    expect(() => renderView({ kind: 'fields', rows: [null] } as never, 20)).toThrow('field row')
    expect(() => renderView({ kind: 'fields', rows: [{ label: 'x', value: [null] }] } as never, 20)).toThrow('field span')
    expect(() => renderView({ kind: 'fields', rows: [{ label: 'x', value: [42] }] } as never, 20)).toThrow('field span')
    expect(() => renderView({ kind: 'fields', rows: [{ label: 'x', value: [{ text: 1 }] }] } as never, 20)).toThrow('span text must be a string')
    expect(() => renderView({ kind: 'sections', sections: null } as never, 20)).toThrow('sections must')
    expect(() => renderView({ kind: 'sections', sections: [null] } as never, 20)).toThrow('section is invalid')

    let nested: MayflySectionContentNode = { kind: 'text', content: 'deep' }
    for (let i = 0; i <= PLUGIN_VIEW_MAX_DEPTH; i += 1) nested = { kind: 'sections', sections: [{ body: nested }] }
    expect(() => renderView(nested, 20)).toThrow('view nesting exceeds')
  })

  it('bounds an outside-window leaf to the viewport plus an elision row', () => {
    expect(renderView({ kind: 'text', content: 'a\nb\nc\nd\ne' }, 20, 2)).toEqual(['<text>a</text>', '<text>b</text>', '  … +3 more rows'])
    // A leaf that fits reports its natural length; unbounded leaves report it always.
    expect(renderView({ kind: 'text', content: 'a\nb' }, 20, 2).length).toBe(2)
    expect(renderView({ kind: 'text', content: 'a\nb\nc\nd\ne' }, 20).length).toBe(5)
  })

  it('summarizes every view kind and rejects invalid summaries', () => {
    const fields: MayflySectionContentNode = { kind: 'fields', rows: [{ label: 'a', value: [{ text: 'b' }] }] }
    const sections: MayflySectionContentNode = { kind: 'sections', sections: [
      { title: 'named', body: { kind: 'text', content: 'ignored' } },
      { body: fields },
    ] }
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
      // The real palette emits ANSI, which `visibleWidth` ignores; the literal-tag palette would count as columns.
      for (const width of SCAN_WIDTHS) {
        const rows = renderView({ kind: 'text', content: fixture.text, tone: 'accent' }, width, undefined, DARK_COLORS)
        expectLinesFit(`content/${fixture.name}`, rows, width)
      }
    })
  }
})
