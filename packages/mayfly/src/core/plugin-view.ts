/**
 * Safe renderer adapter for basic public, renderer-neutral content nodes.
 * Third-party text is stripped of terminal controls before Mayfly applies its
 * own theme and width helpers, so a contribution cannot write raw ANSI or
 * escape its assigned rows.
 *
 * The windowed painters for `text`, `fields`, `code`, `sections`, `rich-text`, and `diff` live in `content-rows.ts`;
 * this module keeps the sanitizing primitives they share.
 *
 * @module @ephemeral-ai/mayfly/core/plugin-view
 */

import type { MayflyTextStyle, MayflyTone } from '@ephemeral-ai/mayfly-ui'
import { stripTerminalText } from './terminal/escape-sequences.ts'
import type { MayflyComponents, MayflySemanticColors } from './types.ts'

/** A code block highlights at most this many rows; the rest are plain text. */
export const CODE_HIGHLIGHT_MAX_ROWS = 40

/** A code block larger than this many UTF-8 bytes is plain text. */
export const CODE_HIGHLIGHT_MAX_BYTES = 32 * 1024

/** Maximum recursive `sections` nesting accepted from a dynamic view. */
export const PLUGIN_VIEW_MAX_DEPTH = 8

/** Strip terminal escapes and non-layout controls from untrusted text. */
export function sanitizePluginText(text: string): string {
  return stripTerminalText(text)
}

/** Resolve one semantic public tone into Mayfly's current palette. */
export function paintPluginTone(colors: MayflySemanticColors, tone: MayflyTone | undefined): (text: string) => string {
  switch (tone) {
    case 'muted': return colors.muted
    case 'primary': return colors.primary
    case 'accent': return colors.accent
    case 'user': return colors.roleUser
    case 'success': return colors.success
    case 'warning': return colors.warning
    case 'danger': return colors.error
    default: return colors.text
  }
}

/**
 * A text field admitted as content has no paint-time cap: the painter checks the shape and returns the raw text;
 * sanitizing happens per painted segment so the check costs nothing until a window needs the row.
 */
export function requireText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  return value
}

export function strong(text: string): string { return `\x1b[1m${text}\x1b[22m` }
function italic(text: string): string { return `\x1b[3m${text}\x1b[23m` }
function strike(text: string): string { return `\x1b[9m${text}\x1b[29m` }
function inverse(text: string): string { return `\x1b[7m${text}\x1b[27m` }

/** Wrap painted text in the weight, slant, and strike a node asks for. */
export function styledText(value: string, styles: readonly MayflyTextStyle[] | undefined): string {
  return (styles ?? []).reduce((text, style) => style === 'strong' ? strong(text) : style === 'italic' ? italic(text) : style === 'inverse' ? inverse(text) : strike(text), value)
}

/**
 * One ellipsized row for `overflow: 'truncate'`: line breaks and tabs fold
 * to spaces so the text can never take a second row.
 * @param text - the (possibly painted) text.
 * @param width - the row width.
 * @param components - the width helpers.
 * @returns exactly one row.
 */
export function truncatedRow(text: string, width: number, components: MayflyComponents): string {
  return components.truncateToWidth(text.replace(/[\r\n\t]+/gu, ' '), Math.max(1, width), '…')
}
