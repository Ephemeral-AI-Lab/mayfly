/**
 * The shared Agent lifecycle presentation helpers: compact duration
 * formatting across seconds, minutes, and hours.
 *
 * @module @ephemeral-ai/mayfly/tests/transcript/agent-presentation
 */

import { describe, expect, it } from 'vitest'
import { compactElapsedMs, compactElapsedSeconds } from '../../src/transcript/agent-presentation.ts'

describe('compactElapsedSeconds', () => {
  it('renders sub-minute, minute, and hour durations compactly', () => {
    expect(compactElapsedSeconds(0)).toBe('0s')
    expect(compactElapsedSeconds(59)).toBe('59s')
    expect(compactElapsedSeconds(60)).toBe('1m 0s')
    expect(compactElapsedSeconds(125)).toBe('2m 5s')
    expect(compactElapsedSeconds(3599)).toBe('59m 59s')
    expect(compactElapsedSeconds(3600)).toBe('1h 0m 0s')
    expect(compactElapsedSeconds(7503)).toBe('2h 5m 3s')
  })

  it('clamps to non-negative whole seconds and converts milliseconds', () => {
    expect(compactElapsedSeconds(-5)).toBe('0s')
    expect(compactElapsedSeconds(59.9)).toBe('59s')
    expect(compactElapsedMs(3_600_000)).toBe('1h 0m 0s')
    expect(compactElapsedMs(7_503_000)).toBe('2h 5m 3s')
  })
})
