/**
 * Frontend-tree transcript presentation policy parsing and isolation.
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TRANSCRIPT_PRESENTATION,
  TranscriptPresentationPolicy,
} from '../../src/transcript/presentation-policy.ts'

describe('transcript presentation policy', () => {
  it('starts with immutable shipped defaults', () => {
    const policy = new TranscriptPresentationPolicy()
    expect(policy.snapshot()).toBe(DEFAULT_TRANSCRIPT_PRESENTATION)
    expect(Object.isFrozen(policy.snapshot())).toBe(true)
    expect(policy.snapshot().detail).toEqual({
      thinking: 'compact', command: 'compact', read: 'compact', search: 'compact',
      edit: 'compact', web: 'compact', other: 'compact',
    })
  })

  it('resolves explicit family detail, inherit fallback, and numeric tunables', () => {
    const policy = new TranscriptPresentationPolicy()
    expect(policy.apply({
      transcript: {
        default: 'collapsed',
        thinking: 'full',
        command: 'inherit',
        read: 'compact',
      },
      windowTurns: 5,
      recentStepsRetention: 20,
      expandTurns: 2,
      userFoldLines: 25,
      userFoldChars: 750,
    })).toBe(true)
    expect(policy.snapshot()).toEqual({
      detail: {
        thinking: 'full', command: 'collapsed', read: 'compact', search: 'collapsed',
        edit: 'collapsed', web: 'collapsed', other: 'collapsed',
      },
      defaultDetail: 'collapsed',
      windowTurns: 5,
      recentStepsRetention: 20,
      expandTurns: 2,
      userFoldLines: 25,
      userFoldChars: 750,
    })
  })

  it('retains current values for malformed fields and resolves absent keys through the default', () => {
    const policy = new TranscriptPresentationPolicy()
    policy.apply({
      transcript: { default: 'collapsed', command: 'full' },
      windowTurns: 5,
      userFoldChars: 750,
    })
    expect(policy.apply({
      transcript: { default: 'wide', command: 'yes', read: 3 },
      windowTurns: -3, recentStepsRetention: 1.5, expandTurns: 'many',
      userFoldLines: 0, userFoldChars: null,
    })).toBe(false)
    const snapshot = policy.snapshot()
    expect(snapshot.defaultDetail).toBe('collapsed')
    expect(snapshot.detail.command).toBe('full')
    expect(snapshot.detail.read).toBe('collapsed')
    expect(snapshot.windowTurns).toBe(5)
    expect(snapshot.userFoldChars).toBe(750)
    // Absent keys are not "keep": they resolve through the fallback default.
    expect(policy.apply(null)).toBe(true)
    expect(policy.snapshot().detail.command).toBe('collapsed')
  })

  it('does not share updates between trees', () => {
    const first = new TranscriptPresentationPolicy()
    const second = new TranscriptPresentationPolicy()
    first.apply({ transcript: { default: 'full' } })
    expect(first.snapshot().detail.thinking).toBe('full')
    expect(second.snapshot().detail.thinking).toBe('compact')
  })
})
