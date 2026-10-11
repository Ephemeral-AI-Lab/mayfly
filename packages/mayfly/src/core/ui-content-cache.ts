/**
 * The D33 cache of painted segment rows: one per renderer, shared by every surface runtime and node slot it mounts,
 * keyed by `(node, segment, width)`. Eviction is least-recently-used by byte cost and never raises an error — the
 * freshest {@link MAYFLY_CONTENT_CACHE_KEEP} entries are exempt so rows a frame is painting are never evicted, and
 * everything older falls out first. A row source keeps no painted rows of its own, so the cache is the single bound
 * on derived-row memory; an evicted segment simply repaints the next time a window lands on it.
 *
 * @module @ephemeral-ai/mayfly/core/ui-content-cache
 */

/** Total painted rows the cache retains; sized from the 2c measurements (roadmap D33). */
export const MAYFLY_CONTENT_CACHE_BYTES = 64 * 1024 * 1024

/** Entries exempt from eviction: the working set of every live window, with generous headroom. */
export const MAYFLY_CONTENT_CACHE_KEEP = 128

interface ContentCacheEntry {
  readonly rows: readonly string[]
  readonly bytes: number
}

/** The estimated byte cost of one painted row set: UTF-16 contents plus array/string overhead. */
export function paintedRowsBytes(rows: readonly string[]): number {
  let bytes = 64
  for (const row of rows) bytes += row.length * 2 + 40
  return bytes
}

export class MayflyContentCache {
  private readonly entries = new Map<string, ContentCacheEntry>()
  private total = 0

  constructor(private readonly byteBudget: number = MAYFLY_CONTENT_CACHE_BYTES) {}

  /** Entries currently retained; the byte cost they sum to stays within the budget once it is met. */
  get size(): number { return this.entries.size }
  get bytes(): number { return this.total }

  /** The painted rows for `key`, refreshed to most-recently-used, or undefined. */
  get(key: string): readonly string[] | undefined {
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return entry.rows
  }

  /** Store the painted rows for `key`, evicting cold entries until the byte budget is met. */
  put(key: string, rows: readonly string[], bytes: number): void {
    const held = this.entries.get(key)
    if (held !== undefined) { this.total -= held.bytes; this.entries.delete(key) }
    this.entries.set(key, { rows, bytes })
    this.total += bytes
    // Evict from the cold end; the newest KEEP entries stay, so the rows a frame paints are never evicted.
    for (const [evictKey, entry] of this.entries) {
      if (this.total <= this.byteBudget) break
      if (this.entries.size <= MAYFLY_CONTENT_CACHE_KEEP) break
      this.entries.delete(evictKey)
      this.total -= entry.bytes
    }
  }
}
