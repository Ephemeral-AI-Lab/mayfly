/** The pending-parity ledgers after the Phase 1 freeze: every remaining entry waits for a later phase, none for a 1.x slice. */
import { describe, expect, it } from 'vitest'
import { PENDING_PARITY, PENDING_WALKS, pendingFor, pendingWalk } from './pending.ts'

const LATER_PHASE = /^Phase [3-7]$/u

describe('the pending ledgers', () => {
  it('tag every walk with a later phase and no Phase 1 slice', () => {
    for (const entry of PENDING_WALKS) {
      expect(entry.slice, `scene ${String(entry.scene)} ${entry.walk}`).toMatch(LATER_PHASE)
      expect(entry.slice).not.toMatch(/^1\./u)
    }
  })

  it('tag every frame entry with a later phase and no Phase 1 slice', () => {
    expect(PENDING_PARITY.length).toBeGreaterThan(0)
    for (const entry of PENDING_PARITY) {
      expect(entry.slice, `${entry.directory} ${entry.walk}`).toMatch(LATER_PHASE)
      expect(entry.slice).not.toMatch(/^1\./u)
      expect(entry.reason.length).toBeGreaterThan(0)
    }
  })

  it('look entries up by walk and by frame', () => {
    expect(pendingWalk(0, 'none')).toBeUndefined()
    expect(pendingFor('15-editor', 'initial', 0).length).toBeGreaterThan(0)
    expect(pendingFor('15-editor', 'initial', 99)).toEqual([])
  })
})
