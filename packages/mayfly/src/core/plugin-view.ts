/**
 * Safe renderer adapter for basic public, renderer-neutral content nodes.
 * Third-party text is stripped of terminal controls before Mayfly applies its
 * own theme and width helpers, so a contribution cannot write raw ANSI or
 * escape its assigned rows.
 *
 * The windowed painters for `text`, `fields`, `code`, `sections`, and `rich-text` live in `content-rows.ts`; this
 * module keeps the sanitizing primitives they share, the still-eager `diff` painter (segmented in slice 2c.5), and
 * the one-line summaries.
 *
 * @module @ephemeral-ai/mayfly/core/plugin-view
 */

import type { MayflyContentNode, MayflyInlineSpan, MayflyTextStyle, MayflyTone } from '@ephemeral-ai/mayfly-ui'
import { alignDiffLines, paintDiffRows } from './diff-align.ts'
import { clampRowsToWidth } from './chrome.ts'
import type { MayflyComponents, MayflySemanticColors } from './types.ts'

/** A code block highlights at most this many rows; the rest are plain text. */
export const CODE_HIGHLIGHT_MAX_ROWS = 12

/** A code block larger than this many UTF-8 bytes is plain text. */
export const CODE_HIGHLIGHT_MAX_BYTES = 32 * 1024

/** Maximum recursive `sections` nesting accepted from a dynamic view. */
export const PLUGIN_VIEW_MAX_DEPTH = 8

/** Interim bound on one diff side until slice 2c.5 segments diffs: past it the paint fails, contained. */
const PLUGIN_VIEW_MAX_DIFF_CHARS = 20_000

const ANSI_OR_OSC = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/gu
/** The focus sentinel is a private-use code point the surface owns; a contribution's text may not carry it. */
const UNSAFE_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f\uf8ff]/gu

/** Strip terminal escapes and non-layout controls from untrusted text. */
export function sanitizePluginText(text: string): string {
  return text.replace(ANSI_OR_OSC, '').replace(UNSAFE_CONTROLS, '')
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

function checkedDiffText(value: unknown, label: string): string {
  const text = requireText(value, label)
  if (text.length > PLUGIN_VIEW_MAX_DIFF_CHARS) throw new RangeError(`${label} exceeds ${String(PLUGIN_VIEW_MAX_DIFF_CHARS)} characters`)
  return sanitizePluginText(text)
}

export function strong(text: string): string { return `\x1b[1m${text}\x1b[22m` }
function italic(text: string): string { return `\x1b[3m${text}\x1b[23m` }
function strike(text: string): string { return `\x1b[9m${text}\x1b[29m` }

/** Wrap painted text in the weight, slant, and strike a node asks for. */
export function styledText(value: string, styles: readonly MayflyTextStyle[] | undefined): string {
  return (styles ?? []).reduce((text, style) => style === 'strong' ? strong(text) : style === 'italic' ? italic(text) : strike(text), value)
}

export function spanText(span: MayflyInlineSpan, colors: MayflySemanticColors): string {
  if (typeof span !== 'object' || span === null) throw new TypeError('field span must be an object')
  return styledText(paintPluginTone(colors, span.tone)(sanitizePluginText(requireText(span.text, 'span text'))), span.styles)
}

export type BasicContentNode = Extract<MayflyContentNode, { readonly kind: 'text' | 'fields' | 'code' | 'diff' | 'sections' }>

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

type DiffContentNode = Extract<BasicContentNode, { readonly kind: 'diff' }>

function renderDiff(
  view: DiffContentNode,
  width: number,
  components: MayflyComponents,
  colors: MayflySemanticColors,
): string[] {
  // The painter clips each line and pads each change band to the full
  // width, so it takes the components service's width truth.
  const before = checkedDiffText(view.before, 'diff before')
  const after = checkedDiffText(view.after, 'diff after')
  return paintDiffRows(alignDiffLines(before, after), width, components, colors, {
    ...view.start === undefined ? {} : { start: view.start },
    ...view.numbered === undefined ? {} : { numbered: view.numbered },
    ...view.hunkHeader === undefined ? {} : { hunkHeader: view.hunkHeader },
    ...view.context === undefined ? {} : { context: view.context },
    ...view.maxRows === undefined ? {} : { maxRows: view.maxRows },
  })
}

/** Core-internal renderer for an already validated canonical diff; segmented in slice 2c.5. */
export function renderCanonicalDiff(
  view: DiffContentNode,
  width: number,
  components: MayflyComponents,
  colors: MayflySemanticColors,
  maxRows?: number,
): string[] {
  const rendered = renderDiff(view, Math.max(1, width), components, colors)
  const rows = maxRows === undefined ? rendered : rendered.slice(0, Math.max(0, maxRows))
  return clampRowsToWidth(rows, Math.max(1, width), (text, target) => components.truncateToWidth(text, target))
}

/** Produce a safe one-line notification/status summary from any public view. */
export function summarizePluginView(view: BasicContentNode): string {
  if (typeof view !== 'object' || view === null) throw new TypeError('view must be an object')
  const text = (value: unknown, label: string): string => sanitizePluginText(requireText(value, label))
  switch (view.kind) {
    case 'text': return text(view.content, 'text content').replace(/\s+/gu, ' ').trim()
    case 'fields': return view.rows.map(row => `${text(row.label, 'field label')}: ${row.value.map(span => text(span.text, 'field span text')).join('')}`).join(' · ')
    case 'code': return text(view.code, 'code content').replace(/\s+/gu, ' ').trim()
    case 'diff': return 'diff contribution'
    case 'sections': return view.sections.map(section => section.title === undefined ? summarizePluginView(section.body) : text(section.title, 'section title')).join(' · ')
    default: throw new TypeError(`unknown basic content kind "${String((view as { kind?: unknown }).kind)}"`)
  }
}
