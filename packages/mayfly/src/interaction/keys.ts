/**
 * The shared Mayfly interaction key actions: the `ui.*` named actions of the
 * kit (navigation and the common meanings) and the product actions. One batch
 * registered once by the `mayfly-interaction-keys` plugin: the shared key
 * grammar resolves its keys through `ctx.mayflyKeymap` against these action
 * ids, so key claims never conflict within a scope and hint text reflects the
 * registered bindings.
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
// Empty type import carries the `settings` Context merge and the
// 'settings/document-updated' Events merge the live apply follows.
import type { SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { MayflyKeymap } from '../core/types.ts'
import type {} from '../app/conversation-views.ts'
import { createInteractionNotificationOwner } from './notifications.ts'
import { currentMayflySettings } from '../frontend/settings.ts'
import { ACTION_TOGGLE_AGENT_VIEW, ACTION_CLOSE_AGENT_VIEW, displayKey } from '../core/key-actions.ts'
import { INTERACTION_KEY_ACTIONS } from './key-definitions.ts'
export {
  ACTION_BACKSPACE, ACTION_CANCEL, ACTION_CLEAR_SEARCH, ACTION_CLOSE_AGENT_VIEW, ACTION_COPY, ACTION_CYCLE_MODE, ACTION_CYCLE_MODEL,
  ACTION_DELETE, ACTION_END, ACTION_EXPAND, ACTION_EXTERNAL_EDITOR, ACTION_FILTER, ACTION_FOCUS_NEXT, ACTION_FOCUS_PREV, ACTION_FOLLOW_TAIL, ACTION_HOME,
  ACTION_INTERRUPT, ACTION_MOVE_DOWN, ACTION_MOVE_UP, ACTION_NEWLINE, ACTION_NEXT_CONTROL, ACTION_NEXT_TAB, ACTION_PAGE_DOWN,
  ACTION_PAGE_UP, ACTION_PREV_TAB, ACTION_REFRESH, ACTION_RESET_FIELD, ACTION_SAVE, ACTION_SEARCH, ACTION_SEGMENT_LEFT,
  ACTION_SEGMENT_RIGHT, ACTION_SHIFT_TAB, ACTION_STEER, ACTION_SUBMIT, ACTION_TOGGLE, ACTION_TOGGLE_AGENT_VIEW,
} from '../core/key-actions.ts'

/** Resolve a hint from the registered action keys, retaining a stable fallback. */
export function interactionKeyHint(keymap: MayflyKeymap, action: string, fallback: string): string {
  const keys = keymap.getKeys(action)
  return keys.length === 0 ? fallback : keys.map(displayKey).join('/')
}

/** Whether a binding change reached the settings document or holds for this session only. */
type KeybindingWrite = 'saved' | 'session'

/**
 * Write one key edit into the `mayfly` settings namespace through the
 * revision-checked `settings.mutate`. Without a writable settings service the
 * live change holds for the session only.
 */
async function persistKeybindings(ctx: Context, operation: SettingsPathOp): Promise<KeybindingWrite> {
  const settings = ctx.get('settings')
  const entry = settings?.describe().find(item => String(item.ns) === 'mayfly')
  if (settings === undefined || !settings.writable || entry === undefined) return 'session'
  try {
    await settings.mutate('mayfly', [operation], entry.revision)
    return 'saved'
  } catch (error) {
    ctx.logger.warn(`could not save key bindings: ${String(error)}`)
    return 'session'
  }
}

/**
 * Rebind an action now and save the binding beside its label, so `/keys` can
 * list it even while the plugin that owns it is not loaded.
 * @param ctx - a context carrying `mayflyKeymap`.
 * @param action - the `<owner>.<action>` id.
 * @param keys - the new keys; a key the action gave up stops working.
 * @param label - the action's label as the keybinding list shows it.
 * @returns where the binding was written.
 * @throws MayflyKeymapError when the keymap refuses the binding; nothing is written then.
 */
export async function saveKeybinding(ctx: Context, action: string, keys: readonly string[], label: string): Promise<KeybindingWrite> {
  ctx.mayflyKeymap.bind(action, keys, label)
  return persistKeybindings(ctx, { op: 'set', path: ['keybindings', action], value: { keys: [...keys], label } })
}

/**
 * Restore one action's default keys now and drop its saved override.
 * @param ctx - a context carrying `mayflyKeymap`.
 * @param action - the action id.
 * @returns where the reset was written.
 */
export async function resetKeybinding(ctx: Context, action: string): Promise<KeybindingWrite> {
  ctx.mayflyKeymap.reset(action)
  return persistKeybindings(ctx, { op: 'unset', path: ['keybindings', action] })
}

/**
 * Restore every default key now and drop every saved override.
 * @param ctx - a context carrying `mayflyKeymap`.
 * @returns where the reset was written.
 */
export async function resetAllKeybindings(ctx: Context): Promise<KeybindingWrite> {
  ctx.mayflyKeymap.resetAll()
  return persistKeybindings(ctx, { op: 'unset', path: ['keybindings'] })
}

/** Stable Cordis plugin name. */
export const name = 'mayfly-interaction-keys'
/** Services required before the key batch can register and follow the saved bindings. */
export const inject = ['mayflyKeymap', 'mayflyConversations', 'mayflyUiInteraction', 'mayflyInteractionState']

/**
 * Register the shared interaction key actions, then apply the saved
 * `keybindings` and `preferPlainKeys` of the `mayfly` settings namespace and
 * follow every commit to it. Unloading unregisters the batch and returns the
 * keymap to its defaults.
 * @param ctx - plugin context carrying `mayflyKeymap`.
 */
export function apply(ctx: Context): void {
  const notifications = createInteractionNotificationOwner(ctx, 'mayfly.keys', () => {
    const agent = ctx.get('mayflyCurrentAgent')?.current()
    return agent == null ? { kind: 'app', targetId: 'agent-view' } : { kind: 'session', sessionId: String(agent.id) }
  })
  const actions = INTERACTION_KEY_ACTIONS.map(action => action.id === ACTION_TOGGLE_AGENT_VIEW
    ? {
        ...action,
        handler: () => {
          if (!ctx.mayflyConversations.back()) notifications.report('toggle-agent-view', { message: 'no other conversation is open', severity: 'warning' })
        },
      }
    : action.id === ACTION_CLOSE_AGENT_VIEW
      ? {
          ...action,
          handler: () => { ctx.emit('mayfly/request-close-conversation') },
        }
      : action)
  ctx.effect(() => ctx.mayflyKeymap.register(actions))
  const keymap = ctx.mayflyKeymap
  const sync = (): void => {
    const settings = currentMayflySettings(ctx)
    keymap.setPreferPlain(settings.preferPlainKeys)
    // A hand-edited line that is invalid or collides is skipped, never fatal.
    for (const refused of keymap.applyOverrides(settings.keybindings)) ctx.logger.warn(`keybindings: ${refused.message}`)
  }
  sync()
  ctx.on('mayfly/settings-source-ready', sync)
  ctx.on('settings/document-updated', (ns) => { if (String(ns) === 'mayfly') sync() })
  ctx.effect(() => () => {
    keymap.applyOverrides({})
    keymap.setPreferPlain(false)
  })
}
