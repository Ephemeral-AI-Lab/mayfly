/**
 * Rows a component paints on demand instead of all at once. pi-tui's contract is `render(width): string[]`, but its
 * layout reads a leaf's `lines.length` for the height and indexes only the rows it clips; a frozen array facade over a
 * {@link RowSource} therefore flows a window through the native layout with no pi-tui change. A facade remembers the
 * rows it produced while its source's row map stands still, so a second read of a row — the verify pass, a retained
 * hit, a sibling reader — costs nothing; when the map moves ({@link RowSource.revision}) the facade forgets them.
 *
 * The pipes that hand rows along either keep them virtual ({@link concatRows}, {@link mapRows}, {@link sliceRows}) or
 * are bounded by the viewport they paint into. A pipe reads through the arrays it was handed, so a retained
 * component's rows are produced once however many frames read them; the `unclamped` chain a scroll follows to reach a
 * whole document reads through facades that keep a bounded number of rows, so a window over a megabyte never fills a
 * facade without limit. A pipe that needs every row anyway — a width measure, a full marker scan — materializes the facade one row at a time, which is the same work as before for real
 * rows and the failure a windowed design exists to avoid for big content; {@link RowSource.declaredWidth} and the
 * marker hints exist so the common scans never have to.
 *
 * One scan stays pi-tui's own: when the layout gives a leaf fewer rows than it reports, the leaf clip runs
 * `lines.findIndex(line => line.includes(CURSOR_MARKER))` on the array itself and no hint can intercept it. Inside a
 * scroll the child is laid out at its natural height and the clip never fires; outside a scroll a virtual leaf must
 * therefore report a clamped length — the viewport's rows plus its elision row — which the content painters own.
 *
 * @module @ephemeral-ai/mayfly/core/ui-rows
 */

/**
 * What a virtual array reads when a row is asked for. `row(index)` produces the row — wrapping a segment, painting a
 * diff hunk — and the source counts that work.
 */
export interface RowSource {
  /**
   * The rows the source reports. A source with a {@link revision} may change it as estimates become painted counts,
   * so a scroll's `contentHeight` converges to the truth wherever windows have been; a source without one is fixed.
   */
  readonly length: number
  /** Produce row `index`, `0 <= index < length`. */
  row(index: number): string
  /**
   * A counter that grows whenever the row map moves — an estimate became a painted count, a bound changed — so row
   * `i` may now name different text and `length` may differ. Omitted (or undefined) means the source is fixed: its
   * length and rows never change once a facade reads them. Wrappers forward it through a getter, never a spread,
   * which would copy one value and freeze it.
   */
  readonly revision?: number | undefined
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
  /** The indices the facade has materialized under its current revision; the verify pass compares only these. */
  readonly materialized: Set<number>
}

const meta = new WeakMap<readonly string[], RowsMeta>()

const ROW_INDEX = /^(0|[1-9]\d*)$/u

/** A source's row count as an index bound. */
function rowCount(source: RowSource): number {
  return Math.max(0, Math.floor(source.length))
}

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
 * A frozen array facade over `source`: `length` is the source's, and row `i` is produced on first read and kept until
 * the source's revision moves. The facade is an ordinary array to everything that reads it — `slice`, `map`,
 * `findIndex`, `for...of` all go through the same trap, so a full walk paints every row, which is exactly what a
 * caller that walks rows asks for. Freezing throws: a frozen facade could never produce its unread rows, so the
 * failure is loud instead of half-empty.
 */
export function virtualRows(source: RowSource): string[] {
  return facade(source, Number.POSITIVE_INFINITY)
}

/**
 * A facade on the `unclamped` chain keeps at most this many rows, then forgets them and starts over: a retained tree
 * that fits answers every frame from memory, and a scroll across a whole document never holds more than this.
 */
const UNCLAMPED_KEEP = 2_048

function facade(source: RowSource, keep: number): string[] {
  // The backing array starts empty: a facade over a million rows holds only what was read.
  const target: string[] = []
  const materialized = new Set<number>()
  const dynamic = source.revision !== undefined
  let revision = source.revision
  let length = rowCount(source)
  /** The current length; a moved row map drops the rows produced under the old one. */
  const sync = (): number => {
    if (dynamic && source.revision !== revision) {
      revision = source.revision
      length = rowCount(source)
      target.length = 0
      materialized.clear()
    }
    return length
  }
  const produce = (index: number): string => {
    const known = target[index]
    if (known !== undefined) return known
    const row = source.row(index)
    if (materialized.size >= keep) {
      target.length = 0
      materialized.clear()
    }
    target[index] = row
    materialized.add(index)
    return row
  }
  const rows = new Proxy<string[]>(target, {
    get(array, prop, receiver) {
      if (prop === 'length') return sync()
      if (typeof prop === 'string' && ROW_INDEX.test(prop)) {
        const index = Number(prop)
        if (index < sync()) return produce(index)
        return undefined
      }
      return Reflect.get(array, prop, receiver)
    },
    has(array, prop) {
      if (typeof prop === 'string' && ROW_INDEX.test(prop)) return Number(prop) < sync()
      return prop in array
    },
    getOwnPropertyDescriptor(array, prop) {
      if (prop === 'length') return { value: sync(), writable: true, enumerable: false, configurable: false }
      if (typeof prop === 'string' && ROW_INDEX.test(prop)) {
        return Number(prop) < sync() ? { value: produce(Number(prop)), writable: true, enumerable: true, configurable: true } : undefined
      }
      return Reflect.getOwnPropertyDescriptor(array, prop)
    },
    ownKeys(array) {
      // Every index is an own enumerable key, as on a real array: a `toEqual` or `Object.keys` reader gets the
      // same view a full iteration would — which is also what asks for every row to be produced.
      const keys: (string | symbol)[] = []
      for (let index = 0; index < sync(); index += 1) keys.push(String(index))
      for (const key of Reflect.ownKeys(array)) if (typeof key !== 'string' || !ROW_INDEX.test(key)) keys.push(key)
      return keys
    },
    preventExtensions() {
      return false
    },
  })
  meta.set(rows, { source, materialized })
  return rows
}

/** A fixed source over already-painted rows, so every part of a pipe reads through one `RowSource`. */
export function rowsSource(rows: readonly string[]): RowSource {
  return {
    get length() { return rows.length },
    row(index) { return rows[index] ?? '' },
  }
}

/**
 * One input of a pipe: the source that owns its row map, and how one of its rows is read. A part the caller handed
 * over as an array reads through it — a real array's rows, or a facade's — so the rows a retained facade already
 * produced are reused. A part reached through the `unclamped` chain reads through a facade of its own that keeps at
 * most {@link UNCLAMPED_KEEP} rows, memoized with the chain, so a retained tree inside a scroll is painted once while
 * a scroll across a whole document holds a bounded window. A source handed in as a source reads it directly.
 */
interface Part {
  readonly source: RowSource
  read(index: number): string
}

function arrayPart(rows: readonly string[]): Part {
  return { source: rowSourceOf(rows) ?? rowsSource(rows), read: index => rows[index] ?? '' }
}

function sourcePart(source: RowSource): Part {
  return { source, read: index => source.row(index) }
}

function unclampedPart(source: RowSource): Part {
  return arrayPart(facade(source, UNCLAMPED_KEEP))
}

/** The first row at or after `from` whose text contains `marker`, without producing rows a seek can answer. */
function seekPart(part: Part, marker: string, from: number): number {
  const { source } = part
  if (source.markerFree === true) return -1
  if (source.seekMarker !== undefined) return source.seekMarker(marker, Math.max(0, from))
  const length = rowCount(source)
  for (let index = Math.max(0, from); index < length; index += 1) if (part.read(index).includes(marker)) return index
  return -1
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

/** The part holding `index`: the last part whose start is at or before it (empty parts share their successor's start). */
function locatePart(starts: readonly number[], index: number): number {
  let low = 0
  let high = starts.length - 2
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if (starts[middle]! <= index) low = middle
    else high = middle - 1
  }
  return low
}

/** The parts of a concat source, so a concat of concats reads one flat list. */
const concatParts = new WeakMap<RowSource, readonly Part[]>()

/**
 * The rows of `parts` read one after another. Part starts are computed once per revision of the parts that have
 * one, so a row costs a binary search, not a walk over every part; a concat over fixed parts lays itself out once.
 */
function concatOf(input: readonly Part[]): RowSource {
  const parts = input.flatMap(part => concatParts.get(part.source) ?? [part])
  if (parts.length === 0) return { length: 0, declaredWidth: 0, markerFree: true, row: () => '' }
  if (parts.length === 1) return parts[0]!.source
  const sources = parts.map(part => part.source)
  const dynamic = sources.filter(source => source.revision !== undefined)
  const revision = (): number => {
    let total = 0
    for (const source of dynamic) total += source.revision!
    return total
  }
  let starts: number[] = []
  let stamp = 0
  const layout = (): readonly number[] => {
    const now = dynamic.length === 0 ? 0 : revision()
    if (starts.length === 0 || now !== stamp) {
      stamp = now
      starts = []
      let total = 0
      for (const source of sources) {
        starts.push(total)
        total += rowCount(source)
      }
      starts.push(total)
    }
    return starts
  }
  const declaredWidth = sources.every(source => source.declaredWidth !== undefined)
    ? sources.reduce((widest, source) => Math.max(widest, source.declaredWidth!), 0)
    : undefined
  const markerFree = sources.every(source => source.markerFree === true)
  let unclamped: RowSource | null | undefined
  const source: RowSource = {
    get length() { return layout()[parts.length]! },
    get revision() { return dynamic.length === 0 ? undefined : revision() },
    ...(declaredWidth === undefined ? {} : { declaredWidth }),
    ...(markerFree ? { markerFree } : {}),
    get unclamped() {
      if (unclamped === undefined) {
        const inner = parts.map(part => part.source.unclamped === undefined ? part : unclampedPart(part.source.unclamped))
        unclamped = inner.some((part, index) => part !== parts[index]) ? concatOf(inner) : null
      }
      return unclamped ?? undefined
    },
    seekMarker(marker, from) {
      const at = layout()
      for (let part = locatePart(at, Math.max(0, from)); part < parts.length; part += 1) {
        const hit = seekPart(parts[part]!, marker, Math.max(0, from - at[part]!))
        if (hit >= 0) return at[part]! + hit
      }
      return -1
    },
    prepare(from, to) {
      // A prepared part may grow, which moves every part after it: walk on from the live lengths.
      let part = locatePart(layout(), Math.max(0, from))
      let start = layout()[part]!
      for (; part < parts.length && start < to; part += 1) {
        const piece = sources[part]!
        if (start + rowCount(piece) > from) piece.prepare?.(Math.max(0, from - start), to - start)
        start += rowCount(piece)
      }
    },
    row(index) {
      const at = layout()
      const part = locatePart(at, index)
      return parts[part]!.read(index - at[part]!)
    },
  }
  concatParts.set(source, parts)
  return source
}

/** The rows of `sources` read one after another: the source-level form of {@link concatRows}. */
export function concatSources(sources: readonly RowSource[]): RowSource {
  return concatOf(sources.map(sourcePart))
}

/**
 * The rows of the parts as one array: a real concat when every part is real, else a facade that reads through. Runs
 * of adjacent real parts join into one, so a long transcript of plain rows around one windowed card stays a handful
 * of parts.
 */
export function concatRows(...parts: readonly (readonly string[])[]): string[] {
  if (parts.length === 0) return []
  if (parts.length === 1) return parts[0] as string[]
  if (parts.every(part => !isVirtualRows(part))) return parts.flat()
  const pieces: Part[] = []
  let run: (readonly string[])[] = []
  const flush = (): void => {
    if (run.length > 0) pieces.push(arrayPart(run.length === 1 ? run[0]! : run.flat()))
    run = []
  }
  for (const part of parts) {
    if (!isVirtualRows(part)) { if (part.length > 0) run.push(part); continue }
    flush()
    pieces.push(arrayPart(part))
  }
  flush()
  return virtualRows(concatOf(pieces))
}

interface MappedRowsOptions {
  /** The widest row the map produces; omitted means unknown, so a measure reads the rows. */
  readonly declaredWidth?: number
  /**
   * Whether the mapped rows stay marker-free. A facade inherits its source's word; a map that can emit pi-tui's
   * cursor marker or the focus sentinel must pass `false`.
   */
  readonly markerFree?: boolean
}

function mapOf(part: Part, map: (row: string, index: number) => string, options: MappedRowsOptions): RowSource {
  const { source } = part
  const markerFree = options.markerFree ?? source.markerFree === true
  let unclamped: RowSource | null | undefined
  return {
    get length() { return source.length },
    get revision() { return source.revision },
    ...(options.declaredWidth === undefined ? {} : { declaredWidth: options.declaredWidth }),
    ...(markerFree ? { markerFree } : {}),
    get unclamped() {
      if (unclamped === undefined) unclamped = source.unclamped === undefined ? null : mapOf(unclampedPart(source.unclamped), map, options)
      return unclamped ?? undefined
    },
    ...(source.prepare === undefined ? {} : { prepare: source.prepare.bind(source) }),
    ...(source.rowOf === undefined ? {} : { rowOf: source.rowOf.bind(source) }),
    ...(source.offsetOf === undefined ? {} : { offsetOf: source.offsetOf.bind(source) }),
    ...(source.seekMarker === undefined || options.markerFree === false ? {} : {
      // A marker-preserving map keeps a hit's row honest; callers that transform markers opt out through markerFree.
      seekMarker: source.seekMarker.bind(source),
    }),
    row(index) {
      return map(part.read(index), index)
    },
  }
}

/** `source` with `map` applied to each row it produces: the source-level form of {@link mapRows}. */
export function mapSource(source: RowSource, map: (row: string, index: number) => string, options: MappedRowsOptions = {}): RowSource {
  return mapOf(sourcePart(source), map, options)
}

/** `rows.map(map)` that stays a facade: row `i` is `map` of the source's row `i`, painted on first read. */
export function mapRows(rows: readonly string[], map: (row: string, index: number) => string, options: MappedRowsOptions = {}): string[] {
  if (!isVirtualRows(rows)) return rows.map(map)
  return virtualRows(mapOf(arrayPart(rows), map, options))
}

function sliceOf(part: Part, start: number, end: number | undefined): RowSource {
  const { source } = part
  const first = Math.max(0, Math.min(start, rowCount(source)))
  // An `end` that already covers the source's whole length means "the rest": it was derived from the reported
  // length, so an `unclamped` unwrap drops it (the unclamped rest is what the slice meant). A shorter `end` is a
  // deliberate window and keeps its bound through the unwrap.
  const openEnd = end === undefined || end >= source.length
  const bound = (): number => Math.max(first, Math.min(end ?? rowCount(source), rowCount(source)))
  let unclamped: RowSource | null | undefined
  return {
    get length() { return bound() - first },
    get revision() { return source.revision },
    ...(source.markerFree === true ? { markerFree: true } : {}),
    ...(source.declaredWidth === undefined ? {} : { declaredWidth: source.declaredWidth }),
    get unclamped() {
      if (unclamped === undefined) unclamped = source.unclamped === undefined ? null : sliceOf(unclampedPart(source.unclamped), first, openEnd ? undefined : end)
      return unclamped ?? undefined
    },
    seekMarker(marker: string, from: number): number {
      const hit = seekPart(part, marker, first + Math.max(0, from))
      return hit < 0 || hit >= bound() ? -1 : hit - first
    },
    ...(source.prepare === undefined ? {} : {
      prepare(from: number, to: number): void {
        source.prepare!(first + Math.max(0, from), Math.min(bound(), first + to))
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
      return part.read(first + index)
    },
  }
}

/** `rows.slice(start, end)` that stays a facade: a window into the same source, no rows copied. */
export function sliceRows(rows: readonly string[], start: number, end?: number): string[] {
  if (!isVirtualRows(rows)) return rows.slice(start, end)
  return virtualRows(sliceOf(arrayPart(rows), start, end))
}

/** `n` blank rows as a facade: nothing to paint, marker-free, zero columns wide. */
export function blankRows(n: number): string[] {
  return virtualRows({ length: n, declaredWidth: 0, markerFree: true, row: () => '' })
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
  // A real array's rows all exist; a facade's known rows are the ones it materialized. Reading may move a revision
  // and clear a set, so each walks a copy.
  if (leftMeta === undefined) { for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false }
  else for (const index of Array.from(leftMeta.materialized)) if (left[index] !== right[index]) return false
  if (rightMeta === undefined) { for (let index = 0; index < right.length; index += 1) if (left[index] !== right[index]) return false }
  else for (const index of Array.from(rightMeta.materialized)) if (left[index] !== right[index]) return false
  return true
}
