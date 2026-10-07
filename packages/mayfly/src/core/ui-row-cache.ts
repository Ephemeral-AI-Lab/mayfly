/** Painted list rows, remembered per admitted item and the state each was painted in.
 * @module @ephemeral-ai/mayfly/core/ui-row-cache
 */
import { countWork, type MayflyWorkCounters } from './ui-work-counters.ts'

/** How many painted variants of one item are kept: its focused, resting, and selected looks at the widths in use. */
const ROW_VARIANTS = 8

/**
 * A surface's memo of painted list rows. An admitted item is immutable, so its row is a function of the item and of the
 * state bits the painter folds in (width, marker, pointer, number, selected, focused); the caller builds that key. A
 * cursor move therefore repaints the two rows whose bits changed. Another palette starts an empty memo, so a theme never
 * serves another theme's colors.
 */
export class UiRowCache {
  private colors: object | undefined
  private rows = new WeakMap<object, Map<string, readonly string[]>>()

  /** The painted row for `item` in the state named by `key`; `paint` runs, and is counted, only on a miss. */
  read(colors: object, item: object, key: string, paint: () => string, counters?: MayflyWorkCounters): string {
    return this.readLines(colors, item, key, () => [paint()], counters)[0]!
  }

  /** The painted lines of `item` (a row with a wrapped label or a body is several) in the state named by `key`. */
  readLines(colors: object, item: object, key: string, paint: () => readonly string[], counters?: MayflyWorkCounters): readonly string[] {
    if (this.colors !== colors) {
      this.colors = colors
      this.rows = new WeakMap()
    }
    let variants = this.rows.get(item)
    if (variants === undefined) {
      variants = new Map()
      this.rows.set(item, variants)
    }
    const known = variants.get(key)
    if (known !== undefined) return known
    const rows = paint()
    countWork(counters, 'rowsPainted', rows.length)
    if (variants.size >= ROW_VARIANTS) variants.delete(variants.keys().next().value!)
    variants.set(key, rows)
    return rows
  }
}
