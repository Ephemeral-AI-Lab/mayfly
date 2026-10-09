/**
 * The transcript's thinking block: one step's reasoning mounted as its own
 * component above the assistant answer. Live it is content, not status: the
 * `✻` marker over the reasoning's last {@link THINKING_PREVIEW_LINES} wrapped
 * lines, with no caption or clock — the activity row owns the phase label,
 * elapsed time, and throughput. Reasoning completion or a switch to
 * text/tools clears `streaming` and the block settles in place into one
 * `✻ Thought for 6s` row, previewing the first line when the work-details
 * policy allows it. The shared Ctrl-O toggle opens the full italic body.
 * Blank reasoning, live or finalized, renders zero rows.
 *
 * @module @ephemeral-ai/mayfly/transcript/thinking
 */

import { sanitizePluginText, type MayflyComponent, type MayflyComponents, type MayflySemanticColors } from '../core/index.ts'
import { interpolateLocaleMessage, type MayflyTranslate } from '../frontend/index.ts'
import { streamingWindow, STREAMING_RENDER_MAX_CHARS } from './components.ts'
import type { TranscriptThinkingItem } from './types.ts'
import { compactElapsedMs } from './agent-presentation.ts'

/** Wrapped reasoning lines a live block keeps visible. */
export const THINKING_PREVIEW_LINES = 2

/** The block's marker: distinct from the answer and tool bullets. */
export const THINKING_MARKER = '✻ '

/** Continuation indent: the marker's visible width, so body text aligns. */
const THINKING_INDENT = '  '

/**
 * The newline-aligned tail a live block needs for its last wrapped lines.
 * Wrapping restarts at every hard line break, so wrapping this tail yields
 * exactly the final wrapped lines of the whole text; streaming then pays for
 * the preview instead of rewrapping the entire reasoning on every delta.
 * @param text - the raw reasoning.
 * @param width - the content width.
 * @returns the tail, or `undefined` when the whole text is short enough.
 */
function streamingPreviewTail(text: string, width: number): string | undefined {
  const budget = (THINKING_PREVIEW_LINES + 2) * width * 2
  if (text.length <= budget) return undefined
  const boundary = text.lastIndexOf('\n', text.length - budget)
  return boundary < 0 ? undefined : text.slice(boundary + 1)
}

/**
 * Renders one step's reasoning. The component reads the item on every
 * render, so the fold's mutations (delta appends, the authoritative
 * finalize rewrite) flow through with nothing but a cache-key change; it
 * owns no timers.
 */
export class ThinkingComponent implements MayflyComponent {
  private readonly item: TranscriptThinkingItem
  private readonly colors: MayflySemanticColors
  private readonly components: MayflyComponents
  private readonly preview: () => boolean
  private readonly t: MayflyTranslate
  private expanded = false
  private keyed = true
  private cache: { key: string, lines: string[] } | undefined
  private wrapped: { text: string, width: number, lines: string[] } | undefined

  /**
   * @param item - the folded thinking item; mutated by the fold as the step
   *   streams and finalizes.
   * @param colors - the semantic color table (muted body, textMuted hint).
   * @param components - the component factory providing the width helpers.
   * @param preview - whether a settled block previews its first line.
   * @param t - transcript translator.
   */
  constructor(
    item: TranscriptThinkingItem,
    colors: MayflySemanticColors,
    components: MayflyComponents,
    preview: () => boolean = () => true,
    t: MayflyTranslate = interpolateLocaleMessage,
  ) {
    this.item = item
    this.colors = colors
    this.components = components
    this.preview = preview
    this.t = t
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

  /**
   * @param width - current viewport width in columns.
   * @returns the rendered rows: none for blank reasoning.
   */
  render(width: number): string[] {
    const { streaming } = this.item
    if (streaming) {
      const contentWidth = Math.max(1, width - THINKING_INDENT.length)
      const tail = streamingPreviewTail(this.item.text, contentWidth)
      const lines = tail === undefined ? undefined : this.renderText(width, sanitizePluginText(tail))
      // A tail without enough visible lines (trailing blank runs) falls back.
      if (lines !== undefined && lines.length > THINKING_PREVIEW_LINES) return lines
    }
    return this.renderText(width, this.item.text.length > STREAMING_RENDER_MAX_CHARS
      ? streamingWindow(this.item.text)
      : sanitizePluginText(this.item.text))
  }

  private renderText(width: number, text: string): string[] {
    const { streaming } = this.item
    const preview = this.preview()
    const key = `${width}:${streaming}:${this.expanded}:${this.keyed}:${preview}:${this.item.durationMs ?? ''}:${text}`
    if (this.cache?.key === key) return this.cache.lines

    const contentWidth = Math.max(1, width - THINKING_INDENT.length)
    const contentLines = this.wrapped?.text === text && this.wrapped.width === contentWidth
      ? this.wrapped.lines
      : text.length > 0 ? this.components.wrapText(text, contentWidth) : ['']
    this.wrapped = { text, width: contentWidth, lines: contentLines }
    const marker = this.colors.muted(THINKING_MARKER)
    let lines: string[]
    if (text.trim() === '') {
      // Blank reasoning, live or finalized, renders nothing.
      lines = []
    } else if (streaming) {
      // The live tail: the last non-blank wrapped lines, the first on the marker.
      const last = contentLines.findLastIndex(line => line.trim() !== '')
      const tail = contentLines.slice(Math.max(0, last + 1 - THINKING_PREVIEW_LINES), last + 1)
      lines = ['', ...tail.map((line, index) => (index === 0 ? marker : THINKING_INDENT) + this.styled(line))]
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
        const hint = ` · ${this.t('Ctrl+O to expand')}`
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
}
