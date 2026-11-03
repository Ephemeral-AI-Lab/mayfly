/**
 * Decision tests for the wire detachment helpers every Host DTO crosses
 * through: lossless values survive frozen, everything else stays behind.
 * @module
 */
import { describe, expect, it } from 'vitest'
import { frozen, jsonSnapshot } from '../../src/remote/json.ts'

describe('frozen', () => {
  it('freezes a nested graph, not only the top level', () => {
    const value = frozen({ row: { cells: [{ text: 'a' }] }, list: ['b'] })
    expect(Object.isFrozen(value)).toBe(true)
    expect(Object.isFrozen(value.row)).toBe(true)
    expect(Object.isFrozen(value.row.cells)).toBe(true)
    expect(Object.isFrozen(value.row.cells[0])).toBe(true)
    expect(Object.isFrozen(value.list)).toBe(true)
  })
})

describe('jsonSnapshot', () => {
  it('detaches a lossless value so no producer alias survives', () => {
    const producer = { text: 'hello', nested: { count: 2 } }
    const snapshot = jsonSnapshot(producer)
    expect(snapshot).toEqual(producer)
    expect(snapshot).not.toBe(producer)
    expect(snapshot?.nested).not.toBe(producer.nested)
    // The snapshot is frozen: a later producer mutation cannot reach it.
    producer.text = 'changed'
    expect(snapshot?.text).toBe('hello')
    expect(Object.isFrozen(snapshot)).toBe(true)
  })

  it('preserves arrays, null, and every JSON scalar', () => {
    expect(jsonSnapshot([1, 'two', null, false])).toEqual([1, 'two', null, false])
    expect(jsonSnapshot('bare')).toBe('bare')
    expect(jsonSnapshot(42)).toBe(42)
    expect(jsonSnapshot(null)).toBe(null)
  })

  it('returns undefined for values that cannot cross the wire unchanged', () => {
    // A function anywhere in the graph makes the whole value unloadable.
    expect(jsonSnapshot({ run: (): void => {} })).toBeUndefined()
    expect(jsonSnapshot([1, (): void => {}])).toBeUndefined()
    expect(jsonSnapshot(undefined)).toBeUndefined()
    // NaN and Infinity are not JSON numbers.
    expect(jsonSnapshot(Number.NaN)).toBeUndefined()
    expect(jsonSnapshot(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(jsonSnapshot({ ratio: Number.NaN })).toBeUndefined()
  })

  it('refuses a value with an undefined-valued key rather than dropping the key', () => {
    // snapshotJsonValue cannot know whether the producer meant the key or its
    // absence, so the whole value stays behind rather than mutating meaning.
    expect(jsonSnapshot({ present: 'yes', absent: undefined })).toBeUndefined()
    expect(jsonSnapshot({ present: 'yes' })).toEqual({ present: 'yes' })
  })

  it('survives a cycle by refusing it instead of hanging', () => {
    const cyclic: { self?: unknown } = {}
    cyclic.self = cyclic
    expect(jsonSnapshot(cyclic)).toBeUndefined()
  })
})
