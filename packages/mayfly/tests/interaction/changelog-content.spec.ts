/**
 * Tests for the clean Mayfly release-history boundary.
 * @module @ephemeral-ai/mayfly/interaction/tests/changelog-content
 */

import { describe, expect, it } from 'vitest'
import { MAYFLY_VERSION } from '../../src/transcript/banner-content.ts'
import { CHANGELOG_ENTRIES } from '../../src/interaction/changelog-content.ts'

describe('Mayfly changelog content', () => {
  it('starts with the current Mayfly release and no inherited history', () => {
    expect(CHANGELOG_ENTRIES).toHaveLength(1)
    expect(CHANGELOG_ENTRIES[0]).toMatchObject({
      version: MAYFLY_VERSION,
      knownIssues: [],
    })
  })

  it('documents the consolidated three-package public surface', () => {
    const content = CHANGELOG_ENTRIES[0]!.highlights.join('\n')
    expect(content).toContain('@ephemeral-ai/mayfly')
    expect(content).toContain('@ephemeral-ai/mayfly-ui')
    expect(content).toContain('@ephemeral-ai/mayfly-cli')
    expect(content).toContain('native dsh services')
  })
})
