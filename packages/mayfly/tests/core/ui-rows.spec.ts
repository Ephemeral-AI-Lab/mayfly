/** The virtual rows facade: array semantics a pipe can rely on, and laziness a windowed source counts on. */
import { describe, expect, it } from 'vitest'
import {
  blankRows,
  concatRows,
  declaredWidthOf,
  findMarkerRow,
  isVirtualRows,
  materializedRows,
  mapRows,
  rowSourceOf,
  sameMaterializedRows,
  sliceRows,
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

  it('keeps the declared width it is given', () => {
    const rows = mapRows(virtualRows(counting(2)), row => `${row}|`, { declaredWidth: 8 })
    expect(declaredWidthOf(rows)).toBe(8)
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
