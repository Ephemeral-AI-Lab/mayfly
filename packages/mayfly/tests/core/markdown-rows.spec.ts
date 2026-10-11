/**
 * The windowed `markdown` leaf (`core/markdown-rows.ts` units behind the `markdown` arm of
 * `core/content-rows.ts`). The pinned property is equivalence: a lazily painted window materializes the same rows
 * the eager segment renderer (`MarkdownAdapter`'s `splitRichDocument` walk) produces for the same source and
 * width. Blocks cut only at safe blank-line boundaries, the reference-definition pre-pass keeps `[x][id]` links
 * resolving, closed Mermaid fences still diagram or fall back, and oversized blocks degrade to raw-line segments.
 *
 * @module @ephemeral-ai/mayfly/core/tests/markdown-rows
 */

import { describe, expect, it } from 'vitest'
import { Markdown, type MarkdownTheme } from '@earendil-works/pi-tui'
import { contentNodeRows } from '../../src/core/content-rows.ts'
import { expandMarkdownRules, markdownTheme, scanMarkdown } from '../../src/core/markdown-rows.ts'
import { renderMermaidRows, splitRichDocument } from '../../src/core/rich-document.ts'
import { CONTENT_SEGMENT_UNITS } from '../../src/core/content-segments.ts'
import { DARK_COLORS } from '../../src/core/theme-dark.ts'
import { MayflyContentCache } from '../../src/core/ui-content-cache.ts'
import { isVirtualRows, prepareRows, rowSourceOf, unclampedRows } from '../../src/core/ui-rows.ts'
import { createWorkCounters, type MayflyWorkCounters } from '../../src/core/ui-work-counters.ts'
import type { ContentRowsEnv } from '../../src/core/content-rows.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'

const components = {
  visibleWidth,
  wrapText: wrapTextWithAnsi,
  truncateToWidth,
} as MayflyComponents

interface Env {
  readonly env: ContentRowsEnv
  readonly counters: MayflyWorkCounters
  readonly cache: MayflyContentCache
}

function makeEnv(bound?: number, colors: MayflySemanticColors = DARK_COLORS): Env {
  const counters = createWorkCounters()
  const cache = new MayflyContentCache()
  return {
    counters,
    cache,
    env: {
      components,
      colors,
      counters,
      cache,
      bounded: bound !== undefined,
      viewportRows: () => bound ?? 0,
      elide: hidden => `…${String(hidden)}`,
      errorRows: message => [`<error>${message}</error>`],
      report: () => {},
    },
  }
}

const theme = markdownTheme(DARK_COLORS)
const hr = DARK_COLORS.mdHr

/** The adapter's render, mirrored: mermaid segments paint through the rich document, the rest is one fragment each. */
function eagerRows(text: string, width: number, mdTheme: MarkdownTheme = theme): string[] {
  const segments = splitRichDocument(text)
  if (!segments.some(segment => segment.kind === 'mermaid')) {
    return expandMarkdownRules(new Markdown(text, 0, 0, mdTheme).render(width), width, hr)
  }
  return segments.flatMap(segment => {
    if (segment.kind === 'mermaid') {
      return renderMermaidRows(segment.source, width) ?? expandMarkdownRules(new Markdown(segment.fallback, 0, 0, mdTheme).render(width), width, hr)
    }
    return segment.source.length === 0 ? [] : expandMarkdownRules(new Markdown(segment.source, 0, 0, mdTheme).render(width), width, hr)
  })
}

function lazyRows(text: string, width: number, env: Env): string[] {
  const rows = contentNodeRows({ kind: 'markdown', source: text }, width, env.env)
  expect(isVirtualRows(rows)).toBe(true)
  return rows
}

const CORPUS: readonly string[] = [
  '# Title\n\nFirst para with **bold**, *em*, `code`, and [a link](https://x.example).\n\n- one\n- two\n\n> quoted\n\n---\n\n```js\nconst x = 1\n```\n',
  'plain para wrapping across a width boundary for several dozen characters of flow text\n\nnext para',
  '## Setext\n\nunder\n===\n\nmore',
  '1. first\n2. second\n\n- loose a\n\n- loose b\n\n  continuation para',
  '- a\n\n  cont\n\n- b',
  '> outer\n> > nested\n\n> second quote',
  'text\n\n<div>\nhtml\n\ninside\n</div>\n\nafter',
  'para\n\n<!-- comment\n\nblank inside\n-->\n\nrest',
  '<script>\nlet a = 1\n\nlet b = 2\n</script>\n\ntail',
  'use [x][r] here\n\nmore text\n\n[r]: /ref/url "title"',
  '[a]: /a\n[b]: /b "t"\n\n[x][a] and [y][b]',
  '[only]: /def',
  'leading blanks\n\n\ntrailing blanks\n\n\n',
  '\n\n\nstarts blank',
  'para\n\n    indented code',
  'para\n\n\tindented tab',
  '- item\n\n  ```js\nnested fence\n```\n\n- next',
  'text\n\n```mermaid\ngraph LR; A --> B\n```\n\nafter',
  'text\n\n```mermaid\nnot a real diagram body that fails\n```\n\nafter',
  'before\n```mermaid\ngraph LR; A --> B',
  'para\n\n```python\ndef f():\n  return 1\n\n  return 2\n```\n\nafter',
  '| a | b |\n| - | - |\n| 1 | 2 |\n\nafter table',
  'para\n[a]: /not-a-def-in-para\n\n[x][a]',
  'mixed [a]: /a def\npara continues\n\nuse [x][a]',
  'a\n\nb\n\n\nc\n\n\n\nd',
  'one trailing def\n\n[z]: /z',
  'first\n\n## head\n\nafter heading',
  '',
  '\n\n  \n',
  '[only]: /def\n\n',
  'para ending the doc',
  '## h\n[a]: /x\n\nuse [x][a]',
  '> quote [a]: /inner\n\npara [x][a]',
  'intro\n\n$$\nx\n\ny\n$$\n\noutro',
]

const WIDTHS = [20, 40, 80, 120]

describe('scanMarkdown', () => {
  it('groups a small document into one block unit whose slice reproduces the source', () => {
    const text = 'a\n\n\n\nb\n\n  indented\n\n- c'
    const { units, normalized } = scanMarkdown(text)
    expect(units).toHaveLength(1)
    const unit = units[0]!
    expect(unit.kind).toBe('block')
    if (unit.kind === 'block') expect(normalized.slice(unit.start, unit.end)).toBe(text)
  })

  it('splits into more block units only at space-token boundaries once over budget', () => {
    const text = Array.from({ length: 60 }, (_, index) => `para ${String(index)} ${'x'.repeat(80)}`).join('\n\n')
    const { units, normalized } = scanMarkdown(text)
    expect(units.length).toBeGreaterThan(1)
    expect(units.every(unit => unit.kind === 'block')).toBe(true)
    // Every boundary lands next to a blank run: each unit starts with a paragraph, not mid-token.
    for (const unit of units) {
      if (unit.kind === 'block') expect(normalized.slice(unit.start, unit.end)).toMatch(/^para \d+ /u)
    }
  })

  it('never cuts inside a list, a running HTML block, or a latex block', () => {
    // Under budget the whole document is one unit; the over-budget variant must still cut only at space edges.
    const listed = '- a\n\n  cont\n\n- b'
    const html = 'p\n\n<script>\na\n\n\nb\n</script>\n\nq'
    const latex = 'intro\n\n$$\nx\n\ny\n$$\n\noutro'
    for (const text of [listed, html, latex]) expect(scanMarkdown(text).units).toHaveLength(1)
    const padded = `${Array.from({ length: 60 }, (_, index) => `pad ${String(index)} ${'x'.repeat(80)}`).join('\n\n')}\n\n${latex}\n\n${listed}`
    const { units, normalized } = scanMarkdown(padded)
    expect(units.length).toBeGreaterThan(1)
    expect(units.some(unit => unit.kind === 'block' && normalized.slice(unit.start, unit.end).includes('$$'))).toBe(true)
    for (const unit of units) {
      if (unit.kind === 'block') {
        const slice = normalized.slice(unit.start, unit.end)
        expect(slice.includes('$$')).toBe(slice.includes('y\n$$'))
        expect(slice.includes('- a')).toBe(slice.includes('- b'))
      }
    }
  })

  it('collects every def line marked resolves, and only those', () => {
    const prepared = scanMarkdown('[a]: /a\n[b]: /b\n\nuse [x][a]')
    expect(prepared.defs.map(def => def.raw).join('')).toBe('[a]: /a\n[b]: /b\n')
    // A def-looking line inside a paragraph is literal text and never collected.
    expect(scanMarkdown('para\n[a]: /x\n\nuse [x][a]').defs).toHaveLength(0)
    // A def nested in a quote resolves document-wide, so it joins the preamble.
    expect(scanMarkdown('> [q]: /nested\n\nuse [x][q]').defs.map(def => def.raw).join('')).toBe('[q]: /nested\n')
  })
})

describe('markdown equivalence', () => {
  for (const text of CORPUS) {
    it.each(WIDTHS)('matches the eager renderer at width %i: %s', width => {
      const rows = lazyRows(text, width, makeEnv())
      expect(rows.slice(), `source: ${JSON.stringify(text.slice(0, 60))}`).toEqual(eagerRows(text, width))
    })
  }

  it('materializes a 512 KB document to the same rows as eager', () => {
    const parts: string[] = []
    for (let i = 0; i < 2700; i += 1) {
      parts.push(`## Section ${String(i)}\n\nPara ${String(i)} with [link ${String(i)}](https://x.example/${String(i)}) and **strong** text that keeps flowing to wrap at least a little.\n\n- item ${String(i)}a\n- item ${String(i)}b\n\n\`\`\`\nfence ${String(i)} line one\nfence ${String(i)} line two\n\`\`\``)
    }
    const text = parts.join('\n\n')
    expect(text.length).toBeGreaterThan(512 * 1024)
    const rows = lazyRows(text, 80, makeEnv())
    // Painted counts replace estimates unit by unit; preparing every unit settles the row map.
    prepareRows(rows, 0, Number.MAX_SAFE_INTEGER)
    expect(rows.slice()).toEqual(eagerRows(text, 80))
  })

  it('answers the same rows through a prepared window as through a full materialization', () => {
    const text = CORPUS[0]!.repeat(8)
    const rows = lazyRows(text, 60, makeEnv())
    prepareRows(rows, 10, 20)
    const windowed = rows.slice(10, 20)
    expect(windowed).toEqual(eagerRows(text, 60).slice(10, 20))
    expect(rows.slice()).toEqual(eagerRows(text, 60))
  })
})

describe('lazy units', () => {
  it('paints only the units a window reads', () => {
    // Forty paragraphs of ~130 chars each: each is its own unit, and the source stays lazy past one segment of work.
    const text = Array.from({ length: 40 }, (_, index) => `para ${String(index).padStart(2, '0')} ${'x'.repeat(120)}`).join('\n\n')
    expect(text.length).toBeGreaterThan(CONTENT_SEGMENT_UNITS)
    const env = makeEnv()
    const rows = lazyRows(text, 40, env)
    expect(env.counters.segmentsPainted).toBe(0)
    expect(rows[0]).toContain('para 00')
    expect(env.counters.segmentsPainted).toBe(1)
    // The estimate may leave the para's second row inside the same unit or the next; read a window and compare.
    const tail = rows.length - 4
    rows.slice(tail)
    const painted = env.counters.segmentsPainted
    expect(painted).toBeLessThanOrEqual(4)
    rows.slice()
    expect(rows.slice()).toEqual(eagerRows(text, 40))
  })

  it('keeps an unbounded document clamped to the viewport plus elision until a scroll unwraps it', () => {
    const text = Array.from({ length: 60 }, (_, index) => `row ${String(index)} ${'y'.repeat(30)}`).join('\n\n')
    const env = makeEnv(10)
    const rows = lazyRows(text, 40, env)
    expect(rows.length).toBe(11)
    expect(rows[10]).toContain('…')
    const full = unclampedRows(rows)
    expect(full.length).toBeGreaterThan(11)
    expect(full.slice(0, 10)).toEqual(rows.slice(0, 10))
  })

  it('memoizes the scan per admitted node and the painted fragments per width', () => {
    const node = { kind: 'markdown' as const, source: Array.from({ length: 50 }, (_, index) => `memo ${String(index)} ${'x'.repeat(80)}`).join('\n\n') }
    expect(node.source.length).toBeGreaterThan(CONTENT_SEGMENT_UNITS)
    const env = makeEnv()
    const wide = contentNodeRows(node, 80, env.env)
    const narrow = contentNodeRows(node, 40, env.env)
    expect(rowSourceOf(wide)).not.toBe(rowSourceOf(narrow))
    wide.slice(0, 6)
    const painted = env.counters.segmentsPainted
    narrow.slice(0, 6)
    expect(env.counters.segmentsPainted).toBeGreaterThan(painted)
  })

  it('degrades an oversized block to raw-line segments and still answers every row', () => {
    const fence = `\`\`\`log\n${Array.from({ length: 300 }, (_, index) => `log ${String(index)} ${'z'.repeat(40)}`).join('\n')}\n\`\`\``
    const text = `before\n\n${fence}\n\nafter`
    expect(fence.length).toBeGreaterThan(CONTENT_SEGMENT_UNITS)
    const env = makeEnv()
    const rows = lazyRows(text, 60, env)
    rows.slice()
    const all = rows.slice()
    expect(all[0]).toContain('before')
    expect(all.at(-1)).toContain('after')
    expect(all.some(row => row.includes('log 150'))).toBe(true)
    expect(all.every(row => visibleWidth(row) <= 60)).toBe(true)
  })
})
