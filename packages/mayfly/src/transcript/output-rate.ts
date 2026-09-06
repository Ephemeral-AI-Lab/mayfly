/**
 * Approximate token rate from phase-local event-time output measurements.
 *
 * @module @ephemeral-ai/mayfly/transcript/output-rate
 */

import type { OutputProgress } from '../conversation/types.ts'

/** A silent stream no longer advertises its last observed output rate. */
export function outputRate(progress: OutputProgress | undefined, now: number): string {
  if (progress === undefined || now - progress.updatedAt > 2_000) return ''
  const elapsed = progress.updatedAt - progress.startedAt
  if (elapsed < 250) return ''
  const tokens = (progress.chars - progress.initialChars) / 4
  return `≈${Math.round(tokens * 1_000 / elapsed)} tok/s`
}
