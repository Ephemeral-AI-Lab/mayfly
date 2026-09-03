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
    const visible = this.models.list().filter(model => model.node !== null)
    const sourceKey = `${width}:${visible.map(entry => `${entry.id}:${String(entry.revision)}`).join(',')}`
    if (this.cache?.key === sourceKey) return this.cache.lines
    const bands: { left: MayflyStatusEntry[], center: MayflyStatusEntry[], right: MayflyStatusEntry[] }[] = [
      { left: [], center: [], right: [] },
      { left: [], center: [], right: [] },
    ]
    for (const model of visible) {
      const band = Math.min(2, Math.max(1, model.definition.row ?? 1)) - 1
      bands[band]![model.definition.band ?? 'left'].push(model)
    }
    const lines: string[] = []
    for (const band of bands) {
      const leftText = this.renderCluster(band.left, width)
      const leftWidth = this.components.visibleWidth(leftText)
      const rightBudget = band.right.length === 0 ? 0 : Math.max(0, width - leftWidth - (leftText === '' ? 0 : 2))
      const rightText = rightBudget > 0 ? this.renderCluster(band.right, rightBudget) : ''
      const rightWidth = this.components.visibleWidth(rightText)
      const middleStart = leftWidth + (leftText === '' ? 0 : 2)
      const middleEnd = Math.max(middleStart, width - rightWidth - (rightText === '' ? 0 : 2))
      const centerText = this.renderCluster(band.center, Math.max(0, middleEnd - middleStart))
      const centerWidth = this.components.visibleWidth(centerText)
      if (leftText === '' && centerText === '' && rightText === '') continue
      const idealCenter = Math.max(middleStart, Math.floor((width - centerWidth) / 2))
      const centerStart = Math.min(Math.max(middleStart, idealCenter), Math.max(middleStart, middleEnd - centerWidth))
      const line = centerText === '' && rightText === ''
        ? leftText + ' '.repeat(Math.max(0, width - leftWidth))
        : leftText === '' && centerText === ''
          ? ' '.repeat(Math.max(0, width - rightWidth)) + rightText
          : leftText
            + ' '.repeat(Math.max(0, centerStart - leftWidth))
            + centerText
            + ' '.repeat(Math.max(0, width - centerStart - centerWidth - rightWidth))
            + rightText
      lines.push(this.components.truncateToWidth(line, width))
    }
    this.cache = { key: sourceKey, lines }
    return lines
  }

  private renderCluster(entries: readonly MayflyStatusEntry[], width: number): string {
    if (width <= 0) return ''
    const parts: string[] = []
    let used = 0
    for (const entry of entries) {
      const remaining = width - used - (parts.length > 0 ? 2 : 0)
      if (remaining <= 0) break
      const result = compileMayflyStatusNode(entry.node!, {
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
      if (entry.definition.overflow === 'hide' && (rendered.overflowed || fullWidth > remaining)) continue
      const part = this.components.truncateToWidth(fullPart, remaining).replace(/ +$/u, '')
      if (part === '') continue
      parts.push(part)
      used += (parts.length > 1 ? 2 : 0) + this.components.visibleWidth(part)
    }
    return parts.join('  ')
  }
}
