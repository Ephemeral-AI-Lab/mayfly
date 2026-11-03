/** How far two long strings agree at their ends, compared in blocks by memory instead of unit by unit.
 * @module @ephemeral-ai/mayfly/core/text-match
 */

/** Units compared at once when two texts are matched from an end: one string comparison of two slices, which is a memory compare. */
const COMPARE_BLOCK = 4_096

/** The length of the longest common prefix of `a` and `b`, at most `limit`: whole blocks by native compare, then the first mismatch by unit. */
export function commonPrefix(a: string, b: string, limit: number): number {
  let length = 0
  while (length + COMPARE_BLOCK <= limit && a.slice(length, length + COMPARE_BLOCK) === b.slice(length, length + COMPARE_BLOCK)) length += COMPARE_BLOCK
  while (length < limit && a[length] === b[length]) length += 1
  return length
}

/** The length of the longest common suffix of `a` and `b`, at most `limit`, matched the same way from the end. */
export function commonSuffix(a: string, b: string, limit: number): number {
  let length = 0
  while (length + COMPARE_BLOCK <= limit && a.slice(a.length - length - COMPARE_BLOCK, a.length - length) === b.slice(b.length - length - COMPARE_BLOCK, b.length - length)) length += COMPARE_BLOCK
  while (length < limit && a[a.length - length - 1] === b[b.length - length - 1]) length += 1
  return length
}
