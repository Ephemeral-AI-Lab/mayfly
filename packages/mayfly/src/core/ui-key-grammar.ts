/**
 * Declarative key grammar for canonical surfaces. One ordered binding list per
 * focus state drives both input dispatch and the contextual hint row, so a
 * hint can never advertise a key that dispatch routes elsewhere.
 *
 * @module @ephemeral-ai/mayfly/core/ui-key-grammar
 */

import {
  ACTION_CANCEL, ACTION_CLEAR_SEARCH, ACTION_END, ACTION_EXPAND, ACTION_FILTER, ACTION_FOCUS_NEXT, ACTION_FOCUS_PREV, ACTION_HOME, ACTION_INTERRUPT, ACTION_MOVE_DOWN,
  ACTION_MOVE_UP, ACTION_NEWLINE, ACTION_NEXT_CONTROL, ACTION_NEXT_TAB, ACTION_PAGE_DOWN, ACTION_PAGE_UP,
  ACTION_PREV_TAB, ACTION_RESET_FIELD, ACTION_SAVE, ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT, ACTION_SHIFT_TAB, ACTION_SUBMIT, ACTION_TOGGLE, displayKey, printableKey,
} from './key-actions.ts'

/** The layer one Escape press leaves, innermost first. */
export type EscapeStep = 'collapse' | 'cancel' | 'done' | 'end-search' | 'back' | 'close' | 'leave'
  /** Escape cancels the work a loader shows; the surface's own `escapeLabel` words the rest, and the host closes it. */
  | 'cancel-work' | 'reject' | 'surface-back' | 'surface-cancel'
  /** Focus is on a control other than the surface's home control: Escape returns to it before it leaves anything. */
  | 'home'

export type ListMovement = 'up' | 'down' | 'page-up' | 'page-down' | 'home' | 'end'
export type Direction = 'up' | 'down' | 'left' | 'right'

/** Renderer-neutral summary of the focused control. */
export type GrammarControl =
  | { readonly kind: 'none' }
  | { readonly kind: 'editor' }
  | { readonly kind: 'scroll' }
  /** `completes`: the field is being edited and one of its suggestions starts with what is typed, so `Tab` takes it. */
  | { readonly kind: 'text', readonly field: 'input' | 'textarea' | 'secret' | 'number', readonly editing: boolean, readonly enterSubmits: boolean, readonly completes?: boolean }
  /** `stuckLeft`: `←` would change nothing (the first option is current), so it is not this control's key now. */
  | { readonly kind: 'select', readonly multiple: boolean, readonly picker: boolean, readonly adjustable: boolean, readonly enterSubmits?: boolean, readonly stuckLeft?: true }
  | { readonly kind: 'toggle', readonly enterSubmits?: boolean }
  | { readonly kind: 'submit' }
  | { readonly kind: 'field-action' }
  | { readonly kind: 'tab', readonly vertical?: boolean }
  | {
    readonly kind: 'row'
    readonly role: 'browse' | 'choose'
    readonly multiple: boolean
    readonly tree: boolean
    /** The focused row carries a segment strip: its label, lower-cased. */
    readonly segment?: string
    /** The segment is pinned and inherits an option, so Delete can unpin it. */
    readonly unpin?: boolean
    /** The row opens a branch or a body. */
    readonly expandable?: boolean
    /** Enter opens and closes the row instead of accepting it (a body, or a branch of a multiple tree). */
    readonly enterToggles?: boolean
    /** The word for Enter: the list's `acceptVerb`. */
    readonly verb?: string
    /** The word for the list's up and down hint. */
    readonly label?: string
    /** The row has a `←` of its own (a segment strip, a branch), but it would change nothing now. */
    readonly stuckLeft?: true
  }
  | { readonly kind: 'empty-list' }
  | { readonly kind: 'action', readonly decision: boolean }
  /** `work` is a loader's cancel, which Escape fires; its Enter binding stays but is not hinted. */
  | { readonly kind: 'cancel', readonly work?: boolean }

/** Everything the grammar needs to know about one focused surface. */
export interface GrammarState {
  readonly mode: 'ui' | 'editor'
  readonly expanded: boolean
  readonly control: GrammarControl
  /** Present while a list row or empty list holds focus. */
  readonly list?: {
    readonly filterable: boolean
    /** `slash`: only `/` starts a search, so printable keys stay free for accelerators until it does. */
    readonly filterMode?: 'type' | 'slash'
    readonly searching: boolean
    readonly query: boolean
    readonly pasting: boolean
    readonly numbered?: { readonly accept: boolean, readonly count: number }
  }
  /** Declared accelerators of focusable actions, in control order. */
  readonly keyed: readonly { readonly control: number, readonly key: string, readonly label: string }[]
  readonly tabs: boolean
  /** The word the hint row uses for the tab switch (a tabs node's `hintLabel`); `tabs` when absent. */
  readonly tabsLabel?: string
  /** The surface has a rail the focused control is not on: a `←` no control used moves focus to it. */
  readonly railBack?: boolean
  /** The focused control is the first of its group, so a `←` along the group has nowhere to go. */
  readonly groupStart?: boolean
  readonly groups: number
  readonly siblings: number
  readonly escape: EscapeStep | undefined
  /** Ctrl+C requests the same close as the outermost Escape. */
  readonly closable: boolean
  /** What resetting the focused field does, when it has a changed or overriding value. */
  readonly reset?: 'inherit' | 'reset'
  /** The focused control belongs to a form that has something to save: `ui.save` submits it from any of its fields. */
  readonly save?: boolean
}

export type GrammarIntent =
  | { readonly kind: 'editor' }
  | { readonly kind: 'swallow' }
  | { readonly kind: 'collapse' }
  | { readonly kind: 'expand' }
  | { readonly kind: 'scroll', readonly movement: ListMovement }
  | { readonly kind: 'escape', readonly step: EscapeStep }
  | { readonly kind: 'close' }
  | { readonly kind: 'keyed', readonly control: number }
  | { readonly kind: 'numbered' }
  | { readonly kind: 'tab-switch', readonly delta: -1 | 1 }
  | { readonly kind: 'focus-level', readonly delta: -1 | 1 }
  | { readonly kind: 'rail-back' }
  | { readonly kind: 'group', readonly delta: -1 | 1 }
  | { readonly kind: 'search-clear' }
  | { readonly kind: 'search-start' }
  | { readonly kind: 'search-type' }
  | { readonly kind: 'text-newline' }
  | { readonly kind: 'text-enter' }
  | { readonly kind: 'text-type' }
  | { readonly kind: 'text-begin' }
  | { readonly kind: 'enter-submits' }
  | { readonly kind: 'select-cycle', readonly delta: -1 | 1 }
  | { readonly kind: 'picker-open' }
  | { readonly kind: 'picker-move', readonly delta: -1 | 1 }
  | { readonly kind: 'picker-toggle' }
  | { readonly kind: 'picker-apply' }
  | { readonly kind: 'tab-move', readonly delta: -1 | 1 }
  | { readonly kind: 'tab-descend' }
  | { readonly kind: 'list-move', readonly movement: ListMovement }
  | { readonly kind: 'segment', readonly delta: -1 | 1 }
  | { readonly kind: 'branch', readonly expand?: boolean }
  | { readonly kind: 'accept' }
  | { readonly kind: 'commit' }
  | { readonly kind: 'toggle-row' }
  | { readonly kind: 'unpin' }
  | { readonly kind: 'branch-all', readonly expand: boolean }
  | { readonly kind: 'navigate', readonly direction: Direction }
  | { readonly kind: 'activate' }
  | { readonly kind: 'field-reset' }
  | { readonly kind: 'form-save' }
  | { readonly kind: 'complete' }
  | { readonly kind: 'number-step', readonly delta: -1 | 1 }

export type GrammarMatch =
  | { readonly kind: 'action', readonly action: string }
  | { readonly kind: 'key', readonly key: string }
  | { readonly kind: 'digit' }
  | { readonly kind: 'text', readonly space: boolean }
  | { readonly kind: 'backspace' }
  | { readonly kind: 'any' }

/** One hint fragment. `actions` render through the live keymap; `keys` is literal. */
export interface GrammarHint {
  readonly id: string
  readonly label: string
  readonly priority: number
  readonly actions?: readonly string[]
  readonly keys?: string
  readonly compact?: string
}

export interface GrammarBinding {
  readonly match: GrammarMatch
  readonly intent: GrammarIntent
  readonly hint?: GrammarHint
}

const ESCAPE_LABEL: Readonly<Record<EscapeStep, string>> = {
  collapse: 'collapse', cancel: 'cancel', done: 'done', 'end-search': 'end search', back: 'back', close: 'close', leave: 'leave',
  'cancel-work': 'cancel', reject: 'reject', 'surface-back': 'back', 'surface-cancel': 'cancel', home: 'back',
}

/** Hint priorities: Escape is reserved, then the primary operation, then navigation; digits repeat Enter, so they yield to arrows. */
const PRIORITY = { escape: 120, primary: 100, accelerator: 96, adjust: 95, rail: 94, navigate: 90, numbered: 88, secondary: 85, group: 80 } as const

const action = (id: string): GrammarMatch => ({ kind: 'action', action: id })

function push(bindings: GrammarBinding[], match: GrammarMatch, intent: GrammarIntent, hint?: GrammarHint): void {
  bindings.push(hint === undefined ? { match, intent } : { match, intent, hint })
}

function accelerators(bindings: GrammarBinding[], state: GrammarState, printable: boolean): void {
  for (const keyed of state.keyed) {
    if (!printable && printableKey(keyed.key)) continue
    push(bindings, { kind: 'key', key: keyed.key }, { kind: 'keyed', control: keyed.control }, { id: `keyed:${String(keyed.control)}`, keys: hintNotation([keyed.key]), label: keyed.label.toLowerCase(), priority: PRIORITY.accelerator })
  }
}

function groupMoves(bindings: GrammarBinding[], state: GrammarState, hinted: boolean): void {
  const hint = hinted && state.groups > 1
    ? { id: 'group', label: 'groups', priority: PRIORITY.group, actions: [ACTION_NEXT_CONTROL, ACTION_SHIFT_TAB], compact: 'Tab' }
    : undefined
  push(bindings, action(ACTION_NEXT_CONTROL), { kind: 'group', delta: 1 }, hint)
  push(bindings, action(ACTION_SHIFT_TAB), { kind: 'group', delta: -1 })
}

function tabSwitches(bindings: GrammarBinding[], state: GrammarState, hinted: boolean): void {
  if (!state.tabs) return
  const hint = hinted ? { id: 'tabs', label: state.tabsLabel ?? 'tabs', priority: PRIORITY.secondary, actions: [ACTION_PREV_TAB, ACTION_NEXT_TAB], compact: 'Alt+←→' } : undefined
  push(bindings, action(ACTION_PREV_TAB), { kind: 'tab-switch', delta: -1 }, hint)
  push(bindings, action(ACTION_NEXT_TAB), { kind: 'tab-switch', delta: 1 })
}

/** Focus levels: `ui.focus-prev`/`ui.focus-next` move between controls whenever no text is being edited (spec 3.5). */
function focusLevels(bindings: GrammarBinding[]): void {
  push(bindings, action(ACTION_FOCUS_PREV), { kind: 'focus-level', delta: -1 })
  push(bindings, action(ACTION_FOCUS_NEXT), { kind: 'focus-level', delta: 1 })
}

/**
 * The last rung of the `←` ladder: a `←` that the focused control did not use moves focus to the surface's rail, and the
 * hint row says so. The caller binds it only where the control has nothing left to do with `←`, so the cue is true.
 */
function railLeft(bindings: GrammarBinding[], state: GrammarState): boolean {
  if (state.railBack !== true) return false
  push(bindings, action(ACTION_SEGMENT_LEFT), { kind: 'rail-back' }, { id: 'labels', label: 'labels', priority: PRIORITY.rail, actions: [ACTION_SEGMENT_LEFT] })
  return true
}

/**
 * Binds the directions; the hint names only `shown` (the kit's pair), since the other arrows move too. With `toRail`, a
 * `←` goes to the surface's rail (when it has one the focused control is not on) instead of the nearest control beside.
 */
function navigation(bindings: GrammarBinding[], state: GrammarState, directions: readonly Direction[], label: string, shown: readonly Direction[] = directions, toRail = false): void {
  const ids: Readonly<Record<Direction, string>> = { up: ACTION_MOVE_UP, down: ACTION_MOVE_DOWN, left: ACTION_SEGMENT_LEFT, right: ACTION_SEGMENT_RIGHT }
  const hinted = state.siblings > 1 || state.groups > 1
  for (const [index, direction] of directions.entries()) {
    if (direction === 'left' && toRail && railLeft(bindings, state)) continue
    push(bindings, action(ids[direction]), { kind: 'navigate', direction },
      index === 0 && hinted ? { id: 'navigate', label, priority: PRIORITY.navigate, actions: shown.map(entry => ids[entry]) } : undefined)
  }
}

function listMovement(bindings: GrammarBinding[], label: string, hinted: boolean): void {
  for (const [index, [id, movement]] of MOVEMENTS.entries()) {
    push(bindings, action(id), { kind: 'list-move', movement },
      index === 0 && hinted ? { id: 'navigate', label, priority: PRIORITY.navigate, actions: [ACTION_MOVE_UP, ACTION_MOVE_DOWN] } : undefined)
  }
}

const MOVEMENTS: readonly (readonly [string, ListMovement])[] = [
  [ACTION_MOVE_UP, 'up'], [ACTION_MOVE_DOWN, 'down'], [ACTION_PAGE_UP, 'page-up'],
  [ACTION_PAGE_DOWN, 'page-down'], [ACTION_HOME, 'home'], [ACTION_END, 'end'],
]

function scrollKeys(bindings: GrammarBinding[]): void {
  const hint = { id: 'navigate', label: 'scroll', priority: PRIORITY.navigate, actions: [ACTION_MOVE_UP, ACTION_MOVE_DOWN] }
  for (const [index, [id, movement]] of MOVEMENTS.entries()) push(bindings, action(id), { kind: 'scroll', movement }, index === 0 ? hint : undefined)
}

function formSave(bindings: GrammarBinding[], state: GrammarState): void {
  if (state.save === true) push(bindings, action(ACTION_SAVE), { kind: 'form-save' })
}

function textEditing(bindings: GrammarBinding[], state: GrammarState, control: Extract<GrammarControl, { readonly kind: 'text' }>): void {
  formSave(bindings, state)
  // A suggestion that matches takes Tab; the group move is hinted only when Tab has nothing to complete.
  if (control.completes === true) push(bindings, action(ACTION_NEXT_CONTROL), { kind: 'complete' }, { id: 'complete', label: 'complete', priority: PRIORITY.adjust, actions: [ACTION_NEXT_CONTROL] })
  groupMoves(bindings, state, control.completes !== true)
  const textarea = control.field === 'textarea'
  push(bindings, action(ACTION_NEWLINE), textarea ? { kind: 'text-newline' } : { kind: 'swallow' },
    textarea ? { id: 'newline', label: 'newline', priority: PRIORITY.adjust, actions: [ACTION_NEWLINE] } : undefined)
  push(bindings, action(ACTION_SUBMIT), { kind: 'text-enter' }, { id: 'activate', label: control.enterSubmits ? 'submit' : 'next', priority: PRIORITY.primary, actions: [ACTION_SUBMIT] })
  push(bindings, { kind: 'any' }, { kind: 'text-type' })
}

function picker(bindings: GrammarBinding[], state: GrammarState, control: Extract<GrammarControl, { readonly kind: 'select' }>): void {
  formSave(bindings, state)
  groupMoves(bindings, state, true)
  const moves: readonly (readonly [string, -1 | 1])[] = [[ACTION_MOVE_UP, -1], [ACTION_MOVE_DOWN, 1], [ACTION_SEGMENT_LEFT, -1], [ACTION_SEGMENT_RIGHT, 1]]
  for (const [index, [id, delta]] of moves.entries()) {
    push(bindings, action(id), { kind: 'picker-move', delta },
      index === 0 && control.adjustable ? { id: 'navigate', label: 'options', priority: PRIORITY.navigate, actions: [ACTION_MOVE_UP, ACTION_MOVE_DOWN] } : undefined)
  }
  if (control.multiple) push(bindings, action(ACTION_TOGGLE), { kind: 'picker-toggle' }, { id: 'toggle', label: 'toggle', priority: PRIORITY.adjust, actions: [ACTION_TOGGLE] })
  push(bindings, action(ACTION_SUBMIT), { kind: 'picker-apply' }, { id: 'activate', label: 'apply', priority: PRIORITY.primary, actions: [ACTION_SUBMIT] })
  push(bindings, { kind: 'any' }, { kind: 'swallow' })
}

/** The word on Enter: the row's own verb, `branch` where Enter opens it, else the list's `acceptVerb` or its role's default. */
function enterVerb(control: Extract<GrammarControl, { readonly kind: 'row' }>): string {
  if (control.enterToggles === true) return 'branch'
  return control.verb ?? (control.role === 'browse' && control.segment === undefined ? 'open' : 'choose')
}

function rowBindings(bindings: GrammarBinding[], state: GrammarState, control: Extract<GrammarControl, { readonly kind: 'row' }>): void {
  const searching = state.list?.searching === true
  const activate = { id: 'activate', label: enterVerb(control), priority: PRIORITY.primary, actions: [ACTION_SUBMIT] }
  if (control.multiple) {
    push(bindings, action(ACTION_TOGGLE), { kind: 'toggle-row' }, { id: 'toggle', label: 'toggle', priority: PRIORITY.adjust, actions: [ACTION_TOGGLE] })
    push(bindings, action(ACTION_SUBMIT), control.enterToggles === true ? { kind: 'branch' } : { kind: 'commit' }, activate)
  } else {
    push(bindings, action(ACTION_SUBMIT), control.enterToggles === true ? { kind: 'branch' } : { kind: 'accept' }, activate)
    // A tree's Space keeps its old meaning; a body opens with Space too, but ←/→ carries its hint.
    if ((control.tree || control.expandable === true) && !searching) {
      push(bindings, action(ACTION_TOGGLE), { kind: 'branch' }, control.tree && control.expandable !== true ? { id: 'branch', label: 'branch', priority: PRIORITY.adjust, actions: [ACTION_TOGGLE] } : undefined)
    }
  }
}

function listText(bindings: GrammarBinding[], state: GrammarState): void {
  const list = state.list
  if (list?.filterable !== true) return
  // A slash list takes typed text only once `/` has started the search; a type list starts one with any printable key.
  if (list.filterMode === 'slash' && !list.searching) return
  push(bindings, { kind: 'text', space: list.searching }, { kind: 'search-type' },
    list.searching ? undefined : { id: 'search', keys: 'Type', label: 'filter', priority: PRIORITY.primary })
}

function rowMovement(bindings: GrammarBinding[], state: GrammarState, control: Extract<GrammarControl, { readonly kind: 'row' }>): void {
  // While a search is typing, arrows still move the cursor, but the hint names only what ends or clears the search.
  listMovement(bindings, control.label ?? 'options', state.list?.searching !== true && control.segment === undefined)
  // The ladder (spec 4.5): a row uses `←` only when it changes something; the first `←` it does not use goes to the rail.
  const stuck = control.stuckLeft === true
  if (control.segment !== undefined) {
    const adjust = { id: 'adjust', label: control.segment, priority: PRIORITY.adjust, actions: [ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT] }
    if (!stuck) push(bindings, action(ACTION_SEGMENT_LEFT), { kind: 'segment', delta: -1 }, adjust)
    push(bindings, action(ACTION_SEGMENT_RIGHT), { kind: 'segment', delta: 1 }, stuck ? adjust : undefined)
    if (stuck) railLeft(bindings, state)
    if (control.unpin === true) push(bindings, action(ACTION_RESET_FIELD), { kind: 'unpin' }, { id: 'reset', label: 'use default', priority: PRIORITY.accelerator, actions: [ACTION_RESET_FIELD] })
  } else if (control.tree || control.expandable === true) {
    const branch = control.multiple || control.expandable === true ? { id: 'branch', label: 'branch', priority: PRIORITY.adjust, actions: [ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT] } : undefined
    if (!stuck) push(bindings, action(ACTION_SEGMENT_LEFT), { kind: 'branch', expand: false }, branch)
    push(bindings, action(ACTION_SEGMENT_RIGHT), { kind: 'branch', expand: true }, stuck ? branch : undefined)
    if (stuck) railLeft(bindings, state)
  } else {
    // Rows move vertically; left/right leave the list for the nearest control beside it.
    if (!railLeft(bindings, state)) push(bindings, action(ACTION_SEGMENT_LEFT), { kind: 'navigate', direction: 'left' })
    push(bindings, action(ACTION_SEGMENT_RIGHT), { kind: 'navigate', direction: 'right' })
  }
  if (control.tree && control.segment === undefined && state.list?.searching !== true) {
    push(bindings, { kind: 'key', key: '*' }, { kind: 'branch-all', expand: true })
    push(bindings, { kind: 'key', key: '-' }, { kind: 'branch-all', expand: false })
  }
}

/**
 * The ordered binding list for one focus state. The first binding whose
 * matcher accepts an input sequence handles it; hints are the first binding
 * carrying each hint id.
 */
export function keyGrammar(state: GrammarState): readonly GrammarBinding[] {
  const bindings: GrammarBinding[] = []
  const control = state.control
  // An editor shell leaves every key to the host editor except modifier accelerators.
  if (state.mode === 'editor' && control.kind === 'editor') {
    accelerators(bindings, state, false)
    push(bindings, { kind: 'any' }, { kind: 'editor' })
    return bindings
  }
  if (state.expanded) {
    push(bindings, action(ACTION_EXPAND), { kind: 'collapse' }, { id: 'expand', label: ESCAPE_LABEL.collapse, priority: PRIORITY.escape - 1, actions: [ACTION_EXPAND] })
    push(bindings, action(ACTION_CANCEL), { kind: 'collapse' }, { id: 'escape', label: ESCAPE_LABEL.collapse, priority: PRIORITY.escape, actions: [ACTION_CANCEL] })
    scrollKeys(bindings)
    push(bindings, { kind: 'any' }, { kind: 'swallow' })
    return bindings
  }
  if (state.escape !== undefined) {
    push(bindings, action(ACTION_CANCEL), { kind: 'escape', step: state.escape }, { id: 'escape', label: ESCAPE_LABEL[state.escape], priority: PRIORITY.escape, actions: [ACTION_CANCEL] })
  }
  if (state.closable) push(bindings, action(ACTION_INTERRUPT), { kind: 'close' })
  if (control.kind === 'text' && control.editing) { textEditing(bindings, state, control); return bindings }
  if (control.kind === 'select' && control.picker) { picker(bindings, state, control); return bindings }

  const list = state.list
  if (list?.pasting === true) push(bindings, { kind: 'any' }, { kind: 'search-type' })
  if (list?.filterable === true) {
    if (list.query || list.searching) push(bindings, action(ACTION_CLEAR_SEARCH), { kind: 'search-clear' }, { id: 'clear', label: 'clear', priority: PRIORITY.secondary, actions: [ACTION_CLEAR_SEARCH] })
    // A slash list names its key: bare letters are free, so `/` is how a search starts.
    if (!list.searching) push(bindings, action(ACTION_FILTER), { kind: 'search-start' }, list.filterMode === 'slash' ? { id: 'search', label: 'filter', priority: PRIORITY.primary, actions: [ACTION_FILTER] } : undefined)
  }
  if (control.kind === 'scroll') push(bindings, action(ACTION_EXPAND), { kind: 'expand' }, { id: 'expand', label: 'expand', priority: PRIORITY.adjust, actions: [ACTION_EXPAND] })
  // Printable accelerators never pre-empt a control that consumes typed text.
  // A type-to-filter list reads every printable key as text; a slash list does only once its search is open.
  accelerators(bindings, state, control.kind !== 'text' && !(list?.filterable === true && (list.filterMode !== 'slash' || list.searching)))
  if (list?.numbered !== undefined && !list.searching && list.numbered.count > 0) {
    push(bindings, { kind: 'digit' }, { kind: 'numbered' }, { id: 'numbered', keys: list.numbered.count === 1 ? '1' : `1-${String(list.numbered.count)}`, label: list.numbered.accept ? 'choose' : 'focus', priority: PRIORITY.numbered })
  }
  // A search in progress hints only what ends or clears it.
  tabSwitches(bindings, state, control.kind !== 'tab' && list?.searching !== true)
  groupMoves(bindings, state, control.kind !== 'tab' && list?.searching !== true)
  focusLevels(bindings)
  if (list?.searching === true) push(bindings, { kind: 'backspace' }, { kind: 'search-type' })
  // A declared Delete accelerator keeps its key; otherwise Delete resets a changed field.
  if (state.reset !== undefined && (control.kind === 'text' || control.kind === 'select' || control.kind === 'toggle') && !state.keyed.some(keyed => keyed.key.toLowerCase() === 'delete')) {
    push(bindings, action(ACTION_RESET_FIELD), { kind: 'field-reset' }, { id: 'reset', label: state.reset === 'inherit' ? 'use inherited' : 'reset', priority: PRIORITY.accelerator, actions: [ACTION_RESET_FIELD] })
  }

  switch (control.kind) {
    case 'none':
    case 'editor':
      push(bindings, { kind: 'any' }, { kind: 'swallow' })
      return bindings
    case 'scroll':
      scrollKeys(bindings)
      railLeft(bindings, state)
      break
    case 'row':
      // Movement first, so the hint row reads `←/→ branch` before `Space toggle`, as the kit orders them.
      rowMovement(bindings, state, control)
      rowBindings(bindings, state, control)
      listText(bindings, state)
      break
    case 'empty-list':
      push(bindings, action(ACTION_SUBMIT), { kind: 'accept' })
      railLeft(bindings, state)
      listText(bindings, state)
      break
    case 'text':
      formSave(bindings, state)
      push(bindings, action(ACTION_SUBMIT), control.enterSubmits ? { kind: 'enter-submits' } : { kind: 'text-begin' },
        { id: 'activate', label: control.enterSubmits ? 'submit' : 'edit', priority: PRIORITY.primary, actions: [ACTION_SUBMIT] })
      push(bindings, { kind: 'text', space: true }, { kind: 'text-begin' })
      if (control.field === 'number') {
        // A number steps with ←/→ and gives the key back to the row beside it at its limits.
        navigation(bindings, state, ['up', 'down'], 'fields')
        push(bindings, action(ACTION_SEGMENT_LEFT), { kind: 'number-step', delta: -1 }, { id: 'adjust', label: 'step', priority: PRIORITY.adjust, actions: [ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT] })
        push(bindings, action(ACTION_SEGMENT_RIGHT), { kind: 'number-step', delta: 1 })
      } else navigation(bindings, state, ['up', 'down', 'left', 'right'], 'fields', ['up', 'down'], true)
      break
    case 'select':
      formSave(bindings, state)
      navigation(bindings, state, ['up', 'down'], 'fields')
      if (!control.multiple && control.adjustable) {
        // A select at its first option does not use `←`: it falls through to the rail.
        const adjust = { id: 'adjust', label: 'adjust', priority: PRIORITY.adjust, actions: [ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT] }
        if (control.stuckLeft !== true) push(bindings, action(ACTION_SEGMENT_LEFT), { kind: 'select-cycle', delta: -1 }, adjust)
        push(bindings, action(ACTION_SEGMENT_RIGHT), { kind: 'select-cycle', delta: 1 }, control.stuckLeft === true ? adjust : undefined)
      }
      // A form that Enter submits keeps Enter for that, and Space opens the picker.
      if (control.enterSubmits === true) {
        push(bindings, action(ACTION_SUBMIT), { kind: 'enter-submits' }, { id: 'activate', label: 'continue', priority: PRIORITY.primary, actions: [ACTION_SUBMIT] })
        push(bindings, action(ACTION_TOGGLE), { kind: 'picker-open' })
      } else {
        push(bindings, action(ACTION_SUBMIT), { kind: 'picker-open' }, { id: 'activate', label: 'pick', priority: PRIORITY.primary, actions: [ACTION_SUBMIT] })
        if (control.multiple) push(bindings, action(ACTION_TOGGLE), { kind: 'picker-open' })
      }
      // `←` is the rail's unless this select steps with it.
      navigation(bindings, state, ['left', 'right'], 'fields', ['left', 'right'], control.multiple || !control.adjustable || control.stuckLeft === true)
      break
    case 'tab':
      // A rail moves with `↑/↓`, enters its content with `→`, and has no level to leave with `←`.
      if (control.vertical === true) {
        push(bindings, action(ACTION_MOVE_UP), { kind: 'tab-move', delta: -1 }, { id: 'navigate', label: 'labels', priority: PRIORITY.navigate, actions: [ACTION_MOVE_UP, ACTION_MOVE_DOWN] })
        push(bindings, action(ACTION_MOVE_DOWN), { kind: 'tab-move', delta: 1 })
        push(bindings, action(ACTION_SEGMENT_RIGHT), { kind: 'tab-descend' }, { id: 'activate', label: 'open', priority: PRIORITY.primary, actions: [ACTION_SEGMENT_RIGHT] })
        push(bindings, action(ACTION_SUBMIT), { kind: 'tab-descend' })
        push(bindings, action(ACTION_SEGMENT_LEFT), { kind: 'swallow' })
        break
      }
      push(bindings, action(ACTION_SEGMENT_LEFT), { kind: 'tab-move', delta: -1 }, { id: 'navigate', label: 'tabs', priority: PRIORITY.navigate, actions: [ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT] })
      push(bindings, action(ACTION_SEGMENT_RIGHT), { kind: 'tab-move', delta: 1 })
      push(bindings, action(ACTION_SUBMIT), { kind: 'tab-descend' }, { id: 'activate', label: 'open', priority: PRIORITY.primary, actions: [ACTION_SUBMIT] })
      navigation(bindings, state, ['up', 'down'], 'tabs')
      break
    case 'toggle':
    case 'submit':
    case 'field-action':
    case 'action':
    case 'cancel': {
      if (control.kind === 'toggle' || control.kind === 'submit') formSave(bindings, state)
      if (control.kind === 'toggle' && control.enterSubmits === true) {
        push(bindings, action(ACTION_SUBMIT), { kind: 'enter-submits' }, { id: 'activate', label: 'continue', priority: PRIORITY.primary, actions: [ACTION_SUBMIT] })
        push(bindings, action(ACTION_TOGGLE), { kind: 'activate' })
        navigation(bindings, state, ['up', 'down', 'left', 'right'], 'fields', ['up', 'down'])
        break
      }
      const label = control.kind === 'toggle' ? 'toggle' : control.kind === 'submit' ? 'submit' : control.kind === 'field-action' ? 'apply'
        : control.kind === 'cancel' ? 'cancel' : control.decision ? 'confirm' : 'run'
      push(bindings, action(ACTION_SUBMIT), { kind: 'activate' }, control.kind === 'cancel' && control.work === true ? undefined : { id: 'activate', label, priority: PRIORITY.primary, actions: [ACTION_SUBMIT] })
      push(bindings, action(ACTION_TOGGLE), { kind: 'activate' })
      // The kit names the pair that moves along the row: `←/→ actions` (`No/Yes` on a decision), `↑/↓ fields`.
      // Along an actions row `←` steps back; at its first action, or on a toggle or submit, it is the rail's.
      if (control.kind === 'action' || control.kind === 'cancel') navigation(bindings, state, ['up', 'down', 'left', 'right'], control.kind === 'action' && control.decision ? 'No/Yes' : 'actions', ['left', 'right'], state.groupStart === true)
      else navigation(bindings, state, ['up', 'down', 'left', 'right'], 'fields', ['up', 'down'], control.kind !== 'field-action')
      break
    }
  }
  push(bindings, { kind: 'any' }, { kind: 'swallow' })
  return bindings
}

/**
 * The notation of a hint's keys (spec §3.2): a printable key reads as itself (`c copy`), others as their display names,
 * and a pair that shares a modifier names it once (`Alt+←/→`).
 * @param keys - the bound key ids, in order.
 * @returns the keys as the hint row writes them.
 */
export function hintNotation(keys: readonly string[]): string {
  const shown = keys.map(key => key.length === 1 && printableKey(key) ? key : displayKey(key))
  const modifier = /^(?:Alt|Ctrl)\+/u.exec(shown[0] ?? '')?.[0]
  if (shown.length === 2 && modifier !== undefined && shown[1]!.startsWith(modifier)) return `${shown[0]!}/${shown[1]!.slice(modifier.length)}`
  return shown.join('/')
}

/** The first hint for each id, in binding order. */
export function grammarHints(bindings: readonly GrammarBinding[]): readonly GrammarHint[] {
  const seen = new Set<string>()
  const hints: GrammarHint[] = []
  for (const binding of bindings) {
    if (binding.hint === undefined || seen.has(binding.hint.id)) continue
    seen.add(binding.hint.id)
    hints.push(binding.hint)
  }
  return hints
}

/**
 * Reader-facing summary of the shared surface grammar with default keys. It
 * is maintained beside `keyGrammar`; /help renders it and the Website key
 * reference is checked against it, so all three describe the same behavior.
 */
export const SHARED_KEY_REFERENCE: readonly { readonly keys: string, readonly action: string }[] = Object.freeze([
  { keys: '↑/↓', action: 'Move between rows and fields; scroll documents' },
  { keys: '←/→', action: 'Cycle a select value, adjust a row setting, open or close a tree branch, or move along a tab strip' },
  { keys: 'Alt+←/→ or F2/F3', action: 'Switch tabs from anywhere on the surface; wizards validate the step being left' },
  { keys: 'Alt+↑/↓ or F4/F5', action: 'Move between controls from anywhere outside text editing and open pickers' },
  { keys: '←', action: 'Used by the focused control when it changes something; otherwise it moves focus to the surface\'s rail of labels, where it does nothing' },
  { keys: '→ or Enter on a rail', action: 'Enter the page beside the rail; ↑/↓ on the rail change the page at once' },
  { keys: 'Alt+↓ or F5, F6', action: 'From an empty prompt, enter the views of the status bar (F6 enters them first, then the interactive panes); ←/→ switch views and Esc returns to the prompt' },
  { keys: 'PgUp/PgDn, Home/End', action: 'Page or jump in lists and documents' },
  { keys: 'Enter', action: 'Choose, run, open a picker, apply it, or start editing a field' },
  { keys: 'Space', action: 'Toggle a checkbox or multi-select row, open a multiselect, or fold a tree branch' },
  { keys: 'Tab/Shift+Tab', action: 'Move to the next or previous control group, committing text and pickers' },
  { keys: 'Esc', action: 'Leave the innermost layer: picker, editing, search, back, return to the first control, then close' },
  { keys: 'Ctrl+C', action: 'Close the surface, asking first when there are unsaved changes' },
  { keys: 'Type or /', action: 'Filter a filterable list; Ctrl+U clears the filter' },
  { keys: '1-9', action: 'Pick a numbered row' },
  { keys: 'Ctrl+E', action: 'Expand focused scrollable content to full screen' },
  { keys: 'Delete', action: 'Return a changed field to its inherited or default value' },
  { keys: 'Alt+Enter or Ctrl+J', action: 'Insert a newline in a multi-line field' },
  { keys: 'Ctrl+S, c, x, r, Ctrl+G, Ctrl+F', action: 'Save, copy, delete, refresh, open in $EDITOR, or search, wherever a panel offers that meaning' },
])
