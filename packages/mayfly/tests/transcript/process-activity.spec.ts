/** Upstream-parity process activity, settled summaries, past-tense titles, and live labels.
 * @module @ephemeral-ai/mayfly/tests/transcript/process-activity
 */
import { describe, expect, it } from 'vitest'
import { interpolateLocaleMessage, type MayflyTranslate } from '../../src/frontend/locale.ts'
import { diffStat, elapsedText, summarizeProcess, toolActivity, type ProcessMemberFact } from '../../src/transcript/process-activity.ts'
import { flightLabel, kindOf, unitPhrase } from '../../src/transcript/tool-kinds.ts'
import { ACTIVITY_LOCALE, TRANSCRIPT_LOCALE } from '../../src/transcript/locale.ts'

const zh: MayflyTranslate = (key, values) => interpolateLocaleMessage(TRANSCRIPT_LOCALE.zh[key] ?? key, values)
const member = (activity: ProcessMemberFact['activity'], overrides: Partial<ProcessMemberFact> = {}): ProcessMemberFact => ({ activity, running: false, ...overrides })

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

  it('ranks settled categories by count with first-seen ties', () => {
    const summary = summarizeProcess([
      member('read'), member('search'), member('search'), member('read', { failed: true }), member('commands'),
    ])
    expect(summary).toEqual({
      counts: [{ activity: 'read', count: 2 }, { activity: 'search', count: 2 }, { activity: 'commands', count: 1 }],
      failed: 1,
    })
  })

  it('phrases what a group of settled calls counts, singular and plural, in English and Chinese', () => {
    const t = interpolateLocaleMessage
    expect(unitPhrase('read', 1, t)).toBe('1 file')
    expect(unitPhrase('read', 2, t)).toBe('2 files')
    expect(unitPhrase('search', 1, t)).toBe('1 search')
    expect(unitPhrase('search', 2, t)).toBe('2 searches')
    expect(unitPhrase('commands', 1, t)).toBe('1 call')
    expect(unitPhrase('commands', 3, t)).toBe('3 calls')
    expect(unitPhrase('subagents', 1, t)).toBe('1 subagent')
    expect(unitPhrase('read', 2, zh)).toBe('2 个文件')
    expect(unitPhrase('search', 2, zh)).toBe('2 次搜索')
    expect(TRANSCRIPT_LOCALE.zh['{count} tool calls']).toBe('{count} 次工具调用')
  })

  it('sums a settled group\'s wall time and file-change lines for the compact title', () => {
    // The wall time runs from the first member's start to the last member's end.
    expect(summarizeProcess([
      member('read', { startedAt: 0, endedAt: 2_000 }), member('read', { startedAt: 1_000, endedAt: 3_000 }), member('commands', { startedAt: 0, endedAt: 6_000 }),
    ])).toEqual({ counts: [{ activity: 'read', count: 2 }, { activity: 'commands', count: 1 }], failed: 0, durationMs: 6_000 })
    // Lines a file change added and removed are summed, and a group with none has none.
    expect(summarizeProcess([member('edit', { added: 4, removed: 2 }), member('write', { added: 9 }), member('read')])).toMatchObject({ added: 13, removed: 2 })
    expect(summarizeProcess([member('read')])).not.toHaveProperty('added')
    expect(diffStat(4, 2)).toBe('+4 −2')
    expect(diffStat(0, 0)).toBe('+0 −0')
  })

  it('reports a group wall time only when it is long enough to read', () => {
    expect(elapsedText(0)).toBeUndefined()
    expect(elapsedText(99)).toBeUndefined()
    expect(elapsedText(100)).toBe('0.1s')
    expect(elapsedText(4_200)).toBe('4.2s')
    expect(elapsedText(9_960)).toBe('10s')
    expect(elapsedText(3_000)).toBe('3s')
    expect(elapsedText(65_000)).toBe('1m 5s')
  })

  it('names running and preparing categories for the activity row, one category by name and several by count', () => {
    expect(kindOf('commands').running).toBe('Running commands')
    expect(kindOf('subagents').running).toBe('Coordinating subagents')
    expect(kindOf('edit').preparing).toBe('Preparing to edit files')
    expect(flightLabel([{ activity: 'commands', preparing: false }, { activity: 'commands', preparing: false }])).toEqual({ key: 'Running commands' })
    expect(flightLabel([{ activity: 'edit', preparing: true }])).toEqual({ key: 'Preparing to edit files' })
    expect(flightLabel([{ activity: 'read', preparing: false }, { activity: 'commands', preparing: false }])).toEqual({ key: 'Running {count} tools', values: { count: 2 } })
    expect(flightLabel([{ activity: 'read', preparing: true }, { activity: 'edit', preparing: true }])).toEqual({ key: 'Preparing {count} tool calls', values: { count: 2 } })
    expect(ACTIVITY_LOCALE.zh[kindOf('commands').running]).toBe('正在运行命令')
    expect(ACTIVITY_LOCALE.zh[kindOf('write').preparing]).toBe('准备写入文件')
    // The retired reasoning-group titles are gone from both catalogs.
    expect(TRANSCRIPT_LOCALE.zh['Analyzing the request']).toBeUndefined()
    expect(TRANSCRIPT_LOCALE.zh['Analysis completed']).toBeUndefined()
  })
})
