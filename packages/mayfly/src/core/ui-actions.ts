/**
 * Action items as named actions (spec §3.5, roadmap slice 1.7). An item runs as a common meaning (`semantic`, the
 * `ui.<meaning>` action), as a named component action (`action`, `<owner>.<action>` with `key` as its default), or as
 * a plain accelerator (`key` alone). The validator checks the naming rules here, and the compiler resolves an item's
 * effective keys through the keymap on every key and paint, so a rebind moves dispatch and every hint together.
 *
 * @module @ephemeral-ai/mayfly/core/ui-actions
 */
import type { MayflyActionItem, MayflyCommonMeaning } from '@ephemeral-ai/mayfly-ui'
import { DEFAULT_ACTION_KEYS, keyActionKeys } from './key-actions.ts'
import type { MayflyKeymap } from './types.ts'

/** The common meanings an item may declare with `semantic`. */
export const COMMON_MEANINGS: readonly MayflyCommonMeaning[] = Object.freeze(['save', 'copy', 'delete', 'refresh', 'external', 'search'])

/** A dotted `<owner>.<action>` id: lowercase words of letters, digits, and hyphens. */
const NAMED_ACTION = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)+$/u

interface ActionNaming {
  readonly key?: string | undefined
  readonly semantic?: MayflyCommonMeaning | undefined
  readonly action?: string | undefined
}

/**
 * Why an item's naming is invalid, or undefined when it is valid.
 * @param item - the item's key, semantic, and action fields.
 * @returns the problem, phrased after the item's path.
 */
export function actionNamingProblem(item: ActionNaming): string | undefined {
  if (item.semantic !== undefined && item.key !== undefined) return '.semantic and .key are exclusive: the key is the meaning\'s binding'
  if (item.semantic !== undefined && item.action !== undefined) return '.semantic and .action are exclusive'
  if (item.action === undefined) return undefined
  if (!NAMED_ACTION.test(item.action)) return `.action "${item.action}" must be an <owner>.<action> id`
  if (item.action.startsWith('ui.')) return `.action "${item.action}" is in the reserved ui.* namespace; declare a semantic meaning instead`
  return undefined
}

/**
 * The named action an item runs as.
 * @param item - an admitted action item.
 * @returns `ui.<meaning>`, the component action, or undefined for a plain accelerator.
 */
export function itemActionId(item: ActionNaming): string | undefined {
  return item.semantic === undefined ? item.action : `ui.${item.semantic}`
}

/**
 * The key an item claims before any rebinding, which the validator checks per page: a meaning's default binding,
 * else the item's own key.
 * @param item - an action item.
 * @returns the default key id, or undefined when the item has none.
 */
export function defaultItemKey(item: ActionNaming): string | undefined {
  return item.semantic === undefined ? item.key : DEFAULT_ACTION_KEYS[`ui.${item.semantic}`]![0]
}

/**
 * The keys an item answers now. A meaning follows its `ui.*` action; a component action and a plain accelerator
 * answer their declared key.
 * @param item - an admitted action item.
 * @param keymap - the live keymap, absent in fixtures.
 * @returns the effective key ids, first key first.
 */
export function effectiveItemKeys(item: ActionNaming, keymap: MayflyKeymap | undefined): readonly string[] {
  if (item.semantic !== undefined) return keyActionKeys(keymap, `ui.${item.semantic}`)
  return item.key === undefined ? [] : [item.key]
}

/**
 * The word the hint row shows after an item's key.
 * @param item - an admitted action item.
 * @returns the declared hint label, else the item's label.
 */
export function actionHintLabel(item: Pick<MayflyActionItem, 'label' | 'hintLabel'>): string {
  return item.hintLabel ?? item.label
}

/**
 * Whether an action group's keys act while a control has focus.
 * @param scope - the group's admitted scope ids, undefined for the whole surface.
 * @param focused - the ids naming the focused control and the control that holds it.
 * @returns whether the group is in scope.
 */
export function actionScopeActive(scope: readonly string[] | undefined, focused: readonly string[]): boolean {
  return scope === undefined || scope.some(id => focused.includes(id))
}
