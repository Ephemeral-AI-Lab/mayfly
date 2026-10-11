/**
 * Line alignment and layout for inline diff panels. The official `FileDiff` presentation
 * carries whole-text `oldText`/`newText` pairs (per-hunk, with the context
 * lines duplicated on both sides); this module re-derives the line-level
 * `ctx`/`del`/`add` alignment a unified panel needs — a prefix/suffix trim that
 * absorbs the presenter's duplicated context, then Myers over interned line ids
 * under a `maxEditLength` bound; past it, lines unique to both sides anchor a
 * bounded split, and an anchorless rewrite degrades to whole-block removal plus
 * addition rather than an unbounded table.
 * Painting numbers both sides in a muted gutter and shades only the code of
 * removed and added lines (spec §4.1).
 *
 * @module @ephemeral-ai/mayfly/core/diff-align
 */

import { diffArrays } from 'diff'
import type { MayflyComponents, MayflySemanticColors } from './types.ts'

/** One aligned line: unchanged on both sides, removed, or added. */
export type DiffOp =
  | { readonly type: 'ctx'; readonly text: string }
  | { readonly type: 'del'; readonly text: string }
  | { readonly type: 'add'; readonly text: string }

/** The line-edit distance one middle may cost before unique-line anchors split it. */
export const DIFF_ALIGN_MAX_EDITS = 1_024

/** Anchor splits a middle may take before it degrades to whole blocks. */
const DIFF_ALIGN_MAX_DEPTH = 16

// oxlint-disable-next-line no-control-regex -- ESC (\x1b) matches the truncator's closing SGR resets
const TRAILING_RESET = /(?:\x1b\[0m)+$/u

/** Unchanged lines a diff keeps around each change unless told otherwise (spec §3.2: default 1, at most 3). */
export const DIFF_CONTEXT_ROWS = 1

/** The palette slice a diff panel paints with. */
export type DiffPaintColors = Pick<MayflySemanticColors, 'text' | 'diffAdded' | 'diffRemoved' | 'diffAddedBg' | 'diffRemovedBg' | 'diffMeta' | 'diffGutter'>

/** The width truth a diff panel clips and pads with. */
export type DiffWidthHelpers = Pick<MayflyComponents, 'truncateToWidth' | 'visibleWidth'>

/** Split whole-file text into lines; a trailing terminator adds no empty line. */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 0 && lines.at(-1) === '') lines.pop()
  return lines
}

/**
 * Align two whole texts line by line.
 * @param before - the prior text (an empty string aligns as pure additions).
 * @param after - the updated text (an empty string aligns as pure removals).
 * @returns the aligned ops in order — context lines appear once, removals
 *   before additions within a change, and inputs whose changed middle costs
 *   more than {@link DIFF_ALIGN_MAX_EDITS} split at unique-line anchors or
 *   degrade to whole-block del+add.
 */
export function alignDiffLines(before: string, after: string): readonly DiffOp[] {
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)
  if (beforeLines.length === 0) return afterLines.map(text => ({ type: 'add', text }))
  if (afterLines.length === 0) return beforeLines.map(text => ({ type: 'del', text }))

  let start = 0
  const maxStart = Math.min(beforeLines.length, afterLines.length)
  while (start < maxStart && beforeLines[start] === afterLines[start]) start += 1
  let endBefore = beforeLines.length
  let endAfter = afterLines.length
  while (endBefore > start && endAfter > start && beforeLines[endBefore - 1] === afterLines[endAfter - 1]) {
    endBefore -= 1
    endAfter -= 1
  }

  const ops: DiffOp[] = []
  for (let index = 0; index < start; index += 1) ops.push({ type: 'ctx', text: beforeLines[index]! })
  if (endBefore > start || endAfter > start) {
    // Interned line ids make Myers' inner compare O(1); `texts` maps an id back to its line.
    const texts: string[] = []
    const ids = new Map<string, number>()
    const intern = (lines: readonly string[], lo: number, hi: number): number[] => {
      const out = new Array<number>(hi - lo)
      for (let index = lo; index < hi; index += 1) {
        const line = lines[index]!
        let id = ids.get(line)
        if (id === undefined) {
          id = texts.length
          texts.push(line)
          ids.set(line, id)
        }
        out[index - lo] = id
      }
      return out
    }
    // A loop, not a spread: a megabyte write is hundreds of thousands of ops, past any argument list.
    for (const op of alignMiddle(intern(beforeLines, start, endBefore), intern(afterLines, start, endAfter), texts, 0)) ops.push(op)
  }
  for (let index = endBefore; index < beforeLines.length; index += 1) ops.push({ type: 'ctx', text: beforeLines[index]! })
  return ops
}

/** Whole-block removal plus addition: the degrade for middles no anchor can split cheaply. */
function blockOps(before: readonly number[], after: readonly number[], texts: readonly string[]): DiffOp[] {
  return [...before.map(id => ({ type: 'del' as const, text: texts[id]! })), ...after.map(id => ({ type: 'add' as const, text: texts[id]! }))]
}

/**
 * The line appearing exactly once on each side at the least skewed relative position, or undefined. A rewrite with
 * no unique lines cannot anchor and degrades instead.
 */
function uniqueAnchor(before: readonly number[], after: readonly number[]): { readonly before: number, readonly after: number } | undefined {
  const beforeCount = new Map<number, number>()
  const afterCount = new Map<number, number>()
  for (const id of before) beforeCount.set(id, (beforeCount.get(id) ?? 0) + 1)
  for (const id of after) afterCount.set(id, (afterCount.get(id) ?? 0) + 1)
  const afterPosition = new Map<number, number>()
  for (const [index, id] of after.entries()) {
    if (afterCount.get(id) === 1 && beforeCount.get(id) === 1) afterPosition.set(id, index)
  }
  let anchor: { readonly before: number, readonly after: number } | undefined
  let skew = Number.POSITIVE_INFINITY
  for (const [index, id] of before.entries()) {
    if (beforeCount.get(id) !== 1) continue
    const match = afterPosition.get(id)
    if (match === undefined) continue
    const value = Math.abs(index * after.length - match * before.length)
    if (value < skew) {
      skew = value
      anchor = { before: index, after: match }
    }
  }
  return anchor
}

/**
 * Myers over interned ids under the edit bound. Past it the least-skewed unique line anchors two cheaper middles; an
 * anchorless or too-deep middle degrades to whole blocks.
 */
function alignMiddle(before: readonly number[], after: readonly number[], texts: readonly string[], depth: number): DiffOp[] {
  // A one-sided middle (a new file, a deleted block) is its own alignment; Myers would only spend its edit budget.
  if (before.length === 0 || after.length === 0) return blockOps(before, after, texts)
  const parts = diffArrays(before as number[], after as number[], { maxEditLength: DIFF_ALIGN_MAX_EDITS })
  if (parts !== undefined) {
    const ops: DiffOp[] = []
    for (const part of parts) {
      const type = part.added === true ? 'add' as const : part.removed === true ? 'del' as const : 'ctx' as const
      for (const id of part.value) ops.push({ type, text: texts[id as number]! })
    }
    return ops
  }
  if (depth >= DIFF_ALIGN_MAX_DEPTH) return blockOps(before, after, texts)
  const anchor = uniqueAnchor(before, after)
  if (anchor === undefined) return blockOps(before, after, texts)
  return [
    ...alignMiddle(before.slice(0, anchor.before), after.slice(0, anchor.after), texts, depth + 1),
    { type: 'ctx', text: texts[before[anchor.before]!]! },
    ...alignMiddle(before.slice(anchor.before + 1), after.slice(anchor.after + 1), texts, depth + 1),
  ]
}

/**
 * Count the added and removed lines of one alignment.
 * @param before - the prior text.
 * @param after - the updated text.
 * @returns exact counts for aligned inputs; block counts for degraded ones.
 */
export function diffChangeCounts(before: string, after: string): { readonly added: number; readonly removed: number } {
  let added = 0
  let removed = 0
  for (const op of alignDiffLines(before, after)) {
    if (op.type === 'add') added += 1
    else if (op.type === 'del') removed += 1
  }
  return { added, removed }
}

/** How a diff paints beyond its alignment; every field is optional. */
export interface DiffPaintOptions {
  /** The first line number of both sides (default 1). */
  readonly start?: number
  /** Old and new line-number gutters (default true). */
  readonly numbered?: boolean
  /** An `@@` header over the rows (default: only when the diff has more than one hunk). */
  readonly hunkHeader?: boolean
  /** Unchanged lines kept around each change (default {@link DIFF_CONTEXT_ROWS}). */
  readonly context?: number
  /** Rows painted before `… +N rows · Ctrl+O` (default: all). */
  readonly maxRows?: number
}

/** One kept line with its two side numbers and sign; only kept lines exist in the model. */
export interface DiffRowModel {
  readonly old?: number
  readonly new?: number
  readonly sign: '' | '-' | '+'
  readonly text: string
}

/** A run of the diff's visible layout: the `@@` header, a kept hunk's rows, one `⋯` gap row, or the `maxRows` tail. */
export type DiffSegment =
  | { readonly kind: 'header', readonly text: string }
  | { readonly kind: 'gap' }
  | { readonly kind: 'rows', readonly rows: readonly DiffRowModel[] }
  | { readonly kind: 'tail', readonly remaining: number }

/**
 * A diff's painted layout before width enters: exact segments and the row total, so a windowed source reports the
 * real length without painting and a collapsed run stays one `⋯` row.
 */
export interface DiffModel {
  readonly digits: number
  readonly segments: readonly DiffSegment[]
  readonly length: number
}

/**
 * Lay `ops` out under `options`: kept runs merge into hunks, collapsed runs become one `⋯` segment each, `maxRows`
 * truncates at an exact remaining count, and `digits` answers the gutter width from the largest line number — no
 * scan over the rows.
 */
export function diffModel(ops: readonly DiffOp[], options: DiffPaintOptions = {}): DiffModel {
  const start = options.start ?? 1
  const context = Math.max(0, Math.floor(options.context ?? DIFF_CONTEXT_ROWS))
  const ranges: [number, number][] = []
  let beforeTotal = 0
  let afterTotal = 0
  for (const [index, op] of ops.entries()) {
    if (op.type === 'ctx') {
      beforeTotal += 1
      afterTotal += 1
    } else {
      if (op.type === 'del') beforeTotal += 1
      else afterTotal += 1
      const lo = Math.max(0, index - context)
      const hi = Math.min(ops.length - 1, index + context)
      const last = ranges.at(-1)
      if (last !== undefined && lo <= last[1] + 1) last[1] = Math.max(last[1], hi)
      else ranges.push([lo, hi])
    }
  }
  const segments: DiffSegment[] = []
  if (options.hunkHeader ?? ranges.length > 1) segments.push({ kind: 'header', text: `@@ -${String(start)},${String(beforeTotal)} +${String(start)},${String(afterTotal)} @@` })
  const keptTotal = ranges.reduce((total, [lo, hi]) => total + hi - lo + 1, 0)
  const maxRows = options.maxRows
  let shown = 0
  let old = start
  let next = start
  let opIndex = 0
  let ended = false
  for (const [lo, hi] of ranges) {
    if (ended) break
    // Skipped context before, between, and around the kept ranges is one `⋯` row per run.
    if (opIndex < lo) segments.push({ kind: 'gap' })
    for (; opIndex < lo; opIndex += 1) {
      const op = ops[opIndex]!
      if (op.type === 'ctx') { old += 1; next += 1 }
      else if (op.type === 'del') old += 1
      else next += 1
    }
    const rows: DiffRowModel[] = []
    let tail: number | undefined
    for (; opIndex <= hi; opIndex += 1) {
      if (maxRows !== undefined && shown >= maxRows) {
        tail = keptTotal - shown
        ended = true
        break
      }
      const op = ops[opIndex]!
      if (op.type === 'ctx') rows.push({ old: old++, new: next++, sign: '', text: op.text })
      else if (op.type === 'del') rows.push({ old: old++, sign: '-', text: op.text })
      else rows.push({ new: next++, sign: '+', text: op.text })
      shown += 1
    }
    if (rows.length > 0) segments.push({ kind: 'rows', rows })
    if (tail !== undefined) segments.push({ kind: 'tail', remaining: tail })
  }
  if (!ended && opIndex < ops.length) segments.push({ kind: 'gap' })
  const digits = Math.max(3, String(Math.max(start - 1 + beforeTotal, start - 1 + afterTotal)).length)
  const length = segments.reduce((total, segment) => total + (segment.kind === 'rows' ? segment.rows.length : 1), 0)
  return { digits, segments, length }
}

/** Paint one kept line: gutter numbers, the −/+ sign, and the change band behind the code only. */
function paintDiffRow(
  row: DiffRowModel,
  digits: number,
  columns: number,
  helpers: DiffWidthHelpers,
  colors: DiffPaintColors | undefined,
  numbered: boolean,
  clip: (text: string, room: number) => string,
  paint: (tone: ((text: string) => string) | undefined, text: string) => string,
): string {
  const number = (value: number | undefined): string => value === undefined ? ' '.repeat(digits) : String(value).padStart(digits)
  const gutter = numbered ? `${paint(colors?.diffGutter, `${number(row.old)} ${number(row.new)} │`)} ` : ''
  const head = `  ${gutter}`
  const room = Math.max(0, columns - helpers.visibleWidth(head))
  const text = row.text.replace(/\t/gu, '   ')
  if (row.sign === '') return clip(`${head}  ${paint(colors?.text, text)}`, columns)
  const tone = row.sign === '-' ? colors?.diffRemoved : colors?.diffAdded
  const code = clip(`${paint(tone, row.sign === '-' ? '−' : '+')} ${paint(tone, text)}`, room)
  const band = row.sign === '-' ? colors?.diffRemovedBg : colors?.diffAddedBg
  const fill = band === undefined ? '' : ' '.repeat(Math.max(0, room - helpers.visibleWidth(code)))
  return room === 0 ? clip(head, columns) : `${head}${paint(band, `${code}${fill}`)}`
}

/**
 * Paint one model segment at `columns`: a `rows` segment maps each kept line, and every other segment answers its
 * one muted row.
 */
export function paintDiffSegment(
  segment: DiffSegment,
  digits: number,
  columns: number,
  helpers: DiffWidthHelpers,
  colors: DiffPaintColors | undefined,
  numbered: boolean,
): string[] {
  const paint = (tone: ((text: string) => string) | undefined, text: string): string => tone === undefined ? text : tone(text)
  // A clipped painted line keeps its band open: the truncator's closing reset becomes a foreground reset after the `…`.
  const clip = (text: string, room: number): string => {
    if (room <= 0) return ''
    if (helpers.visibleWidth(text) <= room) return text
    const cut = helpers.truncateToWidth(text, room - 1, '').replace(TRAILING_RESET, '')
    return text.includes('\x1b') ? `${cut}…\x1b[39m` : `${cut}…`
  }
  switch (segment.kind) {
    case 'header': return [clip(paint(colors?.diffMeta, segment.text), columns)]
    case 'gap': return [clip(`  ${paint(colors?.diffMeta, '⋯')}`, columns)]
    case 'tail': return [clip(`  ${paint(colors?.diffMeta, `… +${String(segment.remaining)} rows · Ctrl+O`)}`, columns)]
    case 'rows': return segment.rows.map(row => paintDiffRow(row, digits, columns, helpers, colors, numbered, clip, paint))
  }
}

/**
 * Paint aligned ops as terminal rows no wider than `width` (spec §4.1): an old and a new line-number gutter (muted,
 * ending in `│`), then `−` or `+` and the code. A removed or added line keeps its band behind the code only, never the
 * gutter, in the removed or added tone; an unchanged line is plain. Only {@link DiffPaintOptions.context} unchanged
 * lines stay around each change, a run of skipped lines is one muted `⋯`, a long line ends in `…`, and tabs expand to
 * three columns so a band has no tab-stop gaps.
 * @param ops - the alignment to paint.
 * @param width - the assigned column width.
 * @param helpers - the width truth used to clip and pad.
 * @param colors - the diff palette; omitted yields uncolored rows.
 * @param options - numbering, context, header, and row budget.
 * @returns the visual rows.
 */
export function paintDiffRows(ops: readonly DiffOp[], width: number, helpers: DiffWidthHelpers, colors?: DiffPaintColors, options: DiffPaintOptions = {}): string[] {
  const columns = Math.max(1, width)
  const model = diffModel(ops, options)
  const out: string[] = []
  for (const segment of model.segments) for (const row of paintDiffSegment(segment, model.digits, columns, helpers, colors, options.numbered !== false)) out.push(row)
  return out
}
