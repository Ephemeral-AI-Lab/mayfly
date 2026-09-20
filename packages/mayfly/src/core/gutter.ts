/**
 * The kimi `GutterContainer` equivalent (D29, consumed in S21): a
 * component wrapper that insets its child by a one-column gutter on both
 * sides without the child knowing. The child renders at `width - 2*n`
 * (the squeeze is the right margin) and every row gains `n` leading
 * columns through the chrome layer's pure `padColumns` — styling
 * untouched. The wrapped children are the passive transcript and dock
 * surfaces; the editor, dialogs, and overlays stay full-width, so nothing
 * focusable passes through.
 *
 * @module @ephemeral-ai/mayfly/core/gutter
 */

import type { MayflyComponent } from './types.ts'
import { clampRowsToWidth, padColumns } from './chrome.ts'
import { truncateToWidth } from './width.ts'

/**
 * Renders one wrapped child inside the kimi one-column gutter. The padded
 * rows are reused by identity while the child returns the same array at the
 * same width, so a cached child stays cached through the wrapper.
 */
export class GutterComponent implements MayflyComponent {
  private cached: { readonly width: number, readonly source: readonly string[], readonly rows: string[] } | undefined

  /**
   * @param child - the component to inset; a passive surface (no input).
   * @param n - the gutter width in columns; defaults to 1.
   */
  constructor(
    private readonly child: MayflyComponent,
    private readonly n = 1,
  ) {}

  /**
   * Render the child squeezed by both gutters and inset by the left one.
   * The child width floors at one column (a degenerate viewport during a
   * resize drag must not hand children a zero or negative width, and a
   * wide character cannot fit below two). Rows are cut only in that
   * degenerate regime — a viewport too narrow for the gutter furniture
   * itself; wider viewports emit the child's rows untouched (D48).
   * @param width - current viewport width in columns.
   * @returns the child's rows, squeezed, gutter-padded, width-bounded.
   */
  render(width: number): string[] {
    const inner = Math.max(1, width - 2 * this.n)
    const source = this.child.render(inner)
    const cached = this.cached
    if (cached?.width === width && cached.source === source) return cached.rows
    const padded = padColumns(source, this.n)
    const rows = width >= 2 * this.n + 2
      ? padded
      : clampRowsToWidth(padded, Math.max(1, width), (text, target) => truncateToWidth(text, target))
    this.cached = { width, source, rows }
    return rows
  }

  /** Forward the cache drop to the wrapped child. */
  invalidate(): void {
    this.child.invalidate()
  }
}
