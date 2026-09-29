/**
 * The compaction boundary row: one durable transcript entry covering a
 * `/compact` or automatic context-compression lifecycle. While the
 * transaction runs it renders the braille frame and a ticking elapsed label;
 * once `compaction/end` (or the command settlement for attempts that never
 * reached the transaction) lands, the row settles into a one-line marker —
 * `✓ compacted N items · ~Tk tokens` or `✗ <reason>` — that Ctrl-O expands
 * into a bounded preview of the generated checkpoint summary.
 *
 * The refresh runs at the shared braille cadence so the frame spins at the
 * same rate as the turn-level waiting spinners; the renderer timer only
 * animates the frame/elapsed label derived from the durable `startedAt`
 * timestamp — it never measures domain progress. Timers are module-injected
 * via `setCompactionTimers` so specs can drive ticks deterministically, and
 * every handle clears on settle, dispose, or prune.
 *
 * @module @ephemeral-ai/mayfly/transcript/compaction
 */

import { sanitizePluginText, type MayflyComponent, type MayflyComponents, type MayflySemanticColors } from '../core/index.ts'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/index.ts'
import type { TranscriptCompactionModel } from '../frontend/models.ts'
import { compactElapsedMs } from './agent-presentation.ts'
import { BRAILLE_SPINNER_FRAMES, BRAILLE_SPINNER_INTERVAL_MS } from '../core/glyphs.ts'
import { formatTokens } from './status-context.ts'

/** Upper bound on the expanded checkpoint-summary preview. */
export const COMPACTION_SUMMARY_LINES = 5

/** Refresh cadence of the live frame and elapsed label. */
const COMPACTION_REFRESH_MS = BRAILLE_SPINNER_INTERVAL_MS

/** The timer primitives behind the live refresh; replaceable in tests. */
export interface CompactionTimers {
  /** Start a repeating callback; mirrors the global `setInterval`. */
  setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
  /** Stop a repeating callback; mirrors the global `clearInterval`. */
  clearInterval: (handle: ReturnType<typeof setInterval>) => void
}

/** The process timer primitives. */
const defaultCompactionTimers: CompactionTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: handle => clearInterval(handle),
}

let compactionTimers: CompactionTimers = defaultCompactionTimers

/**
 * Replace the refresh timers (tests inject fakes here).
 * @param timers - the replacement, or `undefined` to restore the defaults.
 */
export function setCompactionTimers(timers: CompactionTimers | undefined): void {
  compactionTimers = timers ?? defaultCompactionTimers
}

/**
 * Renders one compaction transaction. The component re-reads its model on
 * every render, so fold updates flow through `update`; the refresh interval
 * is the only mutable machinery, and it stands down on the first tick or
 * render that observes the settled entry.
 */
export class CompactionRowComponent implements MayflyComponent {
  private model: TranscriptCompactionModel
  private readonly colors: MayflySemanticColors
  private readonly components: MayflyComponents
  private readonly requestRender: (() => void) | undefined
  private readonly t: MayflyTranslate
  private expanded = false
  private frame = 0
  private timer: ReturnType<typeof setInterval> | undefined
  private timerMs = 0
  private disposed = false

  /**
   * @param model - the transcript compaction entry.
   * @param colors - the semantic color table.
   * @param components - the component factory providing the width helpers.
   * @param requestRender - the redraw nudge for the live refresh; absent in
   *   unit tests, where the label advances only through explicit renders.
   * @param t - transcript translator.
   */
  constructor(
    model: TranscriptCompactionModel,
    colors: MayflySemanticColors,
    components: MayflyComponents,
    requestRender?: (() => void) | undefined,
    t: MayflyTranslate = interpolateLocaleMessage,
    private readonly liveStatus = true,
  ) {
    this.model = model
    this.colors = colors
    this.components = components
    this.requestRender = requestRender
    this.t = t
    if (model.state === 'running' && liveStatus) this.startTimer()
  }

  /**
   * Adopt the updated model for this entry's new revision.
   * @param model - the refreshed transcript compaction entry.
   */
  update(model: TranscriptCompactionModel): void {
    this.model = model
  }

  /**
   * Switch between the marker and the checkpoint-summary preview (the
   * shared Ctrl-O expansion toggle).
   * @param expanded - true renders the bounded summary preview.
   */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }

  /** The marker carries its own state; turn-closure scope does not apply. */
  setScope(_scope: { readonly hint: boolean }): void {}

  /** Drop derived state; the next render rebuilds from the model. */
  invalidate(): void {}

  /** Stop the refresh; the mounter calls this when the component retires. */
  dispose(): void {
    this.disposed = true
    this.stopTimer()
  }

  /**
   * @param width - current viewport width in columns.
   * @returns the rendered rows: the marker plus the expanded summary.
   */
  render(width: number): string[] {
    if (this.model.state === 'running' && this.liveStatus) this.startTimer()
    else this.stopTimer()
    const rows = [this.mainLine()]
    if (this.expanded && this.model.state !== 'running' && this.model.summary !== undefined) {
      for (const line of sanitizePluginText(this.model.summary).split('\n').slice(0, COMPACTION_SUMMARY_LINES)) {
        rows.push(`  ${this.components.italic(this.colors.muted(line))}`)
      }
    }
    return rows.map(row => this.components.truncateToWidth(row, width))
  }

  /** The one-line boundary marker for the entry's current state. */
  private mainLine(): string {
    const { model, colors } = this
    const auto = model.trigger === 'auto' ? this.t(' · auto') : ''
    if (model.state === 'running') {
      if (!this.liveStatus) return colors.primary(`${this.t('compacting context…')}${auto}`)
      const frame = colors.accent(BRAILLE_SPINNER_FRAMES[(this.components.reducedMotion === true ? 0 : this.frame) % BRAILLE_SPINNER_FRAMES.length]!)
      const elapsed = compactElapsedMs(Date.now() - model.startedAt)
      return `${frame} ${colors.muted(`${this.t('compacting context…')} · ${elapsed}${auto}`)}`
    }
    if (model.state === 'error') {
      const reason = firstLine(model.error ?? model.detail ?? this.t('compaction failed'))
      return `${colors.error('✗')} ${colors.error(reason)}`
    }
    if (model.shadowedCount === undefined) {
      const detail = firstLine(model.detail ?? this.t('compacted'))
      return `${colors.success('✓')} ${colors.muted(`${detail}${auto}`)}`
    }
    const done = this.t('compacted {count} items', { count: model.shadowedCount })
    const tokens = model.shadowedTokens === undefined ? '' : ` · ~${formatTokens(model.shadowedTokens)}`
    return `${colors.success('✓')} ${colors.muted(`${done}${tokens}${auto}`)}`
  }

  private startTimer(): void {
    if (this.disposed) return
    const interval = this.components.reducedMotion === true ? 1000 : COMPACTION_REFRESH_MS
    if (this.timer !== undefined && this.timerMs === interval) return
    this.stopTimer()
    this.timerMs = interval
    this.timer = compactionTimers.setInterval(() => {
      // Settlement lands through `update`; the first tick that observes it
      // stands down instead of refreshing a finished row.
      if (this.disposed || this.model.state !== 'running') {
        this.stopTimer()
        return
      }
      this.frame += 1
      this.requestRender?.()
    }, interval)
  }

  private stopTimer(): void {
    if (this.timer === undefined) return
    compactionTimers.clearInterval(this.timer)
    this.timer = undefined
    this.timerMs = 0
  }
}

/** The first physical line of a possibly multi-line status or error string. */
function firstLine(text: string): string {
  return sanitizePluginText(text).split('\n', 1)[0]!
}

