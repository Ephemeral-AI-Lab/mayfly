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

/** Confirm the focused choice or submit the text (Enter). */
export const ACTION_SUBMIT = 'mayfly.interaction.submit'
/** Cancel or dismiss the active surface (Escape). */
export const ACTION_CANCEL = 'mayfly.interaction.cancel'
/** Move the list cursor up (Up arrow). */
export const ACTION_MOVE_UP = 'mayfly.interaction.move-up'
/** Move the list cursor down (Down arrow). */
export const ACTION_MOVE_DOWN = 'mayfly.interaction.move-down'
/** Move one viewport upward (PageUp). */
export const ACTION_PAGE_UP = 'mayfly.interaction.page-up'
/** Move one viewport downward (PageDown). */
export const ACTION_PAGE_DOWN = 'mayfly.interaction.page-down'
/** Move to the first item or row (Home). */
export const ACTION_HOME = 'mayfly.interaction.home'
/** Move to the last item or row (End). */
export const ACTION_END = 'mayfly.interaction.end'
/** Toggle the focused choice in a multi-select list (Space). */
export const ACTION_TOGGLE = 'mayfly.interaction.toggle'
/** Clear the input, interrupt the agent, or exit on a second press (Ctrl-C); editor-context only. */
export const ACTION_INTERRUPT = 'mayfly.interaction.interrupt'
/** Steer the current turn with the drafted input (Ctrl-S); editor-context only. */
export const ACTION_STEER = 'mayfly.interaction.steer'
/**
 * Delete backward — contextual only: the pi-tui Editor owns actual
 * deletion, and this action is a gate for mode exits like bash's
 * "Backspace on an empty `!` prompt" (editor-plus matches it, it never
 * dispatches).
 */
export const ACTION_BACKSPACE = 'mayfly.interaction.backspace'
/** Delete the selected entity or the character ahead (Delete/Ctrl-D). */
export const ACTION_DELETE = 'mayfly.interaction.delete'
/**
 * Step the active segment control left (Left arrow) — contextual only:
 * the thinking-segment panels (`/model`, `/effort`) match it in their own
 * `handleInput`; the pi-tui Editor owns cursor-left in text.
 */
export const ACTION_SEGMENT_LEFT = 'mayfly.interaction.segment-left'
/**
 * Step the active segment control right (Right arrow) — contextual only,
 * the mirror of {@link ACTION_SEGMENT_LEFT}.
 */
export const ACTION_SEGMENT_RIGHT = 'mayfly.interaction.segment-right'
/** Move to the next control (Tab), with forms committing the active field. */
export const ACTION_NEXT_CONTROL = 'mayfly.interaction.next-control'
/** Shift-Tab: previous control in panels, session-mode cycle in the main editor. */
export const ACTION_SHIFT_TAB = 'mayfly.interaction.shift-tab'
/**
 * Hand the draft to the external editor $VISUAL/$EDITOR (Ctrl-G) —
 * contextual only: the main editor's `onKey` chain matches it in
 * `./input-plugin.ts` and runs the `mayflyScreen.suspend` flow from
 * `./external-editor.ts` (S31).
 */
export const ACTION_EXTERNAL_EDITOR = 'mayfly.interaction.external-editor'
/**
 * Cycle the session model within the current provider (Alt+M) — contextual
 * only: the main editor's `onKey` chain matches it in
 * `./input-plugin.ts` and dispatches the session-only switch from
 * `./model-commands.ts`. The press is consumed before the Editor sees it,
 * so the typed draft stays intact — the point of the hotkey.
 */
export const ACTION_CYCLE_MODEL = 'mayfly.interaction.cycle-model'
/** Toggle between the primary and retained auxiliary conversation (F7). */
export const ACTION_TOGGLE_AGENT_VIEW = 'mayfly.interaction.toggle-agent-view'
/** Close the retained auxiliary conversation (F8). */
export const ACTION_CLOSE_AGENT_VIEW = 'mayfly.interaction.close-agent-view'

const DISPLAY_KEY_BY_ID: Readonly<Record<string, string>> = {
  enter: 'Enter',
  escape: 'Esc',
  backspace: 'Backspace',
  delete: 'Delete',
  space: 'Space',
  tab: 'Tab',
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
  pageUp: 'PgUp',
  pageDown: 'PgDn',
  home: 'Home',
  end: 'End',
}

function displayKey(key: string): string {
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
  { id: ACTION_EXTERNAL_EDITOR, keys: 'ctrl+g', description: 'Edit the draft in your external editor ($VISUAL/$EDITOR)' },
  { id: ACTION_CYCLE_MODEL, keys: 'alt+m', description: 'Cycle the session model within the current provider (contextual)' },
  { id: ACTION_TOGGLE_AGENT_VIEW, keys: 'f7', description: 'Toggle the primary and auxiliary conversation' },
  { id: ACTION_CLOSE_AGENT_VIEW, keys: 'f8', description: 'Close the auxiliary conversation' },
]

/** Stable Cordis plugin name. */
export const name = 'mayfly-interaction-keys'
/** Services required before the key batch can register. */
export const inject = ['mayflyKeymap', 'mayflyCurrentAgent', 'mayflyPromptEditor']

/**
 * Register the shared interaction key actions, unregistered automatically
 * when the plugin's fiber unloads.
 * @param ctx - plugin context carrying `mayflyKeymap`.
 */
export function apply(ctx: Context): void {
  const notify = (text: string): void => { ctx.get('mayflyPromptEditor')?.current?.notice?.(text) }
  const actions = INTERACTION_KEY_ACTIONS.map(action => action.id === ACTION_TOGGLE_AGENT_VIEW
    ? {
        ...action,
        handler: () => {
          if (!ctx.mayflyCurrentAgent.toggleAuxiliary()) notify('no auxiliary conversation is open')
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
