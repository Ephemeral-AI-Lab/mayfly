/**
 * The transcript's thinking block (the kimi `ThinkingComponent` port): one
 * step's reasoning mounted as its own component above the assistant answer.
 * Live it scrolls the reasoning's tail — a blank separator row, the braille
 * spinner with the muted `thinking...` label, and the wrapped text's last
 * {@link THINKING_PREVIEW_LINES} lines — advancing at the braille interval
 * behind module-level replaceable timers (the `pane-activity` precedent)
 * with a caller-injected redraw nudge. The closing `assistant/message`
 * flips the item's `streaming` flag and the component settles in place,
 * never remounting: finalized it renders the muted `● ` bullet with the
 * full italic body, folded to the first two lines plus a textMuted
 * `... (N more lines, ctrl+o to expand)` hint until the shared Ctrl-O
 * expansion toggle opens it. A finalized item whose authoritative reasoning
 * is blank renders zero rows — a stream that turned out to carry no visible
 * thinking leaves nothing behind.
 *
 * @module @ephemeral-ai/mayfly/transcript/thinking
 */

import { sanitizePluginText, type MayflyComponent, type MayflyComponents, type MayflySemanticColors } from '../core/index.ts'
import { BRAILLE_SPINNER_FRAMES, BRAILLE_SPINNER_INTERVAL_MS } from './spinners.ts'
import { STREAMING_RENDER_MAX_CHARS } from './components.ts'
import type { TranscriptThinkingItem } from './types.ts'

/** Rendered body lines kept visible when the block folds. */
export const THINKING_PREVIEW_LINES = 2

function streamingTextWindow(text: string): string {
  const start = text.length - STREAMING_RENDER_MAX_CHARS
  const boundary = text.indexOf('\n', start)
  const visible = sanitizePluginText(text.slice(boundary < 0 ? start : boundary + 1))
  return `... (${String(text.length - visible.length)} earlier characters)\n${visible}`
}

/** The finalized block's first-line marker (a muted status bullet). */
const THINKING_MARKER = '● '

/** Continuation indent: the marker's visible width, so body text aligns. */
const THINKING_INDENT = '  '

/** The timer primitives behind the live spinner; replaceable in tests. */
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
 * Replace the spinner timers (tests inject fakes here).
 * @param timers - the replacement, or `undefined` to restore the defaults.
 */
export function setThinkingTimers(timers: ThinkingTimers | undefined): void {
  thinkingTimers = timers ?? defaultThinkingTimers
}

/**
 * Renders one step's reasoning. The component reads the item on every
 * render, so the fold's mutations (delta appends, the authoritative
 * finalize rewrite) flow through with nothing but a cache-key change; the
 * spinner interval is the only mutable machinery, and it retires itself on
 * the first tick that observes the finalized item (a snapshot replay
 * constructs thousands of once-live blocks synchronously — none of them
 * ever fires).
 */
export class ThinkingComponent implements MayflyComponent {
  private readonly item: TranscriptThinkingItem
  private readonly colors: MayflySemanticColors
  private readonly components: MayflyComponents
  private readonly requestRender: (() => void) | undefined
  private expanded = false
  private spinnerFrame = 0
  private spinnerTimer: ReturnType<typeof setInterval> | undefined
  private cache: { key: string, lines: string[] } | undefined
  private wrapped: { text: string, width: number, lines: string[] } | undefined

  /**
   * @param item - the folded thinking item; mutated by the fold as the step
   *   streams and finalizes.
   * @param colors - the semantic color table (muted body, textMuted hint).
   * @param components - the component factory providing the width helpers.
   * @param requestRender - the redraw nudge for spinner ticks; absent in
   *   unit tests, where frames advance only through explicit renders.
   */
  constructor(
    item: TranscriptThinkingItem,
    colors: MayflySemanticColors,
    components: MayflyComponents,
    requestRender?: (() => void) | undefined,
  ) {
    this.item = item
    this.colors = colors
    this.components = components
    this.requestRender = requestRender
    if (item.streaming) this.startSpinner()
  }

  /** Drop the cached lines; the next render rebuilds from the item. */
  invalidate(): void {
    this.cache = undefined
    this.wrapped = undefined
  }

  /**
   * Switch between the folded and full presentation (the shared Ctrl-O
   * expansion toggle).
   * @param expanded - true renders every line, false the folded preview.
   */
  setExpanded(expanded: boolean): void {
    this.expanded = expanded
  }

  /** Stop the spinner; the mounter calls this when the component retires. */
  dispose(): void {
    this.stopSpinner()
  }

  /**
   * @param width - current viewport width in columns.
   * @returns the rendered rows: none for a blank finalized block.
   */
  render(width: number): string[] {
    const { streaming } = this.item
    const text = this.item.text.length > STREAMING_RENDER_MAX_CHARS
      ? streamingTextWindow(this.item.text)
      : sanitizePluginText(this.item.text)
    const key = `${width}:${streaming}:${this.expanded}:${text}`
    if (this.cache?.key === key) return this.cache.lines

    const contentWidth = Math.max(1, width - THINKING_INDENT.length)
    const contentLines = this.wrapped?.text === text && this.wrapped.width === contentWidth
      ? this.wrapped.lines
      : text.length > 0 ? this.components.wrapText(text, contentWidth) : ['']
    this.wrapped = { text, width: contentWidth, lines: contentLines }
    let lines: string[]
    if (streaming) {
      // Live: the spinner row over the reasoning's rolling tail window.
      const tail = contentLines.length > THINKING_PREVIEW_LINES
        ? contentLines.slice(contentLines.length - THINKING_PREVIEW_LINES)
        : contentLines
      const frame = BRAILLE_SPINNER_FRAMES[this.spinnerFrame % BRAILLE_SPINNER_FRAMES.length]!
      lines = [
        '',
        `${this.colors.muted(frame)} ${this.colors.muted('thinking...')}`,
        ...tail.map(line => THINKING_INDENT + this.styled(line)),
      ]
    } else if (text.trim() === '') {
      // A finalized rewrite with no visible reasoning renders nothing.
      lines = []
    } else {
      const body = contentLines.map((line, index) =>
        (index === 0 ? this.colors.muted(THINKING_MARKER) : THINKING_INDENT) + this.styled(line))
      if (this.expanded || contentLines.length <= THINKING_PREVIEW_LINES) {
        lines = ['', ...body]
      } else {
        const folded = body.slice(0, THINKING_PREVIEW_LINES)
        const remaining = contentLines.length - THINKING_PREVIEW_LINES
        const hint = `... (${remaining} more lines, ctrl+o to expand)`
        const hintWidth = Math.max(0, width - THINKING_INDENT.length)
        folded.push(THINKING_INDENT + this.colors.textMuted(
          this.components.truncateToWidth(hint, hintWidth, '…')))
        lines = ['', ...folded]
      }
    }
    // The marker and indent can out-wide a degenerate viewport (a resize
    // drag crossing two columns); assembled rows pass the width backstop.
    lines = lines.map(text => this.components.truncateToWidth(text, width))
    this.cache = { key, lines }
    return lines
  }

  /** One muted italic body line. */
  private styled(line: string): string {
    return this.components.italic(this.colors.muted(line))
  }

  private startSpinner(): void {
    this.spinnerTimer = thinkingTimers.setInterval(() => {
      // The fold finalizes by mutation; the first tick that sees it stands
      // down instead of animating a settled block.
      if (!this.item.streaming) {
        this.stopSpinner()
        return
      }
      this.spinnerFrame += 1
      this.cache = undefined
      this.requestRender?.()
    }, BRAILLE_SPINNER_INTERVAL_MS)
  }

  private stopSpinner(): void {
    if (this.spinnerTimer === undefined) return
    thinkingTimers.clearInterval(this.spinnerTimer)
    this.spinnerTimer = undefined
  }
}
