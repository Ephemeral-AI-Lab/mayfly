/**
 * Core-private framed scroll panel for renderer components that cannot be
 * represented as one canonical UI node, such as the semantic transcript.
 *
 * @module @ephemeral-ai/mayfly/core/scrollable-panel
 */

import { ACTION_CANCEL, ACTION_END, ACTION_HOME, ACTION_MOVE_DOWN, ACTION_MOVE_UP, ACTION_PAGE_DOWN, ACTION_PAGE_UP, matchesKeyAction } from './key-actions.ts'
import type { MayflyComponent, MayflyComponents, MayflyFocusable, MayflyKeymap, MayflyScreen, MayflySemanticColors } from './types.ts'
import { sanitizePluginText } from './plugin-view.ts'
import { OVERFLOW_ELLIPSIS } from './width.ts'

/** Renderer dependencies and product callbacks for one read-only panel. */
export interface ScrollablePanelOptions {
  readonly screen: MayflyScreen
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  readonly body: MayflyComponent
  /** Live semantic bindings; omitted only by isolated fixtures, which use the defaults. */
  readonly keymap?: MayflyKeymap
  readonly title: () => string
  readonly hint?: () => string
  readonly footer?: () => readonly string[]
  readonly onClose: () => void
  /**
   * Rows the host grants this panel, including its own frame and footer. The
   * subagent panel passes `screen.editorViewport.rows` so the panel and its
   * inner renderer share one budget; isolated fixtures may omit it.
   */
  readonly viewportRows?: () => number
}

interface WindowedComponent extends MayflyComponent {
  renderWindow?(width: number, offset: number, rows: number): { readonly rows: string[], readonly total: number }
}

/** Full-height editor-slot panel with core-owned frame and scrolling. */
export class ScrollablePanel implements MayflyFocusable {
  focused = false
  private disposed = false
  private scrollOffset = 0
  private bodyTotal = 0
  private bodyRows = 1

  constructor(private readonly options: ScrollablePanelOptions) {}

  /** Body rows granted by the last render; the inner renderer reads this so both agree. */
  get bodyHeight(): number {
    return this.bodyRows
  }

  handleInput(data: string): void {
    if (this.disposed) return
    const keymap = this.options.keymap
    if (matchesKeyAction(keymap, data, ACTION_CANCEL)) {
      this.options.onClose()
      return
    }
    if (matchesKeyAction(keymap, data, ACTION_MOVE_UP)) this.scrollBy(1)
    else if (matchesKeyAction(keymap, data, ACTION_MOVE_DOWN)) this.scrollBy(-1)
    else if (matchesKeyAction(keymap, data, ACTION_PAGE_UP)) this.scrollBy(Math.max(1, this.bodyRows - 1))
    else if (matchesKeyAction(keymap, data, ACTION_PAGE_DOWN)) this.scrollBy(-Math.max(1, this.bodyRows - 1))
    else if (matchesKeyAction(keymap, data, ACTION_HOME)) this.scrollToStart()
    else if (matchesKeyAction(keymap, data, ACTION_END)) this.scrollToEnd()
  }

  invalidate(): void {
    if (this.disposed) return
    this.options.body.invalidate()
    this.options.screen.requestRender()
  }

  render(width: number): string[] {
    if (this.disposed) return []
    const { colors, components } = this.options
    const safeWidth = Math.max(1, Math.floor(width))
    const contentWidth = Math.max(1, safeWidth - 4)
    const footer = [...(this.options.footer?.() ?? [])]
    const grant = this.grantedRows()
    if (grant !== undefined && grant <= 0) return []
    // A host that cannot fit the frame gets the body alone rather than rows
    // spilling past its grant: the screen clamp is only a diagnostic backstop.
    const framed = grant === undefined || grant >= footer.length + 3
    this.bodyRows = framed ? this.bodyBudget(footer.length, grant) : Math.max(1, grant!)
    const windowed = this.options.body as WindowedComponent
    const requestedOffset = this.scrollOffset
    let rendered = windowed.renderWindow?.(contentWidth, requestedOffset, this.bodyRows)
    const all = rendered === undefined ? this.options.body.render(contentWidth) : undefined
    const total = rendered?.total ?? all!.length
    if (this.scrollOffset > 0 && total > this.bodyTotal) this.scrollOffset += total - this.bodyTotal
    this.bodyTotal = total
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, total - this.bodyRows))
    if (rendered !== undefined && this.scrollOffset !== requestedOffset) {
      rendered = windowed.renderWindow!(contentWidth, this.scrollOffset, this.bodyRows)
    }
    const body = rendered === undefined
      ? (() => { const end = total - this.scrollOffset; return all!.slice(Math.max(0, end - this.bodyRows), end) })()
      : rendered.rows
    while (body.length < this.bodyRows) body.push('')
    if (!framed) return body.slice(0, this.bodyRows).map(line => components.truncateToWidth(line, safeWidth, OVERFLOW_ELLIPSIS))
    const title = sanitizePluginText(this.options.title()).replace(/[\r\n]+/gu, ' ')
    const hint = sanitizePluginText(this.options.hint?.() ?? '').replace(/[\r\n]+/gu, ' ')
    // A long body shows its position so a read-only view cannot look complete.
    const shownEnd = this.bodyTotal - this.scrollOffset
    const shownStart = Math.max(1, shownEnd - this.bodyRows + 1)
    const scrollInfo = this.bodyTotal > this.bodyRows ? `(${String(shownStart)}-${String(shownEnd)}/${String(this.bodyTotal)})` : ''
    const topHint = [hint, scrollInfo].filter(part => part !== '').join(' · ')
    const lines = [components.topRule(safeWidth, {
      title: colors.primary(` ${title} `),
      ...(topHint === '' ? {} : { hint: colors.textMuted(`${topHint} `) }),
      paint: colors.border,
    })]
    lines.push(...body.map(line => this.frame(line, contentWidth)))
    lines.push(...footer.map(line => this.frame(colors.textMuted(sanitizePluginText(line).replace(/[\r\n]+/gu, ' ')), contentWidth)))
    lines.push(colors.border(`╰${'─'.repeat(Math.max(1, safeWidth - 2))}╯`))
    // Below the frame's minimum the rules and furniture cannot fit; degrade
    // by clamping each row instead of making the whole panel vanish.
    return width >= 5 ? lines : lines.map(line => components.truncateToWidth(line, Math.max(0, Math.floor(width)), OVERFLOW_ELLIPSIS))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ;(this.options.body as MayflyComponent & { dispose?: () => void }).dispose?.()
  }

  /** Host-granted rows, or `undefined` when the panel owns the whole screen (isolated fixtures). */
  private grantedRows(): number | undefined {
    const rows = this.options.viewportRows?.()
    return rows === undefined || !Number.isFinite(rows) ? undefined : Math.max(0, Math.floor(rows))
  }

  private bodyBudget(footerRows: number, grant: number | undefined): number {
    const rows = grant ?? this.options.screen.rows
    if (!Number.isFinite(rows) || rows <= 0) return 12
    // The frame owns one top and one bottom rule beside the caller footer.
    return Math.max(1, Math.floor(rows) - footerRows - 2)
  }

  private scrollBy(delta: number): void {
    const next = Math.min(Math.max(0, this.bodyTotal - this.bodyRows), Math.max(0, this.scrollOffset + delta))
    if (next === this.scrollOffset) return
    this.scrollOffset = next
    this.options.screen.requestRender()
  }

  private scrollToStart(): void {
    const next = Math.max(0, this.bodyTotal - this.bodyRows)
    if (next === this.scrollOffset) return
    this.scrollOffset = next
    this.options.screen.requestRender()
  }

  private scrollToEnd(): void {
    if (this.scrollOffset === 0) return
    this.scrollOffset = 0
    this.options.screen.requestRender()
  }

  private frame(line: string, width: number): string {
    const { colors, components } = this.options
    const clipped = components.truncateToWidth(line, width, OVERFLOW_ELLIPSIS)
    const padding = Math.max(0, width - components.visibleWidth(clipped))
    return colors.border('│') + ' ' + clipped + ' '.repeat(padding) + ' ' + colors.border('│')
  }
}
