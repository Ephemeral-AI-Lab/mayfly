/**
 * Private L2 pattern painters for the canonical Mayfly UI compiler. They own
 * semantic presentation and width degradation only; layout, focus routing,
 * validation, and events remain in ui-compiler.ts.
 *
 * @module @ephemeral-ai/mayfly/core/ui-patterns
 */

import type { MayflyFormField, MayflyInlineSpan, MayflyListSegment, MayflyTone, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type { MayflySemanticColors } from './types.ts'
import { ASCII_SPINNER_FRAMES, type MayflyGlyphMode } from './glyphs.ts'
import { hintNotation } from './ui-key-grammar.ts'
import { sanitizePluginText } from './plugin-view.ts'
import type { UiRowCache } from './ui-row-cache.ts'
import type { MayflyWorkCounters } from './ui-work-counters.ts'
import { sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from './width.ts'

type SurfaceNode = Extract<MayflyUiNode, { readonly kind: 'surface' }>
type SurfaceChromeNode = Pick<SurfaceNode, 'badges' | 'chrome' | 'subtitle' | 'title'>
type TabsNode = Extract<MayflyUiNode, { readonly kind: 'tabs' }>
type ListNode = Extract<MayflyUiNode, { readonly kind: 'list' }>
type ActionsNode = Extract<MayflyUiNode, { readonly kind: 'actions' }>
type LoaderNode = Extract<MayflyUiNode, { readonly kind: 'loader' }>
type EmptyNode = Extract<MayflyUiNode, { readonly kind: 'empty' }>
type ProgressNode = Extract<MayflyUiNode, { readonly kind: 'progress' }>

export interface PatternFocus {
  readonly key: string
  readonly focused: boolean
  readonly marker: string
  readonly optionId?: string
  /** True while the field's option picker is open; selects stay one row otherwise. */
  readonly editing?: boolean
}

const PARTIAL_BLOCKS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉', '█'] as const
const DEFAULT_PRIMARY_COLUMN_WIDTH = 32
const PRIMARY_COLUMN_GAP = 2
const MIN_DESCRIPTION_WIDTH = 10
const DESCRIPTION_MAX_LINES = 2
const ELLIPSIS = '…'
const ELLIPSIS_WIDTH = visibleWidth(ELLIPSIS)

// Plain autocomplete content sits inside theme paint. Remove the reset that
// pi-tui's truncator appends so it cannot cancel that enclosing paint.
// oxlint-disable-next-line no-control-regex -- ESC (\x1b) matches ANSI SGR resets
const TRAILING_ANSI_RESET = /(?:\x1b\[0m)+$/

/** Renderer paint and layout supplied by the thin pi-tui select adapter. */
export interface AutocompleteListPatternOptions {
  readonly selectedText: (text: string) => string
  readonly description: (text: string) => string
  readonly scrollInfo: (text: string) => string
  readonly noMatch: (text: string) => string
  readonly minPrimaryColumnWidth?: number
  readonly maxPrimaryColumnWidth?: number
  readonly truncatePrimary?: (context: {
    readonly id: string
    readonly text: string
    readonly maxWidth: number
    readonly columnWidth: number
    readonly isSelected: boolean
  }) => string
}

function safeWidth(width: number): number {
  return Math.max(1, Number.isFinite(width) ? Math.floor(width) : 1)
}

function fit(value: string, width: number): string {
  const available = safeWidth(width)
  return visibleWidth(value) <= available ? value : sliceByColumn(value, 0, available, true)
}

function truncatePlainToWidth(text: string, maxWidth: number): string {
  return truncateToWidth(text, maxWidth, '').replace(TRAILING_ANSI_RESET, '')
}

function wrapDescription(text: string, width: number): string[] {
  const wrapped = wrapTextWithAnsi(text, width)
  if (wrapped.length <= DESCRIPTION_MAX_LINES) return wrapped
  const kept = wrapped.slice(0, DESCRIPTION_MAX_LINES - 1)
  const rest = wrapped.slice(DESCRIPTION_MAX_LINES - 1).join(' ')
  const clipped = truncatePlainToWidth(rest, width - ELLIPSIS_WIDTH).trimEnd()
  return [...kept, `${clipped}${ELLIPSIS}`]
}

/** Render the editor's canonical list node with its compact description rows. */
export function renderAutocompleteList(
  node: ListNode,
  width: number,
  maxVisible: number,
  options: AutocompleteListPatternOptions,
): string[] {
  const available = safeWidth(width)
  if (node.items.length === 0) return [options.noMatch(fit('  No matching commands', available))]

  const selectedId = node.selectedIds[0]
  const selectedIndex = Math.max(0, node.items.findIndex(item => item.id === selectedId))
  const visibleCount = Math.max(1, Math.floor(maxVisible))
  const startIndex = Math.max(0, Math.min(selectedIndex - Math.floor(visibleCount / 2), node.items.length - visibleCount))
  const endIndex = Math.min(startIndex + visibleCount, node.items.length)
  const rawMin = options.minPrimaryColumnWidth ?? options.maxPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH
  const rawMax = options.maxPrimaryColumnWidth ?? options.minPrimaryColumnWidth ?? DEFAULT_PRIMARY_COLUMN_WIDTH
  const min = Math.max(1, Math.min(rawMin, rawMax))
  const max = Math.max(1, Math.max(rawMin, rawMax))
  const widest = node.items.reduce((current, item) => Math.max(current, visibleWidth(item.label) + PRIMARY_COLUMN_GAP), 0)
  const primaryColumnWidth = Math.max(min, Math.min(widest, max))
  const rows: string[] = []

  for (let index = startIndex; index < endIndex; index += 1) {
    const item = node.items[index]!
    const selected = item.id === selectedId
    const prefix = selected ? '→ ' : '  '
    const prefixWidth = visibleWidth(prefix)
    const detail = item.detail?.replaceAll(/[\r\n]+/g, ' ').trim()
    const primary = (maxWidth: number, columnWidth: number): string => {
      const transformed = options.truncatePrimary?.({
        id: item.id,
        text: item.label,
        maxWidth,
        columnWidth,
        isSelected: selected,
      }) ?? item.label
      return truncatePlainToWidth(transformed, maxWidth)
    }

    if (detail !== undefined && detail.length > 0 && available > 40) {
      const effectiveColumnWidth = Math.max(1, Math.min(primaryColumnWidth, available - prefixWidth - 4))
      const value = primary(Math.max(1, effectiveColumnWidth - PRIMARY_COLUMN_GAP), effectiveColumnWidth)
      const spacing = ' '.repeat(Math.max(1, effectiveColumnWidth - visibleWidth(value)))
      const detailStart = prefixWidth + visibleWidth(value) + spacing.length
      const remaining = available - detailStart - 2
      if (remaining > MIN_DESCRIPTION_WIDTH) {
        const detailRows = wrapDescription(detail, remaining)
        const indent = ' '.repeat(detailStart)
        rows.push(...detailRows.map((line, lineIndex) => selected
          ? options.selectedText(lineIndex === 0 ? `${prefix}${value}${spacing}${line}` : `${indent}${line}`)
          : lineIndex === 0 ? `${prefix}${value}${options.description(`${spacing}${line}`)}` : options.description(`${indent}${line}`)))
        continue
      }
    }

    const maxWidth = Math.max(1, available - prefixWidth - 2)
    const value = primary(maxWidth, maxWidth)
    rows.push(selected ? options.selectedText(`${prefix}${value}`) : `${prefix}${value}`)
  }

  if (startIndex > 0 || endIndex < node.items.length) {
    const indicator = `  (${String(selectedIndex + 1)}/${String(node.items.length)})`
    rows.push(options.scrollInfo(truncatePlainToWidth(indicator, Math.max(1, available - 2))))
  }
  // Only the fixed two-column pointer can out-wide a viewport mid-resize.
  // Normal rows remain untouched so theme paint composes outside this seam.
  return available < 3 ? rows.map(row => sliceByColumn(row, 0, available, true)) : rows
}

function interactivePrefix(focus: PatternFocus): string {
  return focus.focused ? `${focus.marker}→ ` : '   '
}

function paintTone(tone: MayflyTone | undefined, value: string, colors: MayflySemanticColors): string {
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

function paintSpan(span: MayflyInlineSpan, colors: MayflySemanticColors): string {
  const painted = paintTone(span.tone, sanitizePluginText(span.text), colors)
  return (span.styles ?? []).reduce((value, style) => {
    if (style === 'strong') return `\x1b[1m${value}\x1b[22m`
    if (style === 'italic') return `\x1b[3m${value}\x1b[23m`
    return `\x1b[9m${value}\x1b[29m`
  }, painted)
}

/** A row's detail after its label: `— detail` in muted, or the detail spans after a muted dash. */
function paintListDetail(item: ListNode['items'][number], colors: MayflySemanticColors): string {
  if (item.detailSpans !== undefined) return item.detailSpans.length === 0 ? '' : ` ${colors.muted('—')} ${item.detailSpans.map(span => paintSpan(span, colors)).join('')}`
  return item.detail === undefined ? '' : ` ${colors.muted(`— ${item.detail}`)}`
}

/** The choose mark of a multiple list row: `●` chosen, `○` not, `◐` for a parent with some of its children chosen. */
function choiceMark(node: ListNode, item: ListNode['items'][number], selected: boolean): string {
  const children = node.items.filter(child => child.parentId === item.id)
  if (children.length === 0) return selected ? '●' : '○'
  const chosen = children.filter(child => node.selectedIds.includes(child.id)).length
  return chosen === 0 ? (selected ? '●' : '○') : chosen === children.length ? '●' : '◐'
}

/** The border paint of a framed chrome: the focus color for an overlay, the quiet color for an inline surface (spec §2.1). */
export function surfaceBorderPaint(chrome: 'surface' | 'overlay', colors: MayflySemanticColors): (text: string) => string {
  return chrome === 'overlay' ? colors.borderFocus : colors.border
}

function strongTitle(title: string, colors: MayflySemanticColors): string {
  return `\x1b[1m${colors.textStrong(title)}\x1b[22m`
}

/**
 * The inset title rule of a framed surface, `╭ Title ─── badge ╮`: the title bold in text color, the badges at the
 * right of the rule, everything else in the border paint. A narrow width drops the badges first, then ellipsises the
 * title, then drops it; the corners and at least one dash always stay.
 */
function framedTopRule(title: string, badges: string, width: number, paint: (text: string) => string, colors: MayflySemanticColors): string {
  if (width < 2) return paint('╭')
  const inner = width - 2
  const titleWidth = title.length === 0 ? 0 : visibleWidth(title) + 2
  const badgeWidth = badges.length === 0 ? 0 : visibleWidth(badges) + 2
  const showBadges = badgeWidth > 0 && inner - titleWidth - badgeWidth >= 1
  const titleRoom = inner - (showBadges ? badgeWidth : 0) - 3
  const fitted = title.length === 0 || titleRoom < 2 ? '' : visibleWidth(title) <= titleRoom ? title : `${sliceByColumn(title, 0, titleRoom - ELLIPSIS_WIDTH, true)}${ELLIPSIS}`
  const titleSegment = fitted.length === 0 ? '' : `${paint(' ')}${strongTitle(fitted, colors)}${paint(' ')}`
  const badgeSegment = showBadges ? `${paint(' ')}${badges}${paint(' ')}` : ''
  const fill = inner - (fitted.length === 0 ? 0 : visibleWidth(fitted) + 2) - (showBadges ? badgeWidth : 0)
  return `${paint('╭')}${titleSegment}${paint('─'.repeat(Math.max(0, fill)))}${badgeSegment}${paint('╮')}`
}

/**
 * The rows a surface paints above its child. A framed chrome (`overlay`, `surface`) returns its top rule first and then
 * the rows that sit inside the frame (the muted subtitle); `lane` is a muted rule carrying the title (`── Title ───`);
 * `none` is the bold title alone.
 */
export function renderSurfaceHead(node: SurfaceChromeNode, width: number, colors: MayflySemanticColors): string[] {
  const available = safeWidth(width)
  const chrome = node.chrome ?? 'none'
  const title = node.title === undefined ? '' : sanitizePluginText(node.title).replace(/[\r\n]+/gu, ' ')
  const badges = node.badges === undefined ? '' : node.badges.map(span => paintSpan(span, colors)).join(' ')
  const rows: string[] = []
  if (chrome === 'none') {
    const heading = [title.length === 0 ? '' : strongTitle(title, colors), badges].filter(part => part.length > 0).join('  ')
    if (heading.length > 0) rows.push(fit(heading, available))
  } else if (chrome === 'lane') {
    const head = title.length === 0 ? '' : `── ${title} `
    const tail = badges.length === 0 ? '' : ` ${badges}`
    const fill = available - visibleWidth(head) - visibleWidth(tail)
    rows.push(fill >= 2 ? `${colors.muted(`${head}${'─'.repeat(fill)}`)}${tail}` : fit(colors.muted(`${head}${'─'.repeat(available)}`), available))
  } else {
    rows.push(framedTopRule(title, badges, available, surfaceBorderPaint(chrome, colors), colors))
  }
  if (node.subtitle !== undefined) rows.push(fit(colors.muted(sanitizePluginText(node.subtitle).replace(/[\r\n]+/gu, ' ')), available))
  return rows
}

/** The bottom rule of a framed surface; `lane` and `none` have none. */
export function renderSurfaceTail(node: SurfaceChromeNode, width: number, colors: MayflySemanticColors): string[] {
  const chrome = node.chrome ?? 'none'
  if (chrome === 'none' || chrome === 'lane') return []
  const available = safeWidth(width)
  return [surfaceBorderPaint(chrome, colors)(available < 2 ? '╰' : `╰${'─'.repeat(available - 2)}╯`)]
}

/** Gap between two tabs of a strip. */
const TAB_GAP = 3

/**
 * A tab strip: the active tab in `primary` (bold while the strip has focus) with a heavy `━` underline on the row below
 * it (`primary` while focused, muted otherwise), the other tabs muted, counts after their labels. A wizard marks its
 * steps `✓` completed, `●` current, `○` the rest, joined by a muted `›`. A strip wider than the width
 * folds to `‹ active next +N ›`. The focus marker rides at the end of the underline row.
 */
export function renderTabs(node: TabsNode, width: number, focus: PatternFocus, colors: MayflySemanticColors, completed: readonly string[] = []): string[] {
  const available = safeWidth(width)
  const focused = focus.focused && focus.key !== ''
  const strong = (text: string): string => `\x1b[1m${text}\x1b[22m`
  const activeIndex = Math.max(0, node.items.findIndex(item => item.id === node.activeId))
  const tokens = node.items.map((item, index) => {
    const active = index === activeIndex
    const count = item.count === undefined ? '' : ` ${String(item.count)}`
    if (node.mode === 'wizard') {
      const done = !active && completed.includes(item.id)
      const plain = `${done ? '✓' : active ? '●' : '○'} ${item.label}`
      const text = done ? `${colors.success('✓')} ${colors.text(item.label)}`
        : active ? `${colors.primary('●')} ${strong(colors.primary(item.label))}` : colors.muted(plain)
      return { plain, text }
    }
    const label = active ? colors.primary(item.label) : colors.muted(item.label)
    return { plain: `${item.label}${count}`, text: `${active && focused ? strong(label) : label}${count === '' ? '' : ` ${(active ? colors.primary : colors.muted)(String(item.count))}`}` }
  })
  const separator = node.mode === 'wizard' ? colors.muted('  ›  ') : ' '.repeat(TAB_GAP)
  const separatorWidth = node.mode === 'wizard' ? 5 : TAB_GAP
  const total = tokens.reduce((sum, token) => sum + visibleWidth(token.plain), 0) + separatorWidth * Math.max(0, tokens.length - 1)
  if (total > available) {
    const shown = [tokens[activeIndex]!, ...(tokens[activeIndex + 1] === undefined ? [] : [tokens[activeIndex + 1]!])]
    const rest = tokens.length - shown.length
    return [fit(`${colors.muted('‹ ')}${shown.map(token => token.text).join('  ')}${colors.muted(rest > 0 ? `  +${String(rest)} ›` : ' ›')}`, available)]
  }
  const offset = tokens.slice(0, activeIndex).reduce((sum, token) => sum + visibleWidth(token.plain) + separatorWidth, 0)
  const rule = '━'.repeat(visibleWidth(tokens[activeIndex]?.plain ?? ''))
  const underline = `${' '.repeat(offset)}${focused ? strong(colors.primary(rule)) : colors.muted(rule)}${focused ? focus.marker : ''}`
  return [tokens.map(token => token.text).join(separator), fit(underline, available)]
}

/** Where `renderList` keeps the item rows it has painted, and the sink that counts the ones it had to paint. */
export interface ListRowMemo {
  readonly cache: UiRowCache
  readonly counters?: MayflyWorkCounters | undefined
}

/** Render list rows; `numberFrom` is the visible position of the first row so numbers stay stable while the window scrolls. */
export function renderList(node: ListNode, width: number, height: number, focus: PatternFocus, colors: MayflySemanticColors, numberFrom = 0, memo?: ListRowMemo): string[] {
  const available = safeWidth(width)
  const rows: { readonly value: string, readonly itemId?: string }[] = []
  if (node.filter !== undefined) rows.push({ value: fit(colors.textMuted(`/ ${node.filter}`), available) })
  let group: string | undefined
  const numbered = node.numbered !== undefined && node.numbered !== false
  for (const [ordinal, item] of node.items.entries()) {
    if (item.group !== undefined && item.group !== group) {
      group = item.group
      rows.push({ value: fit(colors.muted(item.group), available) })
    }
    const selected = node.selectedIds.includes(item.id)
    const cursor = focus.key === item.id && item.disabled !== true
    // The cursor `→` shows only while its list has focus; the space after it carries the focus marker.
    const enabledFocus = cursor && focus.focused
    const marker = enabledFocus ? focus.marker : ' '
    const position = numberFrom + ordinal
    const number = numbered && position < 9 ? String(position + 1) : ''
    const check = node.mode === 'multiple' ? choiceMark(node, item, selected) : ''
    const paintRow = (): string => {
      const detail = available > 40 ? paintListDetail(item.disabled === true && item.detail === undefined && item.detailSpans === undefined && item.disabledReason !== undefined ? { ...item, detail: item.disabledReason } : item, colors) : ''
      const badge = item.badge === undefined ? '' : ` ${colors.muted(`[${item.badge}]`)}`
      const numberCell = number === '' ? '' : `${colors.muted(number)}  `
      const checkCell = check === '' ? '' : `${check === '○' ? colors.muted(check) : colors.primary(check)} `
      if (item.disabled === true) return fit(`  ${numberCell}${check === '' ? '' : `${colors.muted(check)} `}${colors.muted(item.label)}${badge}${detail}`, available)
      const pointer = enabledFocus ? `\x1b[1m${colors.primary('→')}\x1b[22m` : ' '
      const label = cursor ? `\x1b[1m${colors.text(item.label)}\x1b[22m` : colors.text(item.label)
      return fit(`${pointer}${marker}${numberCell}${checkCell}${label}${badge}${detail}`, available)
    }
    const value = memo === undefined
      ? paintRow()
      : memo.cache.read(colors, item, `${String(available)}\0${marker}\0${check}\0${number}\0${selected ? 1 : 0}${cursor ? 1 : 0}${enabledFocus ? 1 : 0}`, paintRow, memo.counters)
    rows.push({ value, itemId: item.id })
  }
  const limit = Math.max(1, Number.isFinite(height) ? Math.floor(height) : 1)
  if (rows.length <= limit) return rows.map(row => row.value)
  const focusRow = rows.findIndex(row => row.itemId === focus.key)
  const start = focusRow < 0 ? 0 : Math.min(Math.max(0, focusRow - Math.floor(limit / 2)), rows.length - limit)
  return rows.slice(start, start + limit).map(row => row.value)
}

/** The focused row's horizontal option strip; the selected option stays visible when the rest truncate. */
export function renderListSegment(segment: MayflyListSegment, selectedId: string | undefined, width: number, colors: MayflySemanticColors): string {
  const available = safeWidth(width)
  const tokens = segment.options.map(option => {
    const active = option.id === selectedId
    const text = active ? `‹ ${option.label} ›` : option.label
    return { id: option.id, value: option.disabled === true ? colors.muted(text) : active ? colors.primary(text) : colors.textMuted(text) }
  })
  /** Options ahead of the active one keep their slots while they fit; the rest collapse into +N. */
  const narrow = (prefix: string): { readonly body: string, readonly hidden: number } => {
    const activeIndex = tokens.findIndex(token => token.id === selectedId)
    const active = activeIndex < 0 ? undefined : tokens[activeIndex]!.value
    const activeWidth = active === undefined ? 0 : visibleWidth(active)
    const kept: string[] = []
    let used = visibleWidth(prefix)
    for (const token of tokens.slice(0, activeIndex < 0 ? tokens.length : activeIndex)) {
      const next = used + (kept.length === 0 ? 0 : 2) + visibleWidth(token.value)
      if (next + (activeWidth === 0 ? 0 : 2 + activeWidth) > available) break
      kept.push(token.value)
      used = next
    }
    return {
      body: `${prefix}${[...kept, ...(active === undefined ? [] : [active])].join('  ')}`,
      hidden: tokens.length - kept.length - (active === undefined ? 0 : 1),
    }
  }
  const prefixes = [
    `   ${segment.label === undefined ? '' : `${colors.textStrong(`${segment.label}:`)} `}`,
    '   ',
    '',
  ]
  const complete = `${prefixes[0]!}${tokens.map(token => token.value).join('  ')}`
  if (visibleWidth(complete) <= available) return complete
  const narrowed = prefixes.map(narrow)
  // Keep the omitted-option count when a shorter prefix makes room for it.
  for (const { body, hidden } of narrowed) {
    const withHidden = `${body}${hidden > 0 ? `  +${String(hidden)}` : ''}`
    if (visibleWidth(withHidden) <= available) return withHidden
  }
  // Then keep the active option itself, dropping the count when it cannot fit.
  for (const { body } of narrowed) if (visibleWidth(body) <= available) return body
  return fit(narrowed.at(-1)!.body, available)
}

export function renderFormField(field: MayflyFormField, width: number, focus: PatternFocus, colors: MayflySemanticColors, text: (key: string) => string = key => key): string[] {
  const available = safeWidth(width)
  const focused = focus.focused && focus.key === field.id && field.disabled !== true
  const expandable = field.kind === 'select' || field.kind === 'multiselect'
  const expanded = expandable && field.disabled !== true && field.options.length > 0 && focus.editing === true
  let value: string
  let placeholder = false
  if (field.kind === 'toggle') value = field.value ? '[on]' : '[off]'
  else if (field.kind === 'select') value = field.value === null ? text('Choose…') : field.options.find(option => option.id === field.value)?.label ?? field.value
  else if (field.kind === 'multiselect') value = field.options.filter(option => field.value.includes(option.id)).map(option => option.label).join(', ') || text('None selected')
  else if (field.kind === 'number') value = `${field.value ?? ''}${field.unit === undefined ? '' : ` ${field.unit}`}`
  else if (field.kind === 'secret') value = field.value.length === 0 ? field.placeholder ?? '' : '•'.repeat(field.value.length)
  else value = field.value.length === 0 ? field.placeholder ?? '' : field.value
  if (field.kind === 'input' || field.kind === 'textarea' || field.kind === 'secret') placeholder = field.value.length === 0 && field.placeholder !== undefined
  const prefix = interactivePrefix({ key: field.id, focused, marker: focus.marker })
  // Expanded selects show the label as a group header; the option rows carry the value.
  // A focused single select wraps its value in ‹ › while ←→ can cycle it.
  const cycles = focused && field.kind === 'select' && field.options.filter(option => option.disabled !== true).length > (field.value === null ? 0 : 1)
  const body = expanded ? field.label : `${field.label}: ${cycles ? `‹ ${value} ›` : value}`
  const row = field.disabled === true
    ? colors.muted(`${prefix}${body}`)
    : focused ? colors.primary(`${prefix}${body}`)
      : expanded ? `${prefix}${colors.textStrong(field.label)}`
        : `${prefix}${colors.textStrong(`${field.label}:`)} ${placeholder ? colors.textMuted(value) : colors.text(value)}`
  const rows = [fit(row, available)]
  if (expanded) {
    for (const option of field.options) {
      const selected = field.kind === 'select' ? field.value === option.id : field.value.includes(option.id)
      const active = focused && (focus.optionId ?? (field.kind === 'select' ? field.value : field.value[0]) ?? field.options[0]?.id) === option.id
      const text = `${active ? ' →' : '  '} ${selected ? '●' : '○'} ${option.label}${option.disabledReason === undefined ? '' : ` — ${option.disabledReason}`}`
      rows.push(fit(option.disabled === true ? colors.muted(text) : active ? colors.primary(text) : colors.text(text), available))
    }
  }
  if (field.error !== undefined) rows.push(fit(colors.error(`   ! ${field.error}`), available))
  return rows
}

/** One action as the kit's `actionTokens` writes it: `[ Label ]` primary, `! Label` danger, a declared key as `(c)`. */
function actionToken(item: ActionsNode['items'][number], focus: PatternFocus, colors: MayflySemanticColors): { readonly plain: string, readonly value: string, readonly focused: boolean } {
  const busy = item.busy === true
  const disabled = item.disabled === true
  const focused = focus.focused && focus.key === item.id && !disabled
  const reason = disabled && item.disabledReason !== undefined ? ` — ${item.disabledReason}` : ''
  const label = `${item.label}${item.key === undefined || busy || disabled ? '' : ` (${hintNotation([item.key])})`}`
  const plain = busy ? `… ${label}` : disabled ? `${label}${reason}` : item.intent === 'primary' ? `[ ${label} ]` : item.intent === 'danger' ? `! ${label}` : label
  // The focused token is inverted with a space either side; the cursor marker takes the column before it.
  if (focused) return { plain, value: `\x1b[7m ${plain} \x1b[27m`, focused }
  const paint = disabled || busy ? colors.muted : item.intent === 'danger' ? colors.error : item.intent === 'primary' ? colors.primary : colors.text
  return { plain, value: paint(plain), focused }
}

/** The columns before a token: the row's indent or the gap, whose last column the cursor marker takes on the focused one. */
function tokenLead(lead: string, focused: boolean, focus: PatternFocus): string {
  return focused ? `${lead.slice(0, -1)}${focus.marker}` : lead
}

/**
 * The actions row (spec 4.2): tokens joined by three spaces after a one-column indent. A row that does not fit keeps
 * the tokens that do, at least one, and ends with a muted `+N` for the rest.
 */
export function renderActions(node: ActionsNode, width: number, focus: PatternFocus, colors: MayflySemanticColors, vertical: boolean): string[] {
  const tokens = node.items.map(item => actionToken(item, focus, colors))
  if (tokens.length === 0) return []
  if (vertical) return tokens.map(token => fit(`${tokenLead(' ', token.focused, focus)}${token.value}`, width))
  const widths = tokens.map(token => visibleWidth(token.plain))
  let shown = tokens.length
  if (widths.reduce((sum, each) => sum + each, 0) + 3 * (tokens.length - 1) > width - 4) {
    let used = 0
    shown = 0
    for (const each of widths) {
      if (used + each + 3 > width - 6) break
      used += each + 3
      shown++
    }
    shown = Math.max(1, shown)
  }
  const folded = shown < tokens.length ? `   ${colors.muted(`+${String(tokens.length - shown)}`)}` : ''
  return [fit(`${tokens.slice(0, shown).map((token, index) => `${tokenLead(index === 0 ? ' ' : '   ', token.focused, focus)}${token.value}`).join('')}${folded}`, width)]
}

/** One fragment of the hint row: the keys, and the word for what they do. */
export interface HintPart {
  readonly keys: string
  readonly label?: string
}

/**
 * The hint row (spec §3.2): indented two columns, each fragment `Keys label` with the key in text color and its label
 * muted, joined by a muted ` · `, so the eye lands on the key.
 */
export function renderHintRow(parts: readonly HintPart[], colors: MayflySemanticColors): string {
  const fragments = parts.map(part => `${colors.text(part.keys)}${part.label === undefined ? '' : ` ${colors.textMuted(part.label)}`}`)
  return `${colors.textMuted('  ')}${fragments.join(colors.textMuted(' · '))}`
}

/**
 * The muted row a bottom lane paints in place of the `hidden` rows it cut.
 * @param hidden - number of rows the lane could not show.
 * @param translate - translator for the owning surface.
 * @returns the localized overflow row.
 */
export function renderOverflowRow(hidden: number, translate: MayflyTranslate): string {
  // The full English string is the catalog key, so it stays a literal for
  // `locale-catalog.spec.ts`'s dead-key scan instead of a template.
  return translate('  … +{count} more rows', { count: hidden })
}

/** Compact non-negative duration from milliseconds: `45s`, or `2m 10s` past a minute. */
function formatElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
}

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
const TIDE_FRAMES = ['≈', '≋', '∿', '≋'] as const

export function renderLoader(node: LoaderNode, width: number, colors: MayflySemanticColors, frame = 0, glyphs: MayflyGlyphMode = 'unicode'): string[] {
  const frames = glyphs === 'ascii' ? ASCII_SPINNER_FRAMES : node.variant === 'tide' ? TIDE_FRAMES : BRAILLE_FRAMES
  const indicator = frames[frame % frames.length]!
  const elapsed = node.elapsedMs === undefined ? '' : ` ${formatElapsedMs(node.elapsedMs)}`
  return [fit(`${colors.primary(indicator)} ${colors.text(node.message)}${colors.textMuted(elapsed)}`, width)]
}

export function renderEmpty(node: EmptyNode, width: number, colors: MayflySemanticColors): string[] {
  const available = safeWidth(width)
  const rows = wrapTextWithAnsi(colors.textStrong(node.title), available)
  if (node.description !== undefined) rows.push(...wrapTextWithAnsi(colors.muted(node.description), available))
  return rows
}

export function renderProgress(node: ProgressNode, width: number, colors: MayflySemanticColors): string[] {
  const available = safeWidth(width)
  const counter = `${String(node.value)}/${String(node.max)}`
  const counterWidth = visibleWidth(counter)
  const showCounter = available >= counterWidth + 2
  const label = node.label === undefined ? '' : `${node.label} `
  const showLabel = label.length > 0 && available >= visibleWidth(label) + counterWidth + 4
  const furniture = (showLabel ? visibleWidth(label) : 0) + (showCounter ? counterWidth + 1 : 0)
  const cells = Math.max(1, available - furniture)
  const eighths = Math.round((node.value / node.max) * cells * 8)
  const bar = Array.from({ length: cells }, (_, index) => {
    const remaining = eighths - index * 8
    return remaining >= 8 ? '█' : remaining <= 0 ? '░' : PARTIAL_BLOCKS[remaining]!
  }).join('')
  return [fit(`${showLabel ? colors.text(label) : ''}${colors.primary(bar)}${showCounter ? ` ${colors.textMuted(counter)}` : ''}`, available)]
}

export function renderDivider(label: string | undefined, width: number, colors: MayflySemanticColors): string[] {
  const available = safeWidth(width)
  const heading = label === undefined ? '' : ` ${label} `
  return [fit(colors.border(`${heading}${'─'.repeat(Math.max(0, available - visibleWidth(heading)))}`), available)]
}
