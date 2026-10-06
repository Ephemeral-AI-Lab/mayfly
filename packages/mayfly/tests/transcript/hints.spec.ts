/** Localized fold hints: pluralization and Ctrl-O reach.
 * @module @ephemeral-ai/mayfly/tests/transcript/hints
 */
import { expect, it } from 'vitest'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import { HINTS_ZH, moreLinesHint, moreOutputHint, moreRowsHint } from '../../src/transcript/hints.ts'

const t = interpolateLocaleMessage
const zh = (key: string, values?: Record<string, string | number>) => interpolateLocaleMessage(HINTS_ZH[key] ?? key, values)

it('pluralizes hidden lines and names Ctrl-O only within reach', () => {
  expect(moreLinesHint(t, 1, undefined, true)).toBe('... (1 more line, Ctrl+O to expand)')
  expect(moreLinesHint(t, 4, undefined, true)).toBe('... (4 more lines, Ctrl+O to expand)')
  expect(moreLinesHint(t, 1, undefined, false)).toBe('... (1 more line)')
  expect(moreLinesHint(t, 4, undefined, false)).toBe('... (4 more lines)')
  expect(moreLinesHint(t, 1, 4, true)).toBe('... (1 more line, 4 total, Ctrl+O to expand)')
  expect(moreLinesHint(t, 3, 6, true)).toBe('... (3 more lines, 6 total, Ctrl+O to expand)')
  expect(moreLinesHint(t, 1, 4, false)).toBe('... (1 more line, 4 total)')
  expect(moreLinesHint(t, 3, 6, false)).toBe('... (3 more lines, 6 total)')
  expect(moreOutputHint(t, true)).toBe('... (more output, Ctrl+O to expand)')
  expect(moreOutputHint(t, false)).toBe('... (more output)')
  expect(moreRowsHint(t, 5, true)).toBe('... (5 more, Ctrl+O to expand)')
  expect(moreRowsHint(t, 5, false)).toBe('... (5 more)')
  expect(moreLinesHint(zh, 3, 6, true)).toBe('...（还有 3 行，共 6 行，按 Ctrl+O 展开）')
  expect(moreRowsHint(zh, 2, false)).toBe('...（还有 2 项）')
})
