/** Native work-detail mode defaults and tree-local settings.
 * @module @ephemeral-ai/mayfly/tests/transcript/fold-defaults
 */
import { expect, it } from 'vitest'
import { DEFAULT_TRANSCRIPT_PRESENTATION, PROCESS_POLICIES, TranscriptPresentationPolicy } from '../../src/transcript/presentation-policy.ts'
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
it('preserves valid numeric settings without supporting retired keys', () => {
  const policy = new TranscriptPresentationPolicy()
  policy.apply({ windowTurns: 5, recentStepsRetention: 20, expandTurns: 2, userFoldLines: 25, userFoldChars: 750 })
  expect(policy.snapshot()).toMatchObject({ mode: 'standard', windowTurns: 5, expandTurns: 2, userFoldLines: 25, userFoldChars: 750 })
  expect(policy.snapshot()).not.toHaveProperty('recentStepsRetention')
  expect(policy.apply({ transcript: { default: 'full' }, windowTurns: -1, expandTurns: 'many', userFoldLines: 0, userFoldChars: null })).toBe(false)
})

it('resolves each mode to its capability table', () => {
  const policy = new TranscriptPresentationPolicy()
  const table = (['compact', 'standard', 'detailed', 'verbose'] as const).map(mode => {
    policy.apply({ transcriptView: mode })
    const { foldCompletedTurns, liveProcess, settledProcess, fileChanges, liveProcessDetail, settledReasoningPreview } = policy.snapshot().process
    return [mode, foldCompletedTurns, liveProcess, settledProcess, fileChanges, liveProcessDetail, settledReasoningPreview]
  })
  expect(table).toEqual([
    ['compact', true, 'hidden', 'titles', 'process', false, false],
    ['standard', true, 'titles', 'titles', 'content', true, true],
    ['detailed', true, 'cards', 'titles', 'content', false, true],
    ['verbose', false, 'cards', 'cards', 'content', false, true],
  ])
  // The activity row carries the running detail exactly where no card shows it.
  for (const process of Object.values(PROCESS_POLICIES)) {
    expect(process.liveProcessDetail).toBe(process.liveProcess === 'titles')
  }
  expect(PROCESS_POLICIES.standard).toBe(DEFAULT_TRANSCRIPT_PRESENTATION.process)
})
