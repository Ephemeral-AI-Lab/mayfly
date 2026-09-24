/** Official work-detail modes keep final replies outside process disclosure.
 * @module @ephemeral-ai/mayfly/tests/transcript/work-details
 */
import { expect, it } from 'vitest'
import type { TranscriptEntryModel } from '../../src/frontend/models.ts'
import { workDetailEntries } from '../../src/transcript/work-details.ts'
const entries: TranscriptEntryModel[] = [
  { kind: 'transcript-user', id: 'u', seq: 1, turn: 1, text: 'Request' },
  { kind: 'transcript-thinking', id: 't', seq: 2, turn: 1, step: 0, text: 'Thought', streaming: false },
  { kind: 'transcript-tool', id: 'c', seq: 3, turn: 1, step: 0, callId: 'c', name: 'write', arguments: '{}', startedAt: 0, family: 'edit' },
  { kind: 'transcript-assistant', id: 'a', seq: 4, turn: 1, step: 1, text: 'Final answer', streaming: false },
]
it('folds eligible completed turns in Compact, Standard, Detailed and keeps Verbose open', () => {
  for (const mode of ['compact', 'standard', 'detailed'] as const) {
    const rows = workDetailEntries(entries, false, mode, false)
    expect(JSON.stringify(rows)).toContain('Final answer')
    expect(JSON.stringify(rows)).not.toContain('Thought')
    expect(rows).toHaveLength(3)
    expect(workDetailEntries(entries, false, mode, true)).toBe(entries)
  }
  expect(workDetailEntries(entries, false, 'verbose', false)).toBe(entries)
})
it('shows running bodies in Detailed and preserves interrupted or interleaved work', () => {
  expect(workDetailEntries(entries, true, 'detailed', false)).toEqual(entries)
  const interrupted = [...entries, { kind: 'transcript-interrupted' as const, id: 'i', seq: 5, turn: 1 }]
  expect(workDetailEntries(interrupted, false, 'standard', false)).toEqual(interrupted)
  const interleaved = [...entries.slice(0, 2), { ...entries[0]!, id: 'steer' }, ...entries.slice(2)]
  expect(workDetailEntries(interleaved, false, 'standard', false)).toEqual(interleaved)
  expect(workDetailEntries([], false, 'standard', false)).toEqual([])
  expect(workDetailEntries([{ kind: 'text', content: 'local' }], false, 'standard', false)).toEqual([{ kind: 'text', content: 'local' }])
  expect(workDetailEntries([entries[0]!], false, 'standard', false)).toEqual([entries[0]])
  expect(workDetailEntries([entries[0]!], true, 'standard', false)).toEqual([entries[0]])
  const preparing = [{ ...entries[2]!, preparing: { characters: 123 } }] as TranscriptEntryModel[]
  expect(JSON.stringify(workDetailEntries(preparing, true, 'standard', false))).toContain('Preparing write')
})
