/**
 * Tests for the editor draft stash: `mayfly-input` mirrors editor text into
 * the frontend-tree stash, the editor mounted after a reload (a theme swap
 * re-runs this fiber) restores it, and consuming the draft — submit or an
 * Escape buffer clear — clears the stash so the next reload starts empty.
 * A separate tree receives a separate stash.
 */

import { describe, expect, it } from 'vitest'
import { DraftStash } from '../../src/interaction/draft-stash.ts'

describe('editor draft stash', () => {

  it('stashes the input mode beside the draft and resets both on submit', () => {
    const stash = new DraftStash()
    stash.stashInputMode('bash')
    expect(stash.getStashedInputMode()).toBe('bash')
    // Consuming the draft resets the mode with it.
    stash.stashDraft({ raw: 'ls', pastes: new Map() })
    stash.clearDraft()
    expect(stash.getStashedInputMode()).toBe('prompt')
    expect(stash.getStashedDraft().raw).toBe('')
  })
})
