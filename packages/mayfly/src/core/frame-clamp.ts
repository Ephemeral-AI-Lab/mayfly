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

import { appendFile, mkdir } from 'node:fs/promises'
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
  /** Optional teardown: flush buffered records, then stop the sink. */
  dispose?(): Promise<void>
}

/**
 * The file-backed sink's face beyond {@link OverflowSink}: records queue in
 * memory and drain through an explicit async flush, so the render path never
 * waits on the filesystem.
 */
export interface FileOverflowSink extends OverflowSink {
  /** Drain queued records now; never rejects. */
  flush(): Promise<void>
  /** Drain queued records, then stop accepting new ones; never rejects. */
  dispose(): Promise<void>
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
   * budget the file would grow one queued line per frame for the rest of
   * the session. Once this budget is spent the sink stays silent —
   * bounded telemetry beats a backstop that can flood the disk. Values
   * below 1 behave as 1; default 1000.
   */
  readonly maxLines?: number
  /**
   * Coalescing window before queued records flush off the render path
   * (milliseconds). Values below 0 behave as 0; default 250.
   */
  readonly flushDelayMs?: number
}

/**
 * Deduplicating JSONL overflow log. Each distinct original line is queued
 * once (renders repeat at 16ms; without dedupe a single over-wide row would
 * flood the file); `record` only touches memory, and a timer flushes the
 * queue off the render path after {@link FileOverflowSinkOptions.flushDelayMs}
 * — the render exit never waits on the filesystem. `maxEntries` is the
 * dedupe window, not a fuse: once the window fills it resets, so a width
 * regression surfacing late in a long session is still recorded (a
 * still-visible line can therefore reappear after a reset). `maxLines`
 * bounds the total appended lines so a *changing* over-wide row cannot
 * drive a queued line per frame indefinitely. A pending flush keeps the
 * event loop alive, so an orderly exit drains the queue; only a hard crash
 * can lose the last window. One failed flush disables the sink, and every
 * filesystem failure is swallowed — the backstop must never take rendering
 * down with it. Entries look like
 * `{"time":"...","index":3,"columns":40,"width":61,"line":"..."}`.
 * @param options - target directory, dedupe window, line budget, flush delay.
 * @returns the file-backed `OverflowSink`.
 */
export function createFileOverflowSink(options: FileOverflowSinkOptions): FileOverflowSink {
  const { directory, maxEntries = 200, maxLines = 1000, flushDelayMs = 250 } = options
  const windowSize = Math.max(1, maxEntries)
  const lineBudget = Math.max(1, maxLines)
  const delayMs = Math.max(0, flushDelayMs)
  const seen = new Set<string>()
  const queued: string[] = []
  let written = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  // Flushes serialize through one chain. The batch work never rejects (the
  // only await points sit inside the try/catch below), so the chain needs
  // no rejection handling and a flush racing the timer (or dispose) cannot
  // interleave half-written batches.
  let chain: Promise<void> = Promise.resolve()
  let stopped = false
  const flush = (): Promise<void> => {
    const run = chain.then(async () => {
      if (queued.length === 0) return
      const batch = queued.splice(0, queued.length).join('')
      try {
        await mkdir(directory, { recursive: true })
        await appendFile(join(directory, 'mayfly-overflow.log'), batch)
      } catch {
        // A broken target will not heal by retrying every frame; the batch
        // is dropped and the sink goes silent.
        stopped = true
      }
    })
    chain = run
    return run
  }
  return {
    record(entry) {
      if (stopped || written >= lineBudget || seen.has(entry.line)) return
      if (seen.size >= windowSize) seen.clear()
      seen.add(entry.line)
      written += 1
      queued.push(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`)
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined
          void flush()
        }, delayMs)
      }
    },
    flush,
    async dispose() {
      stopped = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      await flush()
    },
  }
}
