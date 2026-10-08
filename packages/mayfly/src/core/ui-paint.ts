/**
 * Span and tone painters shared by the pattern painters: a tone is one semantic color, a span is a tone plus weight,
 * slant, and strike.
 *
 * @module @ephemeral-ai/mayfly/core/ui-paint
 */

import type { MayflyInlineSpan, MayflyTone } from '@ephemeral-ai/mayfly-ui'
import type { MayflySemanticColors } from './types.ts'
import { sanitizePluginText } from './plugin-view.ts'

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

export function paintSpan(span: MayflyInlineSpan, colors: MayflySemanticColors): string {
  const painted = paintTone(span.tone, sanitizePluginText(span.text), colors)
  return (span.styles ?? []).reduce((value, style) => {
    if (style === 'strong') return `\x1b[1m${value}\x1b[22m`
    if (style === 'italic') return `\x1b[3m${value}\x1b[23m`
    return `\x1b[9m${value}\x1b[29m`
  }, painted)
}
