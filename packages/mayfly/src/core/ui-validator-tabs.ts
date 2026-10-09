/**
 * Admission rules for the optional fields of slice 1.5 (tabs, rails, and focus levels): a tab item's `count`
 * (a number or a short string), `attention`, `group`, and `clip`, and a tabs node's `orientation` and `hintLabel`.
 *
 * @module @ephemeral-ai/mayfly/core/ui-validator-tabs
 */

import type { AdmissionHelpers } from './ui-validator-content.ts'

type Fields = Record<string, unknown>

function present<Value>(key: string, value: Value | undefined): Fields {
  return value === undefined ? {} : { [key]: value }
}

/**
 * A tab item's `count` (an integer, or text such as `2/6`), `attention`, `group`, and `clip`. The item's `id`, `label`,
 * `disabled`, and `backId` stay with the validator's own arm.
 */
export function admitTabItemFields<State>(h: AdmissionHelpers<State>, entry: Fields, path: string, state: State): Fields {
  const count = h.own(entry, 'count', path)
  const attention = h.own(entry, 'attention', path)
  const group = h.own(entry, 'group', path)
  const clip = h.own(entry, 'clip', path)
  return {
    ...present('count', count === undefined ? undefined : typeof count === 'string' ? h.text(count, `${path}.count`, state) : h.finiteInteger(count, `${path}.count`)),
    ...present('attention', attention === undefined ? undefined : h.boolean(attention, `${path}.attention`)),
    ...present('group', group === undefined ? undefined : h.text(group, `${path}.group`, state)),
    ...present('clip', clip === undefined ? undefined : h.enumeration(clip, ['end', 'start'] as const, `${path}.clip`)),
  }
}

/** A tabs node's `orientation` (a wizard is an ordered strip, so it takes no rail) and `hintLabel`. */
export function admitTabsFields<State>(h: AdmissionHelpers<State>, object: Fields, path: string, state: State, wizard: boolean): Fields {
  const orientation = h.own(object, 'orientation', path)
  const hintLabel = h.own(object, 'hintLabel', path)
  const admitted = orientation === undefined ? undefined : h.enumeration(orientation, ['horizontal', 'vertical'] as const, `${path}.orientation`)
  if (wizard && admitted === 'vertical') h.invalid(`${path}.orientation: a wizard is a horizontal strip`)
  return {
    ...present('orientation', admitted),
    ...present('hintLabel', hintLabel === undefined ? undefined : h.text(hintLabel, `${path}.hintLabel`, state)),
  }
}
