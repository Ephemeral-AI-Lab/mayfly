/**
 * Shared semantic paint primitives for core renderers: the single tone →
 * palette mapping plus the inline strong/italic/strike SGR wrappers every
 * tone-painted span passes through.
 *
 * @module @ephemeral-ai/mayfly/core/paint
 */

import type { MayflyInlineSpan, MayflyTone } from '@ephemeral-ai/mayfly-ui'
import type { MayflySemanticColors } from './types.ts'

/** Resolve one semantic tone into the active palette, applied to a value. */
export function paintTone(tone: MayflyTone | undefined, value: string, colors: MayflySemanticColors): string {
  switch (tone) {
    case 'muted': return colors.muted(value)
    case 'primary': return colors.primary(value)
    case 'accent': return colors.accent(value)
    case 'user': return colors.roleUser(value)
    case 'success': return colors.success(value)
    case 'warning': return colors.warning(value)
    case 'danger': return colors.error(value)
    default: return colors.text(value)
  }
}

/** Wrap text in the strong (bold) SGR pair. */
export function strong(text: string): string { return `\x1b[1m${text}\x1b[22m` }

/** Wrap text in the italic SGR pair. */
export function italic(text: string): string { return `\x1b[3m${text}\x1b[23m` }

/** Wrap text in the strikethrough SGR pair. */
export function strike(text: string): string { return `\x1b[9m${text}\x1b[29m` }

/** Paint one inline span: tone first, then each text style wrapped around it. */
export function paintSpan(span: MayflyInlineSpan, colors: MayflySemanticColors): string {
  const painted = paintTone(span.tone, span.text, colors)
  return (span.styles ?? []).reduce((value, style) => {
    if (style === 'strong') return strong(value)
    if (style === 'italic') return italic(value)
    return strike(value)
  }, painted)
}
