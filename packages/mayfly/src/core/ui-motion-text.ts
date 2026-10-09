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

/** Whether any span of a rich-text node moves. */
export function hasMotion(spans: readonly MayflyInlineSpan[]): boolean {
  return spans.some(span => span.motion !== undefined)
}

/** How the motion spans of a row are painted. */
export interface MotionSpanOptions {
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
