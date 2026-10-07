/**
 * Line alignment for inline diff panels. The official `FileDiff` presentation
 * carries whole-text `oldText`/`newText` pairs (per-hunk, with the context
 * lines duplicated on both sides); this module re-derives the line-level
 * `ctx`/`del`/`add` alignment a unified panel needs — dependency-free, with a
 * prefix/suffix trim that absorbs the presenter's duplicated context, an LCS
 * core for the small middle, and a size guard that degrades oversized inputs
 * to whole-block removal plus addition instead of an unbounded DP table.
 * Painting numbers both sides in a muted gutter and shades only the code of
 * removed and added lines (spec §4.1).
 *
 * @module @ephemeral-ai/mayfly/core/diff-align
 */

import type { MayflyComponents, MayflySemanticColors } from './types.ts'

/** One aligned line: unchanged on both sides, removed, or added. */
export type DiffOp =
  | { readonly type: 'ctx'; readonly text: string }
  | { readonly type: 'del'; readonly text: string }
  | { readonly type: 'add'; readonly text: string }

/** Either middle side above this many lines skips the LCS and renders as whole blocks. */
export const DIFF_ALIGN_MAX_ROWS = 1200

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
 *   before additions within a change, and inputs whose changed middle
 *   exceeds {@link DIFF_ALIGN_MAX_ROWS} degrade to whole-block del+add.
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
  const midBefore = beforeLines.slice(start, endBefore)
  const midAfter = afterLines.slice(start, endAfter)
  if (midBefore.length > DIFF_ALIGN_MAX_ROWS || midAfter.length > DIFF_ALIGN_MAX_ROWS) {
    for (const text of midBefore) ops.push({ type: 'del', text })
    for (const text of midAfter) ops.push({ type: 'add', text })
  } else {
    ops.push(...lcsOps(midBefore, midAfter))
  }
  for (let index = endBefore; index < beforeLines.length; index += 1) ops.push({ type: 'ctx', text: beforeLines[index]! })
  return ops
}

/** Classic LCS table walk over the trimmed middle; removals lead additions. */
function lcsOps(before: readonly string[], after: readonly string[]): DiffOp[] {
  const width = after.length + 1
  const table = new Uint32Array((before.length + 1) * width)
  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = before[i] === after[j]
        ? table[(i + 1) * width + (j + 1)]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + (j + 1)]!)
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ type: 'ctx', text: before[i]! })
      i += 1
      j += 1
    } else if (table[(i + 1) * width + j]! >= table[i * width + (j + 1)]!) {
      ops.push({ type: 'del', text: before[i]! })
      i += 1
    } else {
      ops.push({ type: 'add', text: after[j]! })
      j += 1
    }
  }
  for (; i < before.length; i += 1) ops.push({ type: 'del', text: before[i]! })
  for (; j < after.length; j += 1) ops.push({ type: 'add', text: after[j]! })
  return ops
}

/**
 * Count the added and removed lines of one alignment.
 * @param before - the prior text.
 * @param after - the updated text.
 * @returns exact counts for aligned inputs; block counts for guarded ones.
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

interface NumberedRow {
  readonly old?: number
  readonly new?: number
  readonly sign: '' | '-' | '+'
  readonly text: string
}

function numberedRows(ops: readonly DiffOp[], start: number): NumberedRow[] {
  let old = start
  let next = start
  return ops.map(op => op.type === 'ctx' ? { old: old++, new: next++, sign: '' as const, text: op.text }
    : op.type === 'del' ? { old: old++, sign: '-' as const, text: op.text } : { new: next++, sign: '+' as const, text: op.text })
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
  const paint = (tone: ((text: string) => string) | undefined, text: string): string => tone === undefined ? text : tone(text)
  const start = options.start ?? 1
  const rows = numberedRows(ops, start)
  const context = Math.max(0, options.context ?? DIFF_CONTEXT_ROWS)
  const keep = new Set<number>()
  rows.forEach((row, index) => { if (row.sign !== '') for (let offset = -context; offset <= context; offset += 1) keep.add(index + offset) })
  const hunks = rows.filter((_, index) => keep.has(index) && !keep.has(index - 1)).length
  const digits = Math.max(3, ...rows.map(row => String(Math.max(row.old ?? 0, row.new ?? 0)).length))
  // A clipped painted line keeps its band open: the truncator's closing reset becomes a foreground reset after the `…`.
  const clip = (text: string, room: number): string => {
    if (room <= 0) return ''
    if (helpers.visibleWidth(text) <= room) return text
    const cut = helpers.truncateToWidth(text, room - 1, '').replace(TRAILING_RESET, '')
    return text.includes('\x1b') ? `${cut}…\x1b[39m` : `${cut}…`
  }
  const out: string[] = []
  if (options.hunkHeader ?? hunks > 1) {
    const oldCount = rows.filter(row => row.old !== undefined).length
    const newCount = rows.filter(row => row.new !== undefined).length
    out.push(clip(paint(colors?.diffMeta, `@@ -${String(start)},${String(oldCount)} +${String(start)},${String(newCount)} @@`), columns))
  }
  let skipped = false
  let shown = 0
  for (const [index, row] of rows.entries()) {
    if (!keep.has(index)) {
      if (!skipped) out.push(clip(`  ${paint(colors?.diffMeta, '⋯')}`, columns))
      skipped = true
      continue
    }
    skipped = false
    if (options.maxRows !== undefined && shown >= options.maxRows) {
      const remaining = rows.filter((_, later) => later >= index && keep.has(later)).length
      out.push(clip(`  ${paint(colors?.diffMeta, `… +${String(remaining)} rows · Ctrl+O`)}`, columns))
      break
    }
    shown += 1
    const number = (value: number | undefined): string => value === undefined ? ' '.repeat(digits) : String(value).padStart(digits)
    const gutter = options.numbered === false ? '' : `${paint(colors?.diffGutter, `${number(row.old)} ${number(row.new)} │`)} `
    const head = `  ${gutter}`
    const room = Math.max(0, columns - helpers.visibleWidth(head))
    const text = row.text.replace(/\t/gu, '   ')
    if (row.sign === '') {
      out.push(clip(`${head}  ${paint(colors?.text, text)}`, columns))
      continue
    }
    const tone = row.sign === '-' ? colors?.diffRemoved : colors?.diffAdded
    const code = clip(`${paint(tone, row.sign === '-' ? '−' : '+')} ${paint(tone, text)}`, room)
    const band = row.sign === '-' ? colors?.diffRemovedBg : colors?.diffAddedBg
    const fill = band === undefined ? '' : ' '.repeat(Math.max(0, room - helpers.visibleWidth(code)))
    out.push(room === 0 ? clip(head, columns) : `${head}${paint(band, `${code}${fill}`)}`)
  }
  return out
}
