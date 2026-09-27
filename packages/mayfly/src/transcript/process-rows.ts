/**
 * Work-details row components: the turn header (the whole-turn disclosure
 * with its lifecycle label, upstream `TurnProcessNodeView`) and the collapsed
 * process-group title. A settled header adds its tool-call and subagent
 * counts to describe what the fold hides. The running header, whose elapsed
 * label refreshes each second, renders only in trees without an activity row
 * (the display plan omits it elsewhere); its clock retires once the turn
 * closes. A group title is static past tense: it summarizes settled work and
 * never ticks.
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

/** The timer and clock primitives behind the running header; replaceable in tests. */
export interface ProcessRowTimers {
  setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
  clearInterval: (handle: ReturnType<typeof setInterval>) => void
  now: () => number
}

const defaultTimers: ProcessRowTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: handle => clearInterval(handle),
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
    const counts = item.running ? [] : [
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

/** One collapsed process-group row: the static past-tense title of its settled work. */
export class ProcessTitleComponent implements MayflyComponent {
  private item: ProcessTitleItem | undefined
  private cache: { readonly key: string, readonly rows: string[] } | undefined

  constructor(
    private readonly colors: MayflySemanticColors,
    private readonly components: MayflyComponents,
    private readonly t: MayflyTranslate = interpolateLocaleMessage,
  ) {}

  /** Adopt the latest group facts. */
  update(item: ProcessTitleItem): void {
    this.item = item
    this.cache = undefined
  }

  invalidate(): void { this.cache = undefined }

  render(width: number): string[] {
    const item = this.item
    if (item === undefined) return []
    const title = processTitle(item.summary, this.t)
    const failed = item.summary.failed === 0 ? '' : ` · ${this.t('{count} failed', { count: item.summary.failed })}`
    const key = `${String(width)}:${title}:${failed}`
    if (this.cache?.key === key) return this.cache.rows
    const row = `${this.colors.muted(marker(true))}${this.colors.muted(sanitizePluginText(title))}${this.colors.error(failed)}`
    const rows = ['', this.components.truncateToWidth(row, width)]
    this.cache = { key, rows }
    return rows
  }
}
