/**
 * A lazily painted plain-text document tells its host when painting a segment moved the row count its estimate gave, as a
 * Markdown document does, so a scroll that measured the estimate gets another frame.
 * @module @ephemeral-ai/mayfly/core/tests/segmented-changed
 */
import { describe, expect, it } from 'vitest'
import { contentNodeSource, type ContentRowsEnv } from '../../src/core/content-rows.ts'
import { DARK_COLORS } from '../../src/core/theme-dark.ts'
import { MayflyContentCache } from '../../src/core/ui-content-cache.ts'
import { virtualRows } from '../../src/core/ui-rows.ts'
import { createWorkCounters } from '../../src/core/ui-work-counters.ts'
import type { MayflyComponents } from '../../src/core/types.ts'
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '../../src/core/width.ts'

const components = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth } as MayflyComponents

function envOf(changed: () => void): ContentRowsEnv {
  return {
    components, colors: DARK_COLORS, counters: createWorkCounters(), cache: new MayflyContentCache(), bounded: false, viewportRows: () => 0,
    elide: hidden => `…${String(hidden)}`, errorRows: message => [message], changed,
  }
}

describe('a segmented text document', () => {
  it('tells its host when painting a segment moves the row count its estimate gave', () => {
    // Words that wrap one to a row: a line estimates at its columns over the width, and paints more rows than that.
    const content = Array.from({ length: 120 }, () => 'abcdefghijk '.repeat(8)).join('\n')
    let changes = 0
    const rows = virtualRows(contentNodeSource({ kind: 'text', content }, 20, envOf(() => { changes += 1 })))
    const before = rows.length
    void rows[0]
    expect(changes).toBeGreaterThan(0)
    expect(rows.length).toBeGreaterThan(before)
  })

  it('stays quiet when the painted count is the estimate', () => {
    const content = Array.from({ length: 120 }, (_, index) => `line ${String(index)} ${'x'.repeat(30)}`).join('\n')
    let changes = 0
    const rows = virtualRows(contentNodeSource({ kind: 'text', content }, 80, envOf(() => { changes += 1 })))
    void rows[0]
    expect(changes).toBe(0)
  })
})
