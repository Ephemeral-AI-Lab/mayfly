/** Renderer-owned fixed footer for the direct status registry.
 * @module @ephemeral-ai/mayfly/transcript/status-model
 */
import type { MayflyStatusEntry, MayflyStatusRegistry } from '@ephemeral-ai/mayfly-ui'
import { compileMayflyStatusNode, type MayflyComponent, type MayflyComponents, type MayflySemanticColors } from '../core/index.ts'

export type { MayflyStatusEntry } from '@ephemeral-ai/mayfly-ui'

export class StatusFooterComponent implements MayflyComponent {
  private cache: { key: string, lines: string[] } | null = null

  constructor(
    private readonly models: MayflyStatusRegistry,
    private readonly components: MayflyComponents,
    private readonly colors: MayflySemanticColors,
    private readonly viewport: () => { readonly columns: number, readonly rows: number } = () => ({ columns: 1, rows: 1 }),
  ) {}

  invalidate(): void { this.cache = null }

  render(width: number): string[] {
    const visible = this.models.list().filter(model => model.visible)
    const bands: { left: MayflyStatusEntry[], right: MayflyStatusEntry[] }[] = [{ left: [], right: [] }, { left: [], right: [] }]
    for (const model of visible) {
      const band = Math.min(2, Math.max(1, model.row ?? 1)) - 1
      bands[band]![model.band === 'right' ? 'right' : 'left'].push(model)
    }
    const lines: string[] = []
    const keys: string[] = []
    for (const band of bands) {
      const leftText = this.renderCluster(band.left, width)
      const leftWidth = this.components.visibleWidth(leftText)
      const rightBudget = band.right.length === 0 ? 0 : Math.max(0, width - leftWidth - (leftText === '' ? 0 : 2))
      const rightText = rightBudget > 0 ? this.renderCluster(band.right, rightBudget) : ''
      if (leftText === '' && rightText === '') continue
      const rightWidth = this.components.visibleWidth(rightText)
      const line = leftText === ''
        ? ' '.repeat(Math.max(0, width - rightWidth)) + rightText
        : rightText === ''
          ? leftText + ' '.repeat(Math.max(0, width - leftWidth))
          : leftText + ' '.repeat(Math.max(0, width - leftWidth - rightWidth)) + rightText
      lines.push(line)
      keys.push(`${leftText}\x00${rightText}`)
    }
    const key = `${width}:${keys.join('\x01')}`
    if (this.cache?.key === key) return this.cache.lines
    this.cache = { key, lines }
    return lines
  }

  private renderCluster(entries: readonly MayflyStatusEntry[], width: number): string {
    if (width <= 0) return ''
    const parts: string[] = []
    let used = 0
    for (const entry of entries) {
      const remaining = width - used - (parts.length > 0 ? 2 : 0)
      if (remaining <= 0) break
      const result = compileMayflyStatusNode(entry.node, {
        components: this.components,
        colors: this.colors,
        getViewport: this.viewport,
        screenMode: 'main',
        maxRows: 1,
      })
      const component = result.ok ? result.value.component : result.errorComponent
      const renderWidth = result.ok && result.value.node.kind === 'text'
        ? Math.max(remaining, result.value.node.content.length * 2 + 1)
        : remaining
      const rendered = component.renderStatus(renderWidth)
      const fullPart = (rendered.rows[0] ?? '').replace(/ +$/u, '')
      const fullWidth = this.components.visibleWidth(fullPart)
      if (entry.overflow === 'hide' && (rendered.overflowed || fullWidth > remaining)) continue
      const part = this.components.truncateToWidth(fullPart, remaining).replace(/ +$/u, '')
      if (part === '') continue
      parts.push(part)
      used += (parts.length > 1 ? 2 : 0) + this.components.visibleWidth(part)
    }
    return parts.join('  ')
  }
}
