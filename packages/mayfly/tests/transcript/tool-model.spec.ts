import { describe, expect, it } from 'vitest'
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import type { MayflySemanticColors } from '../../src/core/index.ts'
import { createToolPresentationModel, toolCallNode, toolResultNode, toolResultChip, ToolModelComponent } from '../../src/transcript/tool-model.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { COLORS } from './status-fakes.ts'

const renderer = { components: fakeMayflyComponents(), colors: COLORS as MayflySemanticColors }

describe('ToolModelComponent', () => {
  it('renders missing nodes and invalidates safely', () => { const empty = new ToolModelComponent(() => ({ kind: 'tool', id: 'empty', name: 'empty' }), renderer); expect(empty.render(10)).toEqual([]); empty.invalidate(); const none = new ToolModelComponent(() => null, renderer); expect(none.render(10)).toEqual([]); none.invalidate() })
  it('falls back to the call node when expanded without a result', () => {
    const component = new ToolModelComponent(() => ({ kind: 'tool', id: 'call-only', name: 'call-only', expanded: true, call: { kind: 'text', content: 'pending call' } }), renderer)
    expect(component.render(20)).toEqual(['pending call'])
  })
  it('bounds both collapsed and expanded presenter output', () => {
    const rows = Array.from({ length: 220 }, (_, index) => `row ${String(index)}`).join('\n')
    const component = new ToolModelComponent(() => ({ kind: 'tool', id: 'bounded', name: 'bounded', call: { kind: 'code', code: rows }, result: { kind: 'code', code: rows } }), renderer)
    const collapsed = component.render(40)
    expect(collapsed).toHaveLength(12)
    expect(collapsed.at(-1)).toContain('ctrl+o to expand')
    component.setExpanded(true)
    const expanded = component.render(40)
    expect(expanded).toHaveLength(200)
    expect(expanded.at(-1)).toContain('more lines')
  })
  it('contains invalid canonical nodes and degenerate viewports', () => {
    const invalid = { kind: 'list', id: 'bad', selectedIds: [], items: [{ id: 'same', label: 'one' }, { id: 'same', label: 'two' }] } as MayflyUiNode
    const component = new ToolModelComponent(() => ({ kind: 'tool', id: 'invalid', name: 'invalid', call: invalid }), { ...renderer, viewportRows: () => Number.NaN })
    expect(component.render(Number.NaN).join('')).toContain('May')
  })
})

describe('canonical tool presentation builder', () => {
  it('maps generic, terminal, and diff call metadata', () => {
    const generic = toolCallNode({ card: 'generic', title: 'Read', rawInput: { path: 'a.ts' }, content: [{ type: 'text', text: 'body' }] })
    expect(generic).toMatchObject({ kind: 'sections', sections: [{ title: 'Read', body: { content: 'body' } }] })
    expect(toolCallNode({ card: 'generic', title: 'Raw', rawInput: { path: 'a.ts' } })).toMatchObject({ sections: [{ body: { content: expect.stringContaining('a.ts') } }] })
    const cyclic: { self?: unknown } = {}; cyclic.self = cyclic
    expect(toolCallNode({ card: 'generic', title: 'Cycle', rawInput: cyclic })).toMatchObject({ sections: [{ body: { content: '[object Object]' } }] })
    expect(toolCallNode({ card: 'generic', title: 'Symbol', rawInput: Symbol('x') })).toMatchObject({ sections: [{ body: { content: 'Symbol(x)' } }] })
    expect(toolCallNode({ card: 'generic', title: 'String', rawInput: 'literal' })).toMatchObject({ sections: [{ body: { content: 'literal' } }] })
    expect(toolCallNode({ card: 'terminal', title: 'pnpm test', description: 'Tests', cwd: '/repo' })).toMatchObject({ kind: 'stack', direction: 'column', gap: 0, children: [
      { node: { kind: 'text', content: 'Tests', tone: 'muted' } },
      { node: { kind: 'sections', sections: [{ title: 'cwd', body: { kind: 'text', content: '/repo' } }, { title: 'Command', body: { kind: 'code', code: 'pnpm test' } }] } },
    ] })
    expect(toolCallNode({ card: 'terminal', title: 'pnpm test', description: 'Tests' })).toMatchObject({ kind: 'stack', children: [
      { node: { kind: 'text', content: 'Tests', tone: 'muted' } },
      { node: { kind: 'sections', sections: [{ title: 'Command', body: { kind: 'code', code: 'pnpm test' } }] } },
    ] })
    expect(toolCallNode({ card: 'terminal', title: 'pwd', cwd: '/repo' })).toMatchObject({ kind: 'sections', sections: [{ title: 'cwd', body: { kind: 'text', content: '/repo' } }, { title: 'Command', body: { kind: 'code' } }] })
    expect(toolCallNode({ card: 'terminal', title: 'pwd' })).toMatchObject({ sections: [{ title: 'Command' }] })
    expect(toolCallNode({ card: 'diff', title: 'Write', diffs: [{ path: 'a.ts', oldText: 'old', newText: 'new' }] })).toMatchObject({ sections: [{ title: 'a.ts · +1 −1', body: { kind: 'diff', before: 'old', after: 'new' } }] })
    expect(toolCallNode({ card: 'diff', title: 'Write', diffs: [] })).toMatchObject({ sections: [{ title: 'Write', body: { content: '(no changes)' } }] })
  })

  it('maps every official result node and generic fallback', () => {
    const content = [{ type: 'text' as const, text: 'text' }, { type: 'reasoning' as const, text: 'reason' }, { type: 'image' as const, attachment: {} as never }, { type: 'tool-call' as const, id: 'c' as never, name: 'read', arguments: '{}' }, { type: 'tool-result' as const, toolCallId: 'c' as never, content: [], isError: false }, { type: 'future' }] as never
    expect(toolResultNode({ card: 'generic', title: 'Done', content }, undefined, 'tool')).toMatchObject({ sections: [{ title: 'Done', body: { content: expect.stringContaining('[future]') } }] })
    expect(toolResultNode({ card: 'generic' }, { content: [{ type: 'text', text: 'raw' }], isError: false }, 'tool')).toMatchObject({ sections: [{ title: 'tool', body: { content: 'raw' } }] })
    expect(toolResultNode({ card: 'terminal', title: 'Shell', output: 'ok', exitCode: 0 }, undefined, 'tool')).toMatchObject({ sections: [{ body: { code: 'ok' } }, { body: { content: 'exit 0' } }] })
    expect(toolResultNode({ card: 'terminal', signal: 'SIGTERM' }, undefined, 'tool')).toMatchObject({ sections: [{ body: { code: '(no output)' } }, { body: { content: 'signal SIGTERM' } }] })
    expect(toolResultNode({ card: 'terminal' }, undefined, 'tool')).toMatchObject({ sections: [{}, { body: { content: 'complete' } }] })
    expect(toolResultNode({ card: 'diff', diffs: [{ path: 'new.ts', oldText: null, newText: 'new' }] }, undefined, 'tool')).toMatchObject({ sections: [{ title: 'new.ts · new file, +1 lines', body: { before: '', after: 'new' } }] })
    expect(toolResultNode({ card: 'search', shape: 'paths', paths: ['a.ts'], truncated: false, total: 1 }, undefined, 'tool')).toMatchObject({ rows: [{ label: 'paths', value: [{ text: '1' }] }] })
    expect(toolResultNode({ card: 'search', shape: 'paths', paths: ['a.ts', 'b.ts'], truncated: true, total: 40 }, undefined, 'tool')).toMatchObject({ rows: [{ label: 'paths', value: [{ text: '2 of 40' }] }] })
    expect(toolResultNode({ card: 'search', shape: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: 2, line: 'hit' }] }], truncated: false, total: 1 }, undefined, 'tool')).toMatchObject({ rows: [{ label: 'files', value: [{ text: '1' }] }, { label: 'matches', value: [{ text: '1' }] }] })
    expect(toolResultNode({ card: 'search', shape: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: 2, line: 'hit' }, { lineNumber: 4, line: 'hit' }] }], truncated: true, total: 250 }, undefined, 'tool')).toMatchObject({ rows: [{}, { label: 'matches', value: [{ text: '2 of 250' }] }] })
    expect(toolResultNode({ card: 'search', shape: 'matches', files: [], truncated: false, total: 0 }, undefined, 'tool')).toMatchObject({ rows: [{ label: 'files', value: [{ text: '0' }] }, { label: 'matches', value: [{ text: '0' }] }] })
    expect(toolResultNode({ card: 'read', path: 'a.ts', offset: 1, lines: [{ number: 1, text: 'const x = 1' }], totalLines: 1, lang: 'ts' }, undefined, 'tool')).toMatchObject({ rows: [{ label: 'path', value: [{ text: 'a.ts' }] }, { label: 'lang', value: [{ text: 'ts' }] }, { label: 'lines', value: [{ text: '1-1' }] }] })
    expect(toolResultNode({ card: 'read', path: 'a.ts', offset: 1, lines: [{ number: 3, text: 'x' }, { number: 9, text: 'y' }], totalLines: 40 }, undefined, 'tool')).toMatchObject({ rows: [{}, { value: [{ text: '3-9 of 40' }] }] })
    expect(toolResultNode({ card: 'read', title: 'Read', path: 'a', offset: 5, lines: [], totalLines: 0 }, undefined, 'tool')).toMatchObject({ rows: [{ label: 'path' }, { label: 'lines', value: [{ text: 'from line 5' }] }] })
    expect(toolResultNode({ card: 'web', kind: 'fetch', url: 'https://example.com', statusCode: 200, truncated: true }, undefined, 'tool')).toMatchObject({ rows: [{ value: [{ text: 'https://example.com' }] }, { value: [{ text: '200' }] }, { value: [{ text: 'yes' }] }] })
    expect(toolResultNode({ card: 'web', kind: 'fetch', url: 'x', statusCode: 204, truncated: false }, undefined, 'tool')).toMatchObject({ rows: [{}, {}, { value: [{ text: 'no' }] }] })
    expect(toolResultNode({ card: 'web', kind: 'search', sources: [{ url: 'u', title: 'Title', snippet: 'Snippet' }, { url: 'v' }], truncated: false }, undefined, 'tool')).toMatchObject({ id: 'tool-web-sources', selectedIds: [], items: [{ label: 'Title', detail: 'Snippet' }, { label: 'v', detail: 'v' }] })
    expect(toolResultNode(undefined, { content: [], isError: false }, 'tool')).toEqual({ kind: 'text', content: '(no output)' })
    expect(toolResultNode(undefined, { content: [{ type: 'text', text: 'failed' }], isError: true }, 'tool')).toEqual({ kind: 'text', content: 'failed', tone: 'danger' })
  })

  it('maps follow-along locations, replacement titles, and web metadata', () => {
    expect(toolCallNode({ card: 'generic', title: 'Edit', locations: [{ path: 'a.ts', line: 3 }, { path: 'b.ts' }] })).toEqual({ kind: 'sections', sections: [
      { title: 'Edit', body: { kind: 'text', content: '' } },
      { title: 'files', body: { kind: 'text', content: 'a.ts:3\nb.ts' } },
    ] })
    expect(toolCallNode({ card: 'generic', title: 'Edit', locations: [] })).toEqual({ kind: 'sections', sections: [{ title: 'Edit', body: { kind: 'text', content: '' } }] })
    expect(toolResultNode({ card: 'search', shape: 'paths', title: 'Glob *.ts', paths: ['a.ts'], truncated: false, total: 1 }, undefined, 'tool')).toEqual({ kind: 'sections', sections: [{ title: 'Glob *.ts', body: { kind: 'fields', rows: [{ label: 'paths', value: [{ text: '1' }] }] } }] })
    expect(toolResultNode({ card: 'search', shape: 'matches', title: '', files: [], truncated: false, total: 0 }, undefined, 'tool')).toEqual({ kind: 'fields', rows: [{ label: 'files', value: [{ text: '0' }] }, { label: 'matches', value: [{ text: '0' }] }] })
    expect(toolResultNode({ card: 'read', path: 'a.ts', offset: 1, lines: [], totalLines: 0, lang: '' }, undefined, 'tool')).toEqual({ kind: 'fields', rows: [{ label: 'path', value: [{ text: 'a.ts' }] }, { label: 'lines', value: [{ text: 'from line 1' }] }] })
    expect(toolResultNode({ card: 'web', kind: 'search', sources: [{ url: 'u', publishedAt: '' }], truncated: false, answer: '' }, undefined, 'tool')).toEqual({ kind: 'list', id: 'tool-web-sources', selectedIds: [], items: [{ id: 'source-0', label: 'u', detail: 'u' }] })
    expect(toolResultNode({ card: 'web', kind: 'search', sources: [{ url: 'u', title: 'T', snippet: 'S', publishedAt: '2024-05-01' }], truncated: false, answer: 'Answer' }, undefined, 'tool')).toEqual({ kind: 'stack', direction: 'column', gap: 0, children: [
      { node: { kind: 'text', content: 'Answer' } },
      { node: { kind: 'list', id: 'tool-web-sources', selectedIds: [], items: [{ id: 'source-0', label: 'T', detail: 'S', badge: '2024-05-01' }] } },
    ] })
  })

  it('preserves terminal card row budgets without language headings', () => {
    const call = toolCallNode({ card: 'terminal', title: 'pnpm test' })
    const result = toolResultNode({ card: 'terminal', title: 'Shell', output: 'ok', exitCode: 0 }, undefined, 'tool')
    const callRows = new ToolModelComponent(() => ({ kind: 'tool', id: 'call', name: 'call', call }), renderer).render(40)
    const resultRows = new ToolModelComponent(() => ({ kind: 'tool', id: 'result', name: 'result', result, expanded: true }), renderer).render(40)
    expect(callRows.join('\n')).not.toContain('shell')
    expect(resultRows.join('\n')).not.toContain('console')
    expect(callRows).toHaveLength(2)
    expect(resultRows).toHaveLength(4)
  })

  it('renders the description as a muted line above the terminal card', () => {
    const call = toolCallNode({ card: 'terminal', title: 'pnpm test', description: 'Runs the suite', cwd: '/repo' })
    const rows = new ToolModelComponent(() => ({ kind: 'tool', id: 'described', name: 'described', call }), renderer).render(40)
    expect(rows).toEqual(['Runs the suite', '\x1b[1mcwd\x1b[22m', '/repo', '\x1b[1mCommand\x1b[22m', 'pnpm test'])
  })

  it('renders follow-along files, compact metadata, and the web answer through the tool component', () => {
    const call = toolCallNode({ card: 'generic', title: 'Read a.ts', rawInput: 'a.ts', locations: [{ path: 'a.ts', line: 10 }] })
    expect(new ToolModelComponent(() => ({ kind: 'tool', id: 'located', name: 'read', call }), renderer).render(40))
      .toEqual(['\x1b[1mRead a.ts\x1b[22m', 'a.ts', '\x1b[1mfiles\x1b[22m', 'a.ts:10'])
    const search = toolResultNode({ card: 'search', shape: 'matches', title: 'Grep foo', files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'foo' }] }], truncated: false, total: 1 }, undefined, 'grep')
    expect(new ToolModelComponent(() => ({ kind: 'tool', id: 'titled-search', name: 'grep', result: search, expanded: true }), renderer).render(40))
      .toEqual(['\x1b[1mGrep foo\x1b[22m', 'files: 1', 'matches: 1'])
    const read = toolResultNode({ card: 'read', path: 'a.ts', offset: 1, lines: [{ number: 1, text: 'x' }], totalLines: 1, lang: 'ts' }, undefined, 'read')
    expect(new ToolModelComponent(() => ({ kind: 'tool', id: 'lang-read', name: 'read', result: read, expanded: true }), renderer).render(40))
      .toEqual(['path: a.ts', 'lang: ts', 'lines: 1-1'])
    const web = toolResultNode({ card: 'web', kind: 'search', answer: 'The answer', sources: [{ url: 'https://x', title: 'X', snippet: 'Snippet', publishedAt: '2024-05-01' }], truncated: false }, undefined, 'web_search')
    expect(new ToolModelComponent(() => ({ kind: 'tool', id: 'answered-web', name: 'web_search', result: web, expanded: true }), renderer).render(60))
      .toEqual(['The answer', '   X [2024-05-01] — Snippet'])
  })

  it('summarizes XML-envelope fallbacks and nested tool-call arguments', () => {
    const envelope = '<path>src/a.ts</path>\n<type>file</type>\n<content>\n1: x\n\n(Showing lines 1-1 of 9. Use offset=2 to continue.)\n</content>'
    expect(toolResultNode(undefined, { content: [{ type: 'text', text: envelope }], isError: false }, 'read')).toEqual({ kind: 'text', content: 'src/a.ts · lines 1-1 of 9' })
    expect(toolResultNode(undefined, { content: [{ type: 'text', text: envelope }], isError: true }, 'read')).toEqual({ kind: 'text', content: 'src/a.ts · lines 1-1 of 9', tone: 'danger' })
    const blocks = [{ type: 'tool-call' as const, id: 'c' as never, name: 'read', arguments: '{"file_path":"a.ts","limit":5}' }, { type: 'text' as const, text: 'tail' }] as never
    expect(toolResultNode({ card: 'generic', title: 'Nested', content: blocks }, undefined, 'tool')).toMatchObject({ sections: [{ title: 'Nested', body: { content: 'read\n  file_path: a.ts\n  limit: 5\ntail' } }] })
  })

  it('creates a deeply frozen model with a structured toggle action', () => {
    const model = createToolPresentationModel({ id: 'c1', name: 'read', call: { card: 'generic', title: 'Read' }, result: { card: 'read', path: 'a', offset: 1, lines: [], totalLines: 0 }, outcome: { content: [], isError: false }, expanded: false })
    expect(model).toMatchObject({ id: 'c1', expanded: false, action: { kind: 'tool.toggle', id: 'c1' } }); expect(Object.isFrozen(model)).toBe(true); expect(Object.isFrozen(model.call)).toBe(true)
    const plain = createToolPresentationModel({ id: 'c2', name: 'unknown' }); expect(plain.call).toEqual({ kind: 'text', content: 'unknown' }); expect(plain.result).toBeUndefined()
  })

  it('derives diff chips through canonical nested nodes', () => {
    expect(toolResultChip(undefined)).toBeUndefined()
    expect(toolResultChip(createToolPresentationModel({ id: 'empty', name: 'empty' }))).toBeUndefined()
    const read = createToolPresentationModel({ id: 'r', name: 'read', call: { card: 'generic', title: 'Read' }, result: { card: 'read', path: 'a', offset: 1, lines: [{ number: 1, text: 'x' }], totalLines: 1 } })
    expect(toolResultChip(read)).toBeUndefined()
    const write = createToolPresentationModel({ id: 'w', name: 'write', result: { card: 'diff', title: 'Write', diffs: [{ path: 'a.ts', oldText: 'one\nx\nthree', newText: 'one\ny\nz\nthree' }] } })
    expect(toolResultChip(write)).toBe('+2 −1')
    const nested: ToolPresentationModel = { kind: 'tool', id: 'nested', name: 'nested', result: {
      kind: 'surface',
      child: { kind: 'stack', direction: 'column', children: [
        { node: { kind: 'scroll', child: { kind: 'diff', before: '', after: 'one' } } },
        { node: { kind: 'list', id: 'nested-list', selectedIds: [], items: [], empty: { kind: 'diff', before: 'old', after: '' } } },
        { node: { kind: 'empty', title: 'empty', actions: { kind: 'actions', id: 'nested-actions', items: [] } } },
      ] },
      footer: { kind: 'diff', before: 'same', after: 'changed' },
    } }
    expect(toolResultChip(nested)).toBe('+2 −2')
  })
})
