/**
 * Work-details row components: the turn header (the whole-turn disclosure
 * with its lifecycle label, upstream `TurnProcessNodeView`) and the collapsed
 * process-group title. A running header refreshes its elapsed label each
 * second; a running title holds each label for a short minimum so rapid tool
 * switches do not flicker. Both retire their timers once their turn closes.
 *
 * @module @ephemeral-ai/mayfly/transcript/process-rows
 */

import { sanitizePluginText, type MayflyComponent, type MayflyComponents, type MayflySemanticColors } from '../core/index.ts'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/index.ts'
import { compactElapsedMs } from './agent-presentation.ts'
import { processTitle } from './process-activity.ts'
import type { ProcessTitleItem, TurnHeaderItem } from './process-groups.ts'

/** Refresh cadence of a running turn's elapsed label (upstream live-run clock). */
export const TURN_CLOCK_INTERVAL_MS = 1000

/** Minimum time one running title stays up before a newer one replaces it (upstream). */
export const PROCESS_TITLE_MINIMUM_MS = 150

/** The timer and clock primitives behind the rows; replaceable in tests. */
export interface ProcessRowTimers {
  setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval: (handle: ReturnType<typeof setInterval>) => void
  setTimeout: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimeout: (handle: ReturnType<typeof setTimeout>) => void
  now: () => number
}

const defaultTimers: ProcessRowTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: handle => clearInterval(handle),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle),
  now: () => Date.now(),
}

let rowTimers = defaultTimers

/**
 * Replace the row timers (tests inject fakes here).
 * @param timers - the replacement, or `undefined` to restore the defaults.
 */
export function setProcessRowTimers(timers: ProcessRowTimers | undefined): void {
  rowTimers = timers ?? defaultTimers
}

const STOPPED_OUTCOMES = new Set(['aborted', 'interrupted', 'forked'])

/** The folded or open disclosure marker. */
function marker(folded: boolean): string {
  return folded ? '▸ ' : '▾ '
}

/** One turn header row, refreshed each second while its turn runs. */
export class TurnHeaderComponent implements MayflyComponent {
  private item: TurnHeaderItem | undefined
  private timer: ReturnType<typeof setInterval> | undefined
  private cache: { readonly key: string, readonly rows: string[] } | undefined

  constructor(
    private readonly colors: MayflySemanticColors,
    private readonly components: MayflyComponents,
    private readonly onTick: () => void,
    private readonly t: MayflyTranslate = interpolateLocaleMessage,
  ) {}

  /** Adopt the latest header facts; a running turn keeps the clock ticking. */
  update(item: TurnHeaderItem): void {
    this.item = item
    if (item.running && item.startedAt !== undefined) {
      if (this.timer === undefined) this.timer = rowTimers.setInterval(() => this.onTick(), TURN_CLOCK_INTERVAL_MS)
    } else {
      this.stop()
    }
  }

  invalidate(): void { this.cache = undefined }

  /** Stop the clock; the mounter calls this when the row retires. */
  dispose(): void { this.stop() }

  render(width: number): string[] {
    const item = this.item
    if (item === undefined) return []
    const { colors, t } = this
    let label: string
    let paint: (text: string) => string
    if (item.running) {
      label = item.startedAt === undefined
        ? t('Deep diving...')
        : t('Deep diving for {duration}', { duration: compactElapsedMs(rowTimers.now() - item.startedAt) })
      paint = colors.primary
    } else if (item.outcome !== undefined && STOPPED_OUTCOMES.has(item.outcome)) {
      label = t('Stopped')
      paint = colors.warning
    } else if (item.outcome === 'error') {
      label = t('Failed')
      paint = colors.error
    } else {
      label = item.startedAt === undefined || item.endedAt === undefined
        ? t('Worked')
        : t('Took {duration}', { duration: compactElapsedMs(item.endedAt - item.startedAt) })
      paint = colors.muted
    }
    const counts = [
      ...(item.toolCalls === 0 ? [] : [t(item.toolCalls === 1 ? '{count} tool call' : '{count} tool calls', { count: item.toolCalls })]),
      ...(item.subagents === 0 ? [] : [t(item.subagents === 1 ? '{count} subagent' : '{count} subagents', { count: item.subagents })]),
    ]
    const tail = `${counts.map(count => ` · ${count}`).join('')}${item.hint ? ` · ${t('ctrl+o to expand')}` : ''}`
    const key = `${String(width)}:${String(item.folded)}:${label}:${tail}`
    if (this.cache?.key === key) return this.cache.rows
    const row = `${colors.muted(marker(item.folded))}${paint(label)}${colors.textMuted(tail)}`
    const rows = ['', this.components.truncateToWidth(row, width)]
    this.cache = { key, rows }
    return rows
  }

  private stop(): void {
    if (this.timer === undefined) return
    rowTimers.clearInterval(this.timer)
    this.timer = undefined
  }
}

/** One collapsed process-group row with a flicker-free running title. */
export class ProcessTitleComponent implements MayflyComponent {
  private item: ProcessTitleItem | undefined
  private shown: { readonly title: string, readonly at: number } | undefined
  private hold: ReturnType<typeof setTimeout> | undefined
  private cache: { readonly key: string, readonly rows: string[] } | undefined

  constructor(
    private readonly colors: MayflySemanticColors,
    private readonly components: MayflyComponents,
    private readonly onTick: () => void,
    private readonly t: MayflyTranslate = interpolateLocaleMessage,
  ) {}

  /** Adopt the latest group facts. */
  update(item: ProcessTitleItem): void {
    this.item = item
    this.cache = undefined
  }

  invalidate(): void { this.cache = undefined }

  /** Cancel a pending title commit; the mounter calls this when the row retires. */
  dispose(): void {
    if (this.hold !== undefined) rowTimers.clearTimeout(this.hold)
    this.hold = undefined
  }

  render(width: number): string[] {
    const item = this.item
    if (item === undefined) return []
    const title = this.title(item)
    const failed = item.summary.failed === 0 ? '' : ` · ${this.t('{count} failed', { count: item.summary.failed })}`
    const key = `${String(width)}:${title}:${failed}`
    if (this.cache?.key === key) return this.cache.rows
    const paint = item.closed ? this.colors.muted : this.colors.primary
    const row = `${this.colors.muted(marker(true))}${paint(sanitizePluginText(title))}${this.colors.error(failed)}`
    const rows = ['', this.components.truncateToWidth(row, width)]
    this.cache = { key, rows }
    return rows
  }

  /** The displayed title: a closed title shows at once; a running one holds briefly. */
  private title(item: ProcessTitleItem): string {
    const desired = processTitle(item.summary, item.closed, item.liveDetail, this.t)
    const now = rowTimers.now()
    const shown = this.shown
    if (item.closed || shown === undefined || shown.title === desired) {
      if (shown?.title !== desired) this.shown = { title: desired, at: now }
      this.dispose()
      return desired
    }
    const remaining = PROCESS_TITLE_MINIMUM_MS - (now - shown.at)
    if (remaining <= 0) {
      this.shown = { title: desired, at: now }
      this.dispose()
      return desired
    }
    if (this.hold === undefined) {
      this.hold = rowTimers.setTimeout(() => {
        this.hold = undefined
        this.cache = undefined
        this.onTick()
      }, remaining)
    }
    return shown.title
  }
}
