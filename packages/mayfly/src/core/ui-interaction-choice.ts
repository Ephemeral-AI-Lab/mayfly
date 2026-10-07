/** Shared browsing, selection, and search state independent of renderer instances.
 * @module @ephemeral-ai/mayfly/core/ui-interaction-choice
 */
import type { MayflyListNode } from '@ephemeral-ai/mayfly-ui'
import { admittedListExpanded, admittedListIndex, admittedListItem } from './ui-validator.ts'
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
  /** Per-row segment drafts keyed by item id; `null` is an explicit unpin. Ephemeral and excluded from `dirty`. */
  readonly segments?: Readonly<Record<string, string | null>>
  /** The `focusItem.rev` the cursor last followed, so a republish with the same rev leaves the cursor alone. */
  readonly focusRev?: number
  readonly treeIndex?: UiChoiceTreeIndex
  readonly visibleTreeIndices?: readonly number[]
}

interface UiChoiceTreeIndex {
  readonly all: readonly number[]
  readonly byId: ReadonlyMap<string, number>
  readonly parentByIndex: ReadonlyMap<number, number>
  readonly depthByIndex: ReadonlyMap<number, number>
  readonly parents: ReadonlySet<string>
  /** Indexes that are the last visible child of their parent; recomputed with the visibility. */
  readonly lastByIndex: ReadonlySet<number>
}

/** What the painter needs to know about one visible row beyond the item itself. */
export interface UiChoiceRow {
  readonly item: MayflyListNode['items'][number]
  readonly depth: number
  /** The last visible child of its parent: drawn `╰`, the others `│`. */
  readonly last: boolean
  readonly expandable: boolean
  readonly open: boolean
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
  | { readonly kind: 'expand-all' }
  | { readonly kind: 'collapse-all' }
  | { readonly kind: 'unpin', readonly id: string }

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

/** A row the cursor can rest on: not disabled, and not a rule or a blank row. */
export function focusableListItem(item: MayflyListNode['items'][number]): boolean {
  return item.disabled !== true && item.rule === undefined && item.gap !== true
}

function enabled(definition: MayflyListNode, index: number): boolean {
  const item = admittedListItem(definition.items, index)
  return item !== undefined && focusableListItem(item)
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
  return { all: Object.freeze(all), byId, parentByIndex, depthByIndex, parents, lastByIndex: new Set() }
}

export function createChoiceState(definition: MayflyListNode): UiChoiceState {
  const selected = definition.selectedIds[0]
  const query = definition.filter ?? ''
  const matches = filtered(definition, query)
  const index = treeIndex(definition)
  const selectedIndex = selected === undefined ? -1 : admittedListIndex(definition.items, selected)
  // A single choice opens on its current value; a multiple list opens on its first row, whatever is already chosen.
  const initial = selectedIndex < 0 || definition.mode === 'multiple' ? 0 : selectedIndex
  const focusedIndex = matches === undefined || matches.includes(initial) ? initial : matches[0] ?? -1
  const expandedIds: string[] = [...admittedListExpanded(definition.items)]
  if (definition.tree === true && selected !== undefined) {
    let parent = admittedListItem(definition.items, initial)?.parentId
    const seen = new Set<string>()
    while (parent !== undefined && !seen.has(parent)) {
      seen.add(parent)
      if (!expandedIds.includes(parent)) expandedIds.push(parent)
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
  return freezeChoice(followFocusItem(settleFocus(state, focusedIndex), definition))
}

/** Move the cursor to `focusItem.id`, opening its parents, once per `rev`; a republish with the same rev changes nothing. */
function followFocusItem(state: UiChoiceState, definition: MayflyListNode): UiChoiceState {
  const target = definition.focusItem
  if (target === undefined || target.rev === state.focusRev) return state
  const index = admittedListIndex(definition.items, target.id)
  const followed = { ...state, focusRev: target.rev }
  if (index < 0 || !enabled(definition, index)) return followed
  const expandedIds = [...state.expandedIds]
  const seen = new Set<string>()
  for (let parent = admittedListItem(definition.items, index)?.parentId; parent !== undefined && !seen.has(parent);) {
    seen.add(parent)
    if (!expandedIds.includes(parent)) expandedIds.push(parent)
    const at = admittedListIndex(definition.items, parent)
    parent = at < 0 ? undefined : admittedListItem(definition.items, at)?.parentId
  }
  const open = refreshTreeVisibility({ ...followed, expandedIds })
  return settleFocus(open, index)
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
  const lastByParent = new Map<number | undefined, number>()
  for (const index of visibleTreeIndices) lastByParent.set(state.treeIndex!.parentByIndex.get(index), index)
  const treeIndex = { ...state.treeIndex!, lastByIndex: new Set(lastByParent.values()) }
  return { ...withoutVisibility, treeIndex, focusedPosition: Math.max(0, visibleTreeIndices.indexOf(state.focusedIndex)), visibleTreeIndices }
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

/** The item at a raw index; the label is never decorated, because the painter draws guides and disclosure itself. */
export function decorateChoiceItem(state: UiChoiceState, index: number): MayflyListNode['items'][number] {
  return admittedListItem(state.definition.items, index)!
}

/**
 * The painter's view of one visible row: its depth, whether it ends its parent's children, and whether it opens (a branch
 * or a body). A row is open when it is always open, expanded, the cursor row of an `expandFocused` list, or a search is
 * active (so a match inside a branch or body shows).
 */
export function choiceRow(state: UiChoiceState, index: number): UiChoiceRow {
  const item = admittedListItem(state.definition.items, index)!
  const tree = state.treeIndex
  const hasChildren = tree?.parents.has(item.id) === true
  const always = item.bodyAlways === true && item.body !== undefined
  const expandable = !always && (hasChildren || item.body !== undefined)
  const open = always || (expandable && (state.expandedIds.includes(item.id) || state.query.length > 0
    || (state.definition.expandFocused === true && state.focusedId === item.id)))
  return { item, depth: tree?.depthByIndex.get(index) ?? 0, last: tree?.lastByIndex.has(index) === true, expandable, open }
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
  return freezeChoice(followFocusItem(settleFocus(refreshTreeVisibility({
    ...previous, definition, focusedIndex, segments, matches,
    ...(index === undefined ? {} : { treeIndex: index }),
    selectedIds: state.dirty ? state.selectedIds : definition.selectedIds,
  }), focusedIndex), definition))
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
  if (intent.kind === 'segment' || intent.kind === 'unpin') {
    const index = admittedListIndex(definition.items, intent.id)
    const segment = index < 0 ? undefined : admittedListItem(definition.items, index)?.segment
    if (segment === undefined) return state
    if (intent.kind === 'unpin') {
      // Unpinning needs something to fall back to, and something pinned to drop.
      if (segment.inheritedId === undefined || choicePinned(state, intent.id) === null) return state
      return freezeChoice({ ...state, segments: { ...state.segments, [intent.id]: null } })
    }
    const options = segment.options.filter(option => option.disabled !== true)
    if (options.length < 2) return state
    const current = choiceSegment(state, intent.id)
    const position = options.findIndex(option => option.id === current)
    // An unset segment starts from the edge the arrow points into; the ends clamp.
    const next = position < 0 ? (intent.direction > 0 ? options[0]! : options.at(-1)!) : options[Math.max(0, Math.min(options.length - 1, position + intent.direction))]!
    if (next.id === current) return state
    // Stepping onto the inherited option is unpinning.
    return freezeChoice({ ...state, segments: { ...state.segments, [intent.id]: next.id === segment.inheritedId ? null : next.id } })
  }
  if (intent.kind === 'expand-all') {
    const ids = Array.from({ length: definition.items.length }, (_, at) => admittedListItem(definition.items, at)!).filter(item => item.body !== undefined || state.treeIndex?.parents.has(item.id) === true).map(item => item.id)
    return freezeChoice(refreshTreeVisibility({ ...state, expandedIds: ids }))
  }
  if (intent.kind === 'collapse-all') {
    const hidden = refreshTreeVisibility({ ...state, expandedIds: [] })
    // The cursor must stay on a row that is still drawn: walk up to its top-level ancestor.
    let current = state.focusedIndex
    for (let next = hidden.treeIndex?.parentByIndex.get(current); next !== undefined; next = hidden.treeIndex?.parentByIndex.get(current)) current = next
    return freezeChoice(settleFocus(hidden, current))
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

/** The option a row's segment pins: a draft (`null` once unpinned), else the seeded `selectedId`; `null` while unpinned. */
export function choicePinned(state: UiChoiceState, itemId: string): string | null {
  const index = admittedListIndex(state.definition.items, itemId)
  const segment = index < 0 ? undefined : admittedListItem(state.definition.items, index)?.segment
  if (segment === undefined) return null
  const draft = state.segments?.[itemId]
  const pinned = draft === undefined ? segment.selectedId : draft
  return pinned !== undefined && pinned !== null && segment.options.some(option => option.id === pinned) ? pinned : null
}

/**
 * Resolve a row's effective segment option: the pinned one, else the option it inherits, else (a segment that inherits
 * nothing) the first enabled option.
 */
export function choiceSegment(state: UiChoiceState, itemId: string): string | undefined {
  const index = admittedListIndex(state.definition.items, itemId)
  const segment = index < 0 ? undefined : admittedListItem(state.definition.items, index)?.segment
  if (segment === undefined) return undefined
  return choicePinned(state, itemId) ?? segment.inheritedId ?? segment.options.find(option => option.disabled !== true)?.id
}

/** The segment id a selection event reports: the pinned option, or for a row that inherits one, nothing while unpinned. */
export function choiceReportedSegment(state: UiChoiceState, itemId: string): string | undefined {
  const index = admittedListIndex(state.definition.items, itemId)
  const segment = index < 0 ? undefined : admittedListItem(state.definition.items, index)?.segment
  if (segment?.inheritedId === undefined) return choiceSegment(state, itemId)
  return choicePinned(state, itemId) ?? undefined
}

/**
 * Shared selection validation for the choice and form surfaces: cardinality
 * bounds report before an unavailable selection, so both owners yield the same
 * message for the same draft.
 * @param selectedIds - the draft's selected option ids.
 * @param items - the option rows; admitted lazily by id.
 * @param bounds - the allowed selection count.
 * @param t - translator for the message keys.
 * @returns the first error message, or undefined when the selection is valid.
 */
export function selectionError(
  selectedIds: readonly string[],
  items: MayflyListNode['items'],
  bounds: { readonly minSelected?: number, readonly maxSelected?: number },
  t: UiTranslate = untranslated,
): string | undefined {
  if (selectedIds.length < (bounds.minSelected ?? 0)) return t('Select at least {count} options', { count: bounds.minSelected! })
  if (bounds.maxSelected !== undefined && selectedIds.length > bounds.maxSelected) return t('Select at most {count} options', { count: bounds.maxSelected })
  for (const id of selectedIds) {
    const item = admittedListItem(items, admittedListIndex(items, id))
    if (item === undefined || item.disabled === true) return t('A selected option is unavailable')
  }
  return undefined
}

export function choiceError(state: UiChoiceState, t: UiTranslate = untranslated): string | undefined {
  return selectionError(state.selectedIds, state.definition.items, state.definition, t)
}
