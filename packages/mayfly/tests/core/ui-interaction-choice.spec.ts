/** Shared list, tree disclosure, and search behavior.
 * @module @ephemeral-ai/mayfly/tests/core/ui-interaction-choice
 */
import { describe, expect, it } from 'vitest'
import { ui } from '../../../ui/src/index.ts'
import { acknowledgeChoice, choiceError, choiceSegment, choiceVisibleCount, choiceVisibleIndex, choiceVisiblePosition, createChoiceState, decorateChoiceItem, reconcileChoice, reduceChoice, visibleChoiceIndices } from '../../src/core/ui-interaction-choice.ts'

const tree = ui.list({ id: 'tree', role: 'choose', tree: true, selectedIds: [], filterable: true, items: [
  { id: 'root', label: 'Root' },
  { id: 'child', label: 'Child', parentId: 'root' },
  { id: 'leaf', label: 'Deep target', parentId: 'child' },
  { id: 'other', label: 'Other' },
] })

describe('shared tree choice', () => {
  it('discloses branches, keeps focus visible on collapse, and decorates without changing ids', () => {
    let state = createChoiceState(tree)
    expect(visibleChoiceIndices(state)).toEqual([0, 3])
    expect(visibleChoiceIndices(state)).toBe(state.visibleTreeIndices)
    expect(choiceVisibleCount(state)).toBe(2)
    expect(choiceVisiblePosition(state)).toBe(0)
    expect(choiceVisibleIndex(state, 1)).toBe(3)
    state = reduceChoice(state, { kind: 'expand', id: 'root' })
    expect(visibleChoiceIndices(state)).toEqual([0, 1, 3])
    state = reduceChoice(state, { kind: 'expand', id: 'child' })
    state = reduceChoice(state, { kind: 'focus', id: 'leaf' })
    expect(visibleChoiceIndices(state)).toEqual([0, 1, 2, 3])
    expect(decorateChoiceItem(state, 2)).toMatchObject({ id: 'leaf', label: '      Deep target' })
    state = reduceChoice(state, { kind: 'expand', id: 'root' })
    expect(state.focusedId).toBe('root')
    expect(visibleChoiceIndices(state)).toEqual([0, 3])
  })

  it('shows matching descendants with ancestors and restores disclosure after clearing search', () => {
    let state = reduceChoice(createChoiceState(tree), { kind: 'expand', id: 'root' })
    state = reduceChoice(state, { kind: 'query', query: 'target' })
    expect(visibleChoiceIndices(state)).toEqual([0, 1, 2])
    expect(state.focusedId).toBe('leaf')
    state = reduceChoice(state, { kind: 'clear-search' })
    expect(visibleChoiceIndices(state)).toEqual([0, 1, 3])
    expect(state.expandedIds).toEqual(['root'])
  })

  it('reveals the selected node ancestry on initialization', () => {
    const selected = createChoiceState({ ...tree, selectedIds: ['leaf'] })
    expect(selected.expandedIds).toEqual(['child', 'root'])
    expect(visibleChoiceIndices(selected)).toEqual([0, 1, 2, 3])
  })

  it('contains malformed parent cycles and orphans without looping', () => {
    const malformed = ui.list({ id: 'tree', role: 'browse', tree: true, selectedIds: [], items: [
      { id: 'self', label: 'Self', parentId: 'self' },
      { id: 'a', label: 'A', parentId: 'b' },
      { id: 'b', label: 'B', parentId: 'a' },
      { id: 'orphan', label: 'Orphan', parentId: 'missing' },
    ] })
    let state = createChoiceState(malformed)
    expect(visibleChoiceIndices(state)).toEqual([])
    state = reduceChoice(state, { kind: 'expand', id: 'a' })
    state = reduceChoice(state, { kind: 'expand', id: 'b' })
    expect(visibleChoiceIndices(state)).toEqual([])
    state = reduceChoice(state, { kind: 'query', query: 'B' })
    expect(visibleChoiceIndices(state)).toEqual([1, 2])
    state = reduceChoice(state, { kind: 'query', query: 'Orphan' })
    expect(visibleChoiceIndices(state)).toEqual([3])
    expect(createChoiceState({ ...malformed, selectedIds: ['orphan'] }).expandedIds).toEqual(['missing'])
  })

  it('decorates parent disclosure and tolerates an absent derived tree index', () => {
    let state = createChoiceState(tree)
    expect(decorateChoiceItem(state, 0).label).toContain('▸ Root')
    state = reduceChoice(state, { kind: 'expand', id: 'root' })
    expect(decorateChoiceItem(state, 0).label).toContain('▾ Root')
    expect(decorateChoiceItem({ ...state, treeIndex: undefined }, 0).label).toContain('Root')
    state = reduceChoice(state, { kind: 'focus', id: 'other' })
    state = reduceChoice(state, { kind: 'expand', id: 'root' })
    expect(state.focusedId).toBe('other')
  })
})

describe('flat choice reducer', () => {
  const flat = ui.list({ id: 'flat', role: 'choose', mode: 'multiple', minSelected: 1, maxSelected: 2, selectedIds: ['one'], filterable: true, items: [
    { id: 'one', label: 'One', detail: 'first detail' },
    { id: 'two', label: 'Two', searchText: 'second alias' },
    { id: 'disabled', label: 'Disabled', disabled: true },
  ] })

  it('initializes empty and filtered definitions and decorates flat items unchanged', () => {
    expect(createChoiceState(ui.list({ id: 'empty', role: 'browse', selectedIds: [], items: [] }))).toMatchObject({ focusedIndex: -1, focusedId: undefined })
    const unfiltered = createChoiceState(flat)
    expect(choiceVisibleCount(unfiltered)).toBe(3)
    expect(choiceVisiblePosition(unfiltered)).toBe(0)
    expect(choiceVisibleIndex(unfiltered, 2)).toBe(2)
    expect(choiceVisibleIndex(unfiltered, 3)).toBeUndefined()
    expect(visibleChoiceIndices(unfiltered)).toEqual([0, 1, 2])
    const filtered = createChoiceState({ ...flat, filter: 'alias' })
    expect(filtered).toMatchObject({ focusedId: 'two', matches: [1] })
    expect(decorateChoiceItem(filtered, 1)).toBe(filtered.definition.items[1])
    expect(visibleChoiceIndices(filtered)).toEqual([1])
    expect(choiceVisibleCount(filtered)).toBe(1)
    expect(choiceVisibleIndex(filtered, 0)).toBe(1)
    expect(createChoiceState({ ...flat, selectedIds: ['two'], filter: 'alias' }).focusedId).toBe('two')
    expect(createChoiceState({ ...flat, filter: 'absent' })).toMatchObject({ focusedIndex: -1, focusedId: undefined })
  })

  it('moves, focuses, searches, restores its anchor, and stops search idempotently', () => {
    let state = createChoiceState(flat)
    expect(reduceChoice(state, { kind: 'focus', id: 'missing' })).toBe(state)
    expect(reduceChoice(state, { kind: 'focus', id: 'one' })).toBe(state)
    state = reduceChoice(state, { kind: 'move', direction: 1, count: 0 })
    expect(state.focusedId).toBe('two')
    state = reduceChoice(state, { kind: 'edge', edge: 'last' })
    expect(state.focusedId).toBe('disabled')
    state = reduceChoice(state, { kind: 'edge', edge: 'first' })
    expect(state.focusedId).toBe('one')
    state = reduceChoice(state, { kind: 'query', query: 'second' })
    expect(state).toMatchObject({ focusedId: 'two', searching: true, searchAnchor: 'one' })
    expect(reduceChoice(state, { kind: 'focus', id: 'one' })).toBe(state)
    state = reduceChoice(state, { kind: 'stop-search' })
    expect(state.searching).toBe(false)
    expect(reduceChoice(state, { kind: 'stop-search' })).toBe(state)
    state = reduceChoice(state, { kind: 'clear-search' })
    expect(state).toMatchObject({ focusedId: 'one', query: '', searchAnchor: undefined })
    state = reduceChoice(state, { kind: 'query', query: 'absent' })
    expect(state.focusedIndex).toBe(-1)
    expect(reduceChoice(state, { kind: 'move', direction: 1, count: 1 })).toBe(state)
  })

  it('validates browse, duplicate, single, missing, disabled, and dirty selections', () => {
    const browse = createChoiceState({ ...flat, role: 'browse' })
    expect(reduceChoice(browse, { kind: 'select', ids: ['one'] })).toBe(browse)
    let state = createChoiceState(flat)
    expect(reduceChoice(state, { kind: 'select', ids: ['one', 'one'] })).toBe(state)
    expect(reduceChoice(state, { kind: 'select', ids: ['missing'] })).toBe(state)
    expect(reduceChoice(state, { kind: 'select', ids: ['disabled'] })).toBe(state)
    state = reduceChoice(state, { kind: 'toggle', id: 'two' })
    expect(state).toMatchObject({ selectedIds: ['one', 'two'], dirty: true })
    state = reduceChoice(state, { kind: 'toggle', id: 'one' })
    expect(state.selectedIds).toEqual(['two'])
    const single = createChoiceState({ ...flat, mode: 'single' })
    expect(reduceChoice(single, { kind: 'select', ids: ['one', 'two'] })).toBe(single)
  })

  it('reconciles focus and selection and acknowledges the native baseline', () => {
    let state = reduceChoice(createChoiceState(flat), { kind: 'toggle', id: 'two' })
    expect(reconcileChoice(state, state.definition)).toBe(state)
    state = reconcileChoice(state, { ...flat, items: flat.items.slice(1), selectedIds: ['two'] })
    expect(state).toMatchObject({ focusedId: 'two', selectedIds: ['one', 'two'] })
    state = acknowledgeChoice(state, { ...state.definition, selectedIds: ['two'] })
    expect(state).toMatchObject({ selectedIds: ['two'], dirty: false })
    const clean = reconcileChoice(createChoiceState(flat), { ...flat, selectedIds: ['two'] })
    expect(clean.selectedIds).toEqual(['two'])
    const empty = createChoiceState(ui.list({ id: 'empty', role: 'browse', selectedIds: [], items: [] }))
    expect(reconcileChoice(empty, ui.list({ id: 'filled', role: 'browse', selectedIds: [], items: [{ id: 'one', label: 'One' }] })).focusedId).toBe('one')
    const searching = reduceChoice(createChoiceState(flat), { kind: 'query', query: 'alias' })
    expect(reconcileChoice(searching, { ...flat, items: flat.items.toReversed() }).focusedId).toBe('two')
    expect(reconcileChoice({ ...createChoiceState(flat), query: 'alias' }, { ...flat, items: [...flat.items] }).focusedId).toBe('two')
    expect(reconcileChoice({ ...createChoiceState(flat), query: 'absent' }, { ...flat, items: [...flat.items] }).focusedId).toBeUndefined()
    const treeState = reconcileChoice(createChoiceState(tree), { ...tree, items: tree.items.toReversed() })
    expect(treeState.treeIndex).toBeDefined()
    const flattened = reconcileChoice(treeState, flat)
    expect(flattened.visibleTreeIndices).toBeUndefined()
    expect(choiceVisibleCount(flattened)).toBe(flat.items.length)
  })

  it('retains a newer choice edit across an acknowledgement but resets one matching the submission', () => {
    const submitted = ['one']
    const replacement = { ...flat, selectedIds: ['one'] }
    expect(acknowledgeChoice(reduceChoice(createChoiceState(flat), { kind: 'select', ids: ['two'] }), replacement, submitted)).toMatchObject({ selectedIds: ['two'], dirty: true })
    expect(acknowledgeChoice(reduceChoice(createChoiceState(flat), { kind: 'select', ids: [] }), replacement, submitted)).toMatchObject({ selectedIds: [], dirty: true })
    expect(acknowledgeChoice(reduceChoice(createChoiceState(flat), { kind: 'select', ids: ['one'] }), replacement, submitted)).toMatchObject({ selectedIds: ['one'], dirty: false })
    expect(acknowledgeChoice({ ...createChoiceState(flat), selectedIds: ['two'], dirty: true }, replacement, ['two'])).toMatchObject({ selectedIds: ['one'], dirty: false })
  })

  it('derives minimum, maximum, missing, disabled, and valid selection errors', () => {
    expect(choiceError({ ...createChoiceState(flat), selectedIds: [] })).toContain('at least')
    expect(choiceError({ ...createChoiceState(flat), selectedIds: ['one', 'two', 'disabled'] })).toContain('at most')
    expect(choiceError({ ...createChoiceState(flat), selectedIds: ['missing'] })).toBe('A selected option is unavailable')
    expect(choiceError({ ...createChoiceState(flat), selectedIds: ['disabled'] })).toBe('A selected option is unavailable')
    expect(choiceError(createChoiceState(flat))).toBeUndefined()
    expect(choiceError(createChoiceState(ui.list({ id: 'optional', role: 'choose', selectedIds: [], items: [] })))).toBeUndefined()
  })
})

describe('row segment drafts', () => {
  const segmented = ui.list({ id: 'models', role: 'browse', selectedIds: [], items: [
    { id: 'a', label: 'A', segment: { label: 'Thinking', selectedId: 'low', options: [
      { id: 'default', label: 'Default' },
      { id: 'low', label: 'Low' },
      { id: 'high', label: 'High' },
    ] } },
    { id: 'b', label: 'B', segment: { options: [
      { id: 'off', label: 'Off' },
      { id: 'on', label: 'On', disabled: true },
    ] } },
    { id: 'c', label: 'C' },
  ] })

  it('resolves the seeded option, steps without wrapping, and stays out of selection', () => {
    let state = createChoiceState(segmented)
    expect(choiceSegment(state, 'a')).toBe('low')
    state = reduceChoice(state, { kind: 'segment', id: 'a', direction: 1 })
    expect(choiceSegment(state, 'a')).toBe('high')
    expect(reduceChoice(state, { kind: 'segment', id: 'a', direction: 1 })).toBe(state)
    state = reduceChoice(state, { kind: 'segment', id: 'a', direction: -1 })
    state = reduceChoice(state, { kind: 'segment', id: 'a', direction: -1 })
    expect(choiceSegment(state, 'a')).toBe('default')
    expect(reduceChoice(state, { kind: 'segment', id: 'a', direction: -1 })).toBe(state)
    expect(state.selectedIds).toEqual([])
    expect(state.dirty).toBe(false)
  })

  it('ignores rows without enough enabled options and unknown ids', () => {
    const state = createChoiceState(segmented)
    expect(choiceSegment(state, 'b')).toBe('off')
    expect(reduceChoice(state, { kind: 'segment', id: 'b', direction: 1 })).toBe(state)
    expect(reduceChoice(state, { kind: 'segment', id: 'c', direction: 1 })).toBe(state)
    expect(reduceChoice(state, { kind: 'segment', id: 'missing', direction: 1 })).toBe(state)
    expect(choiceSegment(state, 'c')).toBeUndefined()
    expect(choiceSegment(state, 'missing')).toBeUndefined()
  })

  it('keeps drafts for surviving rows and drops removed segments on reconcile', () => {
    let state = reduceChoice(createChoiceState(segmented), { kind: 'segment', id: 'a', direction: -1 })
    state = reduceChoice(state, { kind: 'segment', id: 'a', direction: -1 })
    expect(choiceSegment(state, 'a')).toBe('default')
    const updated = ui.list({ id: 'models', role: 'browse', selectedIds: [], items: [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', segment: segmented.items[1]!.segment },
      { id: 'c', label: 'C' },
    ] })
    state = reconcileChoice(state, updated)
    expect(choiceSegment(state, 'a')).toBeUndefined()
    expect(state.segments?.['a']).toBeUndefined()
    const absent = reconcileChoice({ ...state, segments: { gone: 'x' } }, segmented)
    expect(absent.segments?.['gone']).toBeUndefined()
    expect(reconcileChoice(state, state.definition)).toBe(state)
  })

  it('falls back to the first enabled option when the seed is absent or unknown', () => {
    const unseeded = ui.list({ id: 'models', role: 'browse', selectedIds: [], items: [
      { id: 'a', label: 'A', segment: { options: [
        { id: 'off', label: 'Off', disabled: true },
        { id: 'on', label: 'On' },
      ] } },
      { id: 'b', label: 'B', segment: { selectedId: 'gone', options: [
        { id: 'off', label: 'Off' },
        { id: 'on', label: 'On' },
      ] } },
    ] })
    const state = createChoiceState(unseeded)
    expect(choiceSegment(state, 'a')).toBe('on')
    expect(choiceSegment(state, 'b')).toBe('off')
    const staleDraft = reduceChoice({ ...state, segments: { b: 'gone' } }, { kind: 'segment', id: 'b', direction: 1 })
    expect(choiceSegment(staleDraft, 'b')).toBe('on')
  })

  it('steps from a draft left on a disabled option', () => {
    const list = ui.list({ id: 'models', role: 'browse', selectedIds: [], items: [
      { id: 'a', label: 'A', segment: { options: [
        { id: 'x', label: 'X' },
        { id: 'y', label: 'Y', disabled: true },
        { id: 'z', label: 'Z' },
      ] } },
    ] })
    const seeded = { ...createChoiceState(list), segments: { a: 'y' } }
    expect(choiceSegment(seeded, 'a')).toBe('y')
    expect(choiceSegment(reduceChoice(seeded, { kind: 'segment', id: 'a', direction: 1 }), 'a')).toBe('z')
    expect(choiceSegment(reduceChoice(seeded, { kind: 'segment', id: 'a', direction: -1 }), 'a')).toBe('x')
  })

  it('tolerates choice state predating the segment map', () => {
    const { segments: _segments, ...legacy } = createChoiceState(segmented)
    const focused = reduceChoice(legacy, { kind: 'focus', id: 'c' })
    expect(focused.segments).toBeUndefined()
    expect(choiceSegment(reconcileChoice(legacy, { ...segmented }), 'a')).toBe('low')
    const stepped = reduceChoice(legacy, { kind: 'segment', id: 'a', direction: -1 })
    expect(choiceSegment(stepped, 'a')).toBe('default')
  })
})
