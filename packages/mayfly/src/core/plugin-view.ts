/**
 * Safe renderer adapter for basic public, renderer-neutral content nodes.
 * Third-party text is stripped of terminal controls before Mayfly applies its
 * own theme and width helpers, so a contribution cannot write raw ANSI or
 * escape its assigned rows.
 *
 * @module @ephemeral-ai/mayfly/core/plugin-view
 */

import type { MayflyContentNode, MayflyInlineSpan, MayflyTextStyle, MayflyTone } from '@ephemeral-ai/mayfly-ui'
import { alignDiffLines, paintDiffRows } from './diff-align.ts'
import { clampRowsToWidth } from './chrome.ts'
import { highlightable, highlightCodeLines } from './highlight.ts'
import type { MayflyComponents, MayflySemanticColors } from './types.ts'
import { truncateMiddle } from './width.ts'

/** Maximum source characters accepted from one dynamic view render. */
export const PLUGIN_VIEW_MAX_CHARS = 20_000

/** A code block highlights at most this many rows; the rest are plain text. */
export const CODE_HIGHLIGHT_MAX_ROWS = 12

/** A code block larger than this many UTF-8 bytes is plain text. */
export const CODE_HIGHLIGHT_MAX_BYTES = 32 * 1024

/** Maximum recursive `sections` nesting accepted from a dynamic view. */
export const PLUGIN_VIEW_MAX_DEPTH = 8

const ANSI_OR_OSC = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/gu
const UNSAFE_CONTROLS = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/gu

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

function checkedText(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`)
  if (value.length > PLUGIN_VIEW_MAX_CHARS) throw new RangeError(`${label} exceeds ${String(PLUGIN_VIEW_MAX_CHARS)} characters`)
  return sanitizePluginText(value)
}

function strong(text: string): string { return `\x1b[1m${text}\x1b[22m` }
function italic(text: string): string { return `\x1b[3m${text}\x1b[23m` }
function strike(text: string): string { return `\x1b[9m${text}\x1b[29m` }

/** Wrap painted text in the weight, slant, and strike a node asks for. */
export function styledText(value: string, styles: readonly MayflyTextStyle[] | undefined): string {
  return (styles ?? []).reduce((text, style) => style === 'strong' ? strong(text) : style === 'italic' ? italic(text) : strike(text), value)
}

function spanText(span: MayflyInlineSpan, colors: MayflySemanticColors): string {
  if (typeof span !== 'object' || span === null) throw new TypeError('field span must be an object')
  return styledText(paintPluginTone(colors, span.tone)(checkedText(span.text, 'field span text')), span.styles)
}

type BasicContentNode = Extract<MayflyContentNode, { readonly kind: 'text' | 'fields' | 'code' | 'diff' | 'sections' }>

function wrapped(text: string, width: number, components: MayflyComponents): string[] {
  return components.wrapText(text, Math.max(1, width))
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

function renderView(
  view: BasicContentNode,
  width: number,
  components: MayflyComponents,
  colors: MayflySemanticColors,
  depth: number,
): string[] {
  if (depth > PLUGIN_VIEW_MAX_DEPTH) throw new RangeError(`view nesting exceeds ${String(PLUGIN_VIEW_MAX_DEPTH)}`)
  if (typeof view !== 'object' || view === null || typeof view.kind !== 'string') throw new TypeError('view must be an object with a kind')
  switch (view.kind) {
    case 'text': {
      const content = checkedText(view.content, 'text content')
      const rows = view.overflow === 'truncate' ? [truncatedRow(content, width, components)]
        : view.overflow === 'middle' || view.overflow === 'start' ? [truncateMiddle(content.replace(/[\r\n\t]+/gu, ' '), width, view.overflow)]
          : wrapped(content, width, components)
      const tone = paintPluginTone(colors, view.tone)
      return rows.map(row => styledText(tone(row), view.styles))
    }
    case 'fields': {
      if (!Array.isArray(view.rows)) throw new TypeError('fields rows must be an array')
      // The labels share one column: each is padded to the longest label and its colon, then one space, as the kit draws.
      const names = view.rows.map(row => {
        if (typeof row !== 'object' || row === null || !Array.isArray(row.value)) throw new TypeError('field row is invalid')
        return checkedText(row.label, 'field label')
      })
      const labels = names.map(name => name === '' ? '' : `${name}:`)
      const column = Math.max(0, ...names.map(name => components.visibleWidth(name))) + 1
      return view.rows.flatMap((row, index) => {
        const label = colors.muted(labels[index]! + ' '.repeat(Math.max(0, column - components.visibleWidth(labels[index]!))))
        const value = (row.value as readonly MayflyInlineSpan[]).map(span => spanText(span, colors)).join('')
        return wrapped(`${label} ${value}`, width, components)
      })
    }
    case 'code': {
      const language = view.language === undefined ? '' : checkedText(view.language, 'code language')
      const heading = language.length === 0 ? [] : [colors.muted(language)]
      const source = checkedText(view.code, 'code content')
      const lines = source.split('\n')
      // Highlighting is on by default and capped (roadmap §2.2 row 14): the first rows of a block up to 32 KB.
      const highlighted = Buffer.byteLength(source, 'utf8') > CODE_HIGHLIGHT_MAX_BYTES || !highlightable(language) ? [] : highlightCodeLines(lines.slice(0, CODE_HIGHLIGHT_MAX_ROWS).join('\n'), language, { base: colors.text, keyword: colors.primary, string: colors.success, comment: colors.muted })
      // A numbered block draws a muted `n │ ` gutter; a wrapped line's continuation rows are indented under its code.
      const digits = view.numbered === true ? String(lines.length).length : 0
      const gutterWidth = digits === 0 ? 0 : digits + 3
      const body = lines.flatMap((line, index) => {
        const rows = wrapped(highlighted[index] ?? colors.text(line), width - gutterWidth, components)
        return gutterWidth === 0 ? rows : rows.map((row, offset) => `${colors.muted(offset === 0 ? `${String(index + 1).padStart(digits)} │ ` : ' '.repeat(gutterWidth))}${row}`)
      })
      return [...heading, ...body]
    }
    case 'diff': {
      // The painter clips each line and pads each change band to the full
      // width, so it takes the components service's width truth.
      const before = checkedText(view.before, 'diff before')
      const after = checkedText(view.after, 'diff after')
      return paintDiffRows(alignDiffLines(before, after), width, components, colors, {
        ...view.start === undefined ? {} : { start: view.start },
        ...view.numbered === undefined ? {} : { numbered: view.numbered },
        ...view.hunkHeader === undefined ? {} : { hunkHeader: view.hunkHeader },
        ...view.context === undefined ? {} : { context: view.context },
        ...view.maxRows === undefined ? {} : { maxRows: view.maxRows },
      })
    }
    case 'sections': {
      if (!Array.isArray(view.sections)) throw new TypeError('sections must be an array')
      return view.sections.flatMap((section) => {
        if (typeof section !== 'object' || section === null) throw new TypeError('section is invalid')
        const title = section.title === undefined ? [] : [strong(colors.primary(checkedText(section.title, 'section title')))]
        if (section.collapsed === true) return title.length === 0 ? [colors.muted('...')] : [...title, colors.muted('  …')]
        // A titled body sits two columns in under its heading.
        return title.length === 0 ? renderView(section.body, width, components, colors, depth + 1)
          : [...title, ...renderView(section.body, Math.max(1, width - 2), components, colors, depth + 1).map(row => `  ${row}`)]
      })
    }
    default: throw new TypeError(`unknown basic content kind "${String((view as { kind?: unknown }).kind)}"`)
  }
}

/** Core-internal renderer for an already validated canonical view. */
export function renderCanonicalView(
  view: BasicContentNode,
  width: number,
  components: MayflyComponents,
  colors: MayflySemanticColors,
  maxRows?: number,
): string[] {
  const rendered = renderView(view, Math.max(1, width), components, colors, 0)
  const rows = maxRows === undefined ? rendered : rendered.slice(0, Math.max(0, maxRows))
  return clampRowsToWidth(rows, Math.max(1, width), (text, target) => components.truncateToWidth(text, target))
}

/** Produce a safe one-line notification/status summary from any public view. */
export function summarizePluginView(view: BasicContentNode): string {
  if (typeof view !== 'object' || view === null) throw new TypeError('view must be an object')
  switch (view.kind) {
    case 'text': return checkedText(view.content, 'text content').replace(/\s+/gu, ' ').trim()
    case 'fields': return view.rows.map(row => `${checkedText(row.label, 'field label')}: ${row.value.map(span => checkedText(span.text, 'field span text')).join('')}`).join(' · ')
    case 'code': return checkedText(view.code, 'code content').replace(/\s+/gu, ' ').trim()
    case 'diff': return 'diff contribution'
    case 'sections': return view.sections.map(section => section.title === undefined ? summarizePluginView(section.body) : checkedText(section.title, 'section title')).join(' · ')
    default: throw new TypeError(`unknown basic content kind "${String((view as { kind?: unknown }).kind)}"`)
  }
}
