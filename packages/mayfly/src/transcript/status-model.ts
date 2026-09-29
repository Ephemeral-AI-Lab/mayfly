/** Renderer-owned fixed footer for the direct status registry.
 * @module @ephemeral-ai/mayfly/transcript/status-model
 */
import type { MayflyStatusEntry, MayflyStatusRegistry } from '@ephemeral-ai/mayfly-ui'
import { compileMayflyStatusNode, type MayflyComponent, type MayflyComponents, type MayflySemanticColors } from '../core/index.ts'

export type { MayflyStatusEntry } from '@ephemeral-ai/mayfly-ui'

type StatusBand = 'left' | 'center' | 'right'

/**
 * The fixed footer. Each row admits its entries in registry order — priority,
 * then id — across all three bands: an entry takes its full width when it
 * fits the room earlier entries left, otherwise it truncates to that room or,
 * with `overflow: 'hide'`, drops out. Admitted parts then lay out as a left
 * cluster, a centered cluster, and a right-aligned cluster.
 */
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
    const lines: string[] = []
    for (const row of [1, 2]) {
      const line = this.renderRow(visible.filter(model => Math.min(2, Math.max(1, model.definition.row ?? 1)) === row), width)
      if (line !== undefined) lines.push(line)
    }
    this.cache = { key: sourceKey, lines }
    return lines
  }

  /** Admit one row's entries by priority, then lay out the three bands. */
  private renderRow(entries: readonly MayflyStatusEntry[], width: number): string | undefined {
    const admitted = new Map<MayflyStatusEntry, string>()
    let used = 0
    const protectedWidths = entries.map(entry => (entry.definition.priority ?? 100) <= 1
      ? this.components.visibleWidth(this.renderPart(entry, Math.max(160, width))) : 0)
    for (const [index, entry] of entries.entries()) {
      const remaining = width - used - (admitted.size > 0 ? 2 : 0)
      if (remaining <= 0) break
      const reserve = protectedWidths.slice(index + 1).reduce((sum, size, offset) => {
        const later = entries[index + 1 + offset]!
        return sum + (size === 0 ? 0 : (later.definition.overflow === 'hide' ? size : Math.min(size, 16)) + 2)
      }, 0)
      const budget = remaining >= reserve + 8 ? remaining - reserve : remaining
      const part = this.renderPart(entry, budget)
      if (part === '') continue
      admitted.set(entry, part)
      used += (admitted.size > 1 ? 2 : 0) + this.components.visibleWidth(part)
    }
    const cluster = (band: StatusBand): string => entries
      .filter(entry => (entry.definition.band ?? 'left') === band && admitted.has(entry))
      .map(entry => admitted.get(entry)!)
      .join('  ')
    const leftText = cluster('left')
    const centerText = cluster('center')
    const rightText = cluster('right')
    if (leftText === '' && centerText === '' && rightText === '') return undefined
    const leftWidth = this.components.visibleWidth(leftText)
    const centerWidth = this.components.visibleWidth(centerText)
    const rightWidth = this.components.visibleWidth(rightText)
    const middleStart = leftWidth + (leftText === '' ? 0 : 2)
    const middleEnd = Math.max(middleStart, width - rightWidth - (rightText === '' ? 0 : 2))
    const idealCenter = Math.max(middleStart, Math.floor((width - centerWidth) / 2))
    const centerStart = Math.min(idealCenter, Math.max(middleStart, middleEnd - centerWidth))
    const line = centerText === '' && rightText === ''
      ? leftText + ' '.repeat(Math.max(0, width - leftWidth))
      : leftText === '' && centerText === ''
        ? ' '.repeat(Math.max(0, width - rightWidth)) + rightText
        : leftText
          + ' '.repeat(Math.max(0, centerStart - leftWidth))
          + centerText
          + ' '.repeat(Math.max(0, width - centerStart - centerWidth - rightWidth))
          + rightText
    return this.components.truncateToWidth(line, width)
  }

  /**
   * Render one entry into at most `width` columns.
   * @returns the painted part, or `''` when it is empty or hides on overflow.
   */
  private renderPart(entry: MayflyStatusEntry, width: number): string {
    const result = compileMayflyStatusNode(entry.node!, {
      components: this.components,
      colors: this.colors,
      getViewport: this.viewport,
      screenMode: 'main',
      maxRows: 1,
    })
    const component = result.ok ? result.value.component : result.errorComponent
    const renderWidth = result.ok && result.value.node.kind === 'text'
      ? Math.max(width, result.value.node.content.length * 2 + 1)
      : width
    const rendered = component.renderStatus(renderWidth)
    const fullPart = (rendered.rows[0] ?? '').replace(/ +$/u, '')
    const fullWidth = this.components.visibleWidth(fullPart)
    if (entry.definition.overflow === 'hide' && (rendered.overflowed || fullWidth > width)) return ''
    return this.components.truncateToWidth(fullPart, width).replace(/ +$/u, '')
  }
}
