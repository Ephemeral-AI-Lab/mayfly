/**
 * A scroll region with a declared viewport: `height` rows (`expandedHeight` while expanded with `Ctrl+E`), a scrollbar
 * column drawn beside the content (`█` thumb, `░` track), `fit` to shrink around short content, and the `↓ N new · End`
 * pill while the view is scrolled away from a followed tail. It paints its own rows, so the surface around it keeps its
 * natural height instead of stretching to the viewport the way a layout-driven scroll does.
 *
 * @module @ephemeral-ai/mayfly/core/ui-scroll-region
 */

import type { Component } from '@earendil-works/pi-tui'
import type { MayflyComponents, MayflySemanticColors } from './types.ts'
import type { UiDocumentAnchor, UiDocumentState } from './ui-interaction-document.ts'
import type { UiScrollControl } from './ui-surface-state.ts'

/** The viewport rows of a scroll that declares none of its sizes. */
export const SCROLL_DEFAULT_HEIGHT = 6

/** The viewport rows once a scroll is expanded and declares no `expandedHeight`. */
export const SCROLL_DEFAULT_EXPANDED_HEIGHT = 14

/** Columns the scrollbar takes beside the content: a gap and the bar. */
const BAR_COLUMNS = 2

/** The document anchors a scroll keeps its place with when its content changes (`ui-interaction-document.ts`). */
export interface ScrollRegionAnchors {
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

export interface ScrollRegionOptions {
  readonly child: Component
  readonly memory: ScrollMemory
  readonly height: number
  readonly expandedHeight: number
  readonly fit: boolean
  readonly pill: boolean
  /** Keep the tail in view while following. */
  readonly follow: boolean
  readonly scrollbar: boolean
  /** Whether `Ctrl+E` expanded this region. */
  readonly expanded: () => boolean
  readonly colors: Pick<MayflySemanticColors, 'primary' | 'muted'>
  readonly components: Pick<MayflyComponents, 'visibleWidth' | 'truncateToWidth'>
  /** The pill's words for `count` rows that arrived while the view was away from the tail. */
  readonly pillText: (count: number) => string
  readonly anchors?: ScrollRegionAnchors | undefined
}

export class ScrollRegion implements Component, UiScrollControl {
  /** The compiler lays this region out itself, so it never takes the layout-driven frame. */
  readonly inline = true
  private readonly memory: ScrollMemory
  private rows = 0
  private viewport: number
  private width = 1
  private bar = false

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

  /** Whether the scrollbar column is drawn at the last paint. */
  get scrollbarVisible(): boolean { return this.bar }

  /** Whether the view follows the tail. */
  get isFollowingEnd(): boolean { return this.following }

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
    let lines = child.render(inner)
    // A fitted region whose content fits the viewport at the full width shows no scrollbar at all.
    if (fit && barred) {
      const full = child.render(columns)
      if (full.length <= target) { lines = full; inner = columns; barred = false }
    }
    this.width = inner
    this.rows = lines.length
    this.viewport = fit ? Math.min(target, Math.max(1, lines.length)) : target
    this.bar = barred
    const anchors = this.options.anchors
    const state = anchors?.state()
    if (anchors !== undefined && state !== undefined) {
      if (state.anchor?.follow === 'end') { this.offset = this.max; this.following = this.options.follow }
      else { this.offset = Math.max(0, Math.min(this.max, anchors.rowOf(state, inner))); this.following = false }
    } else if (this.following) this.offset = this.max
    else this.offset = Math.min(this.offset, this.max)
    if (this.following) this.away = lines.length
    const max = this.max
    const view = lines.slice(this.offset, this.offset + this.viewport)
    while (view.length < this.viewport) view.push('')
    const pill = this.options.pill && this.offset < max && lines.length > this.away ? `\x1b[7m ${this.options.pillText(lines.length - this.away)} \x1b[27m` : ''
    const pillWidth = components.visibleWidth(pill)
    const thumb = Math.max(1, Math.round((this.viewport * this.viewport) / Math.max(this.viewport, lines.length)))
    const thumbAt = max === 0 ? 0 : Math.round((this.offset / max) * (this.viewport - thumb))
    return view.map((row, index) => {
      const last = pill !== '' && index === this.viewport - 1
      const room = last ? Math.max(0, inner - pillWidth) : inner
      const clipped = components.truncateToWidth(row, last ? Math.max(0, room - 1) : room, '')
      const text = `${clipped}${' '.repeat(Math.max(0, room - components.visibleWidth(clipped)))}${last ? pill : ''}`
      if (!barred) return text
      const onThumb = lines.length > this.viewport && index >= thumbAt && index < thumbAt + thumb
      return `${text} ${onThumb ? colors.primary('█') : colors.muted('░')}`
    })
  }

  invalidate(): void { this.options.child.invalidate() }
}
