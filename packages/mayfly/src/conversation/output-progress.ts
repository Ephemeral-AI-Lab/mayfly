/**
 * Event-time output measurements shared by the conversation projections.
 *
 * @module @ephemeral-ai/mayfly/conversation/output-progress
 */

import { z } from 'zod'
import type { OutputProgress } from './types.ts'

export const outputProgressSchema = z.object({
  chars: z.number().int().nonnegative(),
  initialChars: z.number().int().nonnegative(),
  startedAt: z.number().finite(),
  updatedAt: z.number().finite(),
}) satisfies z.ZodType<OutputProgress>

/** Exclude the first chunk from timed output: its generation began off-wire. */
export function appendOutputProgress(previous: OutputProgress | undefined, chars: number, time: number): OutputProgress {
  if (previous === undefined) return { chars, initialChars: chars, startedAt: time, updatedAt: time }
  return { ...previous, chars: previous.chars + chars, updatedAt: Math.max(previous.updatedAt, time) }
}
