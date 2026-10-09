/** A list's `selectedIds` is optional: absent means nothing selected, in the validator, the choice model, and the painters. */
import { afterEach, describe, expect, it } from 'vitest'
import { ui, type MayflyListNode, type MayflyUiEvent } from '../../../ui/src/index.ts'
import { createRealSurface, parityComponents, type RealSurface } from '../design/parity.ts'
import { listSelectedIds } from '../../src/core/ui-list-selection.ts'
import { createChoiceState, reduceChoice } from '../../src/core/ui-interaction-choice.ts'
import { validateMayflyUiNode } from '../../src/core/ui-validator.ts'

const plain = (text: string): string => text.replace(/\x1b\[[0-9;]*m/gu, '')
const items = [{ id: 'apple', label: 'Apple' }, { id: 'banana', label: 'Banana' }]

const surfaces: RealSurface[] = []
afterEach(() => { for (const surface of surfaces.splice(0)) surface.dispose() })

function open(node: MayflyListNode) {
  const events: MayflyUiEvent[] = []
  const surface = createRealSurface(ui.surface({ title: 'List', chrome: 'overlay', child: node }), 80, { components: parityComponents(), events: event => events.push(event) })
  surfaces.push(surface)
  return { surface, events, rows: () => surface.render().map(plain) }
}

describe('a list without selectedIds', () => {
  it('reads as none selected, sharing one empty array', () => {
    const node = ui.list({ id: 'l', role: 'browse', items })
    expect('selectedIds' in node).toBe(false)
    expect(listSelectedIds(node)).toEqual([])
    expect(listSelectedIds(node)).toBe(listSelectedIds(ui.list({ id: 'm', role: 'choose', items })))
    const chosen = ui.list({ id: 'l', role: 'browse', selectedIds: ['apple'], items })
    expect(listSelectedIds(chosen)).toBe(chosen.selectedIds)
  })

  it('is admitted with selectedIds [] and still validates the field when it is given', () => {
    const result = validateMayflyUiNode(ui.list({ id: 'l', role: 'choose', items }))
    expect(result).toMatchObject({ ok: true, value: { kind: 'list', selectedIds: [] } })
    expect(validateMayflyUiNode({ kind: 'list', id: 'l', role: 'choose', items, selectedIds: 'apple' })).toMatchObject({ ok: false })
    expect(validateMayflyUiNode({ kind: 'list', id: 'l', role: 'choose', mode: 'single', selectedIds: ['apple', 'banana'], items })).toMatchObject({ ok: false, message: expect.stringContaining('more than one') })
  })

  it('starts the choice model unselected and selects as a list that declared []', () => {
    const declared = createChoiceState(ui.list({ id: 'l', role: 'choose', selectedIds: [], items }))
    const omitted = createChoiceState(ui.list({ id: 'l', role: 'choose', items }))
    expect(omitted.selectedIds).toEqual([])
    expect(omitted.focusedIndex).toBe(declared.focusedIndex)
    expect(reduceChoice(omitted, { kind: 'select', ids: ['banana'] })).toMatchObject({ selectedIds: ['banana'], dirty: true })
  })

  it('paints and reports through a surface: Enter accepts the cursor row, Space toggles on a multiple list', () => {
    const single = open(ui.list({ id: 'l', role: 'choose', items }))
    expect(single.rows().join('\n')).toContain('Banana')
    single.surface.press('\x1b[B')
    single.surface.press('\r')
    expect(single.events.at(-1)).toMatchObject({ kind: 'selection-accept', controlId: 'l', selectedIds: ['banana'] })
    const multiple = open(ui.list({ id: 'l', role: 'choose', mode: 'multiple', items }))
    multiple.surface.press(' ')
    expect(multiple.events.at(-1)).toMatchObject({ kind: 'selection-toggle', controlId: 'l', selectedIds: ['apple'] })
  })
})
