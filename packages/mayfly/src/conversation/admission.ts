/**
 * Identity-memoized admission for immutable projection wire values. The
 * official registry validates a unit's wire view on every committed event of
 * every session, child sessions included. Fold results never mutate retained
 * objects, so each object passes its strict schema once and later views that
 * retain it answer from the identity memo without a deep parse or copy.
 *
 * @module @ephemeral-ai/mayfly/conversation/admission
 */

import type { z } from 'zod'

/**
 * Build a predicate admitting objects through `schema` once per identity.
 * @param schema - the strict schema for one immutable object.
 * @returns whether the value is an admitted object.
 */
export function identityAdmission(schema: z.ZodType): (value: unknown) => boolean {
  const admitted = new WeakSet<object>()
  return (value) => {
    if (typeof value !== 'object' || value === null) return false
    if (admitted.has(value)) return true
    if (!schema.safeParse(value).success) return false
    admitted.add(value)
    return true
  }
}

/**
 * Build a predicate admitting arrays whose elements each pass `element`.
 * @param element - the per-element admission.
 * @returns whether the value is an array of admitted elements.
 */
export function everyAdmitted(element: (value: unknown) => boolean): (value: unknown) => boolean {
  return value => Array.isArray(value) && value.every(element)
}
