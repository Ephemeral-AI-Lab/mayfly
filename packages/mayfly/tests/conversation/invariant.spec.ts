import { describe, expect, it } from 'vitest'
import * as invariant from '../../src/conversation/invariant.ts'

describe('conversation invariant companion', () => {
  it('has a stable inert entry', () => {
    expect(invariant.name).toBe('mayfly-conversation-invariant')
    expect(() => invariant.apply({} as never)).not.toThrow()
  })
})
