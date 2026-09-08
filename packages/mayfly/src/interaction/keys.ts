/**
 * The shared Mayfly interaction key actions. One batch registered once by the
 * `mayfly-interaction-keys` plugin: the canonical multi-select controller
 * resolves its keys through `ctx.mayflyKeymap` against these action ids, so
 * key claims never conflict and hint text reflects the registered bindings.
 * The editor-context actions (interrupt, steer) carry no handler: they are
 * resolved by the main editor's `onKey` hook in `./input-plugin.ts`, never
 * by the global dispatcher. Text-editing keys are owned by the pi-tui
 * Editor behind `ctx.mayflyComponents.createEditor` and do not appear here —
 * the single exception is the contextual `backspace` gate for mode exits
 * like bash's "Backspace on an empty `!` prompt" (`editor-plus` matches
 * it in its own `onKey` wrapper; it never dispatches).
 *
 * @module @ephemeral-ai/mayfly/interaction/keys
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MayflyKeyAction, MayflyKeymap } from '../core/index.ts'
import type {} from '../app/current-agent.ts'
import { createInteractionNotificationOwner } from './notifications.ts'
import {
  ACTION_BACKSPACE, ACTION_CANCEL, ACTION_CLEAR_SEARCH, ACTION_CLOSE_AGENT_VIEW, ACTION_CYCLE_MODEL,
  ACTION_DELETE, ACTION_END, ACTION_EXTERNAL_EDITOR, ACTION_HOME, ACTION_INTERRUPT, ACTION_MOVE_DOWN,
  ACTION_MOVE_UP, ACTION_NEWLINE, ACTION_NEXT_CONTROL, ACTION_PAGE_DOWN, ACTION_PAGE_UP,
  ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT, ACTION_SHIFT_TAB, ACTION_STEER, ACTION_SUBMIT,
  ACTION_TOGGLE, ACTION_TOGGLE_AGENT_VIEW, displayKey,
} from '../core/key-actions.ts'
export {
  ACTION_BACKSPACE, ACTION_CANCEL, ACTION_CLEAR_SEARCH, ACTION_CLOSE_AGENT_VIEW, ACTION_CYCLE_MODEL,
  ACTION_DELETE, ACTION_END, ACTION_EXTERNAL_EDITOR, ACTION_HOME, ACTION_INTERRUPT, ACTION_MOVE_DOWN,
  ACTION_MOVE_UP, ACTION_NEWLINE, ACTION_NEXT_CONTROL, ACTION_PAGE_DOWN, ACTION_PAGE_UP,
  ACTION_SEGMENT_LEFT, ACTION_SEGMENT_RIGHT, ACTION_SHIFT_TAB, ACTION_STEER, ACTION_SUBMIT,
  ACTION_TOGGLE, ACTION_TOGGLE_AGENT_VIEW,
} from '../core/key-actions.ts'

/** Resolve a hint from the registered action keys, retaining a stable fallback. */
export function interactionKeyHint(keymap: MayflyKeymap, action: string, fallback: string): string {
  const keys = keymap.getKeys(action)
  return keys.length === 0 ? fallback : keys.map(displayKey).join('/')
}

/** The full interaction key batch, registered as one unit. */
export const INTERACTION_KEY_ACTIONS: readonly MayflyKeyAction[] = [
  { id: ACTION_SUBMIT, keys: 'enter', description: 'Submit input / confirm selection' },
  { id: ACTION_CANCEL, keys: 'escape', description: 'Cancel or dismiss the active surface' },
  { id: ACTION_MOVE_UP, keys: 'up', description: 'Move the list cursor up' },
  { id: ACTION_MOVE_DOWN, keys: 'down', description: 'Move the list cursor down' },
  { id: ACTION_PAGE_UP, keys: 'pageUp', description: 'Move one page up' },
  { id: ACTION_PAGE_DOWN, keys: 'pageDown', description: 'Move one page down' },
  { id: ACTION_HOME, keys: 'home', description: 'Move to the first item' },
  { id: ACTION_END, keys: 'end', description: 'Move to the last item' },
  { id: ACTION_TOGGLE, keys: 'space', description: 'Toggle the focused choice in a multi-select' },
  { id: ACTION_INTERRUPT, keys: 'ctrl+c', description: 'Clear input / interrupt the agent / press twice to exit' },
  { id: ACTION_STEER, keys: 'ctrl+s', description: 'Steer the current turn with the draft' },
  { id: ACTION_BACKSPACE, keys: 'backspace', description: 'Delete backward / exit bash mode on an empty prompt' },
  { id: ACTION_DELETE, keys: ['delete', 'ctrl+d'], description: 'Delete the selected entity or character ahead' },
  { id: ACTION_SEGMENT_LEFT, keys: 'left', description: 'Step the segment control left (contextual)' },
  { id: ACTION_SEGMENT_RIGHT, keys: 'right', description: 'Step the segment control right (contextual)' },
  { id: ACTION_NEXT_CONTROL, keys: 'tab', description: 'Move to the next control' },
  { id: ACTION_SHIFT_TAB, keys: 'shift+tab', description: 'Move to the previous control / toggle plan mode in the editor' },
  { id: ACTION_NEWLINE, keys: 'alt+enter', description: 'Insert a newline in a multiline field' },
  { id: ACTION_CLEAR_SEARCH, keys: 'ctrl+u', description: 'Clear the active search query' },
  { id: ACTION_EXTERNAL_EDITOR, keys: 'ctrl+g', description: 'Edit the draft in your external editor ($VISUAL/$EDITOR)' },
  { id: ACTION_CYCLE_MODEL, keys: 'alt+m', description: 'Cycle the session model within the current provider (contextual)' },
  { id: ACTION_TOGGLE_AGENT_VIEW, keys: 'f7', description: 'Toggle the primary and auxiliary conversation' },
  { id: ACTION_CLOSE_AGENT_VIEW, keys: 'f8', description: 'Close the auxiliary conversation' },
]

/** Stable Cordis plugin name. */
export const name = 'mayfly-interaction-keys'
/** Services required before the key batch can register. */
export const inject = ['mayflyKeymap', 'mayflyCurrentAgent', 'mayflyUiInteraction']

/**
 * Register the shared interaction key actions, unregistered automatically
 * when the plugin's fiber unloads.
 * @param ctx - plugin context carrying `mayflyKeymap`.
 */
export function apply(ctx: Context): void {
  const notifications = createInteractionNotificationOwner(ctx, 'mayfly.keys', 'agent-view')
  const actions = INTERACTION_KEY_ACTIONS.map(action => action.id === ACTION_TOGGLE_AGENT_VIEW
    ? {
        ...action,
        handler: () => {
          if (!ctx.mayflyCurrentAgent.toggleAuxiliary()) notifications.report('toggle-agent-view', { message: 'no auxiliary conversation is open', severity: 'warning' })
        },
      }
    : action.id === ACTION_CLOSE_AGENT_VIEW
      ? {
          ...action,
          handler: () => { ctx.emit('mayfly/request-close-agent-view') },
        }
      : action)
  ctx.effect(() => ctx.mayflyKeymap.register(actions))
}
