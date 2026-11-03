/** The immutable slider model: seeding, reconcile, grammar, stepping, edges, and unpinning.
 * @module @ephemeral-ai/mayfly/tests/core/ui-interaction-slider
 */
import { describe, expect, it } from 'vitest'
import type { MayflySliderLevel, MayflySliderNode } from '@ephemeral-ai/mayfly-ui'
import {
  createSliderModel,
  reconcileSlider,
  reduceSlider,
  sliderActive,
  sliderGrammar,
  type UiSliderModel,
} from '../../src/core/ui-interaction-slider.ts'

const address = { pagePath: [], controlId: 'effort' } as const

function level(id: string, disabled = false): MayflySliderLevel {
  return { id, label: id, ...(disabled ? { disabled: true, disabledReason: 'fixed' } : {}) }
}

function definition(over: Partial<MayflySliderNode> = {}): MayflySliderNode {
  const base: MayflySliderNode = { kind: 'slider', id: 'effort', levels: [level('low'), level('mid'), level('high')] }
  return { ...base, ...over }
}

function model(over: Partial<MayflySliderNode> = {}, selectedId?: string | null): UiSliderModel {
  const definitionWithSeed = selectedId === undefined
    ? definition(over)
    : { ...definition(over), selectedId: selectedId as string }
  return createSliderModel(address, definitionWithSeed)
}

describe('createSliderModel', () => {
  it('pins a seed that is still one of the enabled levels', () => {
    expect(model({}, 'low')).toMatchObject({ address, pinned: 'low', revision: 0 })
  })

  it('does not pin an absent or disabled seed', () => {
    expect(model().pinned).toBeNull()
    expect(model({}, null).pinned).toBeNull()
    expect(createSliderModel(address, definition({ selectedId: 'gone' })).pinned).toBeNull()
    expect(createSliderModel(address, definition({ levels: [level('low'), level('high', true)], selectedId: 'high' })).pinned).toBeNull()
  })
})

describe('reconcileSlider', () => {
  it('returns the same model for an identical definition', () => {
    const earlier = model({}, 'low')
    expect(reconcileSlider(earlier, earlier.definition)).toBe(earlier)
  })

  it('keeps the pinned level while the seed is unchanged', () => {
    const earlier = model({}, 'low')
    const next = reconcileSlider(earlier, definition({ selectedId: 'low' }))
    expect(next.pinned).toBe('low')
    expect(next.revision).toBe(earlier.revision)
  })

  it('replaces the pin when a republish names another seed', () => {
    const earlier = model({}, 'low')
    const next = reconcileSlider(earlier, definition({ selectedId: 'high' }))
    expect(next.pinned).toBe('high')
    expect(next.revision).toBe(1)
  })

  it('drops a pinned level that is no longer enabled and bumps the revision', () => {
    const earlier = model({}, 'low')
    const next = reconcileSlider(earlier, definition({ levels: [level('low', true), level('mid'), level('high')] }))
    expect(next.pinned).toBeNull()
    expect(next.revision).toBe(1)
  })

  it('drops a removed pin even when the seed is unchanged, and never seeds a disabled one', () => {
    const earlier = model({}, 'mid')
    expect(reconcileSlider(earlier, definition({ selectedId: 'mid', levels: [level('low'), level('high', true)] })).pinned).toBeNull()
    expect(reconcileSlider(earlier, definition({ selectedId: 'gone' })).pinned).toBeNull()
  })
})

describe('sliderActive and sliderGrammar', () => {
  it('shows the pin, else the inherited level, else nothing', () => {
    expect(sliderActive(model({ inheritedId: 'mid' }, 'low'))).toBe('low')
    expect(sliderActive(model({ inheritedId: 'mid' }))).toBe('mid')
    expect(sliderActive(model())).toBeUndefined()
  })

  it('reports the ends, adjustability, and unpin availability', () => {
    expect(sliderGrammar(model({ inheritedId: 'mid' }))).toEqual({ stuckLeft: false, stuckRight: false, unpin: false, adjustable: true })
    expect(sliderGrammar(model({ inheritedId: 'low' }))).toMatchObject({ stuckLeft: true, stuckRight: false })
    expect(sliderGrammar(model({ inheritedId: 'high' }))).toMatchObject({ stuckLeft: false, stuckRight: true, unpin: false })
    expect(sliderGrammar(model({ inheritedId: 'mid' }, 'low'))).toEqual({ stuckLeft: true, stuckRight: false, unpin: true, adjustable: true })
    expect(sliderGrammar(model({}, 'low'))).toMatchObject({ unpin: false })
    expect(sliderGrammar(model({ levels: [level('only')], inheritedId: 'only' }))).toEqual({ stuckLeft: true, stuckRight: true, unpin: false, adjustable: false })
    expect(sliderGrammar(model({ levels: [level('a', true), level('b', true)] }))).toEqual({ stuckLeft: true, stuckRight: true, unpin: false, adjustable: false })
  })
})

describe('reduceSlider', () => {
  it('accepts the pinned level, or null while following the inherited level', () => {
    const pinned = model({}, 'low')
    expect(reduceSlider(pinned, { kind: 'accept' })).toEqual({ model: pinned, effects: [{ kind: 'accept', value: 'low' }] })
    const inherited = model({ inheritedId: 'mid' })
    expect(reduceSlider(inherited, { kind: 'accept' })).toEqual({ model: inherited, effects: [{ kind: 'accept', value: null }] })
  })

  it('unpins only a pin that can fall back to an inherited level', () => {
    const noPin = model({ inheritedId: 'mid' })
    expect(reduceSlider(noPin, { kind: 'unpin' })).toEqual({ model: noPin, effects: [] })
    const noInherited = model({}, 'low')
    expect(reduceSlider(noInherited, { kind: 'unpin' })).toEqual({ model: noInherited, effects: [] })
    const both = model({ inheritedId: 'mid' }, 'low')
    const result = reduceSlider(both, { kind: 'unpin' })
    expect(result.model.pinned).toBeNull()
    expect(result.model.revision).toBe(both.revision + 1)
    expect(result.effects).toEqual([])
  })

  it('ignores steps and edges when fewer than two levels are enabled', () => {
    const single = model({ levels: [level('low'), level('high', true)] })
    expect(reduceSlider(single, { kind: 'step', delta: 1 }).model).toBe(single)
    expect(reduceSlider(single, { kind: 'edge', end: 'end' }).model).toBe(single)
  })

  it('steps from an inherited level without pinning until a different level is reached', () => {
    const inherited = model({ inheritedId: 'mid' })
    expect(reduceSlider(inherited, { kind: 'step', delta: 1 }).model.pinned).toBe('high')
    expect(reduceSlider(inherited, { kind: 'step', delta: -1 }).model.pinned).toBe('low')
  })

  it('starts from the edge the arrow points into when resting on nothing', () => {
    expect(reduceSlider(model(), { kind: 'step', delta: 1 }).model.pinned).toBe('low')
    expect(reduceSlider(model(), { kind: 'step', delta: -1 }).model.pinned).toBe('high')
  })

  it('clamps at the ends and ignores a step that does not move', () => {
    const atStart = model({}, 'low')
    expect(reduceSlider(atStart, { kind: 'step', delta: -1 }).model).toBe(atStart)
    const atEnd = model({}, 'high')
    expect(reduceSlider(atEnd, { kind: 'step', delta: 1 }).model).toBe(atEnd)
    expect(reduceSlider(atStart, { kind: 'edge', end: 'start' }).model).toBe(atStart)
  })

  it('jumps to either edge and unpins when stepping onto the inherited level', () => {
    const middle = model({ inheritedId: 'mid' }, 'mid')
    expect(reduceSlider(middle, { kind: 'edge', end: 'end' }).model.pinned).toBe('high')
    expect(reduceSlider(middle, { kind: 'edge', end: 'start' }).model.pinned).toBe('low')
    const pinned = model({ inheritedId: 'mid' }, 'low')
    const result = reduceSlider(pinned, { kind: 'step', delta: 1 })
    expect(result.model.pinned).toBeNull()
    expect(result.model.revision).toBe(pinned.revision + 1)
  })

  it('keeps a step that lands on the same level unchanged', () => {
    const disabledMiddle = model({ levels: [level('low'), level('mid', true), level('high')], inheritedId: 'mid' })
    expect(reduceSlider(disabledMiddle, { kind: 'step', delta: 1 }).model.pinned).toBe('low')
    const clamped = model({ inheritedId: 'high' })
    expect(reduceSlider(clamped, { kind: 'step', delta: 1 }).model).toBe(clamped)
    const one = model({ levels: [level('low'), level('high', true)] }, 'low')
    expect(reduceSlider(one, { kind: 'edge', end: 'start' }).model).toBe(one)
  })
})
