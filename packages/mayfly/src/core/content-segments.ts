/**
 * The measure index of one admitted text: where its lines start and how wide each is estimated to be, grouped into
 * the segments a windowed painter materializes. A segment is a run of whole lines (at most
 * {@link CONTENT_SEGMENT_LINES} lines and {@link CONTENT_SEGMENT_UNITS} code units); a single line of
 * {@link CONTENT_CUT_UNITS} or more units is instead cut into column samples of about {@link CONTENT_CUT_COLUMNS}
 * estimated columns each, so a window can start inside a line that is a whole file by itself (D31). Cut boundaries
 * land after a code point, preferring the last plain-ASCII or space boundary within reach.
 *
 * Everything here is an estimate built in one pass over the text: `estimateRows` prices a segment at a width without
 * painting it, and the row source replaces the estimate with the painted count wherever rows materialize.
 *
 * @module @ephemeral-ai/mayfly/core/content-segments
 */

import { estimateColumns } from './width-estimate.ts'

/** A line-run segment ends when either bound is hit. */
export const CONTENT_SEGMENT_UNITS = 4_096
export const CONTENT_SEGMENT_LINES = 64

/** A line this long (in UTF-16 units) becomes a run of column-sample cuts instead of joining a line run. */
export const CONTENT_CUT_UNITS = 16_384

/** One column-sample cut covers about this many estimated columns. */
const CONTENT_CUT_COLUMNS = 4_096

/** How far back from a cut threshold to look for a plain-ASCII or space boundary. */
const CUT_SAFE_LOOKBACK = 64

interface SegmentPlan {
  kind: Uint8Array // 0 = whole lines, 1 = long-line cut
  line0: Uint32Array
  line1: Uint32Array
  text0: Uint32Array
  text1: Uint32Array
  cols: Uint32Array // estimated columns; cut segments only
}

/**
 * One indexed text: line extents and the segment plan. Painted rows are not kept here — the row source and the
 * content cache own those; an index is pure measurement, shared by every width and every repaint of its text.
 */
export class ContentIndex {
  /** Lines in the text. */
  readonly lines: number
  /** Segments the text was planned into. */
  readonly segments: number
  /** UTF-16 units in the text. */
  readonly units: number
  /** The widest estimated line or cut, so a measure can answer without painting. */
  readonly maxColumns: number
  private readonly lineStart: Uint32Array
  private readonly lineEnd: Uint32Array
  private readonly lineCols: Uint32Array
  private readonly plan: SegmentPlan

  constructor(lines: number, units: number, maxColumns: number, lineStart: Uint32Array, lineEnd: Uint32Array, lineCols: Uint32Array, plan: SegmentPlan) {
    this.lines = lines
    this.units = units
    this.maxColumns = maxColumns
    this.lineStart = lineStart
    this.lineEnd = lineEnd
    this.lineCols = lineCols
    this.plan = plan
    this.segments = plan.kind.length
  }

  /** `[firstLine, onePastLastLine)` of a whole-lines segment; both equal the one line of a cut. */
  segmentLines(segment: number): readonly [number, number] {
    return [this.plan.line0[segment]!, this.plan.line1[segment]!]
  }

  /** `[start, end)` text range of a segment: the run's lines for whole-line segments, the slice for a cut. */
  segmentText(segment: number): readonly [number, number] {
    return [this.plan.text0[segment]!, this.plan.text1[segment]!]
  }

  /** Whether the segment is a column-sample cut inside one long line. */
  isCut(segment: number): boolean {
    return this.plan.kind[segment] === 1
  }

  /** `[start, end)` text range of one line, excluding its `\n`. */
  lineText(line: number): readonly [number, number] {
    return [this.lineStart[line]!, this.lineEnd[line]!]
  }

  /** Estimated columns of one line. */
  lineColumns(line: number): number {
    return this.lineCols[line]!
  }

  /**
   * Estimated painted rows of a segment wrapped at `width`. A whole-lines segment sums `ceil(columns / width)` per
   * line (an empty line is still a row); a cut prices its sampled columns the same way. Word-wrap slack is not
   * counted, so prose may paint a few more rows than estimated — drift the row source absorbs.
   */
  estimateRows(segment: number, width: number): number {
    const safe = Math.max(1, width)
    if (this.isCut(segment)) return Math.max(1, Math.ceil(this.plan.cols[segment]! / safe))
    let rows = 0
    const [first, past] = this.segmentLines(segment)
    for (let line = first; line < past; line += 1) {
      const cols = this.lineCols[line]!
      rows += cols === 0 ? 1 : Math.ceil(cols / safe)
    }
    return Math.max(1, rows)
  }

  /** The segment whose text range covers `offset` (an offset past the last cut lands on the last segment). */
  segmentAtOffset(offset: number): number {
    let low = 0, high = this.segments - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (this.plan.text0[middle]! <= offset) low = middle
      else high = middle - 1
    }
    return low
  }

  /**
   * Rows of `segment` (its own row space) estimated to stand before `offset` at `width`: whole lines counted before
   * the line holding the offset, plus the wrapped share of that line the offset's columns cover. The inverse of
   * {@link offsetOfRow} under the same estimate model, so an anchor written from a row maps back to that row.
   */
  rowOfOffset(segment: number, offset: number, width: number, text: string): number {
    const safe = Math.max(1, width)
    const [segmentStart, segmentEnd] = this.segmentText(segment)
    const at = Math.max(segmentStart, Math.min(segmentEnd, offset))
    if (this.isCut(segment)) return Math.floor(estimateColumns(text, segmentStart, at) / safe)
    let rows = 0
    const [first, past] = this.segmentLines(segment)
    for (let line = first; line < past; line += 1) {
      const [start, end] = this.lineText(line)
      if (at <= end) return rows + Math.floor(estimateColumns(text, start, at) / safe)
      const cols = this.lineCols[line]!
      rows += cols === 0 ? 1 : Math.ceil(cols / safe)
    }
    return rows
  }

  /**
   * The text offset where segment-local row `row` begins at `width`, under the same estimate model as
   * {@link rowOfOffset}: enough columns to fill `row` rows, code-point aligned and capped at the segment's end.
   */
  offsetOfRow(segment: number, row: number, width: number, text: string): number {
    const safe = Math.max(1, width)
    const [segmentStart, segmentEnd] = this.segmentText(segment)
    /** The position inside `[start, end)` where the accumulated columns first reach `rows` full rows. */
    const seek = (start: number, end: number, rows: number): number => {
      const target = rows * safe
      if (target <= 0) return start
      let columns = 0
      let position = start
      while (position < end) {
        const code = text.charCodeAt(position)
        const step = code >= 0xd800 && code <= 0xdbff && position + 1 < end ? 2 : 1
        const next = columns + estimateColumns(text, position, position + step)
        if (next > target) return position
        columns = next
        position += step
      }
      return end
    }
    if (this.isCut(segment)) return seek(segmentStart, segmentEnd, Math.max(0, row))
    const [first, past] = this.segmentLines(segment)
    let remaining = Math.max(0, row)
    for (let line = first; line < past; line += 1) {
      const [start, end] = this.lineText(line)
      const cols = this.lineCols[line]!
      const rows = cols === 0 ? 1 : Math.ceil(cols / safe)
      if (remaining < rows) return seek(start, end, remaining)
      remaining -= rows
    }
    return segmentEnd
  }
}

/**
 * The line table of one text piece: starts, ends (excluding the `\n`), and estimated columns, all offsets relative to
 * the piece. A chunk of a {@link MayflyContentField} holds one through the admission memo, so appending to a field
 * scans only the new pieces; {@link indexMergedLines} joins the tables into the index of the whole text.
 */
export interface ContentLineScan {
  /** UTF-16 units of the scanned piece. */
  readonly units: number
  readonly starts: Uint32Array
  readonly ends: Uint32Array
  readonly columns: Uint32Array
}

const EMPTY_SCAN: ContentLineScan = { units: 0, starts: new Uint32Array(0), ends: new Uint32Array(0), columns: new Uint32Array(0) }

/** Scan one text piece into its line table; the last line is open whenever the piece does not end at a `\n`. */
export function scanContentLines(text: string): ContentLineScan {
  if (text.length === 0) return EMPTY_SCAN
  const starts: number[] = []
  const ends: number[] = []
  const columns: number[] = []
  let start = 0
  for (;;) {
    const newline = text.indexOf('\n', start)
    const end = newline < 0 ? text.length : newline
    starts.push(start)
    ends.push(end)
    columns.push(estimateColumns(text, start, end))
    if (newline < 0) break
    start = newline + 1
  }
  return { units: text.length, starts: Uint32Array.from(starts), ends: Uint32Array.from(ends), columns: Uint32Array.from(columns) }
}

/**
 * Join per-chunk line scans into the line table of the whole `text` (the chunks' texts concatenated): a chunk whose
 * text does not end at a `\n` leaves its last line open, and it merges with the next chunk's first line.
 */
export function indexMergedLines(scans: readonly ContentLineScan[], text: string, onLines?: (lines: number) => void): ContentIndex {
  const lineStart: number[] = []
  const lineEnd: number[] = []
  const lineCols: number[] = []
  let base = 0
  let openStart = -1
  let openCols = 0
  for (const scan of scans) {
    const lines = scan.starts.length
    for (let line = 0; line < lines; line += 1) {
      const terminated = line + 1 < lines
      if (line === 0 && openStart >= 0) {
        if (terminated) {
          lineStart.push(openStart); lineEnd.push(base + scan.ends[0]!); lineCols.push(openCols + scan.columns[0]!)
          openStart = -1
        } else openCols += scan.columns[0]!
        continue
      }
      if (terminated) {
        lineStart.push(base + scan.starts[line]!); lineEnd.push(base + scan.ends[line]!); lineCols.push(scan.columns[line]!)
      } else {
        openStart = base + scan.starts[line]!
        openCols = scan.columns[line]!
      }
    }
    base += scan.units
  }
  if (openStart >= 0) {
    lineStart.push(openStart); lineEnd.push(base); lineCols.push(openCols)
  }
  return planContentLines(text, lineStart, lineEnd, lineCols, onLines)
}

/**
 * Index `text` in one pass: line starts, per-line estimated columns, and the segment plan. `onLines` is called once
 * with the line count so the caller can charge its work counter.
 */
export function indexContent(text: string, onLines?: (lines: number) => void): ContentIndex {
  const scan = scanContentLines(text)
  return planContentLines(text, scan.starts, scan.ends, scan.columns, onLines)
}

/** The segment plan over an already-scanned line table; an empty table stands for one empty line. */
function planContentLines(text: string, starts: ArrayLike<number>, ends: ArrayLike<number>, cols: ArrayLike<number>, onLines?: (lines: number) => void): ContentIndex {
  const lineStart = starts.length === 0 ? [0] : starts
  const lineEnd = ends.length === 0 ? [0] : ends
  const lineCols = cols.length === 0 ? [0] : cols
  const kind: number[] = []
  const line0: number[] = []
  const line1: number[] = []
  const text0: number[] = []
  const text1: number[] = []
  const cutCols: number[] = []
  let maxColumns = 0

  const openLineRun = (line: number): void => {
    kind.push(0); line0.push(line); line1.push(line); text0.push(0); text1.push(0); cutCols.push(0)
  }
  const pushCut = (line: number, start: number, end: number, columns: number): void => {
    kind.push(1); line0.push(line); line1.push(line); text0.push(start); text1.push(end); cutCols.push(columns)
  }

  let runUnits = 0
  let runLines = 0
  for (let lineIndex = 0; lineIndex < lineStart.length; lineIndex += 1) {
    const start = lineStart[lineIndex]!
    const end = lineEnd[lineIndex]!
    const units = end - start
    if (units >= CONTENT_CUT_UNITS) {
      // A long line is its own run of column samples; cut each time the estimate crosses another threshold, preferring
      // the last plain-ASCII or space boundary so a split rarely lands inside a grapheme.
      const lineWidth = lineCols[lineIndex]!
      maxColumns = Math.max(maxColumns, lineWidth)
      let cutStart = start
      let cutColsAcc = 0
      let safeEnd = start
      let position = start
      while (position < end) {
        const code = text.charCodeAt(position)
        const step = code >= 0xd800 && code <= 0xdbff && position + 1 < end ? 2 : 1
        if (code >= 0x20 && code <= 0x7e) safeEnd = position + step
        cutColsAcc += estimateColumns(text, position, position + step)
        position += step
        if (cutColsAcc >= CONTENT_CUT_COLUMNS) {
          const boundary = safeEnd > cutStart && safeEnd >= position - CUT_SAFE_LOOKBACK ? safeEnd : position
          pushCut(lineIndex, cutStart, boundary, estimateColumns(text, cutStart, boundary))
          cutStart = boundary
          cutColsAcc = 0
        }
      }
      if (cutStart < end) pushCut(lineIndex, cutStart, end, estimateColumns(text, cutStart, end))
      runUnits = 0
      runLines = 0
    } else {
      maxColumns = Math.max(maxColumns, lineCols[lineIndex]!)
      if (runLines === 0 || runUnits + units > CONTENT_SEGMENT_UNITS || runLines >= CONTENT_SEGMENT_LINES) {
        openLineRun(lineIndex)
        runUnits = 0
        runLines = 0
      }
      runUnits += units
      runLines += 1
    }
  }
  // Whole-line segments record their line span; the text range derives from the lines at query time.
  for (let segment = 0; segment < kind.length; segment += 1) {
    if (kind[segment] === 0) {
      line1[segment] = segment + 1 < kind.length ? line0[segment + 1]! : lineStart.length
      text0[segment] = lineStart[line0[segment]!]!
      text1[segment] = lineEnd[line1[segment]! - 1]!
    }
  }
  onLines?.(lineStart.length)
  return new ContentIndex(
    lineStart.length,
    text.length,
    maxColumns,
    Uint32Array.from(lineStart),
    Uint32Array.from(lineEnd),
    Uint32Array.from(lineCols),
    { kind: Uint8Array.from(kind), line0: Uint32Array.from(line0), line1: Uint32Array.from(line1), text0: Uint32Array.from(text0), text1: Uint32Array.from(text1), cols: Uint32Array.from(cutCols) },
  )
}
