/** Admission of the optional tab fields of slice 1.5: counts, attention, groups, clip, orientation, and the hint word. */
import { describe, expect, it } from 'vitest'
import { ui, type MayflyUiNode } from '../../../ui/src/index.ts'
import { validateMayflyUiNode } from '../../src/core/ui-validator.ts'

function accepted(value: unknown): MayflyUiNode {
  const result = validateMayflyUiNode(value)
  if (!result.ok) throw new Error(result.message)
  return result.value
}

function rejected(value: unknown): string {
  const result = validateMayflyUiNode(value)
  if (result.ok) throw new Error('expected a rejection')
  return result.message
}

const tabs = (items: readonly unknown[], extra: object = {}): unknown => ({ kind: 'tabs', id: 'tabs', activeId: 'a', items, ...extra })

describe('tab items', () => {
  it('admits a numeric or text count, attention, a group, and a clip side', () => {
    const node = accepted(ui.tabs({ id: 'rail', activeId: 'a', orientation: 'vertical', hintLabel: 'labels', items: [
      { id: 'a', label: 'A', count: 3, group: 'Session', clip: 'start' }, { id: 'b', label: 'B', count: '2/6', attention: true, clip: 'end' }, { id: 'c', label: 'C', attention: false },
    ] }))
    expect(node).toMatchObject({ orientation: 'vertical', hintLabel: 'labels', items: [
      { count: 3, group: 'Session', clip: 'start' }, { count: '2/6', attention: true, clip: 'end' }, { attention: false },
    ] })
  })

  it('leaves the fields out when they are not given', () => {
    const [item] = (accepted(tabs([{ id: 'a', label: 'A' }])) as { items: object[] }).items
    expect(Object.keys(item!)).toEqual(['id', 'label'])
    expect(Object.keys(accepted(tabs([{ id: 'a', label: 'A' }])))).toEqual(['kind', 'id', 'activeId', 'items'])
  })

  it('rejects a count that is neither an integer nor text, a non-boolean attention, and an unknown clip', () => {
    expect(rejected(tabs([{ id: 'a', label: 'A', count: 1.5 }]))).toContain('items[0].count')
    expect(rejected(tabs([{ id: 'a', label: 'A', count: -1 }]))).toContain('items[0].count')
    expect(rejected(tabs([{ id: 'a', label: 'A', count: true }]))).toContain('items[0].count')
    expect(rejected(tabs([{ id: 'a', label: 'A', attention: 'yes' }]))).toContain('items[0].attention')
    expect(rejected(tabs([{ id: 'a', label: 'A', group: 3 }]))).toContain('items[0].group')
    expect(rejected(tabs([{ id: 'a', label: 'A', clip: 'middle' }]))).toContain('items[0].clip')
  })
})

describe('tabs nodes', () => {
  it('admits a horizontal or vertical orientation and a hint word, and refuses a vertical wizard', () => {
    expect(accepted(tabs([{ id: 'a', label: 'A' }], { orientation: 'horizontal' }))).toMatchObject({ orientation: 'horizontal' })
    expect(accepted(tabs([{ id: 'a', label: 'A' }], { mode: 'wizard', orientation: 'horizontal' }))).toMatchObject({ mode: 'wizard' })
    expect(rejected(tabs([{ id: 'a', label: 'A' }], { orientation: 'diagonal' }))).toContain('orientation')
    expect(rejected(tabs([{ id: 'a', label: 'A' }], { mode: 'wizard', orientation: 'vertical' }))).toContain('wizard')
    expect(rejected(tabs([{ id: 'a', label: 'A' }], { hintLabel: 4 }))).toContain('hintLabel')
  })
})
