/**
 * Declarative key grammar for canonical surfaces. One ordered binding list per
 * focus state drives both input dispatch and the contextual hint row, so a
 * hint can never advertise a key that dispatch routes elsewhere.
 *
 * @module @ephemeral-ai/mayfly/core/ui-key-grammar
 */

import {
  ACTION_CANCEL, ACTION_CLEAR_SEARCH, ACTION_END, ACTION_EXPAND, ACTION_HOME, ACTION_INTERRUPT, ACTION_MOVE_DOWN,
  ACTION_MOVE_UP, ACTION_NEWLINE, ACTION_NEXT_CONTROL, ACTION_NEXT_TAB, ACTION_PAGE_DOWN, ACTION_PAGE_UP,
  ACTION_PREV_TAB, ACTION_RESET_FIELD, ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT, ACTION_SHIFT_TAB, ACTION_SUBMIT, ACTION_TOGGLE, displayKey, printableKey,
} from './key-actions.ts'

/** The layer one Escape press leaves, innermost first. */
export type EscapeStep = 'collapse' | 'cancel' | 'done' | 'end-search' | 'back' | 'close' | 'leave'

export type ListMovement = 'up' | 'down' | 'page-up' | 'page-down' | 'home' | 'end'
export type Direction = 'up' | 'down' | 'left' | 'right'

/** Renderer-neutral summary of the focused control. */
export type GrammarControl =
  | { readonly kind: 'none' }
  | { readonly kind: 'editor' }
  | { readonly kind: 'scroll' }
  | { readonly kind: 'text', readonly field: 'input' | 'textarea' | 'secret' | 'number', readonly editing: boolean, readonly enterSubmits: boolean }
  | { readonly kind: 'select', readonly multiple: boolean, readonly picker: boolean, readonly adjustable: boolean }
  | { readonly kind: 'toggle' }
  | { readonly kind: 'submit' }
  | { readonly kind: 'field-action' }
  | { readonly kind: 'tab' }
  | { readonly kind: 'row', readonly role: 'browse' | 'choose', readonly multiple: boolean, readonly tree: boolean, readonly segment?: string }
  | { readonly kind: 'empty-list' }
  | { readonly kind: 'action', readonly decision: boolean }
  | { readonly kind: 'cancel' }

/** Everything the grammar needs to know about one focused surface. */
export interface GrammarState {
  readonly mode: 'ui' | 'editor'
  readonly expanded: boolean
  readonly control: GrammarControl
  /** Present while a list row or empty list holds focus. */
  readonly list?: {
    readonly filterable: boolean
    readonly searching: boolean
    readonly query: boolean
    readonly pasting: boolean
    readonly numbered?: { readonly accept: boolean, readonly count: number }
  }
  /** Declared accelerators of focusable actions, in control order. */
  readonly keyed: readonly { readonly control: number, readonly key: string, readonly label: string }[]
  readonly tabs: boolean
  readonly groups: number
  readonly siblings: number
  readonly escape: EscapeStep | undefined
  /** Ctrl+C requests the same close as the outermost Escape. */
  readonly closable: boolean
  /** What resetting the focused field does, when it has a changed or overriding value. */
  readonly reset?: 'inherit' | 'reset'
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
  | { readonly kind: 'navigate', readonly direction: Direction }
  | { readonly kind: 'activate' }
  | { readonly kind: 'field-reset' }

export type GrammarMatch =
  | { readonly kind: 'action', readonly action: string }
  | { readonly kind: 'key', readonly key: string }
  | { readonly kind: 'char', readonly char: string }
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
}

/** Hint priorities: Escape is reserved, then the primary operation, then navigation; digits repeat Enter, so they yield to arrows. */
const PRIORITY = { escape: 120, primary: 100, accelerator: 96, adjust: 95, navigate: 90, numbered: 88, secondary: 85, group: 80 } as const

const action = (id: string): GrammarMatch => ({ kind: 'action', action: id })

function push(bindings: GrammarBinding[], match: GrammarMatch, intent: GrammarIntent, hint?: GrammarHint): void {
  bindings.push(hint === undefined ? { match, intent } : { match, intent, hint })
}

function accelerators(bindings: GrammarBinding[], state: GrammarState, printable: boolean): void {
  for (const keyed of state.keyed) {
    if (!printable && printableKey(keyed.key)) continue
    push(bindings, { kind: 'key', key: keyed.key }, { kind: 'keyed', control: keyed.control }, { id: `keyed:${keyed.key}`, keys: displayKey(keyed.key), label: keyed.label, priority: PRIORITY.accelerator })
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
  const hint = hinted ? { id: 'tabs', label: 'tabs', priority: PRIORITY.secondary, actions: [ACTION_PREV_TAB, ACTION_NEXT_TAB], compact: 'Alt+←→' } : undefined
  push(bindings, action(ACTION_PREV_TAB), { kind: 'tab-switch', delta: -1 }, hint)
  push(bindings, action(ACTION_NEXT_TAB), { kind: 'tab-switch', delta: 1 })
}

function navigation(bindings: GrammarBinding[], state: GrammarState, directions: readonly Direction[], label: string): void {
  const ids: Readonly<Record<Direction, string>> = { up: ACTION_MOVE_UP, down: ACTION_MOVE_DOWN, left: ACTION_SEGMENT_LEFT, right: ACTION_SEGMENT_RIGHT }
  const hinted = state.siblings > 1 || state.groups > 1
  for (const [index, direction] of directions.entries()) {
    push(bindings, action(ids[direction]), { kind: 'navigate', direction },
      index === 0 && hinted ? { id: 'navigate', label, priority: PRIORITY.navigate, actions: directions.map(entry => ids[entry]) } : undefined)
  }
}

function listMovement(bindings: GrammarBinding[]): void {
  for (const [index, [id, movement]] of MOVEMENTS.entries()) {
    push(bindings, action(id), { kind: 'list-move', movement },
      index === 0 ? { id: 'navigate', label: 'options', priority: PRIORITY.navigate, actions: [ACTION_MOVE_UP, ACTION_MOVE_DOWN] } : undefined)
  }
}

const MOVEMENTS: readonly (readonly [string, ListMovement])[] = [
  [ACTION_MOVE_UP, 'up'], [ACTION_MOVE_DOWN, 'down'], [ACTION_PAGE_UP, 'page-up'],
  [ACTION_PAGE_DOWN, 'page-down'], [ACTION_HOME, 'home'], [ACTION_END, 'end'],
]

function scrollKeys(bindings: GrammarBinding[]): void {
  const hint = { id: 'navigate', label: 'scroll', priority: PRIORITY.primary, actions: [ACTION_MOVE_UP, ACTION_MOVE_DOWN, ACTION_PAGE_UP, ACTION_PAGE_DOWN], compact: 'PgUp/PgDn' }
  for (const [index, [id, movement]] of MOVEMENTS.entries()) push(bindings, action(id), { kind: 'scroll', movement }, index === 0 ? hint : undefined)
}

function textEditing(bindings: GrammarBinding[], state: GrammarState, control: Extract<GrammarControl, { readonly kind: 'text' }>): void {
  groupMoves(bindings, state, true)
  const textarea = control.field === 'textarea'
  push(bindings, action(ACTION_NEWLINE), textarea ? { kind: 'text-newline' } : { kind: 'swallow' },
    textarea && control.enterSubmits ? { id: 'newline', label: 'newline', priority: PRIORITY.adjust, actions: [ACTION_NEWLINE] } : undefined)
  push(bindings, action(ACTION_SUBMIT), { kind: 'text-enter' }, textarea && !control.enterSubmits
    ? { id: 'activate', label: 'newline', priority: PRIORITY.adjust, actions: [ACTION_SUBMIT, ACTION_NEWLINE] }
    : { id: 'activate', label: control.enterSubmits ? 'submit' : 'next', priority: PRIORITY.primary, actions: [ACTION_SUBMIT] })
  push(bindings, { kind: 'any' }, { kind: 'text-type' })
}

function picker(bindings: GrammarBinding[], state: GrammarState, control: Extract<GrammarControl, { readonly kind: 'select' }>): void {
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

function rowBindings(bindings: GrammarBinding[], state: GrammarState, control: Extract<GrammarControl, { readonly kind: 'row' }>): void {
  const searching = state.list?.searching === true
  if (control.multiple) {
    push(bindings, action(ACTION_TOGGLE), { kind: 'toggle-row' }, { id: 'activate', label: 'toggle / confirm', priority: PRIORITY.primary, actions: [ACTION_TOGGLE, ACTION_SUBMIT], compact: 'Space/Enter' })
    push(bindings, action(ACTION_SUBMIT), { kind: 'commit' })
  } else {
    push(bindings, action(ACTION_SUBMIT), { kind: 'accept' }, { id: 'activate', label: control.role === 'browse' ? 'open' : 'choose', priority: PRIORITY.primary, actions: [ACTION_SUBMIT] })
    if (control.tree && !searching) push(bindings, action(ACTION_TOGGLE), { kind: 'branch' }, { id: 'branch', label: 'branch', priority: PRIORITY.adjust, actions: [ACTION_TOGGLE] })
  }
}

function listText(bindings: GrammarBinding[], state: GrammarState): void {
  const list = state.list
  if (list?.filterable !== true) return
  push(bindings, { kind: 'text', space: list.searching }, { kind: 'search-type' },
    list.searching ? undefined : { id: 'search', keys: 'Type', label: 'filter', priority: PRIORITY.primary })
}

function rowMovement(bindings: GrammarBinding[], control: Extract<GrammarControl, { readonly kind: 'row' }>): void {
  listMovement(bindings)
  if (control.segment !== undefined) {
    push(bindings, action(ACTION_SEGMENT_LEFT), { kind: 'segment', delta: -1 }, { id: 'adjust', label: control.segment, priority: PRIORITY.adjust, actions: [ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT] })
    push(bindings, action(ACTION_SEGMENT_RIGHT), { kind: 'segment', delta: 1 })
  } else if (control.tree) {
    push(bindings, action(ACTION_SEGMENT_LEFT), { kind: 'branch', expand: false }, control.multiple ? { id: 'branch', label: 'branch', priority: PRIORITY.adjust, actions: [ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT] } : undefined)
    push(bindings, action(ACTION_SEGMENT_RIGHT), { kind: 'branch', expand: true })
  } else {
    // Rows move vertically; left/right leave the list for the nearest control beside it.
    push(bindings, action(ACTION_SEGMENT_LEFT), { kind: 'navigate', direction: 'left' })
    push(bindings, action(ACTION_SEGMENT_RIGHT), { kind: 'navigate', direction: 'right' })
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
    push(bindings, action(ACTION_EXPAND), { kind: 'collapse' }, { id: 'escape', label: ESCAPE_LABEL.collapse, priority: PRIORITY.escape, actions: [ACTION_EXPAND, ACTION_CANCEL] })
    push(bindings, action(ACTION_CANCEL), { kind: 'collapse' })
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
    if (!list.searching) push(bindings, { kind: 'char', char: '/' }, { kind: 'search-start' })
  }
  if (control.kind === 'scroll') push(bindings, action(ACTION_EXPAND), { kind: 'expand' }, { id: 'expand', label: 'expand', priority: PRIORITY.adjust + 10, actions: [ACTION_EXPAND] })
  // Printable accelerators never pre-empt a control that consumes typed text.
  accelerators(bindings, state, control.kind !== 'text' && list?.filterable !== true)
  if (list?.numbered !== undefined && !list.searching && list.numbered.count > 0) {
    push(bindings, { kind: 'digit' }, { kind: 'numbered' }, { id: 'numbered', keys: list.numbered.count === 1 ? '1' : `1-${String(list.numbered.count)}`, label: list.numbered.accept ? 'choose' : 'focus', priority: PRIORITY.numbered })
  }
  tabSwitches(bindings, state, control.kind !== 'tab')
  groupMoves(bindings, state, control.kind !== 'tab')
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
      break
    case 'row':
      rowBindings(bindings, state, control)
      rowMovement(bindings, control)
      listText(bindings, state)
      break
    case 'empty-list':
      push(bindings, action(ACTION_SUBMIT), { kind: 'accept' })
      listText(bindings, state)
      break
    case 'text':
      push(bindings, action(ACTION_SUBMIT), control.enterSubmits ? { kind: 'enter-submits' } : { kind: 'text-begin' },
        { id: 'activate', label: control.enterSubmits ? 'submit' : 'edit', priority: PRIORITY.primary, actions: [ACTION_SUBMIT] })
      push(bindings, { kind: 'text', space: true }, { kind: 'text-begin' })
      navigation(bindings, state, ['up', 'down', 'left', 'right'], 'fields')
      break
    case 'select':
      navigation(bindings, state, ['up', 'down'], 'fields')
      if (!control.multiple && control.adjustable) {
        push(bindings, action(ACTION_SEGMENT_LEFT), { kind: 'select-cycle', delta: -1 }, { id: 'adjust', label: 'adjust', priority: PRIORITY.primary, actions: [ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT] })
        push(bindings, action(ACTION_SEGMENT_RIGHT), { kind: 'select-cycle', delta: 1 })
      }
      push(bindings, action(ACTION_SUBMIT), { kind: 'picker-open' }, { id: 'activate', label: 'pick', priority: control.multiple ? PRIORITY.primary : PRIORITY.adjust, actions: control.multiple ? [ACTION_SUBMIT, ACTION_TOGGLE] : [ACTION_SUBMIT] })
      if (control.multiple) push(bindings, action(ACTION_TOGGLE), { kind: 'picker-open' })
      navigation(bindings, state, ['left', 'right'], 'fields')
      break
    case 'tab':
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
      const label = control.kind === 'toggle' ? 'toggle' : control.kind === 'submit' ? 'submit' : control.kind === 'field-action' ? 'apply'
        : control.kind === 'cancel' ? 'cancel' : control.decision ? 'confirm' : 'run'
      push(bindings, action(ACTION_SUBMIT), { kind: 'activate' }, { id: 'activate', label, priority: PRIORITY.primary, actions: control.kind === 'toggle' ? [ACTION_TOGGLE, ACTION_SUBMIT] : [ACTION_SUBMIT], ...(control.kind === 'toggle' ? { compact: 'Enter' } : {}) })
      push(bindings, action(ACTION_TOGGLE), { kind: 'activate' })
      navigation(bindings, state, ['up', 'down', 'left', 'right'], control.kind === 'action' || control.kind === 'cancel' ? 'actions' : 'fields')
      break
    }
  }
  push(bindings, { kind: 'any' }, { kind: 'swallow' })
  return bindings
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
  { keys: 'Alt+←/→', action: 'Switch tabs from anywhere on the surface; wizards validate the step being left' },
  { keys: 'PgUp/PgDn, Home/End', action: 'Page or jump in lists and documents' },
  { keys: 'Enter', action: 'Choose, run, open a picker, apply it, or start editing a field' },
  { keys: 'Space', action: 'Toggle a checkbox or multi-select row, open a multiselect, or fold a tree branch' },
  { keys: 'Tab/Shift+Tab', action: 'Move to the next or previous control group, committing text and pickers' },
  { keys: 'Esc', action: 'Leave the innermost layer: picker, editing, search, back, then close' },
  { keys: 'Ctrl+C', action: 'Close the surface, asking first when there are unsaved changes' },
  { keys: 'Type or /', action: 'Filter a filterable list; Ctrl+U clears the filter' },
  { keys: '1-9', action: 'Pick a numbered row' },
  { keys: 'Ctrl+E', action: 'Expand focused scrollable content to full screen' },
  { keys: 'Delete', action: 'Return a changed field to its inherited or default value' },
  { keys: 'Alt+Enter', action: 'Insert a newline in a multi-line field' },
])
