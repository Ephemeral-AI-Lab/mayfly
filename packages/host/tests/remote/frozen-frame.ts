/** Recursive immutable JSON assertions shared by Host output regressions. @module */
import { expect } from 'vitest'

export function expectFrozenJson(value: unknown): void {
  if (value === null || typeof value !== 'object') return
  expect(Object.isFrozen(value)).toBe(true)
  expect(JSON.parse(JSON.stringify(value))).toEqual(value)
  for (const child of Object.values(value)) expectFrozenJson(child)
}
