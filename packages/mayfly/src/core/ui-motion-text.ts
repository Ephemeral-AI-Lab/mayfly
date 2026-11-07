/**
 * Rich-text rows that carry a motion channel: a span that shimmers its letters or is one animated loader cell. A row
 * has at most one channel (the validator enforces it), so an animated rich-text node is the one row a clock tick repaints.
 *
 * @module @ephemeral-ai/mayfly/core/ui-motion-text
 */

import type { MayflyInlineSpan } from '@ephemeral-ai/mayfly-ui'
import type { MayflyGlyphMode } from './glyphs.ts'
import { sanitizePluginText } from './plugin-view.ts'
import type { MayflySemanticColors } from './types.ts'
import { loaderCell, shimmerText } from './ui-loader-animation.ts'
import { paintSpan } from './ui-paint.ts'
import { OVERFLOW_ELLIPSIS, sliceByColumn, visibleWidth } from './width.ts'

/** Whether any span of a rich-text node moves. */
export function hasMotion(spans: readonly MayflyInlineSpan[]): boolean {
  return spans.some(span => span.motion !== undefined)
}

/** The fewest cells an elastic span keeps on a narrow row: any less says nothing. */
const ELASTIC_MIN_CELLS = 3

/**
 * The spans of a one-row line, fitted to its row: one wider than the row takes from its elastic spans first, so what follows
 * them is not clipped. The widest shortens behind an ellipsis, and once it would keep too little they all go.
 * @param spans - the line's spans.
 * @param width - the cells the row gives them.
 * @returns the spans to paint, the same array when nothing has to give.
 */
export function fitSpans(spans: readonly MayflyInlineSpan[], width: number): readonly MayflyInlineSpan[] {
  const elastic = spans.filter(span => span.elastic === true)
  if (elastic.length === 0) return spans
  // A loader cell has no text and paints one cell.
  const over = spans.reduce((sum, span) => sum + (span.motion === 'loader' ? 1 : visibleWidth(span.text)), 0) - width
  if (over <= 0) return spans
  const widest = elastic.reduce((most, span) => visibleWidth(span.text) > visibleWidth(most.text) ? span : most)
  const room = visibleWidth(widest.text) - over - 1
  if (room < ELASTIC_MIN_CELLS) return spans.filter(span => span.elastic !== true)
  return spans.map(span => span === widest ? { ...span, text: `${sliceByColumn(span.text, 0, room)}${OVERFLOW_ELLIPSIS}` } : span)
}

/** How the motion spans of a row are painted. */
interface MotionSpanOptions {
  readonly glyphs?: MayflyGlyphMode | undefined
  readonly reducedMotion?: boolean | undefined
}

/**
 * One painted line: ordinary spans as the rich-text painter writes them, a `shimmer` span as its sweeping window over
 * muted letters, and a `loader` span as its cell at the clock `frame`.
 */
export function paintMotionSpans(spans: readonly MayflyInlineSpan[], colors: MayflySemanticColors, frame: number, options: MotionSpanOptions = {}): string {
  return spans.map(span => {
    if (span.motion === 'shimmer') return shimmerText(sanitizePluginText(span.text), frame, colors, options.reducedMotion === true)
    if (span.motion === 'loader') return loaderCell(span.variant ?? 'gap', frame, { colors, glyphs: options.glyphs, reducedMotion: options.reducedMotion })
    return paintSpan(span, colors)
  }).join('')
}
