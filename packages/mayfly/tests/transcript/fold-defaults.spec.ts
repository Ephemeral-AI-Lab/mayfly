/** Native work-detail mode defaults and tree-local settings.
 * @module @ephemeral-ai/mayfly/tests/transcript/fold-defaults
 */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { DEFAULT_TRANSCRIPT_PRESENTATION, PROCESS_POLICIES, TranscriptPresentationPolicy, followPresentationSettings } from '../../src/transcript/presentation-policy.ts'
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
    const { liveProcess, settledProcess, compactionLine, compactionSummary } = policy.snapshot().process
    return [mode, liveProcess, settledProcess, compactionLine, compactionSummary]
  })
  expect(table).toEqual([
    ['compact', 'collect', 'collect', true, false],
    ['standard', 'blocks', 'blocks', false, false],
    ['detailed', 'current', 'blocks', false, false],
    ['verbose', 'cards', 'cards', false, true],
  ])
  expect(PROCESS_POLICIES.standard).toBe(DEFAULT_TRANSCRIPT_PRESENTATION.process)
})

it('follows resolved frontend preferences and native document commits only in its owning tree', async () => {
  const ctx = new Context()
  let settings = { transcriptView: 'compact', windowTurns: 4 }
  ctx.reflect.provide('mayflyInteractionState')
  Object.assign(ctx, { mayflyInteractionState: { settingsSource: () => settings } })
  const policy = new TranscriptPresentationPolicy()
  const other = new TranscriptPresentationPolicy()
  const changed = vi.fn()
  let queued: (() => void) | undefined
  const owner = await ctx.plugin({ name: 'frontend-transcript-policy-test', apply(owner: Context) {
    const on = vi.spyOn(owner, 'on')
    followPresentationSettings(owner, policy, changed)
    queued = on.mock.calls.find(call => call[0] === 'mayfly/settings-source-ready')?.[1] as (() => void) | undefined
  } })
  try {
    expect(policy.snapshot()).toMatchObject({ mode: 'compact', windowTurns: 4 })
    expect(changed).not.toHaveBeenCalled()
    settings = { transcriptView: 'verbose', windowTurns: 2 }
    ctx.emit('settings/document-updated', 'other' as never, 1)
    expect(policy.snapshot().mode).toBe('compact')
    ctx.emit('mayfly/settings-source-ready', settings)
    expect(policy.snapshot()).toMatchObject({ mode: 'verbose', windowTurns: 2 })
    expect(changed).toHaveBeenCalledOnce()
    ctx.emit('settings/document-updated', 'mayfly' as never, 2)
    expect(changed).toHaveBeenCalledOnce()
    settings = { transcriptView: 'detailed', windowTurns: 6 }
    ctx.emit('settings/document-updated', 'mayfly' as never, 3)
    expect(policy.snapshot()).toMatchObject({ mode: 'detailed', windowTurns: 6 })
    expect(changed).toHaveBeenCalledTimes(2)
    expect(other.snapshot()).toBe(DEFAULT_TRANSCRIPT_PRESENTATION)
    await owner.dispose()
    settings = { transcriptView: 'standard', windowTurns: 10 }
    ctx.emit('mayfly/settings-source-ready', settings)
    ctx.emit('settings/document-updated', 'mayfly' as never, 4)
    expect(queued).toBeTypeOf('function')
    queued!()
    expect(policy.snapshot()).toMatchObject({ mode: 'detailed', windowTurns: 6 })
    expect(changed).toHaveBeenCalledTimes(2)
  } finally { await owner.dispose(); await ctx.fiber.dispose(); vi.restoreAllMocks() }
})

it('keeps the default policy when a frontend preference source is not composed', async () => {
  const ctx = new Context()
  const policy = new TranscriptPresentationPolicy()
  const changed = vi.fn()
  followPresentationSettings(ctx, policy, changed)
  ctx.emit('mayfly/settings-source-ready', undefined)
  expect(policy.snapshot()).toBe(DEFAULT_TRANSCRIPT_PRESENTATION)
  expect(changed).not.toHaveBeenCalled()
  await ctx.fiber.dispose()
})
