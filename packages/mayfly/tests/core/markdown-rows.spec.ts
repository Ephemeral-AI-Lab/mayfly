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
import { contentNodeSource, type ContentRowsEnv, type WindowedContentNode } from '../../src/core/content-rows.ts'
import { virtualRows } from '../../src/core/ui-rows.ts'
import { expandMarkdownRules, markdownTheme, scanMarkdown, type MarkdownUnit } from '../../src/core/markdown-rows.ts'
import { renderMermaidRows, splitRichDocument } from '../../src/core/rich-document.ts'
import { CONTENT_SEGMENT_UNITS } from '../../src/core/content-segments.ts'
import { DARK_COLORS } from '../../src/core/theme-dark.ts'
import { MayflyContentCache } from '../../src/core/ui-content-cache.ts'
import { isVirtualRows, prepareRows, rowSourceOf, unclampedRows } from '../../src/core/ui-rows.ts'
import { createWorkCounters, type MayflyWorkCounters } from '../../src/core/ui-work-counters.ts'
import type { MayflyComponents, MayflySemanticColors } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'

/** The leaf's rows materialized through its production row source. */
const contentNodeRows = (node: WindowedContentNode, width: number, env: ContentRowsEnv): string[] =>
  virtualRows(contentNodeSource(node, width, env))

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
  '[ref]: /target "title"\n***\n# Top\n[ref]: /target "title"\nSetext\n===',
  'a\n\n[r]: /t\n```js\nx\n```\n[r]: /t\n# Top\n[r]: /t\nlast',
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

describe('scan cost and latex boundaries', () => {
  it('scans a megabyte of paragraphs in time linear in its size', () => {
    const text = Array.from({ length: 20_000 }, (_, index) => `Paragraph ${String(index)} with some words and [a link](http://x/${String(index)}).`).join('\n\n')
    expect(text.length).toBeGreaterThan(1_000_000)
    const started = performance.now()
    scanMarkdown(text)
    // The quadratic start callback took 3-4 s here; the linear scan takes about a tenth of a second.
    expect(performance.now() - started).toBeLessThan(1500)
  })

  it('keeps latex blocks and whitespace-only separators equal to the eager render', () => {
    const pieces = [
      'a paragraph of plain words that runs on\n', '\n', '  \n', '\n\n', '$$\nx^2\n$$\n', '\\[\ny\n\\]\n', 'text right before\n$$\nm\n$$\n',
      '$$ one line $$\n', '# Heading\n', '- a\n- b\n', '> quote\n', '```\ncode\n```\n', 'tail with \\[ inline ]\n', '1. one\n2. two\n',
    ]
    let seed = 12345
    const next = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296 }
    for (let round = 0; round < 12; round += 1) {
      let text = ''
      while (text.length < CONTENT_SEGMENT_UNITS * 3) text += pieces[Math.floor(next() * pieces.length)]!
      const rows = lazyRows(text, 50, makeEnv())
      prepareRows(rows, 0, Number.MAX_SAFE_INTEGER)
      expect(rows.slice(), `round ${String(round)}`).toEqual(eagerRows(text, 50))
    }
  })
})

describe('adjacent blocks without blank lines', () => {
  const unitSize = (unit: MarkdownUnit): number => unit.kind === 'mermaid' ? 0 : unit.end - unit.start

  // Lists, quotes, tables, and paragraphs take the lines after them as lazy continuation, so each is followed by a
  // block that interrupts it; the rest may follow anything.
  const SWALLOWING = [
    'a paragraph of plain words that runs on for a while', '- one\n- two', '1. first\n2. second', '> quoted\n> more', '| a | b |\n| - | - |\n| 1 | 2 |', 'text with [ref] use',
  ]
  const STANDING = ['## Heading', '# Top', '```js\nconst x = 1\n```', '***', '$$\nx^2\n$$', '[ref]: /target "title"', 'Setext\n===']
  const INTERRUPTING = ['## Next', '***', '```\nfence\n```', '- list after\n- items']

  it('cuts a run of adjacent headings into bounded units', () => {
    const text = Array.from({ length: 8000 }, (_, index) => `## Heading ${String(index)}`).join('\n')
    const { units } = scanMarkdown(text)
    expect(units.length).toBeGreaterThan(20)
    expect(Math.max(...units.map(unitSize))).toBeLessThanOrEqual(CONTENT_SEGMENT_UNITS + 32)
  })

  it('cuts a run of adjacent code fences into bounded units', () => {
    const text = Array.from({ length: 3000 }, (_, index) => `\`\`\`\ncode ${String(index)}\n\`\`\``).join('\n')
    const { units } = scanMarkdown(text)
    expect(units.length).toBeGreaterThan(10)
    expect(Math.max(...units.map(unitSize))).toBeLessThanOrEqual(CONTENT_SEGMENT_UNITS + 64)
  })

  it.each([20, 60])('paints the rows of the whole render across tight cuts of every block pair at width %i', width => {
    let seed = 777
    const next = (): number => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed / 4294967296 }
    for (let round = 0; round < 16; round += 1) {
      const parts: string[] = []
      let length = 0
      while (length < CONTENT_SEGMENT_UNITS * 4) {
        const swallowing = next() < 0.5
        const pool = swallowing ? SWALLOWING : STANDING
        const block = pool[Math.floor(next() * pool.length)]!
        parts.push(block)
        length += block.length + 1
        if (swallowing) {
          const stop = INTERRUPTING[Math.floor(next() * (block.startsWith('- ') || block.startsWith('1.') ? INTERRUPTING.length - 1 : INTERRUPTING.length))]!
          parts.push(stop)
          length += stop.length + 1
        }
      }
      // Single newlines only: no space token ever separates two blocks, so every unit boundary is a tight cut.
      const text = parts.join('\n')
      const prepared = scanMarkdown(text)
      expect(prepared.units.length, `round ${String(round)} cuts`).toBeGreaterThan(3)
      expect(prepared.units.some(unit => unit.kind === 'block' && unit.closed === true)).toBe(true)
      expect(prepared.units.some(unit => unit.kind === 'block' && unit.closed !== true)).toBe(true)
      const rows = lazyRows(text, width, makeEnv())
      prepareRows(rows, 0, Number.MAX_SAFE_INTEGER)
      expect(rows.slice(), `round ${String(round)}`).toEqual(eagerRows(text, width))
    }
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

describe('scanMarkdown of a growing source', () => {
  const block = (index: number): string => [
    `## Part ${String(index)}`,
    `A paragraph with **bold**, \`code\`, and a [link](https://example.com/${String(index)}). ${'words '.repeat(60)}`,
    '- one\n- two\n  - nested\n\n- loose three',
    ['| a | b |', '| --- | ---: |', `| ${String(index)} | x |`, '| 2 | y |'].join('\n'),
    ['```ts', `const n${String(index)} = ${String(index)}`, '', 'export default n', '```'].join('\n'),
    '> a quote\n> over two lines',
    `Setext ${String(index)}\n-----`,
    '---',
    '```mermaid\ngraph TD; A-->B\n```',
    '1. first\n2. second',
  ].join('\n\n')

  /** A scan without `scanned`, the lines it lexed: an extension lexes fewer than a whole scan does. */
  const sans = ({ scanned: _scanned, ...scan }: ReturnType<typeof scanMarkdown>) => scan

  /** A small deterministic generator, so a failing split reproduces. */
  const generator = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }

  it('scans to what a whole scan gives, at every size an append can take', () => {
    const text = Array.from({ length: 22 }, (_, index) => block(index)).join('\n\n')
    expect(text.length).toBeGreaterThan(3 * CONTENT_SEGMENT_UNITS)
    for (const seed of [1, 2, 3]) {
      const next = generator(seed)
      let previous = scanMarkdown('')
      let at = 0
      while (at < text.length) {
        at = Math.min(text.length, at + 1 + Math.floor(next() * 90))
        const source = text.slice(0, at)
        const grown = scanMarkdown(source, previous)
        expect(sans(grown), `seed ${String(seed)} at ${String(at)}`).toEqual(sans(scanMarkdown(source)))
        previous = grown
      }
    }
  })

  it('reuses a scan for the same text without lexing it again', () => {
    const first = scanMarkdown('# t\n\nbody')
    const again = scanMarkdown('# t\n\nbody', first)
    expect(again).toMatchObject({ units: first.units, lines: first.lines, scanned: 0 })
  })

  it('scans a source with a link definition whole, and a source that is not an extension whole', () => {
    const first = scanMarkdown(`${'para\n\n'.repeat(900)}[r]: /t\n\nlast`)
    const defined = `${'para\n\n'.repeat(900)}[r]: /t\n\nlast and more [r]`
    expect(sans(scanMarkdown(defined, first))).toEqual(sans(scanMarkdown(defined)))
    const other = 'something else entirely\n\nwith blocks'
    expect(sans(scanMarkdown(other, first))).toEqual(sans(scanMarkdown(other)))
  })
})
