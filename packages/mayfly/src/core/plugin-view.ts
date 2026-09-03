/**
 * Safe renderer adapter for basic public, renderer-neutral content nodes.
 * Third-party text is stripped of terminal controls before Mayfly applies its
 * own theme and width helpers, so a contribution cannot write raw ANSI or
 * escape its assigned rows.
 *
 * @module @ephemeral-ai/mayfly/core/plugin-view
 */

import type { MayflyContentNode, MayflyInlineSpan, MayflyTone } from '@ephemeral-ai/mayfly-ui'
import { alignDiffLines, paintDiffRows } from './diff-align.ts'
import { clampRowsToWidth } from './chrome.ts'
import type { MayflyComponents, MayflySemanticColors } from './types.ts'

/** Maximum source characters accepted from one dynamic view render. */
export const PLUGIN_VIEW_MAX_CHARS = 20_000

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

function spanText(span: MayflyInlineSpan, colors: MayflySemanticColors): string {
  if (typeof span !== 'object' || span === null) throw new TypeError('field span must be an object')
  const painted = paintPluginTone(colors, span.tone)(checkedText(span.text, 'field span text'))
  return (span.styles ?? []).reduce((value, style) => style === 'strong' ? strong(value) : style === 'italic' ? italic(value) : strike(value), painted)
}

type BasicContentNode = Extract<MayflyContentNode, { readonly kind: 'text' | 'fields' | 'code' | 'diff' | 'sections' }>

function wrapped(text: string, width: number, components: MayflyComponents): string[] {
  return components.wrapText(text, Math.max(1, width))
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
      return wrapped(content, width, components).map(paintPluginTone(colors, view.tone))
    }
    case 'fields': {
      if (!Array.isArray(view.rows)) throw new TypeError('fields rows must be an array')
      return view.rows.flatMap((row) => {
        if (typeof row !== 'object' || row === null || !Array.isArray(row.value)) throw new TypeError('field row is invalid')
        const label = colors.muted(`${checkedText(row.label, 'field label')}: `)
        const value = (row.value as readonly MayflyInlineSpan[]).map(span => spanText(span, colors)).join('')
        return wrapped(label + value, width, components)
      })
    }
    case 'code': {
      const language = view.language === undefined ? '' : checkedText(view.language, 'code language')
      const heading = language.length === 0 ? [] : [colors.muted(language)]
      const body = checkedText(view.code, 'code content').split('\n')
        .flatMap(line => wrapped(colors.mdCodeBlock(line), width, components))
      return [...heading, ...body]
    }
    case 'diff': {
      // Same alignment and paint as the tool-card panel (diff-align); only
      // the wrapping primitive differs (the components service's width truth).
      const before = checkedText(view.before, 'diff before')
      const after = checkedText(view.after, 'diff after')
      return paintDiffRows(alignDiffLines(before, after), colors)
        .flatMap(row => wrapped(row, width, components))
    }
    case 'sections': {
      if (!Array.isArray(view.sections)) throw new TypeError('sections must be an array')
      return view.sections.flatMap((section) => {
        if (typeof section !== 'object' || section === null) throw new TypeError('section is invalid')
        const title = section.title === undefined ? [] : [strong(colors.primary(checkedText(section.title, 'section title')))]
        if (section.collapsed === true) return title.length === 0 ? [colors.muted('...')] : title
        return [...title, ...renderView(section.body, width, components, colors, depth + 1)]
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
  maxRows: number,
): string[] {
  const rows = renderView(view, Math.max(1, width), components, colors, 0).slice(0, Math.max(0, maxRows))
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
