/**
 * A scroll region with a declared viewport: `height` rows (`expandedHeight` while expanded with `Ctrl+E`), a scrollbar
 * column drawn beside the content (`█` thumb, `░` track) while the focused region scrolls, `fit` to shrink around short content, and the `↓ N new · End`
 * pill while the view is scrolled away from a followed tail, and `more` for the `↓ N more` count of the rows below. It paints its own rows, so the surface around it keeps its
 * natural height instead of stretching to the viewport the way a layout-driven scroll does.
 *
 * @module @ephemeral-ai/mayfly/core/ui-scroll-region
 */

import { ScrollView, type Component, type ScrollViewOptions } from '@earendil-works/pi-tui'
import { isImageLine } from '@earendil-works/pi-tui/dist/terminal-image.js'
import type { MayflyComponents, MayflySemanticColors } from './types.ts'
import type { UiDocumentAnchor, UiDocumentState } from './ui-interaction-document.ts'
import type { UiScrollControl } from './ui-surface-state.ts'
import { prepareRows, rowSourceOf, unclampedRows, virtualRows } from './ui-rows.ts'
import { visibleWidth } from './width.ts'
import { countWork, type MayflyWorkCounters } from './ui-work-counters.ts'

/** The viewport rows of a scroll that declares none of its sizes. */
export const SCROLL_DEFAULT_HEIGHT = 6

/** The viewport rows once a scroll is expanded and declares no `expandedHeight`. */
export const SCROLL_DEFAULT_EXPANDED_HEIGHT = 14

/** Columns the scrollbar takes beside the content: a gap and the bar. */
const BAR_COLUMNS = 2

/** The colors of the bar: the thumb in the accent, the track muted. */
type BarColors = Pick<MayflySemanticColors, 'primary' | 'muted'>

const thumbCell = (colors: BarColors | undefined): string => colors === undefined ? '█' : colors.primary('█')
const trackCell = (colors: BarColors | undefined): string => colors === undefined ? '░' : colors.muted('░')

/** How long the bar stays after the last scroll. */
const BAR_LINGER_MS = 1000

/**
 * When a scroll shows its bar: only while it moves, and for {@link BAR_LINGER_MS} after, so two scrolls on one screen
 * (a panel over the conversation) never show two bars. A focus-gated scroll (a panel's) shows it only while it holds
 * focus, and losing focus takes it away at once. The bar's columns stay kept while it is hidden, so nothing rewraps.
 */
export class BarVisibility {
  private shown = false
  private focused = false
  private timer: ReturnType<typeof setTimeout> | undefined

  /**
   * @param focusGated - show only while focused (a panel's scroll); the conversation stream moves only when the reader
   *   scrolls it, so it is not gated.
   * @param repaint - paints the scroll again when the bar goes.
   */
  constructor(private readonly focusGated: boolean, private readonly repaint: () => void) {}

  get visible(): boolean { return this.shown }

  focus(active: boolean): void {
    this.focused = active
    if (!active) this.hide()
  }

  /** The reader moved the scroll. */
  moved(): void {
    if (this.focusGated && !this.focused) return
    this.shown = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.shown = false
      this.repaint()
    }, BAR_LINGER_MS)
    this.timer.unref?.()
  }

  private hide(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    this.shown = false
  }
}

/** The document anchors a scroll keeps its place with when its content changes (`ui-interaction-document.ts`). */
interface ScrollRegionAnchors {
  state(): UiDocumentState | undefined
  rowOf(state: UiDocumentState, width: number): number
  anchorAt(state: UiDocumentState, row: number, width: number, follow: 'none' | 'end'): UiDocumentAnchor | undefined
  move(anchor: UiDocumentAnchor): void
}

/**
 * Where a region is scrolled, kept by the surface runtime so a republish of the surface (the compiler builds a new
 * region each time) leaves the view where the user put it.
 */
export interface ScrollMemory {
  offset: number
  /** Whether the view follows the tail; `undefined` until the region first paints. */
  following: boolean | undefined
  /** The row count when the view last left the tail, for the pill's count of new rows. */
  away: number
}

interface ScrollRegionOptions {
  readonly child: Component
  readonly memory: ScrollMemory
  readonly height: number
  readonly expandedHeight: number
  readonly fit: boolean
  readonly pill: boolean
  /** Say how many rows remain below the viewport on its last row, while any do. */
  readonly more: boolean
  /** Keep the tail in view while following. */
  readonly follow: boolean
  readonly scrollbar: boolean
  /** Paints the surface again when the bar goes. */
  readonly repaint: () => void
  /** Whether `Ctrl+E` expanded this region. */
  readonly expanded: () => boolean
  readonly colors: Pick<MayflySemanticColors, 'primary' | 'muted'>
  readonly components: Pick<MayflyComponents, 'visibleWidth' | 'truncateToWidth'>
  /** The pill's words for `count` rows that arrived while the view was away from the tail. */
  readonly pillText: (count: number) => string
  /** The words for `count` rows below the viewport. */
  readonly moreText: (count: number) => string
  readonly anchors?: ScrollRegionAnchors | undefined
  /** The work sink; the region counts the viewport rows it paints. */
  readonly counters?: MayflyWorkCounters | undefined
}

export class ScrollRegion implements Component, UiScrollControl {
  /** The compiler lays this region out itself, so it never takes the layout-driven frame. */
  readonly inline = true
  private readonly memory: ScrollMemory
  private rows = 0
  private viewport: number
  private width = 1
  private readonly bar: BarVisibility

  constructor(private readonly options: ScrollRegionOptions) {
    this.bar = new BarVisibility(true, options.repaint)
    this.memory = options.memory
    this.memory.following ??= options.follow
    this.viewport = options.height
  }

  private get offset(): number { return this.memory.offset }
  private set offset(value: number) { this.memory.offset = value }
  private get following(): boolean { return this.memory.following! }
  private set following(value: boolean) { this.memory.following = value }
  private get away(): number { return this.memory.away }
  private set away(value: number) { this.memory.away = value }

  get viewportHeight(): number { return this.viewport }

  get expandable(): boolean { return this.options.expanded() || (this.options.expandedHeight > this.viewport && this.rows > this.viewport) }

  private get max(): number { return Math.max(0, this.rows - this.viewport) }

  private sync(): void {
    const anchors = this.options.anchors
    const state = anchors?.state()
    if (anchors === undefined || state === undefined) return
    const anchor = anchors.anchorAt(state, this.offset, this.width, this.following ? 'end' : 'none')
    if (anchor !== undefined) anchors.move(anchor)
  }

  /** Show the bar when a move changed the window. */
  private moved(before: number): void { if (this.offset !== before) this.bar.moved() }

  scrollBy(amount: number): void {
    const before = this.offset
    const wasFollowing = this.following
    const start = this.following ? this.max : this.offset
    this.offset = Math.max(0, Math.min(this.max, start + Math.trunc(amount)))
    this.following = this.options.follow && this.offset === this.max
    if (wasFollowing && !this.following) this.away = this.rows
    this.sync()
    this.moved(before)
  }

  scrollToStart(): void {
    const before = this.offset
    const wasFollowing = this.following
    this.offset = 0
    this.following = this.options.follow && this.rows <= this.viewport
    if (wasFollowing && !this.following) this.away = this.rows
    this.sync()
    this.moved(before)
  }

  scrollToEnd(): void {
    const before = this.offset
    this.offset = this.max
    this.following = this.options.follow
    this.sync()
    this.moved(before)
  }

  setScrollbarActive(active: boolean): void { this.bar.focus(active) }

  render(width: number): string[] {
    const { components, colors, child, fit } = this.options
    const columns = Math.max(1, Math.floor(width))
    const target = this.options.expanded() ? this.options.expandedHeight : this.options.height
    let barred = this.options.scrollbar && columns > BAR_COLUMNS
    let inner = barred ? columns - BAR_COLUMNS : columns
    let lines = unclampedRows(child.render(inner))
    // A fitted region whose content fits the viewport at the full width shows no scrollbar at all.
    if (fit && barred) {
      const full = unclampedRows(child.render(columns))
      if (full.length <= target) { lines = full; inner = columns; barred = false }
    }
    this.width = inner
    this.viewport = fit ? Math.min(target, Math.max(1, lines.length)) : target
    const anchors = this.options.anchors
    const state = anchors?.state()
    const resolve = (): void => {
      if (anchors !== undefined && state !== undefined) {
        if (state.anchor?.follow === 'end') { this.offset = this.max; this.following = this.options.follow }
        else { this.offset = Math.max(0, Math.min(this.max, anchors.rowOf(state, inner))); this.following = false }
      } else if (this.following) this.offset = this.max
      else this.offset = Math.min(this.offset, this.max)
    }
    // The live length comes first: resolving against the last frame's count (or a rebuilt region's zero) would
    // clamp a restored offset to nothing before the new content is even measured. Then resolve the window the
    // view already sat on and paint it — painted counts can grow the map — and resolve once more so a follow-end
    // or anchored position lands on the painted rows, not on estimates that ran short.
    this.rows = lines.length
    resolve()
    prepareRows(lines, this.offset, this.offset + this.viewport)
    this.rows = lines.length
    resolve()
    this.rows = lines.length
    if (this.following) this.away = lines.length
    const max = this.max
    const view = lines.slice(this.offset, this.offset + this.viewport)
    while (view.length < this.viewport) view.push('')
    // The last row names what is still below; the end of the content shows the row itself again.
    if (this.options.more && this.offset < max && this.viewport > 1) view[this.viewport - 1] = colors.muted(this.options.moreText(lines.length - (this.offset + this.viewport - 1)))
    const pill = this.options.pill && this.offset < max && lines.length > this.away ? `\x1b[7m ${this.options.pillText(lines.length - this.away)} \x1b[27m` : ''
    const pillWidth = components.visibleWidth(pill)
    const thumb = Math.max(1, Math.round((this.viewport * this.viewport) / Math.max(this.viewport, lines.length)))
    const thumbAt = max === 0 ? 0 : Math.round((this.offset / max) * (this.viewport - thumb))
    countWork(this.options.counters, 'rowsPainted', view.length)
    return view.map((row, index) => {
      const last = pill !== '' && index === this.viewport - 1
      const room = last ? Math.max(0, inner - pillWidth) : inner
      const clipped = components.truncateToWidth(row, last ? Math.max(0, room - 1) : room, '')
      const text = `${clipped}${' '.repeat(Math.max(0, room - components.visibleWidth(clipped)))}${last ? pill : ''}`
      if (!barred) return text
      if (!this.bar.visible) return `${text}${' '.repeat(BAR_COLUMNS)}`
      const onThumb = lines.length > this.viewport && index >= thumbAt && index < thumbAt + thumb
      return `${text} ${onThumb ? thumbCell(colors) : trackCell(colors)}`
    })
  }

  invalidate(): void { this.options.child.invalidate() }
}

export interface BarredScrollViewOptions extends Omit<ScrollViewOptions, 'scrollbar' | 'scrollbarStyle' | 'scrollbarHideDelayMs'> {
  /** Draw the bar; without it the view is pi-tui's plain scroll. */
  readonly scrollbar: boolean
  /** The palette of the bar, read at paint; `undefined` paints the glyphs plain. */
  readonly colors: () => BarColors | undefined
  /** Show the bar only while the view holds focus (see {@link BarVisibility}). */
  readonly focusGated: boolean
  /** Paints the view again when the bar goes. */
  readonly repaint: () => void
}

/**
 * A layout-driven scroll view (its viewport is the rows the layout gives it) with the bar of {@link ScrollRegion}: two
 * columns kept beside the content, and while the content overflows and the reader scrolls ({@link BarVisibility}) the
 * `░` track with pi-tui's thumb painted as the `█` thumb over it, so a panel's scroll and the conversation stream show one scrollbar. The columns are kept
 * whether or not the content overflows, so the content never rewraps when it starts to.
 *
 * The layout renders the content before it knows the viewport, so the track is not decided at render: the rows are a
 * facade whose revision moves when the overflow or the bar's visibility does, and the paint reads them after the layout.
 * Moves the view makes on its own during a layout (following the tail, keeping an anchor) go through {@link quietly}
 * and show no bar.
 */
export class BarredScrollView extends ScrollView {
  private readonly bar: { overflowing: boolean, readonly visibility: BarVisibility }
  private readonly barred: boolean
  private quiet = false

  constructor(component: Component, options: BarredScrollViewOptions) {
    const bar = { overflowing: false, visibility: new BarVisibility(options.focusGated, options.repaint) }
    let memo: { source: readonly string[], width: number, colors: BarColors | undefined, rows: string[] } | undefined
    const barred: Component = {
      render: (width: number): string[] => {
        if (width <= BAR_COLUMNS) return component.render(width)
        const inner = width - BAR_COLUMNS
        const source = component.render(inner)
        const colors = options.colors()
        if (memo !== undefined && memo.source === source && memo.width === width && memo.colors === colors) return memo.rows
        const gap = ' '.repeat(BAR_COLUMNS)
        const track = ` ${trackCell(colors)}`
        let revision = 0
        const drawn = (): boolean => bar.overflowing && bar.visibility.visible
        let seen = { inner: rowSourceOf(source)?.revision, drawn: drawn() }
        const rows = virtualRows({
          get length() { return source.length },
          get revision() {
            const now = { inner: rowSourceOf(source)?.revision, drawn: drawn() }
            if (now.inner !== seen.inner || now.drawn !== seen.drawn) { seen = now; revision += 1 }
            return revision
          },
          row: (index) => {
            const row = source[index] ?? ''
            return isImageLine(row) ? row : `${row}${' '.repeat(Math.max(0, inner - visibleWidth(row)))}${drawn() ? track : gap}`
          },
        })
        memo = { source, width, colors, rows }
        return rows
      },
      invalidate: () => component.invalidate(),
    }
    super(options.scrollbar ? barred : component, {
      ...options,
      scrollbar: options.scrollbar ? 'always' : 'hidden',
      scrollbarStyle: () => thumbCell(options.colors()),
    })
    this.bar = bar
    this.barred = options.scrollbar
  }

  /** The thumb shows while the content overflows and the reader scrolls; the track is part of the content rows. */
  override get isScrollbarVisible(): boolean { return this.barred && this.bar.overflowing && this.bar.visibility.visible }

  override setScrollbarActive(active: boolean): void { this.bar.visibility.focus(active) }

  /** Run a move the view makes on its own (a layout keeping the tail or an anchor): it shows no bar. */
  protected quietly<Result>(move: () => Result): Result {
    const was = this.quiet
    this.quiet = true
    try { return move() } finally { this.quiet = was }
  }

  private moved(before: number): void { if (!this.quiet && this.scrollTop !== before) this.bar.visibility.moved() }

  override scrollTo(scrollTop: number, options?: Parameters<ScrollView['scrollTo']>[1]): void {
    const before = this.scrollTop
    super.scrollTo(scrollTop, options)
    this.moved(before)
  }

  override scrollBy(lines: number): number {
    const before = this.scrollTop
    const remaining = super.scrollBy(lines)
    this.moved(before)
    return remaining
  }

  override scrollToStart(): void {
    const before = this.scrollTop
    super.scrollToStart()
    this.moved(before)
  }

  override scrollToEnd(): void {
    const before = this.scrollTop
    super.scrollToEnd()
    this.moved(before)
  }

  /** The bar's columns are inside the rows the content wrapper paints, so the content takes the whole width. */
  override getContentWidth(width: number): number { return width }

  /** The columns the bar keeps at the right of the view. */
  get barColumns(): number { return this.barred ? BAR_COLUMNS : 0 }

  /** The width the content itself wraps at, beside the bar. */
  protected innerWidth(width: number): number { return this.barred && width > BAR_COLUMNS ? width - BAR_COLUMNS : width }

  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender)
    this.bar.overflowing = this.barred && contentHeight > viewportHeight
  }
}
