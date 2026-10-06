/**
 * Named key actions shared by core routing and interaction registration (spec §3.5). Every key the runtime dispatches
 * belongs to one: the kit's `ui.*` navigation and common-meaning actions, or a product action that keeps its
 * `mayfly.*` id. A key is an action's current binding, never its identity. The constant names predate the `ui.*`
 * rename and are kept so the grammar reads the same; their values are the named actions.
 *
 * @module @ephemeral-ai/mayfly/core/key-actions
 */
import { type KeyId, matchesKey } from '@earendil-works/pi-tui'
import type { MayflyKeymap } from './types.ts'

// Navigation: the kit's DEFAULT_KEYMAP.
export const ACTION_MOVE_UP = 'ui.up'
export const ACTION_MOVE_DOWN = 'ui.down'
export const ACTION_SEGMENT_LEFT = 'ui.left'
export const ACTION_SEGMENT_RIGHT = 'ui.right'
export const ACTION_SUBMIT = 'ui.accept'
export const ACTION_CANCEL = 'ui.cancel'
export const ACTION_TOGGLE = 'ui.toggle'
export const ACTION_NEXT_CONTROL = 'ui.next-group'
export const ACTION_SHIFT_TAB = 'ui.prev-group'
export const ACTION_PAGE_UP = 'ui.page-up'
export const ACTION_PAGE_DOWN = 'ui.page-down'
export const ACTION_HOME = 'ui.home'
export const ACTION_END = 'ui.end'
export const ACTION_RESET_FIELD = 'ui.reset'
export const ACTION_FILTER = 'ui.filter'
export const ACTION_CLEAR_SEARCH = 'ui.clear'
export const ACTION_EXPAND = 'ui.expand'
export const ACTION_NEWLINE = 'ui.newline'
export const ACTION_PREV_TAB = 'ui.tab-prev'
export const ACTION_NEXT_TAB = 'ui.tab-next'
export const ACTION_FOCUS_PREV = 'ui.focus-prev'
export const ACTION_FOCUS_NEXT = 'ui.focus-next'
// Common meanings: one action across the product, whichever panel uses it.
export const ACTION_SAVE = 'ui.save'
export const ACTION_COPY = 'ui.copy'
export const ACTION_DELETE = 'ui.delete'
export const ACTION_REFRESH = 'ui.refresh'
export const ACTION_EXTERNAL_EDITOR = 'ui.external'
export const ACTION_SEARCH = 'ui.search'
// Product actions keep their ids.
export const ACTION_INTERRUPT = 'mayfly.interaction.interrupt'
export const ACTION_STEER = 'mayfly.interaction.steer'
export const ACTION_BACKSPACE = 'mayfly.interaction.backspace'
export const ACTION_CYCLE_MODE = 'mayfly.interaction.cycle-mode'
export const ACTION_CYCLE_MODEL = 'mayfly.interaction.cycle-model'
export const ACTION_TOGGLE_AGENT_VIEW = 'mayfly.interaction.toggle-agent-view'
export const ACTION_CLOSE_AGENT_VIEW = 'mayfly.interaction.close-agent-view'

/**
 * Default keys of the core actions: the kit's DEFAULT_KEYMAP in pi-tui key ids. Every Alt default has a second default
 * without Alt, because terminals and multiplexers swallow or rewrite Alt (spec §3.5).
 */
export const DEFAULT_ACTION_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [ACTION_MOVE_UP]: ['up'],
  [ACTION_MOVE_DOWN]: ['down'],
  [ACTION_SEGMENT_LEFT]: ['left'],
  [ACTION_SEGMENT_RIGHT]: ['right'],
  [ACTION_SUBMIT]: ['enter'],
  [ACTION_CANCEL]: ['escape'],
  [ACTION_TOGGLE]: ['space'],
  [ACTION_NEXT_CONTROL]: ['tab'],
  [ACTION_SHIFT_TAB]: ['shift+tab'],
  [ACTION_PAGE_UP]: ['pageUp'],
  [ACTION_PAGE_DOWN]: ['pageDown'],
  [ACTION_HOME]: ['home'],
  [ACTION_END]: ['end'],
  [ACTION_RESET_FIELD]: ['delete'],
  [ACTION_FILTER]: ['/'],
  [ACTION_CLEAR_SEARCH]: ['ctrl+u'],
  [ACTION_EXPAND]: ['ctrl+e'],
  [ACTION_NEWLINE]: ['alt+enter', 'ctrl+j'],
  [ACTION_PREV_TAB]: ['alt+left', 'f2'],
  [ACTION_NEXT_TAB]: ['alt+right', 'f3'],
  [ACTION_FOCUS_PREV]: ['alt+up', 'f4'],
  [ACTION_FOCUS_NEXT]: ['alt+down', 'f5'],
  [ACTION_SAVE]: ['ctrl+s'],
  [ACTION_COPY]: ['c'],
  [ACTION_DELETE]: ['x'],
  [ACTION_REFRESH]: ['r'],
  [ACTION_EXTERNAL_EDITOR]: ['ctrl+g'],
  [ACTION_SEARCH]: ['ctrl+f'],
  [ACTION_INTERRUPT]: ['ctrl+c'],
  [ACTION_STEER]: ['ctrl+s'],
  [ACTION_BACKSPACE]: ['backspace'],
  [ACTION_CYCLE_MODE]: ['shift+tab'],
  [ACTION_CYCLE_MODEL]: ['alt+m'],
  [ACTION_TOGGLE_AGENT_VIEW]: ['f7'],
  [ACTION_CLOSE_AGENT_VIEW]: ['f8'],
})

const DISPLAY_KEY_BY_ID: Readonly<Record<string, string>> = {
  enter: 'Enter', escape: 'Esc', backspace: 'Backspace', delete: 'Delete', space: 'Space', tab: 'Tab',
  up: '↑', down: '↓', left: '←', right: '→', pageUp: 'PgUp', pageDown: 'PgDn', home: 'Home', end: 'End',
}

export function displayKey(key: string): string {
  const known = DISPLAY_KEY_BY_ID[key]
  if (known !== undefined) return known
  if (/^f\d+$/u.test(key)) return key.toUpperCase()
  return key.split('+').map(part => {
    if (part === 'ctrl') return 'Ctrl'
    if (part === 'alt') return 'Alt'
    if (part === 'shift') return 'Shift'
    if (part === 'meta') return 'Meta'
    if (/^f\d+$/u.test(part)) return part.toUpperCase()
    return DISPLAY_KEY_BY_ID[part] ?? (part.length === 1 ? part.toUpperCase() : part)
  }).join('+')
}

/** A key id that inserts text rather than chording a modifier or naming a function key. */
export function printableKey(key: string): boolean {
  const normalized = key.toLowerCase()
  if (normalized === 'space') return true
  const parts = normalized.split('+')
  const base = parts.at(-1)!
  return base.length === 1 && parts.slice(0, -1).every(modifier => modifier === 'shift')
}

/** Resolve configured keys, falling back only for compiler use without a keymap fixture. */
export function keyActionKeys(keymap: MayflyKeymap | undefined, actionId: string): readonly string[] {
  return keymap === undefined || typeof keymap.getKeys !== 'function' ? DEFAULT_ACTION_KEYS[actionId] ?? [] : keymap.getKeys(actionId)
}

/** Match one semantic action through the live keymap or deterministic fixture defaults. */
export function matchesKeyAction(keymap: MayflyKeymap | undefined, data: string, actionId: string): boolean {
  if (keymap !== undefined && typeof keymap.matches === 'function' && typeof keymap.getKeys === 'function') return keymap.matches(data, actionId)
  return keyActionKeys(undefined, actionId).some(key => matchesKey(data, key as KeyId))
}
