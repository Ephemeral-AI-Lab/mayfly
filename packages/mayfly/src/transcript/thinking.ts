/**
 * The transcript's thinking block: one step's reasoning mounted as its own
 * component above the assistant answer. Live it shows a static `✻ Thinking`
 * header with the elapsed time, projected token count, and estimated rate,
 * over the reasoning's last {@link THINKING_PREVIEW_LINES} wrapped lines; the
 * activity row owns the animated spinner, so the block only refreshes once a
 * second. Reasoning completion or a switch to text/tools clears `streaming`
 * and the block settles in place into one `✻ Thought for 6s` row, previewing
 * the first line when the work-details policy allows it. The shared Ctrl-O
 * toggle opens the full italic body. A finalized item whose authoritative
 * reasoning is blank renders zero rows.
 *
 * @module @ephemeral-ai/mayfly/transcript/thinking
 */

import { sanitizePluginText, type MayflyComponent, type MayflyComponents, type MayflySemanticColors } from '../core/index.ts'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/index.ts'
import { STREAMING_RENDER_MAX_CHARS } from './components.ts'
import type { TranscriptThinkingItem } from './types.ts'
import { formatTokens } from './status-context.ts'
import { outputRate } from './output-rate.ts'
import { compactElapsedMs } from './agent-presentation.ts'

/** Rendered body lines kept visible under the live header. */
export const THINKING_PREVIEW_LINES = 2

/** Refresh cadence of the live elapsed label. */
export const THINKING_REFRESH_MS = 1000

/** The block's marker: distinct from the answer and tool bullets. */
export const THINKING_MARKER = '✻ '

/** Continuation indent: the marker's visible width, so body text aligns. */
const THINKING_INDENT = '  '

function streamingTextWindow(text: string): string {
  const start = text.length - STREAMING_RENDER_MAX_CHARS
  const boundary = text.indexOf('\n', start)
  const visible = sanitizePluginText(text.slice(boundary < 0 ? start : boundary + 1))
  return `... (${String(text.length - visible.length)} earlier characters)\n${visible}`
}

/** The timer primitives behind the live refresh; replaceable in tests. */
export interface ThinkingTimers {
  /** Start a repeating callback; mirrors the global `setInterval`. */
  setInterval: (callback: () => void, ms: number) => ReturnType<typeof setInterval>
  /** Stop a repeating callback; mirrors the global `clearInterval`. */
  clearInterval: (handle: ReturnType<typeof setInterval>) => void
}

/** The process timer primitives. */
const defaultThinkingTimers: ThinkingTimers = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: handle => clearInterval(handle),
}

let thinkingTimers: ThinkingTimers = defaultThinkingTimers

/**
 * Replace the refresh timers (tests inject fakes here).
 * @param timers - the replacement, or `undefined` to restore the defaults.
 */
export function setThinkingTimers(timers: ThinkingTimers | undefined): void {
  thinkingTimers = timers ?? defaultThinkingTimers
}

/**
 * Renders one step's reasoning. The component reads the item on every
 * render, so the fold's mutations (delta appends, the authoritative
 * finalize rewrite) flow through with nothing but a cache-key change; the
 * refresh interval is the only mutable machinery, and it retires itself on
 * the first tick that observes the finalized item (a snapshot replay
 * constructs thousands of once-live blocks synchronously — none of them
 * ever fires).
 */
export class ThinkingComponent implements MayflyComponent {
  private readonly item: TranscriptThinkingItem
  private readonly colors: MayflySemanticColors
  private readonly components: MayflyComponents
  private readonly requestRender: (() => void) | undefined
  private readonly preview: () => boolean
  private readonly t: MayflyTranslate
  private expanded = false
  private keyed = true
  private timer: ReturnType<typeof setInterval> | undefined
  private cache: { key: string, lines: string[] } | undefined
  private wrapped: { text: string, width: number, lines: string[] } | undefined

  /**
   * @param item - the folded thinking item; mutated by the fold as the step
   *   streams and finalizes.
   * @param colors - the semantic color table (muted body, textMuted hint).
   * @param components - the component factory providing the width helpers.
   * @param requestRender - the redraw nudge for the live refresh; absent in
   *   unit tests, where the label advances only through explicit renders.
   * @param preview - whether a settled block previews its first line.
   * @param t - transcript translator.
   */
  constructor(
    item: TranscriptThinkingItem,
    colors: MayflySemanticColors,
    components: MayflyComponents,
    requestRender?: (() => void) | undefined,
    preview: () => boolean = () => true,
    t: MayflyTranslate = interpolateLocaleMessage,
  ) {
    this.item = item
    this.colors = colors
    this.components = components
    this.requestRender = requestRender
    this.preview = preview
    this.t = t
    if (item.streaming) this.startTimer()
  }

  /** Drop the cached lines; the next render rebuilds from the item. */
  invalidate(): void {
    this.cache = undefined
    this.wrapped = undefined
  }

  /**
   * Switch between the folded and full presentation (the shared Ctrl-O
   * expansion toggle).
   * @param expanded - true renders every line, false the folded row.
   */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }

  /**
   * Adopt the block's disclosure scope.
   * @param scope - whether Ctrl-O reaches the block's turn.
   */
  setScope(scope: { readonly hint: boolean }): void {
    this.keyed = scope.hint
  }

  /** Stop the refresh; the mounter calls this when the component retires. */
  dispose(): void {
    this.stopTimer()
  }

  /**
   * @param width - current viewport width in columns.
   * @returns the rendered rows: none for a blank finalized block.
   */
  render(width: number): string[] {
    const { streaming } = this.item
    if (streaming && this.timer === undefined) this.startTimer()
    if (!streaming) this.stopTimer()
    const now = Date.now()
    const rate = streaming ? outputRate(this.item.outputProgress, now) : ''
    const count = this.item.outputProgress === undefined ? '' : `↓${formatTokens(Math.floor(this.item.text.length / 4))}`
    const elapsed = streaming && this.item.startedAt !== undefined ? compactElapsedMs(now - this.item.startedAt) : ''
    const preview = this.preview()
    const text = this.item.text.length > STREAMING_RENDER_MAX_CHARS
      ? streamingTextWindow(this.item.text)
      : sanitizePluginText(this.item.text)
    const key = `${width}:${streaming}:${this.expanded}:${this.keyed}:${preview}:${elapsed}:${rate}:${count}:${this.item.durationMs ?? ''}:${text}`
    if (this.cache?.key === key) return this.cache.lines

    const contentWidth = Math.max(1, width - THINKING_INDENT.length)
    const contentLines = this.wrapped?.text === text && this.wrapped.width === contentWidth
      ? this.wrapped.lines
      : text.length > 0 ? this.components.wrapText(text, contentWidth) : ['']
    this.wrapped = { text, width: contentWidth, lines: contentLines }
    const marker = this.colors.muted(THINKING_MARKER)
    let lines: string[]
    if (streaming) {
      let label = this.t('Thinking')
      for (const part of [elapsed, count, rate]) {
        if (part === '') continue
        const next = `${label} · ${part}`
        if (this.components.visibleWidth(`${THINKING_MARKER}${next}`) > width) break
        label = next
      }
      const tail = contentLines.length > THINKING_PREVIEW_LINES
        ? contentLines.slice(contentLines.length - THINKING_PREVIEW_LINES)
        : contentLines
      lines = ['', `${marker}${this.colors.muted(label)}`, ...tail.map(line => THINKING_INDENT + this.styled(line))]
    } else if (text.trim() === '') {
      // A finalized rewrite with no visible reasoning renders nothing.
      lines = []
    } else {
      const title = this.item.durationMs === undefined
        ? this.t('Thought for a while')
        : this.t('Thought for {duration}', { duration: compactElapsedMs(Math.max(1000, this.item.durationMs)) })
      if (this.expanded) {
        lines = ['', `${marker}${this.colors.muted(title)}`, ...contentLines.map(line => THINKING_INDENT + this.styled(line))]
      } else {
        // Non-blank reasoning always wraps to at least one non-blank line.
        const first = contentLines.find(line => line.trim() !== '')!
        const summary = preview ? `${this.colors.muted(`${title} · `)}${this.styled(first.trim())}` : this.colors.muted(title)
        // The hint names the key only when it reaches the block and fits whole.
        const hint = ` · ${this.t('ctrl+o to expand')}`
        const fits = this.components.visibleWidth(`${marker}${summary}${hint}`) <= width
        lines = ['', `${marker}${summary}${this.keyed && fits ? this.colors.textMuted(hint) : ''}`]
      }
    }
    // The marker and indent can out-wide a degenerate viewport (a resize
    // drag crossing two columns); assembled rows pass the width backstop.
    lines = lines.map(row => this.components.truncateToWidth(row, width))
    this.cache = { key, lines }
    return lines
  }

  /** One muted italic body line. */
  private styled(line: string): string {
    return this.components.italic(this.colors.muted(line))
  }

  private startTimer(): void {
    this.timer = thinkingTimers.setInterval(() => {
      // The fold finalizes by mutation; the first tick that sees it stands
      // down instead of refreshing a settled block.
      if (!this.item.streaming) {
        this.stopTimer()
        return
      }
      this.cache = undefined
      this.requestRender?.()
    }, THINKING_REFRESH_MS)
  }

  private stopTimer(): void {
    if (this.timer === undefined) return
    thinkingTimers.clearInterval(this.timer)
    this.timer = undefined
  }
}
