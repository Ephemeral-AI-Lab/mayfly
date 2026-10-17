/**
 * Alternate-screen output optimizer: a `Terminal` facade that filters the
 * frames pi-tui's alternate-screen renderer writes through a shadow grid.
 *
 * The parser accepts only the grammar that renderer emits: optional BSU/ESU,
 * an optional full clear, row writes, absolute cursor positions, cursor
 * visibility, and — inside a row line — SGR and the OSC 8 hyperlink close that
 * every pi-tui line reset carries. Any other sequence (another OSC, DCS, APC,
 * kitty image/placement bytes, another private mode, an unknown CSI) passes
 * the whole write through byte-for-byte and invalidates the shadow, so the
 * next frame is treated as a full repaint. Frames are optimized only while
 * the shadow is trusted; a pass-through frame that clears the screen or writes
 * every row rebuilds it, any other frame keeps passing through.
 *
 * A recognized frame updates the shadow and produces the next screen. An
 * unchanged frame emits no rows (the frame is dropped when it carries no
 * cursor state). A frame whose only changes are a dominant vertical shift
 * inside an unchanged prefix/suffix band becomes one scrolling-region update
 * plus the rows the scroll does not explain. Everything else emits exactly
 * the changed rows. Cursor and visibility sequences are always preserved.
 *
 * The facade is core-private; production only uses it through
 * `startMayflyTerminal`, and the diagnostics face exists for tests.
 *
 * @module @ephemeral-ai/mayfly/core/output-optimizer
 */

import { visibleWidth } from './width.ts'

/**
 * The structural terminal face the optimizer wraps. It is pi-tui's `Terminal`
 * shape without the type import: delegation is one property at a time, so a
 * `Terminal`, a recovery facade, or a test fake all satisfy it.
 */
export interface OptimizerTerminal {
  start(onInput: (data: string) => void, onResize: () => void): void
  stop(): void
  drainInput(maxMs?: number, idleMs?: number): Promise<void>
  write(data: string): void
  readonly columns: number
  readonly rows: number
  readonly kittyProtocolActive: boolean
  moveBy(lines: number): void
  hideCursor(): void
  showCursor(): void
  clearLine(): void
  clearFromCursor(): void
  clearScreen(): void
  setTitle(title: string): void
  setProgress(active: boolean): void
}

/** Tuning for the shift heuristic. */
export interface OutputOptimizerOptions {
  /** Fraction of the change band a shift must explain; defaults to 0.6. */
  readonly shiftRatio?: number
  /** Rows a shift must explain before it is used; defaults to 3. */
  readonly minShiftRows?: number
}

/** Test-only activity of one optimizer; production does not read it. */
export interface OutputOptimizerDiagnostics {
  /** Frames whose next screen equaled the shadow; no row was written. */
  readonly noopFrames: number
  /** Frames emitted with a scrolling-region shift. */
  readonly shiftedFrames: number
  /** Frames emitted as changed rows without a shift. */
  readonly changedFrames: number
  /** Recognized full repaints (`2J` or every row) passed through while rebuilding the shadow. */
  readonly fullRepaintFrames: number
  /** Unrecognized writes passed through; the shadow was invalidated. */
  readonly passthroughFrames: number
  /** Row writes the optimizer itself emitted. */
  readonly rowsWritten: number
  /** UTF-8 bytes of every write the facade has handed to the terminal. */
  readonly bytesWritten: number
  /** The trusted screen rows, or `[]` while the shadow is invalid. */
  readonly shadow: readonly string[]
}

/** A terminal facade that filters pi-tui alternate-screen frames. */
export interface OutputOptimizer extends OptimizerTerminal {
  readonly diagnostics: OutputOptimizerDiagnostics
}

const BEGIN_SYNCHRONIZED_OUTPUT = '\x1b[?2026h'
const END_SYNCHRONIZED_OUTPUT = '\x1b[?2026l'
const FULL_CLEAR = '\x1b[2J'
const ERASE_LINE = '\x1b[2K'
const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const DEFAULT_SHIFT_RATIO = 0.6
const DEFAULT_MIN_SHIFT_ROWS = 3

/** One row line the frame writes, row 1-based. */
interface FrameRowWrite {
  readonly row: number
  readonly line: string
}

/** The recognized pieces of one alternate-screen frame. */
interface ParsedFrame {
  readonly prefix: string
  readonly suffix: string
  readonly fullClear: boolean
  readonly rows: readonly FrameRowWrite[]
  /** Cursor moves and visibility changes, in frame order. */
  readonly tail: string
  /** Whether the tail contains an absolute cursor position. */
  readonly positionsCursor: boolean
}

/** A dominant vertical shift inside a content band, with the rows it cannot explain. */
interface ShiftPlan {
  readonly direction: 'up' | 'down'
  readonly distance: number
  /** Band rows, 0-based inclusive. */
  readonly top: number
  readonly bottom: number
  /** Rows, 0-based, the scroll leaves wrong and the frame must rewrite. */
  readonly writes: readonly number[]
}

/**
 * Create the output-optimizing facade.
 * @param terminal - the terminal (or recovery facade) to filter writes for.
 * @param options - shift-heuristic tuning.
 * @returns the facade; every method and property delegates to `terminal`.
 */
export function createOutputOptimizer(
  terminal: OptimizerTerminal,
  options: OutputOptimizerOptions = {},
): OutputOptimizer {
  const shiftRatio = options.shiftRatio ?? DEFAULT_SHIFT_RATIO
  const minShiftRows = options.minShiftRows ?? DEFAULT_MIN_SHIFT_ROWS
  let shadow: string[] = []
  let valid = false
  let noopFrames = 0
  let shiftedFrames = 0
  let changedFrames = 0
  let fullRepaintFrames = 0
  let passthroughFrames = 0
  let rowsWritten = 0
  let bytesWritten = 0

  const invalidate = (): void => {
    shadow = []
    valid = false
  }

  const send = (data: string): void => {
    if (data.length === 0) return
    bytesWritten += Buffer.byteLength(data)
    terminal.write(data)
  }

  /** A row write in the exact grammar pi-tui's renderer uses. */
  const rowWrite = (row: number, line: string): string => `\x1b[${String(row)};1H${ERASE_LINE}${line}`

  /** Write one row through the facade, counting it for diagnostics. */
  const writeRow = (row: number, line: string): string => {
    rowsWritten += 1
    return rowWrite(row, line)
  }

  /** Rebuild the shadow from a cleared screen plus the frame's row writes. */
  const rebuild = (rows: number, writes: readonly FrameRowWrite[]): void => {
    const next = Array.from({ length: rows }, () => '')
    for (const write of writes) next[write.row - 1] = write.line
    shadow = next
    valid = true
  }

  /** The cursor a terminal lands on after writing one line from column 1. */
  const lineEnd = (write: FrameRowWrite): { readonly row: number, readonly col: number } => {
    return { row: write.row - 1, col: Math.min(visibleWidth(write.line), Math.max(0, terminal.columns)) }
  }

  const cursorSequence = (position: { readonly row: number, readonly col: number }): string => {
    return `\x1b[${String(position.row + 1)};${String(position.col + 1)}H`
  }

  /** Find a shift that explains enough of the band between the equal prefix and suffix; output does not include the scroll sequences. */
  function planShift(previous: readonly string[], next: readonly string[]): ShiftPlan | undefined {
    const height = next.length
    let prefix = 0
    while (prefix < height && next[prefix] === previous[prefix]) prefix += 1
    if (prefix === height) return undefined
    let suffix = 0
    while (suffix < height - prefix && next[height - 1 - suffix] === previous[height - 1 - suffix]) suffix += 1
    const top = prefix
    const bottom = height - suffix - 1
    const bandHeight = bottom - top + 1
    if (bandHeight < 2) return undefined
    const needed = Math.max(minShiftRows, Math.ceil(bandHeight * shiftRatio))
    if (needed > bandHeight) return undefined
    let best: { direction: 'up' | 'down', distance: number, explained: number } | undefined
    for (const direction of ['up', 'down'] as const) {
      for (let distance = 1; distance < bandHeight; distance += 1) {
        let explained = 0
        for (let row = top; row <= bottom; row += 1) {
          const source = direction === 'up' ? row + distance : row - distance
          const inside = source >= top && source <= bottom
          if (inside ? next[row] === previous[source] : next[row] === '') explained += 1
        }
        if (best === undefined || explained > best.explained) best = { direction, distance, explained }
      }
    }
    if (best === undefined || best.explained < needed) return undefined
    const writes: number[] = []
    for (let row = top; row <= bottom; row += 1) {
      const source = best.direction === 'up' ? row + best.distance : row - best.distance
      const inside = source >= top && source <= bottom
      if (inside ? next[row] === previous[source] : next[row] === '') continue
      writes.push(row)
    }
    return { direction: best.direction, distance: best.distance, top, bottom, writes }
  }

  /** Emit the recognized frame's optimized form (or nothing for a no-op without tail state). */
  function optimize(parsed: ParsedFrame): void {
    const previous = shadow
    const next = [...previous]
    for (const write of parsed.rows) next[write.row - 1] = write.line
    const lastFrameRow = parsed.rows.at(-1)
    const naiveCursor = lastFrameRow === undefined ? undefined : lineEnd(lastFrameRow)

    const identical = next.every((line, row) => line === previous[row])
    let shift: ShiftPlan | undefined
    if (identical) {
      noopFrames += 1
    } else {
      shift = planShift(previous, next)
      if (shift === undefined) changedFrames += 1
    }

    /** The rows the output's last row write leaves the terminal on, when it wrote any. */
    let emittedCursor: { readonly row: number, readonly col: number } | undefined
    let body = ''
    if (shift !== undefined) {
      shiftedFrames += 1
      body += `\x1b[${String(shift.top + 1)};${String(shift.bottom + 1)}r`
      body += shift.direction === 'up'
        ? `\x1b[${String(shift.distance)}S`
        : `\x1b[${String(shift.distance)}T`
      body += '\x1b[r'
      for (const row of shift.writes) {
        body += writeRow(row + 1, next[row]!)
        emittedCursor = lineEnd({ row: row + 1, line: next[row]! })
      }
      // DECSTBM and its reset home the cursor; with no row writes the
      // terminal stands at the home cell until the tail moves it.
      if (shift.writes.length === 0) emittedCursor = { row: 0, col: 0 }
    } else if (!identical) {
      for (let row = 0; row < next.length; row += 1) {
        if (next[row] === previous[row]) continue
        body += writeRow(row + 1, next[row]!)
        emittedCursor = lineEnd({ row: row + 1, line: next[row]! })
      }
    }

    let tail = parsed.tail
    if (!parsed.positionsCursor && naiveCursor !== undefined) {
      const cursorMatches = emittedCursor !== undefined
        && emittedCursor.row === naiveCursor.row
        && emittedCursor.col === naiveCursor.col
      if (!cursorMatches) {
        if (naiveCursor.col < terminal.columns) {
          tail = cursorSequence(naiveCursor) + tail
        } else if (!identical && lastFrameRow !== undefined) {
          // A pending-wrap cursor (one column past the last cell) cannot be
          // addressed absolutely. Replaying the frame's last row write lands
          // it on exactly the cell the renderer's own write leaves.
          body += writeRow(lastFrameRow.row, lastFrameRow.line)
          emittedCursor = lineEnd(lastFrameRow)
        }
      }
    }

    const output = body.length === 0 && tail.length === 0
      ? ''
      : parsed.prefix + body + tail + parsed.suffix
    if (output.length === 0) return
    send(output)
    shadow = next
    valid = true
  }

  const facade: OutputOptimizer = {
    start(onInput, onResize) {
      invalidate()
      terminal.start(onInput, onResize)
    },
    stop() {
      try {
        terminal.stop()
      } finally {
        invalidate()
      }
    },
    drainInput(maxMs, idleMs) {
      return terminal.drainInput(maxMs, idleMs)
    },
    write(data) {
      const rows = terminal.rows
      if (!Number.isInteger(rows) || rows <= 0) {
        passthroughFrames += 1
        invalidate()
        send(data)
        return
      }
      if (valid && shadow.length !== rows) invalidate()
      const parsed = parseFrame(data, rows)
      if (parsed === undefined) {
        passthroughFrames += 1
        invalidate()
        send(data)
        return
      }
      if (parsed.fullClear) {
        fullRepaintFrames += 1
        rebuild(rows, parsed.rows)
        send(data)
        return
      }
      if (!valid) {
        // Without a trusted screen a partial frame cannot be reconstructed;
        // a frame that rewrites every row (or clears) can start a new one.
        if (!writesEveryRow(parsed, rows)) {
          passthroughFrames += 1
          invalidate()
          send(data)
          return
        }
        fullRepaintFrames += 1
        rebuild(rows, parsed.rows)
        send(data)
        return
      }
      optimize(parsed)
    },
    get columns() {
      return terminal.columns
    },
    get rows() {
      return terminal.rows
    },
    get kittyProtocolActive() {
      return terminal.kittyProtocolActive
    },
    moveBy(lines) {
      terminal.moveBy(lines)
    },
    hideCursor() {
      terminal.hideCursor()
    },
    showCursor() {
      terminal.showCursor()
    },
    clearLine() {
      terminal.clearLine()
    },
    clearFromCursor() {
      terminal.clearFromCursor()
    },
    clearScreen() {
      terminal.clearScreen()
    },
    setTitle(title) {
      terminal.setTitle(title)
    },
    setProgress(active) {
      terminal.setProgress(active)
    },
    get diagnostics() {
      return {
        noopFrames,
        shiftedFrames,
        changedFrames,
        fullRepaintFrames,
        passthroughFrames,
        rowsWritten,
        bytesWritten,
        shadow: valid ? [...shadow] : [],
      }
    },
  }
  return facade
}

/** Whether a frame writes every row of the screen, so a lost shadow can restart from blanks. */
function writesEveryRow(frame: ParsedFrame, rows: number): boolean {
  if (frame.rows.length === 0) return false
  const written = new Set(frame.rows.map(write => write.row))
  for (let row = 1; row <= rows; row += 1) if (!written.has(row)) return false
  return true
}

/**
 * Parse one renderer write. `undefined` means the write is not the pinned
 * grammar and must pass through untouched.
 * @param data - one terminal write.
 * @param rows - the terminal height the frame targets.
 */
function parseFrame(data: string, rows: number): ParsedFrame | undefined {
  let start = 0
  let prefix = ''
  if (data.startsWith(BEGIN_SYNCHRONIZED_OUTPUT)) {
    prefix = BEGIN_SYNCHRONIZED_OUTPUT
    start = prefix.length
  }
  let end = data.length
  let suffix = ''
  if (data.endsWith(END_SYNCHRONIZED_OUTPUT) && data.length - END_SYNCHRONIZED_OUTPUT.length >= start) {
    suffix = END_SYNCHRONIZED_OUTPUT
    end -= suffix.length
  }
  if ((prefix.length === 0) !== (suffix.length === 0)) return undefined
  const frameRows: FrameRowWrite[] = []
  let tail = ''
  let positionsCursor = false
  let fullClear = false
  let line: string | undefined
  let lineRow = 0
  let sawTail = false
  const finishLine = (): void => {
    if (line === undefined) return
    frameRows.push({ row: lineRow, line })
    line = undefined
  }

  let index = start
  while (index < end) {
    const character = data[index]!
    if (character !== '\x1b') {
      if (line === undefined) return undefined
      line += character
      index += 1
      continue
    }
    const rest = data.slice(index, end)
    if (rest.startsWith('\x1b[')) {
      const csi = csiAt(rest)
      if (csi === undefined) return undefined
      const { sequence, final } = csi
      if (line !== undefined && final === 'm' && isSgr(sequence)) {
        line += sequence
        index += sequence.length
        continue
      }
      if (sequence === FULL_CLEAR) {
        // A clear inside a line, after rows, or after the cursor tail is a
        // shape pi-tui never writes; leave it to the untouched path.
        if (line !== undefined || sawTail || frameRows.length > 0) return undefined
        fullClear = true
        index += sequence.length
        continue
      }
      const row = /^\x1b\[(\d+);1H$/.exec(sequence)
      if (row !== null && rest.startsWith(sequence + ERASE_LINE)) {
        finishLine()
        if (sawTail) return undefined
        const rowNumber = Number.parseInt(row[1]!, 10)
        if (rowNumber < 1 || rowNumber > rows) return undefined
        index += sequence.length + ERASE_LINE.length
        line = ''
        lineRow = rowNumber
        continue
      }
      const cursor = /^\x1b\[(\d+);(\d+)H$/.exec(sequence)
      if (cursor !== null) {
        finishLine()
        sawTail = true
        positionsCursor = true
        tail += sequence
        index += sequence.length
        continue
      }
      if (sequence === HIDE_CURSOR || sequence === SHOW_CURSOR) {
        finishLine()
        sawTail = true
        tail += sequence
        index += sequence.length
        continue
      }
      return undefined
    }
    if (rest.startsWith('\x1b]')) {
      // Every pi-tui line reset closes its OSC 8 hyperlink; no other OSC is
      // part of the frame grammar (titles, images, and placements pass through).
      const osc = osc8At(rest)
      if (osc === undefined || line === undefined) return undefined
      line += osc
      index += osc.length
      continue
    }
    return undefined
  }
  finishLine()
  return { prefix, suffix, fullClear, rows: frameRows, tail, positionsCursor }
}

/** The next CSI at the start of `text`, or `undefined` when it never terminates. */
function csiAt(text: string): { readonly sequence: string, readonly final: string } | undefined {
  for (let index = 2; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code >= 0x40 && code <= 0x7e) return { sequence: text.slice(0, index + 1), final: text[index]! }
  }
  return undefined
}

/** An SGR CSI carries only digit, semicolon, and colon parameters. */
function isSgr(sequence: string): boolean {
  return /^\x1b\[[\d;:]*m$/.test(sequence)
}

/** One complete OSC 8 hyperlink (open or close), BEL- or ST-terminated. */
function osc8At(text: string): string | undefined {
  if (!text.startsWith('\x1b]8;')) return undefined
  for (let index = 4; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code === 0x07) return text.slice(0, index + 1)
    if (code === 0x1b && text[index + 1] === '\\') return text.slice(0, index + 2)
    if (code === 0x1b) return undefined
  }
  return undefined
}
