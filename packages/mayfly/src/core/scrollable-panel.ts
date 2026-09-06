/**
 * Core-private framed scroll panel for renderer components that cannot be
 * represented as one canonical UI node, such as the semantic transcript.
 *
 * @module @ephemeral-ai/mayfly/core/scrollable-panel
 */

import { Key, matchesKey } from '@earendil-works/pi-tui'
import type { MayflyComponent, MayflyComponents, MayflyFocusable, MayflyScreen, MayflySemanticColors } from './types.ts'
import { sanitizePluginText } from './plugin-view.ts'

/** Renderer dependencies and product callbacks for one read-only panel. */
export interface ScrollablePanelOptions {
  readonly screen: MayflyScreen
  readonly components: MayflyComponents
  readonly colors: MayflySemanticColors
  readonly body: MayflyComponent
  readonly title: () => string
  readonly hint?: () => string
  readonly footer?: () => readonly string[]
  readonly onClose: () => void
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

  handleInput(data: string): void {
    if (this.disposed) return
    if (matchesKey(data, Key.escape)) {
      this.options.onClose()
      return
    }
    if (matchesKey(data, Key.up)) this.scrollBy(1)
    else if (matchesKey(data, Key.down)) this.scrollBy(-1)
    else if (matchesKey(data, Key.pageUp)) this.scrollBy(Math.max(1, this.bodyRows - 1))
    else if (matchesKey(data, Key.pageDown)) this.scrollBy(-Math.max(1, this.bodyRows - 1))
    else if (matchesKey(data, Key.home)) this.scrollToStart()
    else if (matchesKey(data, Key.end)) this.scrollToEnd()
  }

  invalidate(): void {
    if (this.disposed) return
    this.options.body.invalidate()
    this.options.screen.requestRender()
  }

  render(width: number): string[] {
    if (this.disposed || width < 5) return []
    const { colors, components } = this.options
    const contentWidth = Math.max(1, width - 4)
    const footer = [...(this.options.footer?.() ?? [])]
    this.bodyRows = this.bodyBudget(footer.length)
    const windowed = this.options.body as WindowedComponent
    const rendered = windowed.renderWindow?.(contentWidth, this.scrollOffset, this.bodyRows)
    const all = rendered === undefined ? this.options.body.render(contentWidth) : undefined
    const total = rendered?.total ?? all!.length
    if (this.scrollOffset > 0 && total > this.bodyTotal) this.scrollOffset += total - this.bodyTotal
    this.bodyTotal = total
    this.scrollOffset = Math.min(this.scrollOffset, Math.max(0, total - this.bodyRows))
    const body = rendered === undefined
      ? (() => { const end = total - this.scrollOffset; return all!.slice(Math.max(0, end - this.bodyRows), end) })()
      : rendered.rows
    while (body.length < this.bodyRows) body.push('')
    const title = sanitizePluginText(this.options.title()).replace(/[\r\n]+/gu, ' ')
    const hint = sanitizePluginText(this.options.hint?.() ?? '').replace(/[\r\n]+/gu, ' ')
    const lines = [components.topRule(width, {
      title: colors.primary(` ${title} `),
      ...(hint === '' ? {} : { hint: colors.textMuted(`${hint} `) }),
      paint: colors.border,
    })]
    lines.push(...body.map(line => this.frame(line, contentWidth)))
    lines.push(...footer.map(line => this.frame(colors.textMuted(sanitizePluginText(line).replace(/[\r\n]+/gu, ' ')), contentWidth)))
    lines.push(colors.border(`╰${'─'.repeat(Math.max(1, width - 2))}╯`))
    return lines
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    ;(this.options.body as MayflyComponent & { dispose?: () => void }).dispose?.()
  }

  private bodyBudget(footerRows: number): number {
    const rows = this.options.screen.rows
    if (!Number.isFinite(rows) || rows <= 0) return 12
    return Math.max(1, Math.floor(rows) - footerRows - 4)
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
    const clipped = components.truncateToWidth(line, width, '…')
    const padding = Math.max(0, width - components.visibleWidth(clipped))
    return colors.border('│') + ' ' + clipped + ' '.repeat(padding) + ' ' + colors.border('│')
  }
}
