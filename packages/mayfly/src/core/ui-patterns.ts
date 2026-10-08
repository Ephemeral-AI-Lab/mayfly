/**
 * Private L2 pattern painters for the canonical Mayfly UI compiler. They own
 * semantic presentation and width degradation only; layout, focus routing,
 * validation, and events remain in ui-compiler.ts.
 *
 * @module @ephemeral-ai/mayfly/core/ui-patterns
 */

import type { MayflyFormField, MayflyListSegment, MayflyTone, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflyTranslate } from '../frontend/locale.ts'
import type { MayflySemanticColors } from './types.ts'
import type { MayflyGlyphMode } from './glyphs.ts'
import { loaderCell, loaderVariant } from './ui-loader-animation.ts'
import { hintNotation } from './ui-key-grammar.ts'
import { sanitizePluginText } from './plugin-view.ts'
import { paintSpan, paintTone } from './ui-paint.ts'
import { paintFormField, type FieldDecor } from './ui-form-paint.ts'
import { segmentFooter } from './ui-list-segment.ts'
import { paintList, type ListPaintOptions, type ListRowMemo, type ListRowSpec } from './ui-list-paint.ts'
import { sliceByColumn, truncateMiddle, truncateToWidth, visibleWidth, wrapTextWithAnsi } from './width.ts'

type SurfaceNode = Extract<MayflyUiNode, { readonly kind: 'surface' }>
type SurfaceChromeNode = Pick<SurfaceNode, 'badges' | 'border' | 'chrome' | 'subtitle' | 'title' | 'titleAlign'>
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

/** The kit's default widths: a rule is 24 cells, a cells bar 10. */
const RULE_CELLS = 24
const CELLS = 10
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

/**
 * The border paint of a framed chrome: the focus color for an overlay, the quiet color for an inline surface (spec
 * §2.1), or the surface's own `border` tone.
 */
export function surfaceBorderPaint(chrome: 'surface' | 'overlay', colors: MayflySemanticColors, border?: MayflyTone): (text: string) => string {
  if (border !== undefined) return text => paintTone(border, text, colors)
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
function framedTopRule(title: string, badges: string, width: number, paint: (text: string) => string, colors: MayflySemanticColors, align: 'left' | 'right' = 'left'): string {
  if (width < 2) return paint('╭')
  const inner = width - 2
  const titleWidth = title.length === 0 ? 0 : visibleWidth(title) + 2
  const badgeWidth = badges.length === 0 ? 0 : visibleWidth(badges) + 2
  const showBadges = badgeWidth > 0 && inner - titleWidth - badgeWidth >= 1
  const titleRoom = inner - (showBadges ? badgeWidth : 0) - 3
  // A right-aligned title keeps its distinguishing end (a path), so a long one loses its start.
  const elided = (): string => align === 'right' ? truncateMiddle(title, titleRoom, 'start') : `${sliceByColumn(title, 0, titleRoom - ELLIPSIS_WIDTH, true)}${ELLIPSIS}`
  const fitted = title.length === 0 || titleRoom < 2 ? '' : visibleWidth(title) <= titleRoom ? title : elided()
  const titleSegment = fitted.length === 0 ? '' : `${paint(' ')}${strongTitle(fitted, colors)}${paint(' ')}`
  const badgeSegment = showBadges ? `${paint(' ')}${badges}${paint(' ')}` : ''
  const fill = paint('─'.repeat(Math.max(0, inner - (fitted.length === 0 ? 0 : visibleWidth(fitted) + 2) - (showBadges ? badgeWidth : 0))))
  return align === 'right' ? `${paint('╭')}${badgeSegment}${fill}${titleSegment}${paint('╮')}` : `${paint('╭')}${titleSegment}${fill}${badgeSegment}${paint('╮')}`
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
    rows.push(framedTopRule(title, badges, available, surfaceBorderPaint(chrome, colors, node.border), colors, node.titleAlign))
  }
  if (node.subtitle !== undefined) rows.push(fit(colors.muted(sanitizePluginText(node.subtitle).replace(/[\r\n]+/gu, ' ')), available))
  return rows
}

/** The bottom rule of a framed surface; `lane` and `none` have none. */
export function renderSurfaceTail(node: SurfaceChromeNode, width: number, colors: MayflySemanticColors): string[] {
  const chrome = node.chrome ?? 'none'
  if (chrome === 'none' || chrome === 'lane') return []
  const available = safeWidth(width)
  return [surfaceBorderPaint(chrome, colors, node.border)(available < 2 ? '╰' : `╰${'─'.repeat(available - 2)}╯`)]
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

/** What the compiler knows about a list beyond its node: the model's rows, the cursor, bodies, strips, and the window. */
export type ListRenderExtras = Omit<ListPaintOptions, 'rows' | 'focused' | 'marker' | 'selectedIds' | 'cursorId' | 'memo'> & {
  readonly rows?: readonly ListRowSpec[]
  readonly cursorId?: string | undefined
}

export type { ListRowMemo } from './ui-list-paint.ts'

/**
 * Render list rows (spec 4.4); `numberFrom` is the visible position of the first row so numbers stay stable while the
 * window scrolls. Without `extras` the rows are the node's items as a flat list and the cursor is the focused row.
 */
export function renderList(node: ListNode, width: number, height: number, focus: PatternFocus, colors: MayflySemanticColors, numberFrom = 0, memo?: ListRowMemo, extras?: ListRenderExtras): string[] {
  const available = safeWidth(width)
  const rows = extras?.rows ?? node.items.map((item, ordinal) => ({
    item, depth: 0, last: false, expandable: item.body !== undefined && item.bodyAlways !== true, open: item.bodyAlways === true && item.body !== undefined, position: numberFrom + ordinal,
  }))
  return paintList(node, available, height, colors, {
    ...extras,
    rows,
    cursorId: extras?.cursorId ?? (focus.key === '' ? undefined : focus.key),
    focused: focus.focused && focus.key !== '',
    marker: focus.marker,
    selectedIds: node.selectedIds,
    memo,
    ...(node.filter === undefined ? {} : { lead: fit(colors.textMuted(`/ ${node.filter}`), available) }),
  })
}

/**
 * The segment strip as one footer line: the label and the whole strip when they fit, then the strip alone, without
 * `(default)`, folded into `+N`, and last the active option alone. `selectedId` is the option that applies.
 */
export function renderListSegment(segment: MayflyListSegment, selectedId: string | undefined, width: number, colors: MayflySemanticColors, pinned: string | null = selectedId ?? null): string {
  return segmentFooter({ segment, pinned, active: selectedId }, safeWidth(width), colors, segment.label ?? 'Options')
}

export function renderFormField(field: MayflyFormField, width: number, focus: PatternFocus, colors: MayflySemanticColors, text: (key: string) => string = key => key, decor: FieldDecor = {}, labelWidth = visibleWidth(field.label)): string[] {
  return paintFormField({ field, decor, width, focus, colors, text, labelWidth })
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

/** Compact non-negative duration from milliseconds: `45s`, `2m 10s` past a minute, `1h 5m` past an hour. */
function formatElapsedMs(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${String(seconds)}s`
  if (seconds < 3600) return `${String(Math.floor(seconds / 60))}m ${String(seconds % 60)}s`
  return `${String(Math.floor(seconds / 3600))}h ${String(Math.floor((seconds % 3600) / 60))}m`
}

/**
 * One loader row: the variant's glyph cell, the message in text color, and the elapsed time muted. The cell moves with
 * the clock `frame` (frozen under reduced motion); without a message the row is the bare glyph.
 */
export function renderLoader(node: LoaderNode, width: number, colors: MayflySemanticColors, frame = 0, glyphs: MayflyGlyphMode = 'unicode', reducedMotion = false): string[] {
  const cell = loaderCell(loaderVariant(node.variant), frame, { colors, glyphs, reducedMotion })
  const message = node.message === undefined || node.message === '' ? '' : ` ${colors.text(node.message)}`
  const elapsed = node.elapsedMs === undefined ? '' : ` ${colors.textMuted(formatElapsedMs(node.elapsedMs))}`
  return [fit(`${cell}${message}${elapsed}`, width)]
}

export function renderEmpty(node: EmptyNode, width: number, colors: MayflySemanticColors): string[] {
  const available = safeWidth(width)
  const rows = wrapTextWithAnsi(colors.muted(node.title), available)
  if (node.description !== undefined) rows.push(...wrapTextWithAnsi(colors.muted(node.description), available))
  return rows
}

/**
 * A determinate bar. `style: 'rule'` is the heading rule (`━` done, `─` left), `cells` the `▰▱` cells with an optional
 * label, `n/N`, and percentage; a bar that names neither a style nor a width keeps the full-row block bar. `shown` is
 * the value to draw, which a transition moves between publishes.
 */
export function renderProgress(node: ProgressNode, width: number, colors: MayflySemanticColors, shown: number = node.value): string[] {
  const available = safeWidth(width)
  const ratio = Math.max(0, Math.min(1, shown / node.max))
  const tone = (text: string): string => paintTone(node.tone ?? 'primary', text, colors)
  if (node.style === 'rule') {
    const cells = Math.min(node.width ?? RULE_CELLS, available)
    const done = Math.round(ratio * cells)
    return [`${tone('━'.repeat(done))}${colors.muted('─'.repeat(cells - done))}`]
  }
  const percent = node.showPercent === true ? ` ${String(Math.round(ratio * 100))}%` : ''
  if (node.style === 'cells' || node.width !== undefined) {
    const label = node.label === undefined ? '' : `${node.label} `
    const count = node.showCount === false ? '' : ` ${String(Math.round(shown))}/${String(node.max)}`
    const furniture = visibleWidth(label) + visibleWidth(count) + visibleWidth(percent)
    const cells = Math.max(1, Math.min(node.width ?? CELLS, available - furniture))
    const done = Math.round(ratio * cells)
    return [fit(`${label.length === 0 ? '' : colors.text(label)}${tone('▰'.repeat(done))}${colors.muted('▱'.repeat(cells - done))}${count === '' ? '' : colors.text(count)}${percent === '' ? '' : colors.text(percent)}`, available)]
  }
  const counter = `${String(Math.round(shown))}/${String(node.max)}`
  const counterWidth = visibleWidth(counter)
  const showCounter = node.showCount !== false && available >= counterWidth + 2
  const label = node.label === undefined ? '' : `${node.label} `
  const showLabel = label.length > 0 && available >= visibleWidth(label) + counterWidth + 4
  const furniture = (showLabel ? visibleWidth(label) : 0) + (showCounter ? counterWidth + 1 : 0) + visibleWidth(percent)
  const cells = Math.max(1, available - furniture)
  const eighths = Math.round(ratio * cells * 8)
  const bar = Array.from({ length: cells }, (_, index) => {
    const remaining = eighths - index * 8
    return remaining >= 8 ? '█' : remaining <= 0 ? '░' : PARTIAL_BLOCKS[remaining]!
  }).join('')
  return [fit(`${showLabel ? colors.text(label) : ''}${tone(bar)}${showCounter ? ` ${colors.textMuted(counter)}` : ''}${percent === '' ? '' : colors.textMuted(percent)}`, available)]
}

/** A rule across the row, or `── Label ───` with at least two dashes after the label; always the quiet border color. */
export function renderDivider(label: string | undefined, width: number, colors: MayflySemanticColors): string[] {
  const available = safeWidth(width)
  const rule = label === undefined ? '─'.repeat(available) : `── ${label} ${'─'.repeat(Math.max(2, available - visibleWidth(label) - 4))}`
  return [fit(colors.border(rule), available)]
}
