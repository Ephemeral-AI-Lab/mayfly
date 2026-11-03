/** The joined text of a content field, joined once per admitted field.
 * @module @ephemeral-ai/mayfly/core/field-text
 */
import { textOf, type MayflyContentField } from '@ephemeral-ai/mayfly-ui'

const joined = new WeakMap<object, string>()

/**
 * `textOf`, remembered on the identity of a frozen chunk list. An admitted field is immutable, so its text is a function
 * of its identity, and the document anchor, the line index, and the painters that all read one stream's text join its
 * chunks once instead of once each. A list that is not frozen is joined every time, since it may change under its caller.
 */
export function fieldText(field: MayflyContentField): string {
  if (typeof field === 'string') return field
  const known = joined.get(field)
  if (known !== undefined) return known
  const text = textOf(field)
  if (Object.isFrozen(field)) joined.set(field, text)
  return text
}
