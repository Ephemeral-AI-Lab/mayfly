/**
 * Approximate output tokens and token rate from streamed characters, using
 * the Harness four-characters-per-token estimate.
 *
 * @module @ephemeral-ai/mayfly/transcript/output-rate
 */

import type { OutputProgress } from '../conversation/types.ts'
import { formatTokens } from './status-context.ts'

/** The `↓` estimated-output counter for streamed characters; '' below one token. */
export function outputCounter(chars: number): string {
  const tokens = Math.floor(chars / 4)
  return tokens > 0 ? `↓${formatTokens(tokens)}` : ''
}

/** A silent stream no longer advertises its last observed output rate. */
export function outputRate(progress: OutputProgress | undefined, now: number): string {
  if (progress === undefined || now - progress.updatedAt > 2_000) return ''
  const elapsed = progress.updatedAt - progress.startedAt
  if (elapsed < 250) return ''
  const tokens = (progress.chars - progress.initialChars) / 4
  return `≈${Math.round(tokens * 1_000 / elapsed)} tok/s`
}
