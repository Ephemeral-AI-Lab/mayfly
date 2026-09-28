/**
 * The render-exit width backstop (D48). pi-tui's main-screen guard crashes
 * the process when any rendered line exceeds the terminal width — the right
 * fail-loud behavior for dogfooding, but a user session dies with it. This
 * module clamps every frame line at the one seam that sees the complete
 * flat output before pi-tui's differential writer (the dock-filling
 * `render` wrapper in terminal.ts), so an over-wide component line degrades
 * to a truncated row plus one deduplicated log entry instead of a crash.
 *
 * @module @ephemeral-ai/mayfly/core/frame-clamp
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sliceByColumn, visibleWidth } from './width.ts'

/** One clamped frame line, as logged. `line` doubles as the dedupe key. */
export interface FrameOverflowEntry {
  /** The clamped line's index within the frame. */
  readonly index: number
  /** The viewport width the line was clamped to. */
  readonly columns: number
  /** The line's original visible width. */
  readonly width: number
  /** The original, unclamped line. */
  readonly line: string
}

/** Receives clamped-line records; implementations must never throw. */
export interface OverflowSink {
  record(entry: FrameOverflowEntry): void
}

/**
 * Clamp every line of a rendered frame to `width` visible columns.
 * Over-wide lines are hard-sliced with `sliceByColumn` (strict: a wide
 * character straddling the boundary is dropped, never overflowed — no
 * ellipsis, the last-resort guard stays absolutely safe). A clean frame
 * returns the input array itself (no copy); `sink`, when given, records
 * each clamped line once per call.
 * @param lines - the rendered frame.
 * @param width - the viewport width, the same value pi-tui's guard checks.
 * @param sink - where clamped-line records go; never throws.
 * @returns the frame to hand to pi-tui, every line `visibleWidth <= width`.
 */
export function clampFrame(lines: string[], width: number, sink?: OverflowSink): string[] {
  let clamped: string[] | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (visibleWidth(line) <= width) continue
    clamped ??= [...lines]
    clamped[index] = sliceByColumn(line, 0, width, true)
    sink?.record({ index, columns: width, width: visibleWidth(line), line })
  }
  return clamped ?? lines
}

/** A previous clamp of one source at the same width. */
export interface ClampedRows {
  /** The rows the component returned. */
  readonly source: readonly string[]
  /** The clamped rows handed to pi-tui for that source. */
  readonly rows: readonly string[]
}

/**
 * {@link clampFrame} against the previous clamp of the same child at the same
 * width. A row equal to the previous source row at its index reuses the
 * previous result, so a live frame that appends or rewrites its tail measures
 * only the changed rows instead of rescanning the whole transcript (pi-tui's
 * width cache is far smaller than a long session). Shifted rows fall back to
 * measurement, so the result always equals `clampFrame(lines, width)`.
 * @param previous - the previous clamp at this width, if any.
 * @param lines - the rendered rows.
 * @param width - the viewport width.
 * @param sink - where newly clamped rows are recorded.
 * @returns the clamped rows; the input array itself when nothing clamps.
 */
export function clampFrameFrom(previous: ClampedRows | undefined, lines: string[], width: number, sink?: OverflowSink): string[] {
  if (previous === undefined) return clampFrame(lines, width, sink)
  let clamped: string[] | undefined
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!
    if (previous.source[index] === line) {
      const row = previous.rows[index]!
      if (row === line) continue
      clamped ??= [...lines]
      clamped[index] = row
      continue
    }
    if (visibleWidth(line) <= width) continue
    clamped ??= [...lines]
    clamped[index] = sliceByColumn(line, 0, width, true)
    sink?.record({ index, columns: width, width: visibleWidth(line), line })
  }
  return clamped ?? lines
}

/**
 * pi-tui's own log-directory chain (`PI_CODING_AGENT_DIR ?? ~/.pi/agent`),
 * so `mayfly-overflow.log` lands next to `pi-crash.log`.
 * @returns the directory for the default overflow sink.
 */
export function defaultOverflowDirectory(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
}

/** Options for the file-backed overflow sink. */
export interface FileOverflowSinkOptions {
  /** Directory to create on first write; holds `mayfly-overflow.log`. */
  readonly directory: string
  /**
   * Distinct-line dedupe window. Once this many distinct lines are
   * remembered the window resets, so later violations still record. Values
   * below 1 behave as 1; default 200.
   */
  readonly maxEntries?: number
  /**
   * Total lines the sink ever appends. The dedupe window keeps late
   * violations recording, but a *changing* over-wide row (a spinner,
   * elapsed time, progress) is distinct every frame, so without a total
   * budget the file would grow one synchronous write per frame for the
   * rest of the session. Once this budget is spent the sink stays silent —
   * bounded telemetry beats a backstop that can flood the disk. Values
   * below 1 behave as 1; default 1000.
   */
  readonly maxLines?: number
}

/**
 * Deduplicating JSONL overflow log. Each distinct original line is appended
 * once (renders repeat at 16ms; without dedupe a single over-wide row would
 * flood the file). `maxEntries` is the dedupe window, not a fuse: once the
 * window fills it resets, so a width regression surfacing late in a long
 * session is still recorded (a still-visible line can therefore reappear
 * after a reset). `maxLines` bounds the total appended lines so a *changing*
 * over-wide row cannot drive a synchronous write per frame indefinitely.
 * Every filesystem failure is swallowed — the backstop must never take
 * rendering down with it. Entries look like
 * `{"time":"...","index":3,"columns":40,"width":61,"line":"..."}`.
 * @param options - target directory, dedupe window, and line budget.
 * @returns the file-backed `OverflowSink`.
 */
export function createFileOverflowSink(options: FileOverflowSinkOptions): OverflowSink {
  const { directory, maxEntries = 200, maxLines = 1000 } = options
  const windowSize = Math.max(1, maxEntries)
  const lineBudget = Math.max(1, maxLines)
  const seen = new Set<string>()
  let written = 0
  return {
    record(entry) {
      if (written >= lineBudget || seen.has(entry.line)) return
      if (seen.size >= windowSize) seen.clear()
      seen.add(entry.line)
      written += 1
      try {
        mkdirSync(directory, { recursive: true })
        appendFileSync(
          join(directory, 'mayfly-overflow.log'),
          `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`,
        )
      } catch {
        // The backstop's own log must never break rendering.
      }
    },
  }
}
