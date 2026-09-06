import { describe, expect, it } from 'vitest'
import { WindowController } from '../../src/core/window-controller.ts'

describe('WindowController', () => {
  it('clamps offsets and reports navigation state', () => {
    const controller = new WindowController()
    expect(controller.update(10, 3, 5)).toEqual({ offset: 5, limit: 3, total: 10, hasPrevious: true, hasNext: true })
    expect(controller.move(99)).toEqual({ offset: 7, limit: 3, total: 10, hasPrevious: true, hasNext: false })
    expect(controller.move(-99)).toEqual({ offset: 0, limit: 3, total: 10, hasPrevious: false, hasNext: true })
  })

  it('normalizes invalid totals, limits, offsets, and deltas', () => {
    const controller = new WindowController()
    expect(controller.update(Number.NaN, 0, Number.NaN)).toEqual({ offset: 0, limit: 1, total: 0, hasPrevious: false, hasNext: false })
    expect(controller.move(Number.NaN)).toEqual({ offset: 0, limit: 1, total: 0, hasPrevious: false, hasNext: false })
  })
})
