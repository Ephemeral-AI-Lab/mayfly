/** One-row tool presentation: delegation, plan, questions, web, messaging, and preparation.
 * @module @ephemeral-ai/mayfly/tests/transcript/tool-line
 */
import { describe, expect, it } from 'vitest'
import type { MayflySemanticColors } from '../../src/core/index.ts'
import type { TranscriptToolModel } from '../../src/frontend/models.ts'
import { interpolateLocaleMessage } from '../../src/frontend/locale.ts'
import { TRANSCRIPT_LOCALE } from '../../src/transcript/locale.ts'
import { isLineTool, prettyJson, toolDisplayName, ToolLineComponent, TOOL_LINE_EXPANDED_ROWS } from '../../src/transcript/tool-line.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { COLORS } from './status-fakes.ts'

const colors = COLORS as MayflySemanticColors
const ok = (text: string) => ({ text, fullText: text, isError: false, endedAt: 2 })
const failed = (text: string) => ({ text, fullText: text, isError: true, endedAt: 2 })

function entry(overrides: Partial<TranscriptToolModel>): TranscriptToolModel {
  return {
    kind: 'transcript-tool', id: 't', seq: 1, updatedSeq: 1, turn: 1, step: 0, callId: 'c', name: 'tool', family: 'other',
    activity: 'tools', detail: 'tool', arguments: '{}', startedAt: 0, ...overrides,
  }
}

const row = (value: TranscriptToolModel, width = 120): string => new ToolLineComponent(value, colors, fakeMayflyComponents()).render(width)[1]!

describe('tool line helpers', () => {
  it('selects one-row tools, formats MCP names, and pretty-prints JSON', () => {
    expect(isLineTool(entry({ preparing: { characters: 1 } }))).toBe(true)
    expect(isLineTool(entry({ activity: 'subagents' }))).toBe(true)
    expect(isLineTool(entry({ name: 'skill' }))).toBe(true)
    expect(isLineTool(entry({ activity: 'commands', name: 'bash' }))).toBe(false)
    expect(toolDisplayName('mcp__github__create_issue')).toBe('github › create_issue')
    expect(toolDisplayName('mcp__bad')).toBe('mcp__bad')
    expect(prettyJson('{"a":1}')).toBe('{\n  "a": 1\n}')
    expect(prettyJson('[1]')).toBe('[\n  1\n]')
    expect(prettyJson('{broken')).toBe('{broken')
    expect(prettyJson('plain')).toBe('plain')
  })
})

describe('ToolLineComponent', () => {
  it('renders delegation rows through their states', () => {
    const agent = entry({ name: 'subagent', activity: 'subagents', arguments: JSON.stringify({ name: 'reviewer', description: 'Review the change' }) })
    expect(row(agent)).toBe('● \x1b[1mreviewer\x1b[22m · Review the change · running')
    expect(row({ ...agent, result: ok('Looks good\nmore') })).toBe('✓ \x1b[1mreviewer\x1b[22m · Review the change · Looks good')
    expect(row({ ...agent, result: failed('boom') })).toBe('✗ \x1b[1mreviewer\x1b[22m · Review the change · boom')
    const cancelled = new ToolLineComponent(agent, colors, fakeMayflyComponents())
    cancelled.setScope({ hint: true, turnClosed: true })
    expect(cancelled.render(120)[1]).toBe('⊘ \x1b[1mreviewer\x1b[22m · Review the change · cancelled')
  })

  it('renders plan, goal, and skill rows without echoing their payloads', () => {
    const todos = JSON.stringify({ todos: [{ content: 'Read', status: 'completed' }, { content: 'Fix retry', status: 'in_progress' }, { content: 'Test', status: 'pending' }] })
    expect(row(entry({ name: 'todo_write', activity: 'plan', arguments: todos, result: ok('ok') }))).toBe('✓ \x1b[1mUpdated the plan\x1b[22m · 1/3 done · ● Fix retry')
    expect(row(entry({ name: 'todo_write', activity: 'plan', arguments: JSON.stringify({ todos: [{ content: 'A', status: 'completed' }] }), result: ok('ok') }))).toBe('✓ \x1b[1mUpdated the plan\x1b[22m · 1/1 done')
    expect(row(entry({ name: 'todo_write', activity: 'plan', arguments: '{"todos":[]}', result: failed('bad list') }))).toBe('✗ \x1b[1mUpdated the plan\x1b[22m · bad list')
    expect(row(entry({ name: 'todo_write', activity: 'plan', arguments: '[1]', result: ok('ok') }))).toBe('✓ \x1b[1mUpdated the plan\x1b[22m')
    expect(row(entry({ name: 'todo_write', activity: 'plan', arguments: 'null', result: ok('ok') }))).toBe('✓ \x1b[1mUpdated the plan\x1b[22m')
    expect(row(entry({ name: 'create_goal', activity: 'plan', title: 'Create goal', detail: 'Ship it', result: ok('{"id":"g1"}') }))).toBe('✓ \x1b[1mCreate goal\x1b[22m · Ship it')
    expect(row(entry({ name: 'get_goal', activity: 'plan', detail: 'get_goal', result: failed('no goal') }))).toBe('✗ \x1b[1mget_goal\x1b[22m · no goal')
    expect(row(entry({ name: 'skill', title: 'Load skill notes', detail: 'notes', result: ok('<skill>body</skill>') }))).toBe('✓ \x1b[1mLoad skill notes\x1b[22m')
    expect(row(entry({ name: 'skill', detail: 'x', result: failed('missing skill') }))).toBe('✗ \x1b[1mskill\x1b[22m · missing skill')
  })

  it('renders questions with their answers', () => {
    const ask = entry({ name: 'ask_user_question', activity: 'questions', detail: 'Also fix signup?' })
    expect(row(ask)).toBe('● \x1b[1mAlso fix signup?\x1b[22m · waiting for your answer')
    expect(row({ ...ask, result: ok('{"answers":[{"question":"Also fix signup?","answer":"No"}]}') })).toBe('✓ \x1b[1mAlso fix signup?\x1b[22m → No')
    expect(row({ ...ask, result: ok('{"answers":[{"answer":["A","B"]},{"answer":3}]}') })).toBe('✓ \x1b[1mAlso fix signup?\x1b[22m → A, B')
    expect(row({ ...ask, result: ok('{"answers":"none"}') })).toBe('✓ \x1b[1mAlso fix signup?\x1b[22m · {"answers":"none"}')
    expect(row({ ...ask, result: ok('not json') })).toBe('✓ \x1b[1mAlso fix signup?\x1b[22m · not json')
    // Results built without a full text fall back to the summary text.
    expect(row({ ...ask, result: { text: '{"answers":[null,{"answer":"Yes"}]}', isError: false, endedAt: 2 } })).toBe('✓ \x1b[1mAlso fix signup?\x1b[22m → Yes')
    const plain = new ToolLineComponent(entry({ name: 'workflow', title: 'workflow: w', detail: 'workflow', result: { text: 'summary only', isError: false, endedAt: 2 } }), colors, fakeMayflyComponents())
    plain.setExpanded(true)
    expect(plain.render(80)).toEqual(['', '✓ \x1b[1mworkflow: w\x1b[22m · summary only', '  summary only'])
    expect(row({ ...ask, result: failed('dismissed') })).toBe('✗ \x1b[1mAlso fix signup?\x1b[22m · dismissed')
  })

  it('renders web search and fetch rows, and expands a search into its sources', () => {
    const search = entry({ name: 'web_search', activity: 'webSearch', detail: 'vitest vi.fn' })
    expect(row(search)).toBe('● \x1b[1mSearching the web\x1b[22m · vitest vi.fn')
    expect(row({ ...search, result: failed('quota') })).toBe('✗ \x1b[1mSearched the web\x1b[22m · vitest vi.fn · quota')
    const found = { ...search, result: ok('1. docs'), web: { kind: 'search' as const, sources: [{ url: 'https://a', title: 'A' }, { url: 'https://b' }], truncated: true } }
    expect(row(found)).toBe('✓ \x1b[1mSearched the web\x1b[22m · vitest vi.fn · 2 sources · truncated')
    expect(row({ ...found, web: { kind: 'search', sources: [{ url: 'https://a' }], truncated: false } })).toBe('✓ \x1b[1mSearched the web\x1b[22m · vitest vi.fn · 1 source')
    const expanded = new ToolLineComponent(found, colors, fakeMayflyComponents())
    expanded.setExpanded(true)
    expect(expanded.render(120).slice(2)).toEqual(['  ├─ A — https://a', '  └─ https://b'])
    const fetch = entry({ name: 'web_fetch', activity: 'webFetch', detail: 'https://x' })
    expect(row(fetch)).toBe('● \x1b[1mFetching\x1b[22m · https://x')
    expect(row({ ...fetch, result: failed('404') })).toBe('✗ \x1b[1mFetched\x1b[22m · https://x · 404')
    expect(row({ ...fetch, result: ok('# body'), web: { kind: 'fetch', url: 'https://x/final', statusCode: 200, truncated: false } })).toBe('✓ \x1b[1mFetched\x1b[22m · https://x/final · 200')
    expect(row({ ...fetch, result: ok('# body'), web: { kind: 'fetch', url: 'https://x', statusCode: 206, truncated: true } })).toBe('✓ \x1b[1mFetched\x1b[22m · https://x · 206 · truncated')
  })

  it('renders messaging and generic rows, preparation, and a bounded expanded body', () => {
    expect(row(entry({ name: 'send_message', arguments: JSON.stringify({ to: 'reviewer', message: 'Please re-check' }), result: ok('delivered') }))).toBe('✓ \x1b[1mMessage to reviewer\x1b[22m · Please re-check · delivered')
    expect(row(entry({ name: 'send_message', arguments: JSON.stringify({ agent: 'a1' }), result: ok('ok') }))).toBe('✓ \x1b[1mMessage to a1\x1b[22m · ok')
    expect(row(entry({ name: 'send_message', detail: 'hello', arguments: '{}', result: ok('ok') }))).toBe('✓ \x1b[1msend_message\x1b[22m · hello · ok')
    expect(row(entry({ name: 'workflow', title: 'workflow: audit', detail: 'workflow', result: ok('\n  done: 6 agents') }))).toBe('✓ \x1b[1mworkflow: audit\x1b[22m · done: 6 agents')
    expect(row(entry({ name: 'interrupt_agent', title: 'Interrupt reviewer', detail: 'reviewer', result: ok('') }))).toBe('✓ \x1b[1mInterrupt reviewer\x1b[22m')
    expect(new ToolLineComponent(entry({ name: 'write', activity: 'write', preparing: { characters: 18_342 } }), colors, fakeMayflyComponents()).render(80)).toEqual(['', '⋯ Preparing write · 17.9k chars'])
    const long = Array.from({ length: TOOL_LINE_EXPANDED_ROWS + 3 }, (_, index) => `row ${String(index)}`).join('\n')
    const body = new ToolLineComponent(entry({ name: 'workflow', title: 'workflow: audit', result: ok(long) }), colors, fakeMayflyComponents())
    body.setExpanded(true)
    const rows = body.render(80)
    expect(rows).toHaveLength(2 + TOOL_LINE_EXPANDED_ROWS + 1)
    expect(rows.at(-1)).toBe('  ... (3 more lines, 15 total)')
    expect(body.render(80)).toBe(rows)
    body.invalidate()
    body.update(entry({ name: 'workflow', title: 'workflow: audit', result: failed('{"error":"x"}') }))
    expect(body.render(80).slice(2)).toEqual(['  {', '    "error": "x"', '  }'])
    body.update(entry({ name: 'workflow', title: 'workflow: audit', result: ok('  \n') }))
    expect(body.render(80)).toHaveLength(2)
    const pending = new ToolLineComponent(entry({ name: 'workflow', title: 'workflow: audit' }), colors, fakeMayflyComponents())
    pending.setExpanded(true)
    expect(pending.render(80)).toHaveLength(2)
  })

  it('localizes its copy', () => {
    const t = (key: string, values?: Record<string, string | number>) => interpolateLocaleMessage(TRANSCRIPT_LOCALE.zh[key] ?? key, values)
    const line = new ToolLineComponent(entry({ name: 'web_search', activity: 'webSearch', detail: 'q', result: ok('x'), web: { kind: 'search', sources: [], truncated: false } }), colors, fakeMayflyComponents(), t)
    expect(line.render(80)[1]).toBe('✓ \x1b[1m已搜索网页\x1b[22m · q · 0 个来源')
  })
})
