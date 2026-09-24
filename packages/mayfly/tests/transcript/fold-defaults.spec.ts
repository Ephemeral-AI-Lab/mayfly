/** Native work-detail mode defaults and tree-local settings.
 * @module @ephemeral-ai/mayfly/tests/transcript/fold-defaults
 */
import { expect, it } from 'vitest'
import { DEFAULT_TRANSCRIPT_PRESENTATION, TranscriptPresentationPolicy } from '../../src/transcript/presentation-policy.ts'
it('uses immutable Standard defaults and independent settings per tree', () => {
  const first = new TranscriptPresentationPolicy(), second = new TranscriptPresentationPolicy()
  expect(first.snapshot()).toBe(DEFAULT_TRANSCRIPT_PRESENTATION)
  expect(Object.isFrozen(first.snapshot())).toBe(true)
  for (const mode of ['compact', 'standard', 'detailed', 'verbose']) {
    first.apply({ transcriptView: mode })
    expect(first.snapshot().mode).toBe(mode)
  }
  expect(second.snapshot().mode).toBe('standard')
  expect(first.apply({ transcriptView: 'verbose' })).toBe(false)
  expect(first.apply(null)).toBe(true)
  expect(first.apply({ transcriptView: 'unknown' })).toBe(false)
})
it('preserves valid numeric settings without supporting retired family overrides', () => {
  const policy = new TranscriptPresentationPolicy()
  policy.apply({ windowTurns: 5, recentStepsRetention: 20, expandTurns: 2, userFoldLines: 25, userFoldChars: 750 })
  expect(policy.snapshot()).toMatchObject({ mode: 'standard', windowTurns: 5, recentStepsRetention: 20, expandTurns: 2, userFoldLines: 25, userFoldChars: 750 })
  expect(policy.apply({ transcript: { default: 'full' }, windowTurns: -1, recentStepsRetention: 1.5, expandTurns: 'many', userFoldLines: 0, userFoldChars: null })).toBe(false)
})
