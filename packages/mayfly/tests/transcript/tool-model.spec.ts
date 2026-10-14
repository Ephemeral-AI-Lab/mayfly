import { describe, expect, it } from 'vitest'
import { createToolPresentationModel, toolCallNode, toolResultNode } from '../../src/transcript/tool-model.ts'

describe('canonical tool presentation builder', () => {
  it('maps generic, terminal, and diff call metadata', () => {
    const generic = toolCallNode({ card: 'generic', title: 'Read', rawInput: { path: 'a.ts' }, content: [{ type: 'text', text: 'body' }] })
    expect(generic).toEqual({ kind: 'text', content: 'body' })
    expect(toolCallNode({ card: 'generic', title: 'Raw', rawInput: { path: 'a.ts' } })).toMatchObject({ kind: 'text', content: expect.stringContaining('a.ts') })
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic
    expect(toolCallNode({ card: 'generic', title: 'Cycle', rawInput: cyclic })).toMatchObject({ content: '[object Object]' })
    expect(toolCallNode({ card: 'generic', title: 'Symbol', rawInput: Symbol('x') })).toMatchObject({ content: 'Symbol(x)' })
    expect(toolCallNode({ card: 'generic', title: 'String', rawInput: 'literal' })).toMatchObject({ content: 'literal' })
    // The header already shows the title: a call that only repeats it yields no node.
    expect(toolCallNode({ card: 'generic', title: 'Fetch https://x', rawInput: 'https://x' })).toBeUndefined()
    expect(toolCallNode({ card: 'generic', title: 'List jobs' })).toBeUndefined()
    expect(toolCallNode({ card: 'generic', title: 'Blank', rawInput: '  ' })).toBeUndefined()
    expect(toolCallNode({ card: 'terminal', title: 'pnpm test', description: 'Tests', cwd: '/repo' })).toMatchObject({ kind: 'sections', sections: [{ title: 'Tests' }, { title: 'Command', body: { kind: 'code' } }] })
    expect((toolCallNode({ card: 'terminal', title: 'pnpm test', description: 'Tests' }) as { sections: readonly unknown[] }).sections[0]).toMatchObject({ title: 'Tests', body: { content: '' } })
    expect((toolCallNode({ card: 'terminal', title: 'pwd', cwd: '/repo' }) as { sections: readonly unknown[] }).sections[0]).toMatchObject({ title: 'cwd', body: { content: '/repo' } })
    expect(toolCallNode({ card: 'terminal', title: 'pwd' })).toMatchObject({ sections: [{ title: 'Command' }] })
    expect(toolCallNode({ card: 'diff', title: 'Write', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] })).toMatchObject({ sections: [{ title: 'a.ts · +1 −1', body: { kind: 'diff', before: 'old', after: 'new' } }] })
    expect(toolCallNode({ card: 'diff', title: 'Write', diffs: [] })).toMatchObject({ sections: [{ title: 'Write', body: { content: '(no changes)' } }] })
  })

  it('maps every official result node and generic fallback', () => {
    const content = [{ type: 'text' as const, text: 'text' }, { type: 'reasoning' as const, text: 'reason' }, { type: 'image' as const, attachment: {} as never }, { type: 'tool-call' as const, id: 'c' as never, name: 'read', arguments: '{}' }, { type: 'future' }] as never
    expect(toolResultNode({ card: 'generic', title: 'Done', content }, undefined, 'tool')).toMatchObject({ kind: 'text', content: expect.stringContaining('[future]') })
    expect(toolResultNode({ card: 'generic' }, { content: [{ type: 'text', text: 'raw' }], isError: false }, 'tool')).toEqual({ kind: 'text', content: 'raw' })
    expect(toolResultNode({ card: 'terminal', title: 'Shell', output: 'ok', exitCode: 0 }, undefined, 'tool')).toMatchObject({ sections: [{ body: { code: 'ok' } }, { body: { content: 'exit 0' } }] })
    expect(toolResultNode({ card: 'terminal', signal: 'SIGTERM' }, undefined, 'tool')).toMatchObject({ sections: [{ body: { code: '(no output)' } }, { body: { content: 'signal SIGTERM' } }] })
    expect(toolResultNode({ card: 'terminal' }, undefined, 'tool')).toMatchObject({ sections: [{}, { body: { content: 'complete' } }] })
    expect(toolResultNode({ card: 'diff', diffs: [{ path: 'new.ts', oldText: null, newText: 'new' }] }, undefined, 'tool')).toMatchObject({ sections: [{ title: 'new.ts · new file, +1 lines', body: { before: '', after: 'new' } }] })
    expect(toolResultNode({ card: 'search', shape: 'paths', paths: ['a.ts'], truncated: false, total: 1 }, undefined, 'tool')).toMatchObject({ rows: [{ label: 'paths', value: [{ text: '1' }] }] })
    expect(toolResultNode({ card: 'search', shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: true, total: 40 }, undefined, 'tool')).toMatchObject({ rows: [{ label: 'paths', value: [{ text: '2 of 40' }] }] })
    expect(toolResultNode({ card: 'search', shape: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: 2, line: 'hit' }] }], truncated: false, total: 1 }, undefined, 'tool')).toMatchObject({ rows: [{ label: 'files', value: [{ text: '1' }] }, { label: 'matches', value: [{ text: '1' }] }] })
    expect(toolResultNode({ card: 'search', shape: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: 2, line: 'hit' }, { lineNumber: 4, line: 'hit' }] }], truncated: true, total: 250 }, undefined, 'tool')).toMatchObject({ rows: [{}, { label: 'matches', value: [{ text: '2 of 250' }] }] })
    expect(toolResultNode({ card: 'search', shape: 'matches', files: [], truncated: false, total: 0 }, undefined, 'tool')).toMatchObject({ rows: [{ label: 'files', value: [{ text: '0' }] }, { label: 'matches', value: [{ text: '0' }] }] })
    expect(toolResultNode({ card: 'read', path: 'a.ts', offset: 1, lines: [{ number: 1, text: 'const x = 1' }], totalLines: 1, lang: 'ts' }, undefined, 'tool')).toMatchObject({ rows: [{ label: 'path', value: [{ text: 'a.ts' }] }, { label: 'lines', value: [{ text: '1-1' }] }] })
    expect(toolResultNode({ card: 'read', path: 'a.ts', offset: 1, lines: [{ number: 3, text: 'x' }, { number: 9, text: 'y' }], totalLines: 40 }, undefined, 'tool')).toMatchObject({ rows: [{}, { value: [{ text: '3-9 of 40' }] }] })
    expect(toolResultNode({ card: 'read', title: 'Read', path: 'a', offset: 5, lines: [], totalLines: 0 }, undefined, 'tool')).toMatchObject({ rows: [{ label: 'path' }, { label: 'lines', value: [{ text: 'from line 5' }] }] })
    expect(toolResultNode({ card: 'web', kind: 'fetch', url: 'https://example.com', statusCode: 200, truncated: true }, undefined, 'tool')).toMatchObject({ rows: [{ value: [{ text: 'https://example.com' }] }, { value: [{ text: '200' }] }, { value: [{ text: 'yes' }] }] })
    expect(toolResultNode({ card: 'web', kind: 'fetch', url: 'x', statusCode: 204, truncated: false }, undefined, 'tool')).toMatchObject({ rows: [{}, {}, { value: [{ text: 'no' }] }] })
    expect(toolResultNode({ card: 'web', kind: 'search', sources: [{ url: 'u', title: 'Title', snippet: 'Snippet' }, { url: 'v' }], truncated: false }, undefined, 'tool')).toMatchObject({ id: 'tool-web-sources', selectedIds: [], items: [{ label: 'Title', detail: 'Snippet' }, { label: 'v', detail: 'v' }] })
    expect(toolResultNode(undefined, { content: [], isError: false }, 'tool')).toEqual({ kind: 'text', content: '(no output)' })
    expect(toolResultNode(undefined, { content: [{ type: 'text', text: 'failed' }], isError: true }, 'tool')).toEqual({ kind: 'text', content: 'failed', tone: 'danger' })
  })

  it('summarizes XML-envelope fallbacks and nested tool-call arguments', () => {
    const envelope = '<path>src/a.ts</path>\n<type>file</type>\n<content>\n1: x\n\n(Showing lines 1-1 of 9. Use offset=2 to continue.)\n</content>'
    expect(toolResultNode(undefined, { content: [{ type: 'text', text: envelope }], isError: false }, 'read')).toEqual({ kind: 'text', content: 'src/a.ts · lines 1-1 of 9' })
    expect(toolResultNode(undefined, { content: [{ type: 'text', text: envelope }], isError: true }, 'read')).toEqual({ kind: 'text', content: 'src/a.ts · lines 1-1 of 9', tone: 'danger' })
    const blocks = [{ type: 'tool-call' as const, id: 'c' as never, name: 'read', arguments: '{"file_path":"a.ts","limit":5}' }, { type: 'text' as const, text: 'tail' }] as never
    expect(toolResultNode({ card: 'generic', title: 'Nested', content: blocks }, undefined, 'tool')).toEqual({ kind: 'text', content: 'read\n  file_path: a.ts\n  limit: 5\ntail' })
  })

  it('creates a deeply frozen model with a structured toggle action', () => {
    const model = createToolPresentationModel({ id: 'c1', name: 'read', call: { card: 'generic', title: 'Read' }, result: { card: 'read', path: 'a', offset: 1, lines: [], totalLines: 0 }, outcome: { content: [], isError: false }, expanded: false })
    expect(model).toMatchObject({ id: 'c1', expanded: false, action: { kind: 'tool.toggle', id: 'c1' } }); expect(Object.isFrozen(model)).toBe(true); expect(Object.isFrozen(model.call)).toBe(true)
    const plain = createToolPresentationModel({ id: 'c2', name: 'unknown' }); expect(plain.call).toBeUndefined(); expect(plain.result).toBeUndefined()
  })
})
