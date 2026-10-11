/**
 * Rows a component paints on demand instead of all at once. pi-tui's contract is `render(width): string[]`, but its
 * layout reads a leaf's `lines.length` for the height and indexes only the rows it clips; a frozen array facade over a
 * {@link RowSource} therefore flows a window through the native layout with no pi-tui change. Every row read is
 * materialized once into the facade's own backing array, so a second read of a row — the verify pass, a retained hit,
 * a sibling pipe — costs nothing.
 *
 * The pipes that hand rows along either keep them virtual ({@link concatRows}, {@link mapRows}, {@link sliceRows}) or
 * are bounded by the viewport they paint into. A pipe that needs every row anyway — a width measure, a full marker
 * scan — materializes the facade one row at a time, which is the same work as before for real rows and the failure a
 * windowed design exists to avoid for big content; {@link RowSource.declaredWidth} and the marker hints exist so the
 * common scans never have to.
 *
 * One scan stays pi-tui's own: when the layout gives a leaf fewer rows than it reports, the leaf clip runs
 * `lines.findIndex(line => line.includes(CURSOR_MARKER))` on the array itself and no hint can intercept it. Inside a
 * scroll the child is laid out at its natural height and the clip never fires; outside a scroll a virtual leaf must
 * therefore report a clamped length — the viewport's rows plus its elision row — which the content painters own.
 *
 * @module @ephemeral-ai/mayfly/core/ui-rows
 */

/**
 * What a virtual array reads when a row is asked for. `row(index)` is called once per index per facade; producing the
 * row — wrapping a segment, painting a diff hunk — is the source's work and the source counts it.
 */
export interface RowSource {
  /**
   * The rows the facade reports, read live: a segmented source raises its length as estimates become painted counts,
   * so a scroll's `contentHeight` converges to the truth wherever windows have been.
   */
  readonly length: number
  /** Produce row `index`, `0 <= index < length`. */
  row(index: number): string
  /** The widest row in columns, when the source can answer without painting; a measure uses it instead of scanning. */
  readonly declaredWidth?: number
  /** True when no row can contain pi-tui's cursor marker or the focus sentinel, so a marker scan may skip the array. */
  readonly markerFree?: boolean
  /** The first index at or after `from` whose row contains `marker`; `-1` when none. Default scans row by row. */
  seekMarker?(marker: string, from: number): number
  /**
   * Warm the rows `[from, to)` before a frame reads them: a segmented painter produces the segments under the window,
   * replacing their estimates with painted counts so the row map is exact where it is seen.
   */
  prepare?(from: number, to: number): void
  /**
   * The same rows with the outside-window elision bound removed, when this source was clamped to a viewport. A scroll
   * reads it to reach the full content; combinators unwrap their parts, so the chain survives concatenation, mapping,
   * and slicing.
   */
  readonly unclamped?: RowSource | undefined
  /**
   * Rows of this source's document estimated (or, where painted, known) to stand before `offset` units of the text
   * the source was built over. Only sources that index a text can map positions; document anchors ride this map so
   * a scroll position stays a source position instead of a re-wrapped guess.
   */
  rowOf?(offset: number): number
  /** The inverse of {@link rowOf} under the same model: the text offset `row` begins at. */
  offsetOf?(row: number): number
}

interface RowsMeta {
  readonly source: RowSource
  /** The indices the facade has materialized so far; the verify pass compares only these. */
  readonly materialized: Set<number>
}

const meta = new WeakMap<readonly string[], RowsMeta>()

const ROW_INDEX = /^(0|[1-9]\d*)$/u

/** Whether `rows` is a virtual facade. */
export function isVirtualRows(rows: readonly string[]): boolean {
  return meta.has(rows)
}

/** The source a facade reads, when `rows` is virtual. */
export function rowSourceOf(rows: readonly string[]): RowSource | undefined {
  return meta.get(rows)?.source
}

/** The width a measure may use without reading rows: the declared width of a virtual array. */
export function declaredWidthOf(rows: readonly string[]): number | undefined {
  return meta.get(rows)?.source.declaredWidth
}

/** How many rows of `rows` have been materialized so far; a real array reports its length. */
export function materializedRows(rows: readonly string[]): number {
  return meta.get(rows)?.materialized.size ?? rows.length
}

/**
 * A frozen array facade over `source`: `length` is real and row `i` is produced on first read. The facade is an
 * ordinary array to everything that reads it — `slice`, `map`, `findIndex`, `for...of` all go through the same trap,
 * so a full walk paints every row, which is exactly what a caller that walks rows asks for. Freezing throws: a frozen
 * facade could never produce its unread rows, so the failure is loud instead of half-empty.
 */
export function virtualRows(source: RowSource): string[] {
  const liveLength = (): number => Math.max(Math.max(0, Math.floor(source.length)), target.length)
  const target = new Array<string>(Math.max(0, Math.floor(source.length)))
  const materialized = new Set<number>()
  const produce = (index: number): string => {
    const known = target[index]
    if (known !== undefined) return known
    const row = source.row(index)
    target[index] = row
    materialized.add(index)
    return row
  }
  const rows = new Proxy<string[]>(target, {
    get(array, prop, receiver) {
      if (prop === 'length') return liveLength()
      if (typeof prop === 'string' && ROW_INDEX.test(prop)) {
        const index = Number(prop)
        if (index < liveLength()) return produce(index)
      }
      return Reflect.get(array, prop, receiver)
    },
    has(array, prop) {
      if (typeof prop === 'string' && ROW_INDEX.test(prop)) return Number(prop) < liveLength() || prop in array
      return prop in array
    },
    getOwnPropertyDescriptor(array, prop) {
      if (prop === 'length') return { value: liveLength(), writable: true, enumerable: false, configurable: false }
      if (typeof prop === 'string' && ROW_INDEX.test(prop) && Number(prop) < liveLength()) {
        return { value: produce(Number(prop)), writable: true, enumerable: true, configurable: true }
      }
      return Reflect.getOwnPropertyDescriptor(array, prop)
    },
    ownKeys(array) {
      // Every index is an own enumerable key, as on a real array: a `toEqual` or `Object.keys` reader gets the
      // same view a full iteration would — which is also what asks for every row to be produced.
      const keys = new Set<string | symbol>()
      for (let index = 0; index < liveLength(); index += 1) keys.add(String(index))
      for (const key of Reflect.ownKeys(array)) keys.add(key)
      return [...keys]
    },
    preventExtensions() {
      return false
    },
  })
  meta.set(rows, { source, materialized })
  return rows
}

function seekIn(rows: readonly string[], marker: string, from: number): number {
  for (let index = Math.max(0, from); index < rows.length; index += 1) if (rows[index]!.includes(marker)) return index
  return -1
}

/**
 * The first row at or after `from` that contains `marker`, `-1` when none. A virtual array whose source rules the
 * marker out answers without a read; a concat or slice delegates to its parts, so a marker-free document inside a
 * bordered surface is skipped whole while the small real rows around it are still searched.
 */
export function findMarkerRow(rows: readonly string[], marker: string, from = 0): number {
  const source = rowSourceOf(rows)
  if (source === undefined) return seekIn(rows, marker, from)
  if (source.markerFree === true) return -1
  if (source.seekMarker !== undefined) return source.seekMarker(marker, from)
  return seekIn(rows, marker, from)
}

/** The rows of the parts as one array: a real concat when every part is real, else a facade that reads through. */
export function concatRows(...parts: readonly (readonly string[])[]): string[] {
  if (parts.length === 0) return []
  if (parts.length === 1) return parts[0] as string[]
  if (parts.every(part => !isVirtualRows(part))) return parts.flat()
  // Part lengths are read live: a segmented part grows as its estimates become painted counts.
  const last = parts.length - 1
  const locate = (index: number): { part: number, start: number } => {
    let start = 0
    for (let part = 0; part <= last; part += 1) {
      const next = start + parts[part]!.length
      if (index < next || part === last) return { part, start }
      start = next
    }
    return { part: last, start }
  }
  const markerFree = parts.every(part => rowSourceOf(part)?.markerFree === true)
  let unclamped: RowSource | null | undefined
  return virtualRows({
    get length() {
      let total = 0
      for (const part of parts) total += part.length
      return total
    },
    ...(markerFree ? { markerFree } : {}),
    get unclamped() {
      if (unclamped === undefined) {
        const inner = parts.map(part => {
          const source = rowSourceOf(part)?.unclamped
          return source === undefined ? part : virtualRows(source)
        })
        unclamped = inner.some((part, index) => part !== parts[index]) ? rowSourceOf(concatRows(...inner))! : null
      }
      return unclamped ?? undefined
    },
    seekMarker(marker, from) {
      let start = 0
      for (const part of parts) {
        const end = start + part.length
        if (from < end) {
          const source = rowSourceOf(part)
          const at = Math.max(0, from - start)
          if (source === undefined) {
            const hit = seekIn(part, marker, at)
            if (hit >= 0) return start + hit
          } else if (source.markerFree !== true) {
            const hit = source.seekMarker === undefined ? seekIn(part, marker, at) : source.seekMarker(marker, at)
            if (hit >= 0) return start + hit
          }
          from = end
        }
        start = end
      }
      return -1
    },
    prepare(from, to) {
      let start = 0
      for (const part of parts) {
        const end = start + part.length
        if (to > start && from < end) {
          const source = rowSourceOf(part)
          source?.prepare?.(Math.max(0, from - start), Math.min(part.length, to - start))
        }
        start = end
      }
    },
    row(index) {
      const { part, start } = locate(index)
      return parts[part]![index - start] ?? ''
    },
  })
}

export interface MappedRowsOptions {
  /** The widest row the map produces; omitted means unknown, so a measure reads the rows. */
  readonly declaredWidth?: number
  /**
   * Whether the mapped rows stay marker-free. A facade inherits its source's word; a map that can emit pi-tui's
   * cursor marker or the focus sentinel must pass `false`.
   */
  readonly markerFree?: boolean
}

/** `rows.map(map)` that stays a facade: row `i` is `map` of the source's row `i`, painted on first read. */
export function mapRows(rows: readonly string[], map: (row: string, index: number) => string, options: MappedRowsOptions = {}): string[] {
  const source = rowSourceOf(rows)
  if (source === undefined) return rows.map(map)
  const markerFree = options.markerFree ?? source.markerFree === true
  const sourcePrepare = source.prepare?.bind(source)
  let unclamped: RowSource | null | undefined
  return virtualRows({
    get length() {
      return rows.length
    },
    ...(options.declaredWidth === undefined ? {} : { declaredWidth: options.declaredWidth }),
    ...(markerFree ? { markerFree } : {}),
    get unclamped() {
      if (unclamped === undefined) {
        const inner = source.unclamped
        unclamped = inner === undefined ? null : rowSourceOf(mapRows(virtualRows(inner), map, options))!
      }
      return unclamped ?? undefined
    },
    ...(sourcePrepare === undefined ? {} : { prepare: sourcePrepare }),
    ...(source.rowOf === undefined ? {} : { rowOf: source.rowOf.bind(source) }),
    ...(source.offsetOf === undefined ? {} : { offsetOf: source.offsetOf.bind(source) }),
    ...(source.seekMarker === undefined || options.markerFree === false ? {} : {
      // A marker-preserving map keeps a hit's row honest; callers that transform markers opt out through markerFree.
      seekMarker: source.seekMarker.bind(source),
    }),
    row(index) {
      return map(rows[index]!, index)
    },
  })
}

/** `rows.slice(start, end)` that stays a facade: a window into the same source, no rows copied. */
export function sliceRows(rows: readonly string[], start: number, end?: number): string[] {
  const source = rowSourceOf(rows)
  if (source === undefined) return rows.slice(start, end)
  const first = Math.max(0, Math.min(start, rows.length))
  // An `end` that already covers the source's whole length means "the rest": it was derived from the reported
  // length, so an `unclamped` unwrap drops it (the unclamped rest is what the slice meant). A shorter `end` is a
  // deliberate window and keeps its bound through the unwrap.
  const openEnd = end === undefined || end >= rows.length
  const bound = (): number => Math.max(first, Math.min(end ?? rows.length, rows.length))
  const sourceSeek = source.seekMarker?.bind(source)
  const sourcePrepare = source.prepare?.bind(source)
  let unclamped: RowSource | null | undefined
  return virtualRows({
    get length() {
      return bound() - first
    },
    ...(source.markerFree === true ? { markerFree: true } : {}),
    ...(source.declaredWidth === undefined ? {} : { declaredWidth: source.declaredWidth }),
    get unclamped() {
      if (unclamped === undefined) {
        const inner = source.unclamped
        unclamped = inner === undefined ? null : rowSourceOf(sliceRows(virtualRows(inner), first, openEnd ? undefined : end))!
      }
      return unclamped ?? undefined
    },
    ...(sourceSeek === undefined ? {} : {
      seekMarker(marker: string, from: number): number {
        const hit = sourceSeek(marker, first + Math.max(0, from))
        return hit < 0 || hit >= bound() ? -1 : hit - first
      },
    }),
    ...(sourcePrepare === undefined ? {} : {
      prepare(from: number, to: number): void {
        sourcePrepare(first + Math.max(0, from), Math.min(bound(), first + to))
      },
    }),
    ...(source.rowOf === undefined ? {} : {
      rowOf(offset: number): number {
        return Math.max(0, source.rowOf!(offset) - first)
      },
    }),
    ...(source.offsetOf === undefined ? {} : {
      offsetOf(row: number): number {
        return source.offsetOf!(first + Math.max(0, row))
      },
    }),
    row(index) {
      return rows[first + index]!
    },
  })
}

/** `n` blank rows as a facade: nothing to paint, marker-free, zero columns wide. */
export function blankRows(n: number): string[] {
  return virtualRows({ length: n, declaredWidth: 0, markerFree: true, row: () => '' })
}

/** A trivial source over already-painted rows, so a leaf can answer every kind through one `RowSource`. */
export function rowsSource(rows: readonly string[]): RowSource {
  return {
    get length() { return rows.length },
    row(index) { return rows[index] ?? '' },
  }
}

/** Warm the rows `[from, to)` of a possibly virtual array before a frame reads them; a no-op on real rows. */
export function prepareRows(rows: readonly string[], from: number, to: number): void {
  rowSourceOf(rows)?.prepare?.(from, to)
}

/**
 * `rows` with the outside-window elision bound lifted: a scroll hands itself the unbounded facade so its window can
 * reach every row of a leaf the viewport alone would have clamped. Real rows and unclamped facades answer themselves.
 */
export function unclampedRows(rows: readonly string[]): string[] {
  const unclamped = rowSourceOf(rows)?.unclamped
  return unclamped === undefined ? rows as string[] : virtualRows(unclamped)
}

/**
 * Whether two row arrays agree — the `retain` verify pass. Real arrays compare row by row; a facade compares only the
 * indices either side has materialized, so verifying a window repaints the window, not the document.
 */
export function sameMaterializedRows(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) return true
  if (left.length !== right.length) return false
  const leftMeta = meta.get(left)
  const rightMeta = meta.get(right)
  if (leftMeta === undefined && rightMeta === undefined) return left.every((row, index) => row === right[index])
  // A real array's rows all exist; a facade's known rows are the ones it materialized.
  if (leftMeta === undefined) { for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false }
  else for (const index of leftMeta.materialized) if (left[index] !== right[index]) return false
  if (rightMeta === undefined) { for (let index = 0; index < right.length; index += 1) if (left[index] !== right[index]) return false }
  else for (const index of rightMeta.materialized) if (left[index] !== right[index]) return false
  return true
}
