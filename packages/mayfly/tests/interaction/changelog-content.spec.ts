/**
 * Tests for the clean Mayfly release-history boundary.
 * @module @ephemeral-ai/mayfly/interaction/tests/changelog-content
 */

import { describe, expect, it } from 'vitest'
import { rcompare } from 'semver'
import { MAYFLY_VERSION } from '../../src/transcript/banner-content.ts'
import { CHANGELOG_ENTRIES } from '../../src/interaction/changelog-content.ts'

describe('Mayfly changelog content', () => {
  it('starts with the current Mayfly release and no inherited history', () => {
    const versions = CHANGELOG_ENTRIES.map(entry => entry.version)
    expect(versions[0]).toBe(MAYFLY_VERSION)
    expect(versions.at(-1)).toBe('0.1.0-alpha.1')
    expect(new Set(versions).size).toBe(versions.length)
    expect(versions).toEqual([...versions].sort(rcompare))
    for (const entry of CHANGELOG_ENTRIES) {
      expect(entry.summary.length).toBeGreaterThan(20)
      expect(entry.highlights.length).toBeGreaterThan(0)
      expect(entry.knownIssues).toBeInstanceOf(Array)
    }
  })

  it('documents the consolidated three-package public surface', () => {
    const content = CHANGELOG_ENTRIES.at(-1)!.highlights.join('\n')
    expect(content).toContain('@ephemeral-ai/mayfly')
    expect(content).toContain('@ephemeral-ai/mayfly-ui')
    expect(content).toContain('@ephemeral-ai/mayfly-cli')
    expect(content).toContain('native dsh services')
  })
})
