/** Shared browsing, selection, and search state independent of renderer instances.
 * @module @ephemeral-ai/mayfly/core/ui-interaction-choice
 */
import type { MayflyListNode } from '@ephemeral-ai/mayfly-ui'
import { admittedListIndex, admittedListItem } from './ui-validator.ts'
import { untranslated, type UiTranslate } from './ui-interaction-locale.ts'

export interface UiChoiceState {
  readonly definition: MayflyListNode
  readonly focusedId: string | undefined
  readonly focusedIndex: number
  readonly focusedPosition: number
  readonly selectedIds: readonly string[]
  readonly dirty: boolean
  readonly query: string
  readonly searching: boolean
  readonly searchAnchor: string | undefined
  readonly matches: readonly number[] | undefined
  readonly expandedIds: readonly string[]
  /** Per-row segment drafts keyed by item id; ephemeral and excluded from `dirty`. */
  readonly segments?: Readonly<Record<string, string>>
  readonly treeIndex?: UiChoiceTreeIndex
  readonly visibleTreeIndices?: readonly number[]
}

interface UiChoiceTreeIndex {
  readonly all: readonly number[]
  readonly byId: ReadonlyMap<string, number>
  readonly parentByIndex: ReadonlyMap<number, number>
  readonly depthByIndex: ReadonlyMap<number, number>
  readonly parents: ReadonlySet<string>
}

export type UiChoiceIntent =
  | { readonly kind: 'focus', readonly id: string }
  | { readonly kind: 'move', readonly direction: -1 | 1, readonly count: number }
  | { readonly kind: 'edge', readonly edge: 'first' | 'last' }
  | { readonly kind: 'toggle', readonly id: string }
  | { readonly kind: 'select', readonly ids: readonly string[] }
  | { readonly kind: 'segment', readonly id: string, readonly direction: -1 | 1 }
  | { readonly kind: 'query', readonly query: string }
  | { readonly kind: 'stop-search' }
  | { readonly kind: 'clear-search' }
  | { readonly kind: 'expand', readonly id: string }

const ownedIndexes = new WeakSet<readonly unknown[]>()

function immutable<T>(values: readonly T[]): readonly T[] {
  if (ownedIndexes.has(values)) return values
  const frozen = Object.freeze([...values])
  ownedIndexes.add(frozen)
  return frozen
}

function freezeChoice(state: UiChoiceState): UiChoiceState {
  return Object.freeze({
    ...state,
    selectedIds: immutable(state.selectedIds),
    expandedIds: immutable(state.expandedIds),
    matches: state.matches === undefined ? undefined : immutable(state.matches),
    ...(state.segments === undefined ? {} : { segments: Object.freeze({ ...state.segments }) }),
    ...(state.visibleTreeIndices === undefined ? {} : { visibleTreeIndices: immutable(state.visibleTreeIndices) }),
  })
}

function filtered(definition: MayflyListNode, query: string): readonly number[] | undefined {
  if (query.length === 0) return undefined
  const needle = query.toLocaleLowerCase()
  const result: number[] = []
  for (let index = 0; index < definition.items.length; index += 1) {
    const item = admittedListItem(definition.items, index)!
    const haystack = item.searchText ?? `${item.label} ${item.detail ?? ''}`
    if (haystack.toLocaleLowerCase().includes(needle)) result.push(index)
  }
  return result
}

function enabled(definition: MayflyListNode, index: number): boolean {
  const item = admittedListItem(definition.items, index)
  return item !== undefined && item.disabled !== true
}

function positionOf(state: UiChoiceState, index: number): number {
  const visible = indexedVisibility(state)
  return visible === undefined ? Math.max(0, index) : Math.max(0, visible.indexOf(index))
}

/** The enabled visible item nearest to `preferred`, searching forward first; -1 when none is focusable. */
function focusableIndex(state: UiChoiceState, preferred: number): number {
  const { definition } = state
  const visible = indexedVisibility(state)
  const count = visible?.length ?? definition.items.length
  const at = (position: number): number => visible === undefined ? position : visible[position]!
  const start = visible === undefined ? preferred : visible.indexOf(preferred)
  const origin = Math.max(0, Math.min(count - 1, start))
  for (let distance = 0; distance < count; distance += 1) {
    if (origin + distance < count && enabled(definition, at(origin + distance))) return at(origin + distance)
    if (origin - distance >= 0 && enabled(definition, at(origin - distance))) return at(origin - distance)
  }
  return -1
}

/** Place focus on the enabled visible item nearest to `preferred`; disabled rows never hold focus. */
function settleFocus(state: UiChoiceState, preferred: number): UiChoiceState {
  const focusedIndex = focusableIndex(state, preferred)
  return { ...state, focusedIndex, focusedPosition: positionOf(state, focusedIndex), focusedId: admittedListItem(state.definition.items, focusedIndex)?.id }
}

function treeIndex(definition: MayflyListNode): UiChoiceTreeIndex | undefined {
  if (definition.tree !== true) return undefined
  const all = Array.from({ length: definition.items.length }, (_, index) => index)
  const byId = new Map<string, number>()
  for (const index of all) byId.set(admittedListItem(definition.items, index)!.id, index)
  const parentByIndex = new Map<number, number>()
  const parents = new Set<string>()
  for (const index of all) {
    const item = admittedListItem(definition.items, index)!
    const parent = item.parentId === undefined ? undefined : byId.get(item.parentId)
    if (parent !== undefined && parent !== index) { parentByIndex.set(index, parent); parents.add(item.parentId!) }
  }
  const depthByIndex = new Map<number, number>()
  for (const index of all) {
    let depth = 0
    let current = parentByIndex.get(index)
    const seen = new Set<number>([index])
    while (current !== undefined && !seen.has(current)) {
      seen.add(current); depth += 1; current = parentByIndex.get(current)
    }
    depthByIndex.set(index, depth)
  }
  return { all: Object.freeze(all), byId, parentByIndex, depthByIndex, parents }
}

export function createChoiceState(definition: MayflyListNode): UiChoiceState {
  const selected = definition.selectedIds[0]
  const query = definition.filter ?? ''
  const matches = filtered(definition, query)
  const index = treeIndex(definition)
  const selectedIndex = selected === undefined ? -1 : admittedListIndex(definition.items, selected)
  const initial = selectedIndex < 0 ? 0 : selectedIndex
  const focusedIndex = matches === undefined || matches.includes(initial) ? initial : matches[0] ?? -1
  const expandedIds: string[] = []
  if (definition.tree === true && selected !== undefined) {
    let parent = admittedListItem(definition.items, initial)?.parentId
    const seen = new Set<string>()
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent)
      expandedIds.push(parent)
      const index = admittedListIndex(definition.items, parent)
      parent = index < 0 ? undefined : admittedListItem(definition.items, index)?.parentId
    }
  }
  const state = refreshTreeVisibility({
    definition, focusedIndex, focusedPosition: 0, focusedId: undefined,
    selectedIds: definition.selectedIds, dirty: false, query, searching: false, searchAnchor: undefined, matches, expandedIds,
    segments: {},
    ...(index === undefined ? {} : { treeIndex: index }),
  })
  return freezeChoice(settleFocus(state, focusedIndex))
}

function calculateTreeVisibility(state: UiChoiceState): readonly number[] {
  const { definition } = state
  const all = state.treeIndex!.all
  const matches = state.matches
  const byId = state.treeIndex!.byId
  const expanded = new Set(state.expandedIds)
  const allowed = new Set<number>()
  if (matches === undefined) {
    for (const index of all) {
      let parent = admittedListItem(definition.items, index)?.parentId
      let visible = true
      const seen = new Set<string>()
      while (parent !== undefined) {
        if (seen.has(parent)) { visible = false; break }
        seen.add(parent)
        const parentIndex = byId.get(parent)
        if (parentIndex === undefined || !expanded.has(parent)) { visible = false; break }
        parent = admittedListItem(definition.items, parentIndex)?.parentId
      }
      if (visible) allowed.add(index)
    }
  } else {
    for (const match of matches) {
      allowed.add(match)
      let parent = admittedListItem(definition.items, match)?.parentId
      const seen = new Set<string>()
      while (parent !== undefined && !seen.has(parent)) {
        seen.add(parent)
        const parentIndex = byId.get(parent)
        if (parentIndex === undefined) break
        allowed.add(parentIndex)
        parent = admittedListItem(definition.items, parentIndex)?.parentId
      }
    }
  }
  return all.filter(index => allowed.has(index))
}

function refreshTreeVisibility(state: UiChoiceState): UiChoiceState {
  const { visibleTreeIndices: _visibleTreeIndices, ...withoutVisibility } = state
  if (state.definition.tree !== true) return withoutVisibility
  const visibleTreeIndices = calculateTreeVisibility(withoutVisibility)
  return { ...withoutVisibility, focusedPosition: Math.max(0, visibleTreeIndices.indexOf(state.focusedIndex)), visibleTreeIndices }
}

function indexedVisibility(state: UiChoiceState): readonly number[] | undefined {
  return state.definition.tree === true ? state.visibleTreeIndices! : state.matches
}

export function choiceVisibleCount(state: UiChoiceState): number {
  return indexedVisibility(state)?.length ?? state.definition.items.length
}

export function choiceVisiblePosition(state: UiChoiceState): number {
  return state.focusedPosition
}

export function choiceVisibleIndex(state: UiChoiceState, position: number): number | undefined {
  const visible = indexedVisibility(state)
  return visible === undefined
    ? position >= 0 && position < state.definition.items.length ? position : undefined
    : visible[position]
}

/** Return visible raw item indexes, including matching ancestors for tree search. */
export function visibleChoiceIndices(state: UiChoiceState): readonly number[] {
  return indexedVisibility(state) ?? Array.from({ length: state.definition.items.length }, (_, index) => index)
}

/** Render-only tree decoration; semantic IDs remain the original item IDs. */
export function decorateChoiceItem(state: UiChoiceState, index: number): MayflyListNode['items'][number] {
  const item = admittedListItem(state.definition.items, index)!
  if (state.definition.tree !== true) return item
  const depth = state.treeIndex?.depthByIndex.get(index) ?? 0
  const hasChildren = state.treeIndex?.parents.has(item.id) === true
  const expanded = state.expandedIds.includes(item.id)
  const marker = hasChildren ? expanded ? '▾ ' : '▸ ' : '  '
  return { ...item, label: `${'  '.repeat(Math.max(0, depth))}${marker}${item.label}` }
}

export function acknowledgeChoice(state: UiChoiceState, definition: MayflyListNode, submittedIds?: readonly string[]): UiChoiceState {
  const changedAfterSubmit = submittedIds !== undefined && state.dirty
    && (state.selectedIds.length !== submittedIds.length || state.selectedIds.some((id, index) => id !== submittedIds[index]))
  return freezeChoice(reconcileChoice({ ...state, dirty: changedAfterSubmit, selectedIds: changedAfterSubmit ? state.selectedIds : definition.selectedIds }, definition))
}

export function reconcileChoice(state: UiChoiceState, definition: MayflyListNode): UiChoiceState {
  if (state.definition === definition) return state
  const anchored = state.focusedId === undefined ? -1 : admittedListIndex(definition.items, state.focusedId)
  const matches = filtered(definition, state.query)
  const index = treeIndex(definition)
  const focusedIndex = matches !== undefined
    ? matches.includes(anchored) ? anchored : matches[0] ?? -1
    : anchored < 0 ? state.focusedIndex : anchored
  const segments = Object.fromEntries(Object.entries(state.segments ?? {}).filter(([id]) => {
    const itemIndex = admittedListIndex(definition.items, id)
    return itemIndex >= 0 && admittedListItem(definition.items, itemIndex)?.segment !== undefined
  }))
  const { treeIndex: _treeIndex, ...previous } = state
  return freezeChoice(settleFocus(refreshTreeVisibility({
    ...previous, definition, focusedIndex, segments, matches,
    ...(index === undefined ? {} : { treeIndex: index }),
    selectedIds: state.dirty ? state.selectedIds : definition.selectedIds,
  }), focusedIndex))
}

function focus(state: UiChoiceState, index: number, position?: number): UiChoiceState {
  const visible = indexedVisibility(state)
  const focusedPosition = position ?? (visible === undefined ? Math.max(0, index) : Math.max(0, visible.indexOf(index)))
  if (index === state.focusedIndex && focusedPosition === state.focusedPosition) return state
  return freezeChoice({ ...state, focusedIndex: index, focusedPosition, focusedId: admittedListItem(state.definition.items, index)?.id })
}

export function reduceChoice(state: UiChoiceState, intent: UiChoiceIntent): UiChoiceState {
  const { definition } = state
  if (intent.kind === 'focus') {
    const index = admittedListIndex(definition.items, intent.id)
    return index < 0 || !enabled(definition, index) || (state.matches !== undefined && !state.matches.includes(index)) ? state : focus(state, index)
  }
  if (intent.kind === 'move' || intent.kind === 'edge') {
    const total = choiceVisibleCount(state)
    const at = (position: number): number => choiceVisibleIndex(state, position)!
    if (intent.kind === 'edge') {
      const step = intent.edge === 'first' ? 1 : -1
      for (let position = step > 0 ? 0 : total - 1; position >= 0 && position < total; position += step) {
        if (enabled(definition, at(position))) return focus(state, at(position), position)
      }
      return state
    }
    /* Movement counts focusable rows: disabled rows are stepped over, and the
       cursor stops on the last enabled row instead of entering a disabled tail. */
    let position = choiceVisiblePosition(state)
    let target: number | undefined
    for (let remaining = Math.max(1, Math.floor(intent.count)), next = position + intent.direction; remaining > 0 && next >= 0 && next < total; next += intent.direction) {
      if (!enabled(definition, at(next))) continue
      target = next
      position = next
      remaining -= 1
    }
    return target === undefined ? state : focus(state, at(target), target)
  }
  if (intent.kind === 'query' || intent.kind === 'clear-search') {
    const query = intent.kind === 'query' ? intent.query : ''
    const matches = filtered(definition, query)
    const anchor = intent.kind === 'clear-search' && state.searchAnchor !== undefined ? admittedListIndex(definition.items, state.searchAnchor) : state.focusedIndex
    const preferred = matches?.[0] ?? anchor
    return freezeChoice(settleFocus(refreshTreeVisibility({ ...state, query, matches,
      searching: intent.kind === 'query',
      searchAnchor: intent.kind === 'clear-search' ? undefined : state.searchAnchor ?? state.focusedId,
    }), preferred))
  }
  if (intent.kind === 'stop-search') return state.searching ? freezeChoice({ ...state, searching: false }) : state
  if (intent.kind === 'segment') {
    const index = admittedListIndex(definition.items, intent.id)
    const segment = index < 0 ? undefined : admittedListItem(definition.items, index)?.segment
    if (segment === undefined) return state
    const options = segment.options.filter(option => option.disabled !== true)
    if (options.length < 2) return state
    const current = choiceSegment(state, intent.id)!
    const position = options.findIndex(option => option.id === current)
    const next = options[Math.max(0, Math.min(options.length - 1, (position < 0 ? 0 : position) + intent.direction))]!
    if (next.id === current) return state
    return freezeChoice({ ...state, segments: { ...state.segments, [intent.id]: next.id } })
  }
  if (intent.kind === 'expand') {
    const collapsing = state.expandedIds.includes(intent.id)
    const expandedIds = collapsing ? state.expandedIds.filter(id => id !== intent.id) : [...state.expandedIds, intent.id]
    if (!collapsing) return freezeChoice(refreshTreeVisibility({ ...state, expandedIds }))
    const parent = state.treeIndex?.byId.get(intent.id)
    let current = state.focusedIndex
    while (parent !== undefined && current !== parent) {
      const next = state.treeIndex?.parentByIndex.get(current)
      if (next === undefined) break
      current = next
    }
    return freezeChoice(settleFocus(refreshTreeVisibility({ ...state, expandedIds }), current === parent ? parent : state.focusedIndex))
  }
  const ids = intent.kind === 'select' ? intent.ids
    : state.selectedIds.includes(intent.id) ? state.selectedIds.filter(id => id !== intent.id) : [...state.selectedIds, intent.id]
  if (definition.role !== 'choose' || new Set(ids).size !== ids.length || ((definition.mode ?? 'single') === 'single' && ids.length > 1)) return state
  for (const id of ids) {
    const item = admittedListItem(definition.items, admittedListIndex(definition.items, id))
    if (item === undefined || item.disabled === true) return state
  }
  const dirty = ids.length !== definition.selectedIds.length || ids.some(id => !definition.selectedIds.includes(id))
  return freezeChoice({ ...state, selectedIds: ids, dirty })
}

/** Resolve a row's effective segment option: draft, then the seeded `selectedId`, then the first enabled option. */
export function choiceSegment(state: UiChoiceState, itemId: string): string | undefined {
  const index = admittedListIndex(state.definition.items, itemId)
  const segment = index < 0 ? undefined : admittedListItem(state.definition.items, index)?.segment
  if (segment === undefined) return undefined
  const draft = state.segments?.[itemId]
  if (draft !== undefined && segment.options.some(option => option.id === draft)) return draft
  return segment.selectedId !== undefined && segment.options.some(option => option.id === segment.selectedId)
    ? segment.selectedId
    : segment.options.find(option => option.disabled !== true)?.id
}

export function choiceError(state: UiChoiceState, t: UiTranslate = untranslated): string | undefined {
  const { definition, selectedIds } = state
  if (selectedIds.length < (definition.minSelected ?? 0)) return t('Select at least {count} options', { count: definition.minSelected! })
  if (definition.maxSelected !== undefined && selectedIds.length > definition.maxSelected) return t('Select at most {count} options', { count: definition.maxSelected })
  for (const id of selectedIds) {
    const item = admittedListItem(definition.items, admittedListIndex(definition.items, id))
    if (item === undefined || item.disabled === true) return t('A selected option is unavailable')
  }
  return undefined
}
