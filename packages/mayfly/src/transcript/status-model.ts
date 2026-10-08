/** Renderer-owned fixed footer for the direct status registry.
 * @module @ephemeral-ai/mayfly/transcript/status-model
 */
import type { MayflyStatusEntry, MayflyStatusRegistry } from '@ephemeral-ai/mayfly-ui'
import { compileMayflyStatusNode, type MayflyComponent, type MayflyComponents, type MayflySemanticColors, type MayflyViewsSource } from '../core/index.ts'

export type { MayflyStatusEntry } from '@ephemeral-ai/mayfly-ui'

type StatusBand = 'left' | 'center' | 'right'

/**
 * The fixed footer. Each row admits its entries in registry order — priority,
 * then id — across all three bands: an entry takes its full width when it
 * fits the room earlier entries left, otherwise it truncates to that room or,
 * with `overflow: 'hide'`, drops out. Admitted parts then lay out as a left
 * cluster, a centered cluster, and a right-aligned cluster. The summaries of
 * the views lane join row 2 as ordinary entries, and an entered view's panel
 * takes the place of row 2.
 */
export class StatusFooterComponent implements MayflyComponent {
  private cache: { key: string, rows: readonly (string | undefined)[], lines: string[] } | null = null

  constructor(
    private readonly models: MayflyStatusRegistry,
    private readonly components: MayflyComponents,
    private readonly colors: MayflySemanticColors,
    private readonly viewport: () => { readonly columns: number, readonly rows: number } = () => ({ columns: 1, rows: 1 }),
    private readonly views?: MayflyViewsSource,
  ) {}

  invalidate(): void { this.cache = null }

  render(width: number): string[] {
    const { rows, lines } = this.statusRows(width)
    const panel = this.views?.panel(width)
    if (panel === undefined) return lines
    return rows[0] === undefined ? [...panel] : [rows[0], ...panel]
  }

  /** Rows 1 and 2 as painted (`undefined` when empty) and the painted ones as lines; cached by the entries' revisions. */
  private statusRows(width: number): { readonly rows: readonly (string | undefined)[], readonly lines: string[] } {
    const visible = [...this.models.list(), ...(this.views?.statusEntries() ?? [])].filter(model => model.node !== null)
    const sourceKey = `${width}:${visible.map(entry => `${entry.id}:${String(entry.revision)}`).join(',')}`
    if (this.cache?.key === sourceKey) return this.cache
    const rows = [1, 2].map(row => this.renderRow(visible.filter(model => Math.min(2, Math.max(1, model.definition.row ?? 1)) === row), width))
    this.cache = { key: sourceKey, rows, lines: rows.filter((line): line is string => line !== undefined) }
    return this.cache
  }

  /** Admit one row's entries by priority, then lay out the three bands. */
  private renderRow(entries: readonly MayflyStatusEntry[], width: number): string | undefined {
    const admitted = new Map<MayflyStatusEntry, string>()
    let used = 0
    for (const entry of entries) {
      const remaining = width - used - (admitted.size > 0 ? 2 : 0)
      if (remaining <= 0) break
      const part = this.renderPart(entry, remaining)
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
