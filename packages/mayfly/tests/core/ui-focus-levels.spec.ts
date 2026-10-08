/** The pure decisions of the `←` ladder: where an unused ← goes, and whether a stepped control has ← left to use. */
import { describe, expect, it } from 'vitest'
import { canStepLeft, railGroupFor, type LevelControl } from '../../src/core/ui-focus-levels.ts'

const rail = (group: string): LevelControl => ({ group, tabs: { rail: true, wizard: false, count: 3 } })
const strip = (group: string): LevelControl => ({ group, tabs: { rail: false, wizard: false, count: 3 } })
const content = (group: string): LevelControl => ({ group })

describe('railGroupFor', () => {
  it('finds the rail wherever it sits in the focus order', () => {
    const before = [rail('rail'), rail('rail'), content('form'), content('form')]
    expect(railGroupFor(before, 2)).toBe('rail')
    const after = [content('form'), content('form'), rail('rail'), rail('rail')]
    expect(railGroupFor(after, 0)).toBe('rail')
    expect(railGroupFor(after, 1)).toBe('rail')
  })

  it('prefers the nearest rail before the focused control, else the first', () => {
    const controls = [rail('outer'), content('a'), rail('inner'), content('b'), rail('late')]
    expect(railGroupFor(controls, 1)).toBe('outer')
    expect(railGroupFor(controls, 3)).toBe('inner')
    expect(railGroupFor([content('a'), rail('first'), rail('second')], 0)).toBe('first')
  })

  it('finds none on a rail, on a surface without one, on a strip alone, or without a focused control', () => {
    expect(railGroupFor([rail('rail'), content('form')], 0)).toBeUndefined()
    expect(railGroupFor([content('a'), content('b')], 1)).toBeUndefined()
    expect(railGroupFor([strip('strip'), content('form')], 1)).toBeUndefined()
    expect(railGroupFor([], 0)).toBeUndefined()
  })
})

describe('canStepLeft', () => {
  it('uses ← while an enabled option precedes the current one, or none is current', () => {
    expect(canStepLeft(['low', 'medium', 'high'], 'medium')).toBe(true)
    expect(canStepLeft(['low', 'medium', 'high'], 'high')).toBe(true)
    expect(canStepLeft(['low', 'medium', 'high'], null)).toBe(true)
    expect(canStepLeft(['low', 'medium'], undefined)).toBe(true)
    expect(canStepLeft(['low', 'medium', 'high'], 'low')).toBe(false)
    expect(canStepLeft(['only'], 'only')).toBe(false)
    expect(canStepLeft([], 'low')).toBe(false)
  })
})
