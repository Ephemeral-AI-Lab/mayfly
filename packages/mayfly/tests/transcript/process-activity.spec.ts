/** Upstream-parity process activity, live detail, summaries, and titles.
 * @module @ephemeral-ai/mayfly/tests/transcript/process-activity
 */
import { describe, expect, it } from 'vitest'
import { interpolateLocaleMessage, type MayflyTranslate } from '../../src/frontend/locale.ts'
import {
  LIVE_DETAIL_MAX_CHARS,
  normalizeDetail,
  processTitle,
  reasoningDetail,
  SHARED_DONE_PREFIX_KEY,
  summarizeProcess,
  toolActivity,
  toolDetail,
  type ProcessMemberFact,
} from '../../src/transcript/process-activity.ts'
import { TRANSCRIPT_LOCALE } from '../../src/transcript/locale.ts'

const zh: MayflyTranslate = (key, values) => interpolateLocaleMessage(TRANSCRIPT_LOCALE.zh[key] ?? key, values)
const member = (activity: ProcessMemberFact['activity'], overrides: Partial<ProcessMemberFact> = {}): ProcessMemberFact => ({ activity, running: false, detail: activity, ...overrides })

describe('process activity', () => {
  it('classifies by the upstream name table, then by presenter vocabulary', () => {
    expect(['read', 'read_image', 'grep', 'glob', 'cordis_inspect', 'write', 'edit', 'apply_patch', 'bash', 'pwsh', 'terminal_x', 'run_code', 'web_search', 'web_fetch', 'subagent', 'subagent_fork', 'todo_write', 'get_goal', 'ask_user_question', 'request_user_input', 'mystery'].map(name => toolActivity(name)))
      .toEqual(['read', 'readImage', 'search', 'search', 'search', 'write', 'edit', 'edit', 'commands', 'commands', 'commands', 'code', 'webSearch', 'webFetch', 'subagents', 'subagents', 'plan', 'plan', 'questions', 'questions', 'tools'])
    expect(toolActivity('mcp_shell', { card: 'terminal', title: 'ls' })).toBe('commands')
    expect(toolActivity('str_replace_editor', { card: 'diff', title: 'x', diffs: [] })).toBe('edit')
    expect(toolActivity('reader', undefined, { card: 'read', path: 'a', offset: 1, lines: [], totalLines: 0 })).toBe('read')
    expect(toolActivity('finder', undefined, { card: 'search', shape: 'paths', paths: [], truncated: false, total: 0 })).toBe('search')
    expect(toolActivity('browse', undefined, { card: 'web', kind: 'search', sources: [], truncated: false })).toBe('webSearch')
    expect(toolActivity('browse', undefined, { card: 'web', kind: 'fetch', url: 'u', statusCode: 200, truncated: false })).toBe('webFetch')
  })

  it('extracts bounded live details in the upstream key order', () => {
    expect(toolDetail('bash', { command: '  pnpm   test ', description: 'Run tests' })).toBe('Run tests')
    expect(toolDetail('web_search', { queries: ['a', 'b'] })).toBe('a, b')
    expect(toolDetail('ask', { questions: [null, { question: '' }, { question: 'Which?' }] })).toBe('Which?')
    expect(toolDetail('ask', { questions: 'bad' })).toBe('ask')
    expect(toolDetail('ask', { questions: [{ question: '  ' }] })).toBe('ask')
    expect(toolDetail('grep', { pattern: 'x', path: 'src' })).toBe('x')
    expect(toolDetail('tool', { other: 1 })).toBe('tool')
    expect(toolDetail('tool', undefined)).toBe('tool')
    expect(normalizeDetail(42)).toBe('')
    expect(normalizeDetail(['a', 1])).toBe('')
    const long = normalizeDetail('界'.repeat(LIVE_DETAIL_MAX_CHARS + 10))
    expect(Array.from(long)).toHaveLength(LIVE_DETAIL_MAX_CHARS)
    expect(long.endsWith('…')).toBe(true)
    expect(reasoningDetail('first\n\n**second** idea\n\n  ')).toBe('second idea')
    expect(reasoningDetail(' \n\n ')).toBe('')
  })

  it('ranks categories by count with first-seen ties and picks the latest running member', () => {
    const summary = summarizeProcess([
      member('read'), member('search'), member('search'), member('read', { failed: true }),
      member('commands', { running: true, detail: 'pnpm test' }), member('edit', { running: true, preparing: true }),
    ])
    expect(summary.counts).toEqual([{ activity: 'read', count: 2 }, { activity: 'search', count: 2 }, { activity: 'commands', count: 1 }, { activity: 'edit', count: 1 }])
    expect(summary).toMatchObject({ failed: 1, running: 'edit', runningDetail: '', preparing: true })
    expect(summarizeProcess([member('commands', { running: true, detail: 'ls' })])).toMatchObject({ running: 'commands', runningDetail: 'ls', preparing: false })
    expect(summarizeProcess([], 'plan the fix')).toMatchObject({ running: undefined, runningDetail: 'plan the fix' })
  })

  it('titles running and closed groups in English and Chinese', () => {
    const t = interpolateLocaleMessage
    const running = summarizeProcess([member('commands', { running: true, detail: 'pnpm test' })])
    expect(processTitle(running, false, true, t)).toBe('Running commands · pnpm test')
    expect(processTitle(running, false, false, t)).toBe('Running commands')
    expect(processTitle(summarizeProcess([member('edit', { running: true, preparing: true })]), false, true, t)).toBe('Preparing to edit files')
    // A running spawn names delegation only: the agents pane owns its task label,
    // and the latest reasoning does not stand in for it.
    const spawning = summarizeProcess([member('subagents', { running: true, detail: 'Summarize repo structure' })], 'plan the fix')
    expect(spawning).toMatchObject({ running: 'subagents', runningDetail: '' })
    expect(processTitle(spawning, false, true, t)).toBe('Coordinating subagents')
    expect(processTitle(spawning, false, true, zh)).toBe('正在协调子智能体')
    expect(processTitle(summarizeProcess([], ''), false, true, t)).toBe('Analyzing the request')
    expect(processTitle(summarizeProcess([]), true, true, t)).toBe('Analysis completed')
    expect(processTitle(summarizeProcess([member('read')]), true, true, t)).toBe('Read files')
    expect(processTitle(summarizeProcess([member('read'), member('search')]), true, true, t)).toBe('Read files and searched code')
    expect(processTitle(summarizeProcess([member('read'), member('search'), member('commands')]), true, true, t)).toBe('Read files, searched code, ran commands')
    expect(processTitle(summarizeProcess([member('read'), member('search'), member('commands'), member('edit')]), true, true, t)).toBe('Read files, searched code, ran commands, etc.')
    // Chinese joins drop the repeated done prefix `已`.
    expect(processTitle(summarizeProcess([member('read'), member('search')]), true, true, zh)).toBe('已读取文件并搜索代码')
    expect(processTitle(summarizeProcess([member('read'), member('edit')]), true, true, zh)).toBe('已读取文件并修改了文件')
    expect(processTitle(summarizeProcess([member('read'), member('search'), member('commands'), member('edit')]), true, true, zh)).toBe('已读取文件，已搜索代码，执行了命令等')
    expect(TRANSCRIPT_LOCALE.en[SHARED_DONE_PREFIX_KEY]).toBe('')
  })
})
