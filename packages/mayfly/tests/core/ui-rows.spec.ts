/** The virtual rows facade: array semantics a pipe can rely on, and laziness a windowed source counts on. */
import { describe, expect, it } from 'vitest'
import {
  blankRows,
  concatRows,
  concatSources,
  declaredWidthOf,
  findMarkerRow,
  isVirtualRows,
  materializedRows,
  mapRows,
  mapSource,
  prepareRows,
  rowSourceOf,
  sameMaterializedRows,
  sliceRows,
  unclampedRows,
  virtualRows,
  type RowSource,
} from '../../src/core/ui-rows.ts'

/** A source that counts its reads and answers `row ${index}`. */
function counting(length: number, extras: Partial<RowSource> = {}): RowSource & { readonly reads: number[] } {
  const reads: number[] = []
  return {
    reads,
    length,
    row: index => { reads.push(index); return `row ${String(index)}` },
    ...extras,
  }
}

describe('virtualRows', () => {
  it('behaves as an array: length, index, slice, map, iteration, join', () => {
    const rows = virtualRows(counting(4))
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBe(4)
    expect(rows[2]).toBe('row 2')
    expect(rows.slice(1, 3)).toEqual(['row 1', 'row 2'])
    expect(rows.map(row => row.toUpperCase())).toEqual(['ROW 0', 'ROW 1', 'ROW 2', 'ROW 3'])
    expect([...rows]).toEqual(['row 0', 'row 1', 'row 2', 'row 3'])
    expect(rows.join('|')).toBe('row 0|row 1|row 2|row 3')
    expect(rows.at(-1)).toBe('row 3')
    expect(rows.findIndex(row => row === 'row 2')).toBe(2)
  })

  it('produces a row once and remembers it', () => {
    const source = counting(10)
    const rows = virtualRows(source)
    expect(rows[4]).toBe('row 4')
    expect(rows[4]).toBe('row 4')
    expect(source.reads).toEqual([4])
    expect(materializedRows(rows)).toBe(1)
    expect(rows[9]).toBe('row 9')
    expect(source.reads).toEqual([4, 9])
    expect(materializedRows(rows)).toBe(2)
  })

  it('reads only the rows a slice asks for', () => {
    const source = counting(1_000_000)
    const rows = virtualRows(source)
    expect(rows.slice(500_000, 500_005)).toEqual([500_000, 500_001, 500_002, 500_003, 500_004].map(index => `row ${String(index)}`))
    expect(source.reads).toEqual([500_000, 500_001, 500_002, 500_003, 500_004])
  })

  it('drops what it produced when the revision moves, and follows the length both ways', () => {
    let revision = 0
    let length = 4
    let label = 'a'
    const rows = virtualRows({ get length() { return length }, get revision() { return revision }, row: index => `${label}${String(index)}` })
    expect([...rows]).toEqual(['a0', 'a1', 'a2', 'a3'])
    // Unchanged revision: the rows already produced answer, whatever the source would say now.
    label = 'b'
    expect(rows[1]).toBe('a1')
    revision += 1
    length = 2
    expect(rows.length).toBe(2)
    expect([...rows]).toEqual(['b0', 'b1'])
    expect(rows[3]).toBeUndefined()
    revision += 1
    length = 3
    expect([...rows]).toEqual(['b0', 'b1', 'b2'])
  })

  it('answers the descriptors of an array: rows below its length, no row past it, and its own properties', () => {
    const rows = virtualRows(counting(3))
    expect(Object.getOwnPropertyDescriptor(rows, '1')).toEqual({ value: 'row 1', writable: true, enumerable: true, configurable: true })
    expect(Object.getOwnPropertyDescriptor(rows, '3')).toBeUndefined()
    expect(Object.getOwnPropertyDescriptor(rows, 'length')).toEqual({ value: 3, writable: true, enumerable: false, configurable: false })
    expect(Object.getOwnPropertyDescriptor(rows, 'note')).toBeUndefined()
    expect(Object.keys(rows)).toEqual(['0', '1', '2'])
    expect(3 in rows).toBe(false)
    expect('map' in rows).toBe(true)
  })

  it('refuses to be frozen, because a frozen facade could never produce its unread rows', () => {
    const rows = virtualRows(counting(3))
    expect(() => Object.freeze(rows)).toThrow(TypeError)
    expect(() => Object.preventExtensions(rows)).toThrow(TypeError)
  })

  it('reports its source', () => {
    const source = counting(3, { declaredWidth: 40 })
    const rows = virtualRows(source)
    expect(isVirtualRows(rows)).toBe(true)
    expect(rowSourceOf(rows)).toBe(source)
    expect(declaredWidthOf(rows)).toBe(40)
    expect(isVirtualRows(['a'])).toBe(false)
    expect(rowSourceOf(['a'])).toBeUndefined()
    expect(declaredWidthOf(['a'])).toBeUndefined()
  })
})

describe('materializedRows', () => {
  it('counts the rows a facade has produced, and a real array has all of them', () => {
    const rows = virtualRows(counting(10))
    expect(materializedRows(rows)).toBe(0)
    expect(rows[2]).toBe('row 2')
    expect(materializedRows(rows)).toBe(1)
    expect(materializedRows(['a', 'b', 'c'])).toBe(3)
  })
})

describe('concatSources', () => {
  it('reads sources one after another, and no sources at all as no rows', () => {
    const none = concatSources([])
    expect(none).toMatchObject({ length: 0, declaredWidth: 0, markerFree: true })
    expect(none.row(0)).toBe('')
    const joined = virtualRows(concatSources([counting(2), counting(1)]))
    expect([...joined]).toEqual(['row 0', 'row 1', 'row 0'])
    // One source is itself.
    const only = counting(2)
    expect(concatSources([only])).toBe(only)
  })

  it('has no unclamped form when no part has one, and prepares nothing past its end', () => {
    const prepared: [number, number][] = []
    const parts = [counting(2, { prepare: (from, to) => { prepared.push([from, to]) } }), counting(3)]
    const rows = virtualRows(concatSources(parts))
    expect(rowSourceOf(rows)?.unclamped).toBeUndefined()
    expect(unclampedRows(rows)).toBe(rows)
    prepareRows(rows, 100, 110)
    expect(prepared).toEqual([])
    prepareRows(rows, 1, 4)
    expect(prepared).toEqual([[1, 4]])
  })
})

describe('concatRows', () => {
  it('returns a real array when every part is real', () => {
    const rows = concatRows(['a'], ['b', 'c'])
    expect(isVirtualRows(rows)).toBe(false)
    expect(rows).toEqual(['a', 'b', 'c'])
  })

  it('returns the part itself when there is exactly one', () => {
    const rows = virtualRows(counting(2))
    expect(concatRows(rows)).toBe(rows)
    expect(concatRows(['x'])).toEqual(['x'])
  })

  it('stays a facade over its parts and reads only the row asked for', () => {
    const head = counting(3)
    const body = counting(1_000_000, { markerFree: true })
    const tail = counting(2)
    const rows = concatRows(virtualRows(head), virtualRows(body), virtualRows(tail))
    expect(rows.length).toBe(1_000_005)
    expect(isVirtualRows(rows)).toBe(true)
    expect(rows[0]).toBe('row 0')
    expect(rows[500_000]).toBe('row 499997')
    expect(rows[1_000_004]).toBe('row 1')
    expect(head.reads).toEqual([0])
    expect(body.reads).toEqual([499_997])
    expect(tail.reads).toEqual([1])
  })

  it('reads through the arrays it is handed, so a retained part produces a row once for every pipe', () => {
    const source = counting(1_000)
    const part = virtualRows(source)
    expect(concatRows(['head'], part)[500]).toBe('row 499')
    expect(concatRows(['other head'], part)[500]).toBe('row 499')
    expect(source.reads).toEqual([499])
    expect(materializedRows(part)).toBe(1)
  })

  it('joins runs of real parts and flattens a concat of concats', () => {
    const middle = virtualRows(counting(3))
    const inner = concatRows(['a'], middle)
    const rows = concatRows(...Array.from({ length: 200 }, (_, index) => [`p${String(index)}`]), inner, ['z'])
    expect(rows.length).toBe(205)
    expect(rows[0]).toBe('p0')
    expect(rows[199]).toBe('p199')
    expect(rows[200]).toBe('a')
    expect(rows[203]).toBe('row 2')
    expect(rows[204]).toBe('z')
  })

  it('moves with a part whose row map moves', () => {
    let revision = 0
    let length = 2
    const grows = virtualRows({ get length() { return length }, get revision() { return revision }, row: index => `g${String(index)}` })
    const rows = concatRows(['head'], grows, ['tail'])
    expect([...rows]).toEqual(['head', 'g0', 'g1', 'tail'])
    revision += 1
    length = 3
    expect([...rows]).toEqual(['head', 'g0', 'g1', 'g2', 'tail'])
    expect(rowSourceOf(rows)!.revision).toBe(1)
  })

  it('reads parts in sequence as rows are read in sequence', () => {
    const body = counting(10)
    const rows = concatRows(virtualRows(body))
    expect([...rows].length).toBe(10)
    expect(body.reads).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })
})

describe('mapRows', () => {
  it('maps a real array eagerly and a facade lazily', () => {
    expect(mapRows(['a'], row => `${row}!`)).toEqual(['a!'])
    const source = counting(5)
    const rows = mapRows(virtualRows(source), row => `<${row}>`)
    expect(isVirtualRows(rows)).toBe(true)
    expect(source.reads).toEqual([])
    expect(rows[2]).toBe('<row 2>')
    expect(source.reads).toEqual([2])
  })

  it('forwards a moving revision through map and slice instead of freezing it', () => {
    let revision = 0
    const source: RowSource = { length: 5, get revision() { return revision }, row: index => `r${String(index)}` }
    const mapped = rowSourceOf(mapRows(virtualRows(source), row => row))!
    const sliced = rowSourceOf(sliceRows(virtualRows(source), 1, 3))!
    revision = 7
    expect(mapped.revision).toBe(7)
    expect(sliced.revision).toBe(7)
    expect(rowSourceOf(mapRows(virtualRows(counting(2)), row => row))!.revision).toBeUndefined()
  })

  it('keeps the declared width it is given', () => {
    const rows = mapRows(virtualRows(counting(2)), row => `${row}|`, { declaredWidth: 8 })
    expect(declaredWidthOf(rows)).toBe(8)
  })
})

describe('mapSource', () => {
  it('has no unclamped form when its source has none', () => {
    const mapped = mapSource(counting(3), row => row.toUpperCase())
    expect(mapped.unclamped).toBeUndefined()
    expect(virtualRows(mapped).slice()).toEqual(['ROW 0', 'ROW 1', 'ROW 2'])
  })
})

describe('sliceRows', () => {
  it('slices a real array eagerly and a facade lazily', () => {
    expect(sliceRows(['a', 'b', 'c'], 1)).toEqual(['b', 'c'])
    const source = counting(1_000_000)
    const rows = sliceRows(virtualRows(source), 999_990)
    expect(rows.length).toBe(10)
    expect(isVirtualRows(rows)).toBe(true)
    expect(rows[3]).toBe('row 999993')
    expect(source.reads).toEqual([999_993])
  })

  it('clamps out-of-range bounds', () => {
    const rows = sliceRows(virtualRows(counting(4)), 2, 99)
    expect(rows.length).toBe(2)
    expect([...rows]).toEqual(['row 2', 'row 3'])
  })
})

describe('unclampedRows', () => {
  /** A source clamped to `cap` rows plus its elision row, like a bounded leaf's. */
  function clamped(inner: RowSource, cap: number): RowSource {
    return {
      get length() { return inner.length <= cap ? inner.length : cap + 1 },
      get unclamped() { return inner },
      row(index) { return index < cap ? inner.row(index) : '…more' },
    }
  }

  it('answers the same rows when the source has no bound', () => {
    const rows = virtualRows(counting(10))
    expect(unclampedRows(rows)).toBe(rows)
    expect(unclampedRows(['a', 'b'])).toEqual(['a', 'b'])
  })

  it('lifts the bound through concat and map', () => {
    const leaf = virtualRows(clamped(counting(500), 20))
    const rows = mapRows(concatRows(['head'], leaf), row => row)
    expect(rows.length).toBe(22)
    const lifted = unclampedRows(rows)
    expect(lifted.length).toBe(501)
    expect(lifted[500]).toBe('row 499')
  })

  it('follows the unclamped chain over sources, so a scroll never fills the clamped facade', () => {
    const leaf = virtualRows(clamped(counting(500), 20))
    const lifted = unclampedRows(mapRows(concatRows(['head'], leaf), row => row))
    expect(lifted[400]).toBe('row 399')
    expect(materializedRows(leaf)).toBe(0)
  })

  it('answers a retained tree from memory on the next frame, and keeps only a bounded window of a long one', () => {
    // A scroll asks for `unclampedRows` every frame; the chain is memoized with the parent it unwraps.
    const small = counting(100)
    const tree = mapRows(concatRows(['head'], virtualRows(clamped(small, 20))), row => row)
    for (let frame = 0; frame < 3; frame += 1) {
      const lifted = unclampedRows(tree)
      for (let index = 0; index < lifted.length; index += 1) void lifted[index]
    }
    expect(small.reads).toHaveLength(100)
    const long = counting(10_000)
    const document = mapRows(concatRows(['head'], virtualRows(clamped(long, 20))), row => row)
    for (let frame = 0; frame < 2; frame += 1) {
      const lifted = unclampedRows(document)
      for (let index = 0; index < lifted.length; index += 1) void lifted[index]
    }
    // Every row of the second walk was produced again: the chain forgot the first walk instead of keeping it all.
    expect(long.reads).toHaveLength(20_000)
  })

  it('maps text offsets through a slice by the rows it skips, and never to a row before its first', () => {
    const indexed = counting(10, { rowOf: offset => Math.floor(offset / 10), offsetOf: row => row * 10 })
    const window = rowSourceOf(sliceRows(virtualRows(indexed), 4, 8))!
    expect(window.length).toBe(4)
    expect(window.rowOf!(65)).toBe(2)
    expect(window.rowOf!(5)).toBe(0)
    expect(window.offsetOf!(2)).toBe(60)
    expect(window.offsetOf!(-3)).toBe(40)
  })

  it('has no unclamped form when its source has none', () => {
    const slice = rowSourceOf(sliceRows(virtualRows(counting(10)), 2, 6))!
    expect(slice.unclamped).toBeUndefined()
  })

  it('drops a slice end that covered the source, keeps a deliberate window', () => {
    const source = clamped(counting(500), 20)
    // A stack's allocation slice is a no-op over the reported length: the unwrap must reach the rest.
    const rest = sliceRows(virtualRows(source), 0, 21)
    expect(rest.length).toBe(21)
    expect(unclampedRows(rest).length).toBe(500)
    const window = sliceRows(virtualRows(source), 0, 10)
    expect(unclampedRows(window).length).toBe(10)
    const tail = sliceRows(virtualRows(source), 5)
    expect(unclampedRows(tail).length).toBe(495)
  })
})

describe('findMarkerRow', () => {
  const MARKER = ''

  it('finds the first row containing the marker in a real array', () => {
    expect(findMarkerRow(['a', `b${MARKER}`, `c${MARKER}`], MARKER)).toBe(1)
    expect(findMarkerRow(['a'], MARKER)).toBe(-1)
  })

  it('answers -1 for a marker-free source without a read', () => {
    const source = counting(1_000_000, { markerFree: true })
    const rows = virtualRows(source)
    expect(findMarkerRow(rows, MARKER)).toBe(-1)
    expect(source.reads).toEqual([])
  })

  it('skips marker-free concat parts whole and still searches the rest', () => {
    const body = counting(1_000_000, { markerFree: true })
    const tail = ['plain', `has ${MARKER}`]
    const rows = concatRows(virtualRows(body), tail)
    expect(findMarkerRow(rows, MARKER)).toBe(1_000_001)
    expect(body.reads).toEqual([])
  })

  it('scans a facade without a seek through its rows', () => {
    const source = counting(1_000_000)
    const rows = virtualRows(source)
    expect(findMarkerRow(rows, 'row 999999')).toBe(999_999)
    expect(source.reads).toEqual(Array.from({ length: 1_000_000 }, (_, index) => index))
  })

  it('honors a source seekMarker without producing the row', () => {
    const source = counting(1_000_000, { seekMarker: (marker, from) => marker === MARKER && from <= 42 ? 42 : -1 })
    const rows = virtualRows(source)
    expect(findMarkerRow(rows, MARKER)).toBe(42)
    expect(source.reads).toEqual([])
  })
})

describe('sameMaterializedRows', () => {
  it('is true for the same array', () => {
    const rows = virtualRows(counting(1_000_000))
    expect(sameMaterializedRows(rows, rows)).toBe(true)
    expect(materializedRows(rows)).toBe(0)
  })

  it('compares real arrays row by row', () => {
    expect(sameMaterializedRows(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameMaterializedRows(['a'], ['a', 'b'])).toBe(false)
    expect(sameMaterializedRows(['a', 'x'], ['a', 'b'])).toBe(false)
  })

  it('compares only the indices either facade has materialized', () => {
    const known = virtualRows(counting(1_000_000))
    const fresh = virtualRows(counting(1_000_000))
    expect(known[10]).toBe('row 10')
    expect(fresh[20]).toBe('row 20')
    expect(sameMaterializedRows(known, fresh)).toBe(true)
    // The comparison materialized the indices the other side knew, nothing else.
    expect(materializedRows(known)).toBe(2)
    expect(materializedRows(fresh)).toBe(2)
  })

  it('fails on a materialized index that differs', () => {
    const known = virtualRows(counting(10))
    const fresh = virtualRows({ length: 10, row: index => (index === 3 ? 'different' : `row ${String(index)}`) })
    expect(known[3]).toBe('row 3')
    expect(sameMaterializedRows(known, fresh)).toBe(false)
  })

  it('fails when a real array differs from a facade in any row, on either side', () => {
    const source = counting(3)
    expect(sameMaterializedRows(['row 0', 'x', 'row 2'], virtualRows(source))).toBe(false)
    expect(sameMaterializedRows(virtualRows(counting(3)), ['row 0', 'row 1', 'x'])).toBe(false)
    // A facade that agrees on what it materialized still differs from a real array on a row it has not read.
    const known = virtualRows(counting(3))
    expect(known[0]).toBe('row 0')
    expect(sameMaterializedRows(known, ['row 0', 'row 1', 'x'])).toBe(false)
  })

  it('fails on a row only the second facade has materialized', () => {
    const first = virtualRows(counting(10))
    const second = virtualRows({ length: 10, row: index => (index === 7 ? 'different' : `row ${String(index)}`) })
    expect(first[0]).toBe('row 0')
    expect(second[7]).toBe('different')
    expect(sameMaterializedRows(first, second)).toBe(false)
  })

  it('compares a real array against a facade over all its rows', () => {
    const source = counting(6)
    const fresh = virtualRows(source)
    expect(sameMaterializedRows(['row 0', 'row 1', 'row 2', 'row 3', 'row 4', 'row 5'], fresh)).toBe(true)
    expect(source.reads).toEqual([0, 1, 2, 3, 4, 5])
  })
})

describe('blankRows', () => {
  it('is a marker-free facade of empty rows', () => {
    const rows = blankRows(5)
    expect(rows.length).toBe(5)
    expect(isVirtualRows(rows)).toBe(true)
    expect(declaredWidthOf(rows)).toBe(0)
    expect(findMarkerRow(rows, 'x')).toBe(-1)
    expect([...rows]).toEqual(['', '', '', '', ''])
  })
})
