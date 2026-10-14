/** The copied text of a row per kind: what a person reads (text) and the model's JSON (raw), including wide characters. */
import { describe, expect, it } from 'vitest'
import type { TranscriptEntryModel } from '../../src/frontend/models.ts'
import { partText, type RowPart } from '../../src/transcript/row-text.ts'

const base = { seq: 1, updatedSeq: 1, turn: 1 }
const tool = (overrides: Record<string, unknown>): TranscriptEntryModel => ({
  ...base, id: 'tool:1', kind: 'transcript-tool', step: 1, callId: 'c1', name: 'bash', family: 'command', activity: 'commands',
  detail: 'pnpm test', arguments: '{}', startedAt: 0, result: { text: 'ok', isError: false, endedAt: 1 }, ...overrides,
} as unknown as TranscriptEntryModel)
const text = (part: RowPart): string => partText(part, 'text')
const entry = (value: TranscriptEntryModel): RowPart => ({ entry: value })

describe('partText in text mode', () => {
  it('gives a message as its Markdown, wide characters and all', () => {
    const user: TranscriptEntryModel = { ...base, id: 'user:1', kind: 'transcript-user', text: '中文 **bold** 😀', images: [] }
    const assistant: TranscriptEntryModel = { ...base, id: 'assistant:1', kind: 'transcript-assistant', step: 1, text: '## 标题\n- 项目', streaming: false }
    expect(text(entry(user))).toBe('中文 **bold** 😀')
    expect(text(entry(assistant))).toBe('## 标题\n- 项目')
  })

  it('gives a thinking block its text and an error its message; an interrupt has no text', () => {
    expect(text(entry({ ...base, id: 'thinking:1', kind: 'transcript-thinking', step: 1, text: 'plan', streaming: false } as TranscriptEntryModel))).toBe('plan')
    expect(text(entry({ ...base, id: 'error:1', kind: 'transcript-error', message: 'boom' } as TranscriptEntryModel))).toBe('boom')
    expect(text(entry({ ...base, id: 'interrupted:1', kind: 'transcript-interrupted' } as TranscriptEntryModel))).toBe('')
  })

  it('gives an edit as a unified-style diff, with the lines the cut hid named at the tail', () => {
    const edit = tool({ change: { path: 'src/a.ts', added: 1, removed: 1, hunks: [{ before: 'const 旧 = 1', after: 'const 新 = 2' }], hiddenLines: 3 } })
    expect(text(entry(edit))).toBe('--- src/a.ts\n+++ src/a.ts\n@@\n-const 旧 = 1\n+const 新 = 2\n… 3 more changed lines')
  })

  it('gives a write as its new file head, and names the lines past the head', () => {
    const write = tool({ name: 'write', activity: 'write', change: { path: 'new.txt', added: 5, removed: 0, hunks: [], hiddenLines: 0, write: { bytes: 40, lines: 5, head: ['一', 'two'] } } })
    expect(text(entry(write))).toBe('--- /dev/null\n+++ new.txt\n+一\n+two\n… 3 more lines')
  })

  it('gives a command with its output, and a plain tool with its head, web sources, and result', () => {
    expect(text(entry(tool({ terminal: { command: 'pnpm test', exitCode: 0, output: 'ok 中' } })))).toBe('$ pnpm test\nok 中')
    const search = tool({ name: 'web_search', activity: 'webSearch', family: 'web', detail: 'mayfly', web: { kind: 'search', sources: [{ url: 'https://a.dev', title: 'A' }, { url: 'https://b.dev' }], truncated: false }, result: { text: 'done', isError: false, endedAt: 1 } })
    expect(text(entry(search))).toBe('web_search(mayfly)\nA https://a.dev\nhttps://b.dev\ndone')
  })

  it('gives a plan as its Markdown from the arguments', () => {
    expect(text(entry(tool({ name: 'plan', activity: 'plan', arguments: JSON.stringify({ plan: '# Step 1\n- 做' }) })))).toBe('# Step 1\n- 做')
  })

  it('gives each call of a group as its own part: a read window, a search, and a command with its preview', () => {
    const read = { callId: 'r1', activity: 'read', detail: 'src/a.ts', seq: 1, updatedSeq: 1, turn: 1, step: 0, name: 'read', startedAt: 0, state: 'ok', path: 'src/a.ts', previewLines: [{ number: 12, text: '中文' }] }
    const readGroup = { ...base, id: 'read:1', kind: 'transcript-read-group', step: 0, reads: [read] } as unknown as TranscriptEntryModel
    expect(partText({ entry: readGroup, call: read as never }, 'text')).toBe('src/a.ts\n   12  中文')
    const search = { callId: 's1', activity: 'search', detail: 'foo', seq: 1, updatedSeq: 1, turn: 1, step: 0, name: 'grep', startedAt: 0, state: 'ok', shape: 'matches', pattern: 'foo', files: [{ path: 'a.ts', count: 1, previews: [{ lineNumber: 3, line: 'foo()' }] }] }
    const searchGroup = { ...base, id: 'search:1', kind: 'transcript-search-group', step: 0, searches: [search] } as unknown as TranscriptEntryModel
    expect(partText({ entry: searchGroup, call: search as never }, 'text')).toBe('foo\na.ts\n  3: foo()')
    const command = { callId: 'g1', activity: 'commands', detail: 'pnpm test', seq: 1, updatedSeq: 1, turn: 1, step: 0, name: 'bash', startedAt: 0, state: 'ok', command: 'pnpm test', previewLines: ['a', '中'] }
    const commandGroup = { ...base, id: 'cmd:1', kind: 'transcript-command-group', step: 0, commands: [command] } as unknown as TranscriptEntryModel
    expect(partText({ entry: commandGroup, call: command as never }, 'text')).toBe('$ pnpm test\na\n中')
  })

  it('gives a compaction its detail, summary, and error', () => {
    expect(text(entry({ ...base, id: 'compaction:1', kind: 'transcript-compaction', state: 'error', trigger: 'auto', startedAt: 0, detail: 'context full', summary: 'kept 中', error: 'failed' } as TranscriptEntryModel))).toBe('context full\nkept 中\nfailed')
  })
})

describe('partText in raw mode', () => {
  it('gives the model JSON of a whole entry, and of one call when the part is a call', () => {
    const user: TranscriptEntryModel = { ...base, id: 'user:1', kind: 'transcript-user', text: '中文', images: [] }
    expect(partText(entry(user), 'raw')).toBe(JSON.stringify(user, null, 2))
    const command = { callId: 'g1', activity: 'commands', detail: 'x', seq: 1, updatedSeq: 1, turn: 1, step: 0, name: 'bash', startedAt: 0, state: 'ok', command: 'x' }
    const group = { ...base, id: 'cmd:1', kind: 'transcript-command-group', step: 0, commands: [command] } as unknown as TranscriptEntryModel
    expect(partText({ entry: group, call: command as never }, 'raw')).toBe(JSON.stringify(command, null, 2))
  })
})
