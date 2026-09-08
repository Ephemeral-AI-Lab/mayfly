/** Stable semantic key action ids shared by core routing and interaction registration.
 * @module @ephemeral-ai/mayfly/core/key-actions
 */
import { type KeyId, matchesKey } from '@earendil-works/pi-tui'
import type { MayflyKeymap } from './types.ts'

export const ACTION_SUBMIT = 'mayfly.interaction.submit'
export const ACTION_CANCEL = 'mayfly.interaction.cancel'
export const ACTION_MOVE_UP = 'mayfly.interaction.move-up'
export const ACTION_MOVE_DOWN = 'mayfly.interaction.move-down'
export const ACTION_PAGE_UP = 'mayfly.interaction.page-up'
export const ACTION_PAGE_DOWN = 'mayfly.interaction.page-down'
export const ACTION_HOME = 'mayfly.interaction.home'
export const ACTION_END = 'mayfly.interaction.end'
export const ACTION_TOGGLE = 'mayfly.interaction.toggle'
export const ACTION_INTERRUPT = 'mayfly.interaction.interrupt'
export const ACTION_STEER = 'mayfly.interaction.steer'
export const ACTION_BACKSPACE = 'mayfly.interaction.backspace'
export const ACTION_DELETE = 'mayfly.interaction.delete'
export const ACTION_SEGMENT_LEFT = 'mayfly.interaction.segment-left'
export const ACTION_SEGMENT_RIGHT = 'mayfly.interaction.segment-right'
export const ACTION_NEXT_CONTROL = 'mayfly.interaction.next-control'
export const ACTION_SHIFT_TAB = 'mayfly.interaction.shift-tab'
export const ACTION_NEWLINE = 'mayfly.interaction.newline'
export const ACTION_CLEAR_SEARCH = 'mayfly.interaction.clear-search'
export const ACTION_EXTERNAL_EDITOR = 'mayfly.interaction.external-editor'
export const ACTION_CYCLE_MODEL = 'mayfly.interaction.cycle-model'
export const ACTION_TOGGLE_AGENT_VIEW = 'mayfly.interaction.toggle-agent-view'
export const ACTION_CLOSE_AGENT_VIEW = 'mayfly.interaction.close-agent-view'

const FALLBACK_KEYS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [ACTION_SUBMIT]: ['enter'],
  [ACTION_CANCEL]: ['escape'],
  [ACTION_MOVE_UP]: ['up'],
  [ACTION_MOVE_DOWN]: ['down'],
  [ACTION_PAGE_UP]: ['pageUp'],
  [ACTION_PAGE_DOWN]: ['pageDown'],
  [ACTION_HOME]: ['home'],
  [ACTION_END]: ['end'],
  [ACTION_TOGGLE]: ['space'],
  [ACTION_NEXT_CONTROL]: ['tab'],
  [ACTION_SHIFT_TAB]: ['shift+tab'],
  [ACTION_SEGMENT_LEFT]: ['left'],
  [ACTION_SEGMENT_RIGHT]: ['right'],
  [ACTION_NEWLINE]: ['alt+enter'],
  [ACTION_CLEAR_SEARCH]: ['ctrl+u'],
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
    return DISPLAY_KEY_BY_ID[part] ?? (part.length === 1 ? part.toUpperCase() : part)
  }).join('+')
}

/** Resolve configured keys, falling back only for compiler use without a keymap fixture. */
export function keyActionKeys(keymap: MayflyKeymap | undefined, actionId: string): readonly string[] {
  return keymap === undefined || typeof keymap.getKeys !== 'function' ? FALLBACK_KEYS[actionId] ?? [] : keymap.getKeys(actionId)
}

/** Match one semantic action through the live keymap or deterministic fixture defaults. */
export function matchesKeyAction(keymap: MayflyKeymap | undefined, data: string, actionId: string): boolean {
  if (keymap !== undefined && typeof keymap.matches === 'function' && typeof keymap.getKeys === 'function') return keymap.matches(data, actionId)
  return keyActionKeys(undefined, actionId).some(key => matchesKey(data, key as KeyId))
}
