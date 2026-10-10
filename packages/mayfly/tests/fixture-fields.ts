/**
 * Fixture builders that take overrides: an override of `undefined` leaves the field out of the built value, the way a
 * value read from JSON or folded from events never holds `undefined`.
 *
 * @module @ephemeral-ai/mayfly/tests/fixture-fields
 */

/** Overrides of a fixture's fields; `undefined` removes a field. */
export type Overrides<T> = { readonly [Key in keyof T]?: T[Key] | undefined }

/**
 * Build a fixture from its defaults and overrides.
 * @param defaults - the complete fixture.
 * @param overrides - fields to replace; one set to `undefined` is left out.
 * @returns the fixture without the removed fields.
 */
export function withOverrides<T extends object>(defaults: T, overrides: Overrides<T>): T {
  return Object.fromEntries(Object.entries({ ...defaults, ...overrides }).filter(([, value]) => value !== undefined)) as T
}
