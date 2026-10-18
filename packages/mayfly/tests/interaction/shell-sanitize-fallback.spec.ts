/** The sanitizer's last-resort path: an engine whose `replace` throws still yields C0-free text, never a crash.
 * @module @ephemeral-ai/mayfly/tests/interaction/shell-sanitize-fallback
 */
import { expect, it } from 'vitest'
import { sanitizeShellOutput } from '../../src/interaction/shell-sanitize.ts'

it('falls back to stripping only C0 controls when a replace call throws', () => {
  const original = String.prototype.replace
  let calls = 0
  String.prototype.replace = function throwingReplace(this: string): string {
    calls += 1
    // Restore first, so the fallback's own replace reaches the real implementation.
    String.prototype.replace = original
    throw new Error('pathological replace')
  } as unknown as typeof String.prototype.replace
  try {
    expect(sanitizeShellOutput('a\x01b\x1b[31mc')).toBe('ab[31mc')
    expect(calls).toBe(1)
  } finally {
    String.prototype.replace = original
  }
})
