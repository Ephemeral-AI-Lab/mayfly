/** Frozen rc.2 export samples, complete projection visibility, and opaque wire payload handling. @module */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  buildRemoteExportMarkdown, buildRemoteFullExportMarkdown, remoteExportFileName, remoteExportItems,
} from '../../src/remote/operations/export-markdown.ts'
import { entry, events, exportedAt, projection, wire } from './export-fixture.ts'

const facts = { sessionId: 'sess-12345678', workDir: '/tmp/spec', exportedAt }

describe('frozen rc.2 export samples', () => {
  it('retains the immutable reference source identity beside the generated documents', () => {
    expect(JSON.parse(readFileSync(new URL('./fixtures/export-rc2-provenance.json', import.meta.url), 'utf8'))).toMatchObject({
      commit: 'f148e7045cc22a66e62c0cd5203f8eeca1368081',
      source: 'packages/mayfly/src/interaction/session-export.ts',
      blob: '98a1527d45478a3e9aa7347c086d7bc3e2b03d3d',
      facts: '../export-fixture.ts',
    })
  })

  it('byte-matches the actual frozen readable projection export, including raw tool JSON and paired results', () => {
    const markdown = buildRemoteExportMarkdown({ ...facts, items: remoteExportItems(projection) })
    expect(markdown).toBe(JSON.parse(readFileSync(new URL('./fixtures/export-readable-rc2.json', import.meta.url), 'utf8')))
    expect(markdown).toContain('```json\n{"file_path":"a.ts"}\n```')
    expect(markdown.indexOf('result A')).toBeLessThan(markdown.indexOf('result B'))
    expect(markdown).not.toContain('compaction')
    expect(markdown).not.toContain('goal')
  })

  it('byte-matches the frozen full audit sample, preserving hidden source labels and readable attempts', () => {
    expect(buildRemoteFullExportMarkdown({ ...facts, events })).toBe(JSON.parse(readFileSync(new URL('./fixtures/export-full-rc2.json', import.meta.url), 'utf8')))
  })
})

describe('readable projection export', () => {
  it.each(['', 'attached documents'] as const)('retains file-only and text/file messages with ordered file and image metadata: %s', text => {
    const attachments = [
      { kind: 'file', attachmentId: 'file-a', name: '报告.txt', bytes: 12 },
      { kind: 'image', attachmentId: 'image-a', mediaType: 'image/png', bytes: 1, width: 2, height: 3, name: 'diagram.png' },
      { kind: 'file', attachmentId: 'file-b', name: 'second.pdf', bytes: 24 },
    ]
    const markdown = buildRemoteExportMarkdown({ ...facts, items: remoteExportItems({ ...projection, entries: [entry({ kind: 'user', text, attachments })] }) })
    expect(markdown).toContain('message_count: 1')
    expect(markdown).toContain('[file 报告.txt (12 bytes)]\n\n[image diagram.png]\n\n[file second.pdf (24 bytes)]')
    if (text !== '') expect(markdown.indexOf(text)).toBeLessThan(markdown.indexOf('[file'))
    expect(markdown).not.toContain('file-a')
  })
  it('retains empty-message rules, named images, codeless failures and pending tools', () => {
    const items = [
      entry({ kind: 'user', text: '', attachments: [] }), entry({ kind: 'user', text: 'second user', attachments: [] }),
      entry({ kind: 'thinking', step: 0, streaming: false, text: '  ' }),
      entry({ kind: 'assistant', step: 0, streaming: false, text: '' }),
      entry({ kind: 'tool', callId: 'c', channel: 'transcript', step: 0, startedAt: 1, name: 'read', arguments: 'invalid JSON' }),
      entry({ kind: 'error', message: 'no code' }),
    ]
    const markdown = buildRemoteExportMarkdown({ ...facts, workDir: undefined, items: remoteExportItems({ ...projection, entries: items }) })
    expect(markdown.match(/### User/gu)).toHaveLength(1)
    expect(markdown).not.toContain('summary>Thinking')
    expect(markdown).not.toContain('### Assistant')
    expect(markdown).toContain('```json\ninvalid JSON\n```')
    expect(markdown).toContain('request failed: no code\n')
    expect(markdown).toContain('1 turn | 1 tool call')
    expect(markdown).toContain('work_dir: \n')
  })

  it('bounds the first nonempty topic and keeps an empty overview when no user text exists', () => {
    const long = entry({ kind: 'user', text: `${'x'.repeat(200)}\nmore`, attachments: [] })
    expect(buildRemoteExportMarkdown({ ...facts, items: remoteExportItems({ ...projection, entries: [long] }) })).toContain(`Topic**: ${'x'.repeat(80)}…`)
    const empty = buildRemoteExportMarkdown({ ...facts, items: [] })
    expect(empty).toContain('Topic**: (empty)')
    expect(empty).toContain('0 turns | 0 tool calls')
  })
})

describe('full wire audit export', () => {
  const full = (...rows: Parameters<typeof wire>[]): string => buildRemoteFullExportMarkdown({ ...facts, workDir: undefined, events: rows.map(([type, data], index) => wire(type, data, index)) })

  it('preserves ordered file metadata while excluding opaque filesystem targets from the readable full document', () => {
    const markdown = full(['user/message', { source: { kind: 'user' }, content: [
      { type: 'text', text: 'files follow' },
      { type: 'file', attachmentId: 'first', name: '报告.txt', bytes: 12, target: '/private/opaque' },
      { type: 'image' },
      { type: 'file', attachmentId: 'second', name: 'empty', bytes: 0 },
      { type: 'file' },
    ] }])
    expect(markdown).toContain('files follow\n\n[file 报告.txt (12 bytes)]\n\n[image]\n\n[file empty (0 bytes)]\n\n[file ]')
    expect(markdown).not.toContain('/private/opaque')
  })

  it('handles opaque or incomplete data without inventing message text or usage', () => {
    for (const type of ['turn/start', 'step/start', 'user/message', 'assistant/message', 'tool/call', 'tool/result', 'turn/end']) {
      expect(full([type, null])).not.toContain('undefined')
      expect(full([type, {}])).not.toContain('undefined')
    }
    expect(full(['user/message', { source: {}, content: [null, { type: 'text', text: 1 }, { type: 'text', text: '' }] }])).toContain('#### user ()')
    expect(full(['assistant/message', { message: { content: [null, { type: 'text', text: 1 }, { type: 'reasoning', text: 1 }, { type: 'text', text: '' }, { type: 'reasoning', text: '' }] }, usage: { inputTokens: 'bad', outputTokens: 1 } }])).not.toContain('usage:')
    expect(full(['assistant/message', { message: { content: [] }, usage: { inputTokens: 1, outputTokens: 2 } }])).toContain('usage: input 1, output 2')
    expect(full(['tool/result', { meta: ' ', message: {}, error: {} }])).toContain('tool result (error: )')
    expect(full(['tool/result', { error: { code: 'E', name: '' } }])).toContain('tool result (error: E)')
    expect(full(['turn/end', { reason: { kind: 'error', error: {} } }])).toContain('turn/end (error: )')
    expect(full(['turn/end', { reason: { kind: 'error', error: { message: 'no code' } } }])).toContain('turn/end (error: no code)')
    expect(full(['turn/end', { reason: { kind: 'error' } }])).toContain('turn/end (error)')
    expect(full(['user/message', { content: 'opaque' }])).toContain('#### user ()')
    expect(full(['assistant/message', { message: { content: 'opaque' }, usage: null }])).not.toContain('usage:')
  })

  it('keeps reasoning-only and text-only attempt prefixes and skips boundary-only attempts', () => {
    const raw = (type: string, text: string) => ({ type: 'chunk', time: 1, chunk: { type, index: 0, text } })
    const text = full(['assistant/attempt', { stream: [raw('reasoning-delta', 'reason'), raw('text-delta', 'prefix'), { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } } }] }])
    expect(text).toContain('reason')
    expect(text).toContain('prefix')
    expect(full(['assistant/attempt', { stream: [raw('text-delta', 'only text')] }])).toContain('assistant attempt\n\nonly text')
    expect(full(['assistant/attempt', { stream: [raw('reasoning-delta', 'only reasoning')] }])).toContain('summary>Thinking')
    for (const data of [null, {}, { stream: [] }, { stream: [{ type: 'chunk', time: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }] }]) expect(full(['assistant/attempt', data])).not.toContain('assistant attempt')
  })
})

it('generates the immutable default filename safely from a session id', () => {
  expect(remoteExportFileName('sess-12345678', exportedAt)).toBe('mayfly-export-sess-123-20260821-071530.md')
  expect(remoteExportFileName('../bad/name', exportedAt)).not.toContain('/')
})
