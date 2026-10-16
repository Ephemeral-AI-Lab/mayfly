/**
 * A scroll region with a declared viewport: `height` rows (`expandedHeight` while expanded with `Ctrl+E`), a scrollbar
 * column drawn beside the content (`█` thumb, `░` track), `fit` to shrink around short content, and the `↓ N new · End`
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

  constructor(private readonly options: ScrollRegionOptions) {
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

  scrollBy(amount: number): void {
    const wasFollowing = this.following
    const start = this.following ? this.max : this.offset
    this.offset = Math.max(0, Math.min(this.max, start + Math.trunc(amount)))
    this.following = this.options.follow && this.offset === this.max
    if (wasFollowing && !this.following) this.away = this.rows
    this.sync()
  }

  scrollToStart(): void {
    const wasFollowing = this.following
    this.offset = 0
    this.following = this.options.follow && this.rows <= this.viewport
    if (wasFollowing && !this.following) this.away = this.rows
    this.sync()
  }

  scrollToEnd(): void {
    this.offset = this.max
    this.following = this.options.follow
    this.sync()
  }

  /** The region's bar is always drawn while there is a bar; focus does not change it. */
  setScrollbarActive(): void {}

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
}

/**
 * A layout-driven scroll view (its viewport is the rows the layout gives it) with the bar of {@link ScrollRegion}: two
 * columns kept beside the content, the `░` track while the content overflows the viewport, and pi-tui's thumb painted
 * as the `█` thumb over it, so a panel's scroll and the conversation stream show one scrollbar. The columns are kept
 * whether or not the content overflows, so the content never rewraps when it starts to.
 *
 * The layout renders the content before it knows the viewport, so the track is not decided at render: the rows are a
 * facade whose revision moves when the overflow does, and the layout that sets it reads the rows it paints after.
 */
export class BarredScrollView extends ScrollView {
  private readonly bar: { overflowing: boolean }
  private readonly barred: boolean

  constructor(component: Component, options: BarredScrollViewOptions) {
    const bar = { overflowing: false }
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
        let seen = { inner: rowSourceOf(source)?.revision, overflowing: bar.overflowing }
        const rows = virtualRows({
          get length() { return source.length },
          get revision() {
            const now = { inner: rowSourceOf(source)?.revision, overflowing: bar.overflowing }
            if (now.inner !== seen.inner || now.overflowing !== seen.overflowing) { seen = now; revision += 1 }
            return revision
          },
          row: (index) => {
            const row = source[index] ?? ''
            return isImageLine(row) ? row : `${row}${' '.repeat(Math.max(0, inner - visibleWidth(row)))}${bar.overflowing ? track : gap}`
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

  /** The thumb shows while the content overflows; the track is part of the content rows. */
  override get isScrollbarVisible(): boolean { return this.barred && this.bar.overflowing }

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
