/**
 * Windowed painters for the content leaf kinds (`text`, `fields`, `code`, `sections`, `rich-text` without motion;
 * `diff` stays eager until slice 2c.5). Instead of rendering every row, a leaf indexes its text once per node
 * (`content-segments.ts`), answers its height from per-segment row estimates at the asked width, and paints a segment
 * only when a row inside it is read — a scroll `prepare`d its window or the layout indexed the row. Painted segments
 * live in the renderer's content cache (`ui-content-cache.ts`), keyed by node, segment, and width, so a repaint is
 * free and the estimate under a painted window is always the truth.
 *
 * A leaf the viewport cannot fully show reports at most the viewport's rows plus a `… N more rows` elision row
 * (`elidedSource`): that keeps every bounded-height consumer — pi-tui's clipped-leaf marker scan, a horizontal
 * stack's intrinsic-width measure — reading a bounded prefix. A scroll unwraps the bound through the source's
 * `unclamped` chain (`ui-rows.ts`), so inside a window the leaf reports its natural length. In the main screen every
 * leaf reports its natural length: the transcript prints all of it.
 *
 * @module @ephemeral-ai/mayfly/core/content-rows
 */

import type { MayflyContentNode, MayflyField, MayflyRichTextNode, MayflySection, MayflySectionContentNode, MayflyTextStyle, MayflyTone, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { CONTENT_SEGMENT_UNITS, indexContent, type ContentIndex } from './content-segments.ts'
import { ownDataErrorMessage } from './error-message.ts'
import { highlightable, highlightCodeLines } from './highlight.ts'
import {
  CODE_HIGHLIGHT_MAX_BYTES,
  CODE_HIGHLIGHT_MAX_ROWS,
  PLUGIN_VIEW_MAX_DEPTH,
  paintPluginTone,
  renderCanonicalDiff,
  requireText,
  sanitizePluginText,
  strong,
  styledText,
  truncatedRow,
} from './plugin-view.ts'
import { concatRows, mapRows, rowSourceOf, rowsSource, virtualRows, type RowSource } from './ui-rows.ts'
import { paintedRowsBytes, type MayflyContentCache } from './ui-content-cache.ts'
import type { MayflyComponents, MayflySemanticColors } from './types.ts'
import { truncateMiddle } from './width.ts'
import { countWork, type MayflyWorkCounters } from './ui-work-counters.ts'

/** The leaf kinds this module paints; `MayflySectionContentNode` covers `sections` bodies. */
export type WindowedContentNode = MayflySectionContentNode | Extract<MayflyContentNode, { readonly kind: 'rich-text' }>

/** What a content leaf needs beyond its node: width helpers, palette, the content cache, and the frame contract. */
export interface ContentRowsEnv {
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  readonly counters?: MayflyWorkCounters | undefined
  readonly cache: MayflyContentCache
  /** Whether the outside-window elision applies (the alternate screen); the main screen prints every row. */
  readonly bounded: boolean
  /** Rows the viewport gives a leaf outside any window; the leaf clamps to this plus its elision row. */
  readonly viewportRows: () => number
  /** The row shown for `hidden` rows the outside-window clamp removed. */
  readonly elide: (hidden: number) => string
  /** Contained error rows for a segment whose paint threw, one failure per segment. */
  readonly errorRows: (message: string, width: number) => string[]
  /** Report a contained paint failure to the host, once per segment. */
  readonly report?: ((message: string) => void) | undefined
}

/** Prefix sums over per-segment row counts; an estimate becomes the painted count wherever a segment is painted. */
class Fenwick {
  private readonly tree: Float64Array
  constructor(private readonly size: number) {
    this.tree = new Float64Array(size + 1)
  }

  add(index: number, delta: number): void {
    for (let at = index + 1; at <= this.size; at += at & -at) this.tree[at]! += delta
  }

  /** Rows in segments `[0, index]`; a negative index sums nothing. */
  sum(index: number): number {
    let total = 0
    for (let at = index + 1; at > 0; at -= at & -at) total += this.tree[at]!
    return total
  }

  /** The segment containing row `row`: the smallest index whose prefix sum exceeds it. */
  locate(row: number): number {
    let bit = 1
    while (bit * 2 <= this.size) bit <<= 1
    let segment = 0
    let covered = 0
    for (; bit > 0; bit >>= 1) {
      const next = segment + bit
      if (next <= this.size && covered + this.tree[next]! <= row) {
        segment = next
        covered += this.tree[next]!
      }
    }
    return Math.min(segment, this.size - 1)
  }
}

/**
 * The row source of one segmented text at one width: `length` is the current row map (estimates replaced by painted
 * counts as segments paint), `row` paints the segment under the row on first touch, and `prepare` paints the segments
 * under a window so the map is exact where the frame looks. Painted rows are marker-free: sanitizing stripped every
 * sequence the cursor marker could hide in.
 */
class SegmentedContent implements RowSource {
  readonly declaredWidth: number
  readonly markerFree = true
  private readonly counts: number[]
  private readonly tree: Fenwick
  private readonly failures = new Set<number>()

  constructor(
    private readonly index: ContentIndex,
    /** The text the index measured: anchors map their source positions through it. */
    private readonly text: () => string,
    /** The width rows wrap and estimate at: the leaf width minus whatever fixed chrome the painter adds. */
    private readonly wrapWidth: number,
    private readonly paint: (segment: number, width: number) => readonly string[],
    private readonly env: ContentRowsEnv,
    private readonly key: string,
    /** Columns the painter adds beside the wrap, for the leaf's declared width. */
    extraColumns = 0,
  ) {
    this.counts = new Array<number>(index.segments)
    this.tree = new Fenwick(index.segments)
    for (let segment = 0; segment < index.segments; segment += 1) {
      const estimate = index.estimateRows(segment, wrapWidth)
      this.counts[segment] = estimate
      this.tree.add(segment, estimate)
    }
    this.declaredWidth = Math.min(wrapWidth + extraColumns, extraColumns + index.maxColumns)
    // A document that fits a segment's paint budget is painted eagerly: its row map is exact at once, so a small
    // leaf never shows a one-frame tail while an estimate converges.
    if (index.units <= CONTENT_SEGMENT_UNITS) this.prepare(0, Number.MAX_SAFE_INTEGER)
  }

  get length(): number {
    return this.index.segments === 0 ? 0 : this.tree.sum(this.index.segments - 1)
  }

  private cacheKey(segment: number): string {
    return `${this.key}:${String(this.wrapWidth)}:${String(segment)}`
  }

  /** The painted rows of one segment: the cache answers repaints, otherwise the painter runs once. */
  private segmentRows(segment: number): readonly string[] {
    let rows = this.env.cache.get(this.cacheKey(segment))
    if (rows === undefined) {
      rows = this.paintSafely(segment)
      this.env.cache.put(this.cacheKey(segment), rows, paintedRowsBytes(rows))
      countWork(this.env.counters, 'segmentsPainted')
      countWork(this.env.counters, 'rowsPainted', rows.length)
    }
    if (this.counts[segment] !== rows.length) {
      this.tree.add(segment, rows.length - this.counts[segment]!)
      this.counts[segment] = rows.length
    }
    return rows
  }

  private paintSafely(segment: number): readonly string[] {
    try {
      return this.paint(segment, this.wrapWidth)
    } catch (error) {
      const message = ownDataErrorMessage(error) ?? 'unknown render failure'
      if (!this.failures.has(segment)) {
        this.failures.add(segment)
        this.env.report?.(message)
      }
      return this.env.errorRows(message, this.wrapWidth)
    }
  }

  row(index: number): string {
    if (index < 0 || index >= this.length) return ''
    const segment = this.tree.locate(index)
    const rows = this.segmentRows(segment)
    countWork(this.env.counters, 'rowsMaterialized')
    return rows[index - this.tree.sum(segment - 1)] ?? ''
  }

  /**
   * Rows before `offset` units of the text, under the source's own row map: painted segments count their painted
   * rows before the offset's segment, and inside the segment the index estimates the share the offset's columns
   * cover — the same model `offsetOf` inverts, so an anchor round-trips to the row it was written from.
   */
  rowOf(offset: number): number {
    if (this.index.segments === 0) return 0
    const segment = this.index.segmentAtOffset(offset)
    const local = Math.min(this.index.rowOfOffset(segment, offset, this.wrapWidth, this.text()), this.counts[segment]! - 1)
    return this.tree.sum(segment - 1) + Math.max(0, local)
  }

  /** The text offset `row` begins at: the segment under the row, then the estimated boundary inside it. */
  offsetOf(row: number): number {
    if (this.index.segments === 0) return 0
    const segment = this.tree.locate(row)
    const local = Math.min(Math.max(0, row - this.tree.sum(segment - 1)), this.counts[segment]! - 1)
    return this.index.offsetOfRow(segment, local, this.wrapWidth, this.text())
  }

  prepare(from: number, to: number): void {
    if (from >= this.length) return
    let segment = this.tree.locate(Math.max(0, from))
    while (segment < this.index.segments && this.tree.sum(segment - 1) < to) {
      this.segmentRows(segment)
      segment += 1
    }
  }
}

const indexes = new WeakMap<object, ContentIndex>()
const nodeIds = new WeakMap<object, number>()
let nextNodeId = 0

/** The measure index of one node, built once from its text and shared by every width and repaint. */
function indexFor(node: object, text: () => string, env: ContentRowsEnv): ContentIndex {
  let index = indexes.get(node)
  if (index === undefined) {
    index = indexContent(text(), lines => countWork(env.counters, 'linesEstimated', lines))
    indexes.set(node, index)
  }
  return index
}

/** The cache-key prefix of one node: an id per admitted node object, stable for the surface's life. */
function keyOf(node: object): string {
  let id = nodeIds.get(node)
  if (id === undefined) {
    id = nextNodeId += 1
    nodeIds.set(node, id)
  }
  return `n${String(id)}`
}

const sourceOf = (rows: string[]): RowSource => rowSourceOf(rows) ?? rowsSource(rows)

/** Already-painted rows as a source, counting what the old per-width memo would have counted. */
function eager(rows: string[], env: ContentRowsEnv): RowSource {
  countWork(env.counters, 'rowsPainted', rows.length)
  return rowsSource(rows)
}

interface SanitizedSpan {
  readonly tone?: MayflyTone | undefined
  readonly styles?: readonly MayflyTextStyle[] | undefined
  /** Text painted raw, outside any tone (the field column's separator space is one). */
  readonly raw?: true | undefined
  readonly text: string
}

/** Spans clipped to the `[start, end)` range of their joined text; each piece keeps its paint. */
function clipSpans(spans: readonly SanitizedSpan[], start: number, end: number): SanitizedSpan[] {
  const clipped: SanitizedSpan[] = []
  let at = 0
  for (const span of spans) {
    const next = at + span.text.length
    const from = Math.max(start, at)
    const to = Math.min(end, next)
    if (from < to) clipped.push({ tone: span.tone, styles: span.styles, raw: span.raw, text: span.text.slice(from - at, to - at) })
    at = next
    if (at >= end) break
  }
  return clipped
}

const paintSpan = (span: SanitizedSpan, colors: MayflySemanticColors): string =>
  styledText(span.raw === true ? span.text : paintPluginTone(colors, span.tone)(span.text), span.styles)

const ANSI_AT = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/uy
const SGR_AT = /^\x1b\[([0-9;]*)m/u
const grapheme = new Intl.Segmenter('en', { granularity: 'grapheme' })

/**
 * The SGR attribute one code controls: opening codes key their channel, closing codes key it with `-` so a close
 * deletes the matching open. Foreground/background truecolor and palette codes share one channel each.
 */
function sgrChannel(code: string): string | undefined {
  const params = SGR_AT.exec(code)?.[1]
  if (params === undefined) return undefined
  const first = Number(params.split(';', 1)[0] ?? '0')
  if (first === 0 || Number.isNaN(first)) return ''
  switch (first) {
    case 1: case 2: case 22: return first === 22 ? '-w' : 'w'
    case 3: case 23: return first === 23 ? '-i' : 'i'
    case 4: case 24: return first === 24 ? '-u' : 'u'
    case 5: case 6: case 25: return first === 25 ? '-b' : 'b'
    case 7: case 27: return first === 27 ? '-v' : 'v'
    case 8: case 28: return first === 28 ? '-h' : 'h'
    case 9: case 29: return first === 29 ? '-s' : 's'
    case 30: case 31: case 32: case 33: case 34: case 35: case 36: case 37: case 38: case 39:
    case 90: case 91: case 92: case 93: case 94: case 95: case 96: case 97:
      return first === 39 ? '-fg' : 'fg'
    case 40: case 41: case 42: case 43: case 44: case 45: case 46: case 47: case 48: case 49:
    case 100: case 101: case 102: case 103: case 104: case 105: case 106: case 107:
      return first === 49 ? '-bg' : 'bg'
    case 51: case 54: return first === 54 ? '-f' : 'f'
    case 53: case 55: return first === 55 ? '-o' : 'o'
    default: return `x${String(first)}`
  }
}

/**
 * A column-exact wrap for a cut of a long line (D31): graphemes pack each row to the wrap width so a window lands
 * identically wherever the cut started. Painted input is legal: escape sequences travel with the text, open SGR
 * attributes reopen at each following row (a terminal row's styling must be self-contained), and the cut stays
 * deterministic because no word boundary is consulted.
 */
function charWrap(text: string, width: number, components: Pick<MayflyComponents, 'visibleWidth'>): string[] {
  if (text.length === 0) return ['']
  const active = new Map<string, string>()
  const rows: string[] = []
  let row = ''
  let columns = 0
  const push = (): void => {
    rows.push(row)
    row = [...active.values()].join('')
    columns = 0
  }
  const segments = grapheme.segment(text)
  let cursor = 0
  while (cursor < text.length) {
    if (text.charCodeAt(cursor) === 0x1b) {
      ANSI_AT.lastIndex = cursor
      const ansi = ANSI_AT.exec(text)
      const code = ansi?.[0] ?? '\x1b'
      row += code
      cursor += code.length
      const channel = ansi?.[0] === undefined ? undefined : sgrChannel(ansi[0])
      if (channel !== undefined) {
        if (channel === '') active.clear()
        else if (channel.startsWith('-')) active.delete(channel.slice(1))
        else active.set(channel, code)
      }
      continue
    }
    const cluster = segments.containing(cursor)?.segment ?? text[cursor]!
    const wide = components.visibleWidth(cluster)
    if (columns + wide > width && columns > 0) { push(); continue }
    row += cluster
    columns += wide
    cursor += cluster.length
  }
  if (columns > 0 || rows.length === 0) push()
  return rows
}

function textSource(node: Extract<MayflySectionContentNode, { readonly kind: 'text' }>, width: number, env: ContentRowsEnv): RowSource {
  const content = requireText(node.content, 'text content')
  const tone = paintPluginTone(env.colors, node.tone)
  const painted = (row: string): string => styledText(tone(row), node.styles)
  if (node.overflow === 'truncate') return eager([painted(truncatedRow(sanitizePluginText(content), width, env.components))], env)
  if (node.overflow === 'middle' || node.overflow === 'start') return eager([painted(truncateMiddle(sanitizePluginText(content).replace(/[\r\n\t]+/gu, ' '), width, node.overflow))], env)
  const index = indexFor(node, () => content, env)
  return new SegmentedContent(index, () => content, width, (segment, at) => {
    const rows: string[] = []
    const paint = (start: number, end: number, cut: boolean): void => {
      const slice = sanitizePluginText(content.slice(start, end))
      const wrapped = cut ? charWrap(slice, at, env.components) : env.components.wrapText(slice, at)
      for (const row of wrapped) rows.push(painted(row))
    }
    if (index.isCut(segment)) {
      const [start, end] = index.segmentText(segment)
      paint(start, end, true)
      return rows
    }
    const [first, past] = index.segmentLines(segment)
    for (let line = first; line < past; line += 1) {
      const [start, end] = index.lineText(line)
      paint(start, end, false)
    }
    return rows
  }, env, keyOf(node))
}

function codeSource(node: Extract<MayflySectionContentNode, { readonly kind: 'code' }>, width: number, env: ContentRowsEnv): RowSource {
  const code = requireText(node.code, 'code content')
  const language = node.language === undefined ? '' : sanitizePluginText(requireText(node.language, 'code language'))
  const index = indexFor(node, () => code, env)
  const digits = node.numbered === true ? String(index.lines).length : 0
  const gutter = digits === 0 ? 0 : digits + 3
  const inner = Math.max(1, width - gutter)
  // Highlighting keeps its old cap (roadmap §2.2 row 14): the first rows of a block up to 32 KB, computed once.
  let highlighted: readonly string[] | undefined
  const highlights = (): readonly string[] => {
    if (highlighted === undefined) {
      if (Buffer.byteLength(code, 'utf8') > CODE_HIGHLIGHT_MAX_BYTES || !highlightable(language)) highlighted = []
      else {
        const head: string[] = []
        for (let line = 0; line < Math.min(index.lines, CODE_HIGHLIGHT_MAX_ROWS); line += 1) {
          const [start, end] = index.lineText(line)
          head.push(sanitizePluginText(code.slice(start, end)))
        }
        highlighted = highlightCodeLines(head.join('\n'), language, { base: env.colors.text, keyword: env.colors.primary, string: env.colors.success, comment: env.colors.muted })
      }
    }
    return highlighted
  }
  const body = new SegmentedContent(index, () => code, inner, (segment, at) => {
    const rows: string[] = []
    const wrap = (line: number, painted: string, numbered: boolean, cut: boolean): void => {
      const wrapped = cut ? charWrap(painted, at, env.components) : env.components.wrapText(painted, at)
      wrapped.forEach((row, offset) => {
        if (gutter === 0) { rows.push(row); return }
        const mark = numbered && offset === 0 ? `${String(line + 1).padStart(digits)} │ ` : ' '.repeat(gutter)
        rows.push(`${env.colors.muted(mark)}${row}`)
      })
    }
    if (index.isCut(segment)) {
      const [start, end] = index.segmentText(segment)
      const [line] = index.segmentLines(segment)
      // A cut inside a line is a continuation unless the cut begins the line, whose first row carries the number.
      wrap(line, sanitizePluginText(code.slice(start, end)), start === index.lineText(line)[0], true)
      return rows
    }
    const [first, past] = index.segmentLines(segment)
    const lit = highlights()
    for (let line = first; line < past; line += 1) {
      const [start, end] = index.lineText(line)
      wrap(line, lit[line] ?? env.colors.text(sanitizePluginText(code.slice(start, end))), true, false)
    }
    return rows
  }, env, keyOf(node), gutter)
  if (language.length === 0) return body
  countWork(env.counters, 'rowsPainted', 1)
  const lifted = sourceOf(concatRows([env.colors.muted(language)], virtualRows(body)))
  // The anchor's text space is `language\ncode`: the label row covers the prefix, the body maps the rest.
  return {
    get length() { return lifted.length },
    row: index => lifted.row(index),
    ...(lifted.declaredWidth === undefined ? {} : { declaredWidth: lifted.declaredWidth }),
    ...(lifted.markerFree === true ? { markerFree: true } : {}),
    ...(lifted.seekMarker === undefined ? {} : { seekMarker: lifted.seekMarker.bind(lifted) }),
    ...(lifted.prepare === undefined ? {} : { prepare: lifted.prepare.bind(lifted) }),
    get unclamped() { return lifted.unclamped },
    rowOf(offset) { return offset <= language.length ? 0 : 1 + body.rowOf(offset - language.length - 1) },
    offsetOf(row) { return row <= 0 ? 0 : language.length + 1 + body.offsetOf(row - 1) },
  }
}

/** The prepared pieces of one fields node, shared by every width: labels, padding, sanitized spans, and the raw text. */
interface PreparedFields {
  readonly labels: readonly string[]
  readonly pads: readonly string[]
  readonly values: readonly SanitizedSpan[][]
  readonly raw: string
}

const preparedFields = new WeakMap<object, PreparedFields>()

function fieldsSource(node: Extract<MayflySectionContentNode, { readonly kind: 'fields' }>, width: number, env: ContentRowsEnv): RowSource {
  if (!Array.isArray(node.rows)) throw new TypeError('fields rows must be an array')
  let prepared = preparedFields.get(node)
  if (prepared === undefined) {
    const fields = node.rows as readonly MayflyField[]
    const names = fields.map(row => {
      if (typeof row !== 'object' || row === null || !Array.isArray(row.value)) throw new TypeError('field row is invalid')
      row.value.forEach(span => {
        if (typeof span !== 'object' || span === null) throw new TypeError('field span must be an object')
        requireText(span.text, 'field span text')
      })
      return sanitizePluginText(requireText(row.label, 'field label'))
    })
    // The labels share one column: each is padded to the longest label and its colon, then one space, as the kit draws.
    const labels = names.map(name => name === '' ? '' : `${name}:`)
    const column = Math.max(0, ...names.map(name => env.components.visibleWidth(name))) + 1
    const pads = labels.map(label => ' '.repeat(Math.max(0, column - env.components.visibleWidth(label))))
    const values = fields.map(row => row.value.map(span => ({ tone: span.tone, styles: span.styles, text: sanitizePluginText(requireText(span.text, 'field span text')) })))
    const raw = values.map((value, line) => `${labels[line]!}${pads[line]!} ${value.map(span => span.text).join('')}`).join('\n')
    prepared = { labels, pads, values, raw }
    preparedFields.set(node, prepared)
  }
  const { labels, pads, values, raw } = prepared
  // The estimate indexes one synthetic document whose lines have the painted column shape.
  const index = indexFor(node, () => raw, env)
  const spansOf = (line: number): SanitizedSpan[] => [
    { tone: 'muted', text: `${labels[line]!}${pads[line]!}` },
    { raw: true, text: ' ' },
    ...values[line]!,
  ]
  return new SegmentedContent(index, () => raw, width, (segment, at) => {
    const wrap = (line: number, start: number, end: number, cut: boolean): string[] => {
      const joined = clipSpans(spansOf(line), start, end).map(span => paintSpan(span, env.colors)).join('')
      return cut ? charWrap(joined, at, env.components) : env.components.wrapText(joined, at)
    }
    if (index.isCut(segment)) {
      const [start, end] = index.segmentText(segment)
      const [line] = index.segmentLines(segment)
      return wrap(line, start - index.lineText(line)[0], end - index.lineText(line)[0], true)
    }
    const rows: string[] = []
    const [first, past] = index.segmentLines(segment)
    for (let line = first; line < past; line += 1) {
      const [lineStart, lineEnd] = index.lineText(line)
      rows.push(...wrap(line, 0, lineEnd - lineStart, false))
    }
    return rows
  }, env, keyOf(node))
}

function sectionsSource(node: Extract<MayflySectionContentNode, { readonly kind: 'sections' }>, width: number, env: ContentRowsEnv, depth: number): RowSource {
  if (!Array.isArray(node.sections)) throw new TypeError('sections must be an array')
  const sections = node.sections as readonly MayflySection[]
  const parts: string[][] = []
  for (const section of sections) {
    if (typeof section !== 'object' || section === null) throw new TypeError('section is invalid')
    const title = section.title === undefined ? undefined : sanitizePluginText(requireText(section.title, 'section title'))
    if (title !== undefined) parts.push([strong(env.colors.primary(title))])
    if (section.collapsed === true) {
      parts.push(title === undefined ? [env.colors.muted('...')] : [env.colors.muted('  …')])
      continue
    }
    const body = nodeSource(section.body, title === undefined ? width : Math.max(1, width - 2), env, depth + 1)
    // A titled body sits two columns in under its heading.
    parts.push(title === undefined ? virtualRows(body) : mapRows(virtualRows(body), row => `  ${row}`))
  }
  return sourceOf(concatRows(...parts))
}

function richTextSource(node: MayflyRichTextNode, width: number, env: ContentRowsEnv): RowSource {
  if (!Array.isArray(node.spans)) throw new TypeError('rich-text spans must be an array')
  const spans: SanitizedSpan[] = node.spans.map(span => {
    if (typeof span !== 'object' || span === null) throw new TypeError('rich-text span must be an object')
    return { tone: span.tone, styles: span.styles, text: sanitizePluginText(requireText(span.text, 'rich-text span text')) }
  })
  if (node.overflow === 'truncate') return eager([truncatedRow(spans.map(span => paintSpan(span, env.colors)).join(''), width, env.components)], env)
  const raw = spans.map(span => span.text).join('')
  const index = indexFor(node, () => raw, env)
  return new SegmentedContent(index, () => raw, width, (segment, at) => {
    const [start, end] = index.segmentText(segment)
    const joined = clipSpans(spans, start, end).map(span => paintSpan(span, env.colors)).join('')
    return index.isCut(segment) ? charWrap(joined, at, env.components) : env.components.wrapText(joined, at)
  }, env, keyOf(node))
}

function buildNodeSource(node: WindowedContentNode, width: number, env: ContentRowsEnv, depth: number): RowSource {
  if (depth > PLUGIN_VIEW_MAX_DEPTH) throw new RangeError(`view nesting exceeds ${String(PLUGIN_VIEW_MAX_DEPTH)}`)
  switch (node.kind) {
    case 'text': return textSource(node, width, env)
    case 'fields': return fieldsSource(node, width, env)
    case 'code': return codeSource(node, width, env)
    case 'sections': return sectionsSource(node, width, env, depth)
    case 'rich-text': return richTextSource(node, width, env)
    case 'diff': return eager(renderCanonicalDiff(node, width, env.components, env.colors), env)
    default: throw new TypeError(`unknown basic content kind "${String((node as { readonly kind?: unknown }).kind)}"`)
  }
}

/** The leaf kinds this module answers a shared source for. */
const CONTENT_NODE_KINDS = new Set<string>(['text', 'fields', 'code', 'sections', 'rich-text', 'diff'])

/**
 * One source per admitted node and width, shared by the leaf that paints it and the document resolver that maps its
 * anchors: a scroll's anchor and its viewport read the same row map instead of re-wrapping the document on their own.
 * Keyed by node identity — the same object arriving again is the same text — and bounded to the widths the leaf
 * memo keeps.
 */
const SHARED_SOURCE_WIDTHS = 4

const sharedSources = new WeakMap<object, Map<number, RowSource>>()

function nodeSource(node: WindowedContentNode, width: number, env: ContentRowsEnv, depth: number): RowSource {
  let widths = sharedSources.get(node)
  const shared = widths?.get(width)
  if (shared !== undefined) return shared
  const built = buildNodeSource(node, width, env, depth)
  if (widths === undefined) {
    widths = new Map()
    sharedSources.set(node, widths)
  }
  if (widths.size >= SHARED_SOURCE_WIDTHS) widths.delete(widths.keys().next().value!)
  widths.set(width, built)
  return built
}

/** A source that clips every produced row to the leaf's width: the canonical renderer's `clampRowsToWidth` backstop. */
function clampedSource(source: RowSource, width: number, env: ContentRowsEnv): RowSource {
  const seek = source.seekMarker?.bind(source)
  const prepare = source.prepare?.bind(source)
  return {
    get length() { return source.length },
    declaredWidth: Math.min(width, source.declaredWidth ?? width),
    ...(source.markerFree === true ? { markerFree: true } : {}),
    get unclamped() {
      const inner = source.unclamped
      return inner === undefined ? undefined : clampedSource(inner, width, env)
    },
    ...(seek === undefined ? {} : { seekMarker: seek }),
    ...(prepare === undefined ? {} : { prepare }),
    ...(source.rowOf === undefined ? {} : { rowOf: source.rowOf.bind(source) }),
    ...(source.offsetOf === undefined ? {} : { offsetOf: source.offsetOf.bind(source) }),
    row(index) {
      const row = source.row(index)
      // A source that declares its width inside the leaf's guarantees every row fits; the measure is the backstop
      // for painters that cannot say so (eager rows, or a declared width past the leaf's).
      if (source.declaredWidth !== undefined && source.declaredWidth <= width) return row
      countWork(env.counters, 'stringsMeasured')
      return env.components.visibleWidth(row) > width ? env.components.truncateToWidth(row, width) : row
    },
  }
}

/**
 * A source that answers at most `cap` content rows plus one elision row: the outside-window clamp, computed live so a
 * leaf whose estimate grows still reports a bounded height and every bounded consumer reads a bounded prefix. The
 * `unclamped` chain lets a scroll reach the full content.
 */
function elidedSource(inner: RowSource, cap: () => number, env: ContentRowsEnv): RowSource {
  const seek = inner.seekMarker?.bind(inner)
  const prepare = inner.prepare?.bind(inner)
  return {
    get length() {
      const total = inner.length
      const bound = Math.max(0, cap())
      return total <= bound ? total : bound + 1
    },
    ...(inner.declaredWidth === undefined ? {} : { declaredWidth: inner.declaredWidth }),
    ...(inner.markerFree === true ? { markerFree: true } : {}),
    get unclamped() { return inner.unclamped ?? inner },
    ...(seek === undefined ? {} : {
      seekMarker(marker: string, from: number): number {
        const bound = Math.max(0, cap())
        const hit = seek(marker, Math.max(0, Math.min(from, bound)))
        return hit < 0 || hit >= bound ? -1 : hit
      },
    }),
    ...(prepare === undefined ? {} : {
      prepare(from: number, to: number): void {
        prepare(from, Math.min(to, Math.max(0, cap())))
      },
    }),
    // The document map always speaks for the whole source: an anchor keeps meaning while the leaf only reports a
    // bounded prefix.
    ...(inner.rowOf === undefined ? {} : { rowOf: inner.rowOf.bind(inner) }),
    ...(inner.offsetOf === undefined ? {} : { offsetOf: inner.offsetOf.bind(inner) }),
    row(index) {
      return index < Math.max(0, cap()) ? inner.row(index) : env.elide(Math.max(0, inner.length - Math.max(0, cap())))
    },
  }
}

/**
 * The row source of one content leaf at one width: the node's own source (segmented or already painted), bounded to
 * the viewport plus its elision row while `env.bounded` holds, with every produced row clipped to the width. A scroll
 * reaches past the bound through the source's `unclamped` chain.
 */
export function contentNodeSource(node: WindowedContentNode, width: number, env: ContentRowsEnv): RowSource {
  if (typeof node !== 'object' || node === null) throw new TypeError('view must be an object')
  const inner = nodeSource(node, Math.max(1, Math.floor(width)), env, 0)
  return clampedSource(env.bounded ? elidedSource(inner, env.viewportRows, env) : inner, width, env)
}

/** The leaf's rows as a `string[]` facade over its source: pi-tui reads `length`, indexes the rows it paints. */
export function contentNodeRows(node: WindowedContentNode, width: number, env: ContentRowsEnv): string[] {
  return virtualRows(contentNodeSource(node, width, env))
}

/**
 * The shared row source of a document block at `width`, or undefined when its node is not a content leaf. This is the
 * instance the leaf render uses, so a document anchor and the painted viewport agree on the row map: `text`, `code`,
 * and `rich-text` sources translate source-text offsets through `rowOf`/`offsetOf`, while `fields`, `sections`, and
 * `diff` report their real `length` for the document's proportional map.
 */
export function documentRowsSource(node: MayflyUiNode, width: number, env: ContentRowsEnv): RowSource | undefined {
  if (typeof node !== 'object' || node === null || !CONTENT_NODE_KINDS.has(node.kind)) return undefined
  return nodeSource(node as WindowedContentNode, Math.max(1, Math.floor(width)), env, 0)
}
