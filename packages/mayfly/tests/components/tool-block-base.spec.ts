/**
 * Decision tests of the tool block base and the streaming input: the descriptor each category is built from (its name,
 * merging, streaming), a call whose arguments still stream as a pending block that shows its input so far, and a
 * command's running input at each tier.
 * @module components-tool-block-base
 */

import { describe, expect, it } from 'vitest'
import type { TranscriptEntryModel } from '../../src/frontend/models.ts'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import { callsOf, verboseRow, STANDARD_INPUT_ROWS } from '../../src/transcript/tool-calls.ts'
import { flightLabel, kindOf } from '../../src/transcript/tool-kinds.ts'
import type { StreamRow } from '../../src/components/transcript-view.ts'

const t = interpolateLocaleMessage
const NOW = Date.UTC(2026, 0, 1, 12, 5) + 60_000
let seq = 0
const base = (turn: number) => ({ seq: (seq += 1), updatedSeq: seq, turn })

/** A tool entry whose arguments may still stream: `preparing` marks one, `args` is what has arrived so far. */
const streaming = (name: string, args: string, overrides: Record<string, unknown> = {}): TranscriptEntryModel => ({
  ...base(1), id: `tool:${String(seq)}`, kind: 'transcript-tool', step: 1, callId: `c${String(seq)}`, name, family: 'other', detail: '',
  arguments: args, startedAt: NOW - 3_000, preparing: { characters: args.length }, activity: ACTIVITY[name] ?? 'tools', ...overrides,
} as unknown as TranscriptEntryModel)

/** The category each streaming tool counts under. */
const ACTIVITY: Readonly<Record<string, string>> = { bash: 'commands', edit: 'edit', write: 'write' }

const row = (entry: TranscriptEntryModel, open = false, tier: 'verbose' | 'standard' | 'compact' = 'verbose') =>
  verboseRow(callsOf(entry, t, NOW)[0]!, open, t, tier) as Extract<StreamRow, { kind: 'tool' }>

describe('the tool block base', () => {
  it('builds each category from one descriptor: a run head names the tool, a block merges with its neighbours, edits and writes stream and never merge', () => {
    expect(kindOf('commands')).toMatchObject({ headed: true, title: 'Bash', mergeable: true, streams: false, running: 'Running commands' })
    expect(kindOf('read')).toMatchObject({ headed: true, title: 'Read', unit: ['{count} file', '{count} files'] })
    expect(kindOf('edit')).toMatchObject({ mergeable: false, streams: true, title: 'Edit' })
    expect(kindOf('write')).toMatchObject({ mergeable: false, streams: true, title: 'Write' })
    // A category that names no descriptor of its own takes the base: a generic tool, mergeable, with the generic phrases.
    expect(kindOf('tools')).toMatchObject({ headed: false, title: 'Tools', mergeable: true, streams: false, running: 'Calling tools', preparing: 'Preparing tool calls' })
  })

  it('names a running category by its descriptor, and a mixed flight by its count', () => {
    expect(flightLabel([{ activity: 'edit', preparing: true }])).toEqual({ key: 'Preparing to edit files' })
    expect(flightLabel([{ activity: 'subagents', preparing: false }, { activity: 'subagents', preparing: false }])).toEqual({ key: 'Coordinating subagents' })
    expect(flightLabel([{ activity: 'read', preparing: false }, { activity: 'commands', preparing: false }])).toEqual({ key: 'Running {count} tools', values: { count: 2 } })
    expect(flightLabel([{ activity: 'read', preparing: false }, { activity: 'read', preparing: false }])).toEqual({ key: 'Reading files' })
  })
})

describe('a call whose arguments still stream', () => {
  it('is a pending block with no outcome, named by its tool, and its partial arguments as the input under it', () => {
    const block = row(streaming('bash', '{"command":"pnpm te'))
    expect(block).toMatchObject({ kind: 'tool', state: 'pending', name: 'Bash' })
    expect(block).not.toHaveProperty('outcome')
  })

  it('draws an edit\'s diff as its old and new strings arrive, under the pending line', () => {
    const edit = streaming('edit', '{"file_path":"src/a.ts","old_string":"one\\ntwo","new_string":"one\\nthree')
    const block = row(edit)
    expect(block).toMatchObject({ kind: 'tool', state: 'pending', name: 'Edit', target: 'src/a.ts' })
    expect(block.diff).toHaveLength(1)
    expect(block.diff?.[0]).toMatchObject({ before: 'one\ntwo', after: 'one\nthree', language: 'typescript' })
    // While it streams the change's tail is what the block shows.
    expect(block.diff?.[0]?.tail).toBeUndefined()
  })

  it('shows a write\'s code as it is generated, the last lines so far, with the earlier ones counted above', () => {
    const content = Array.from({ length: 20 }, (_, index) => `row ${String(index + 1)}`).join('\\n')
    const block = row(streaming('write', `{"file_path":"notes/x.md","content":"${content}`))
    expect(block).toMatchObject({ kind: 'tool', state: 'pending', name: 'Write', target: 'notes/x.md' })
    expect(block.code?.text.split('\n').at(-1)).toBe('row 20')
    expect(block.moreBefore).toMatch(/^… \+\d+ earlier/u)
  })

  it('shows nothing of its input at Compact, and the input rows at Standard only up to the input budget', () => {
    const command = streaming('bash', '{"command":"echo a\\necho b\\necho c\\necho d\\necho e"}')
    expect(row(command, false, 'compact')).not.toHaveProperty('body')
    const standard = row(command, false, 'standard')
    expect(standard.body?.length ?? 0).toBeLessThanOrEqual(STANDARD_INPUT_ROWS)
  })
})

describe('a command that runs', () => {
  it('shows its command lines beneath the line while it runs, and its time so far in the outcome', () => {
    const running: TranscriptEntryModel = {
      ...base(1), id: `tool:${String(seq)}`, kind: 'transcript-tool', step: 1, callId: 'r1', name: 'bash', family: 'command', activity: 'commands', detail: 'echo a',
      arguments: '{"command":"echo a\\necho b"}', startedAt: NOW - 3_000, terminal: { command: 'echo a\necho b' },
    } as unknown as TranscriptEntryModel
    const call = callsOf(running, t, NOW)[0]!
    expect(call).toMatchObject({ state: 'pending', outcome: ['3s'] })
    const block = verboseRow(call, false, t, 'verbose') as Extract<StreamRow, { kind: 'tool' }>
    expect(block.state).toBe('pending')
  })
})
