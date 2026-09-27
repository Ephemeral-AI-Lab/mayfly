/** Upstream-parity process activity, settled summaries, past-tense titles, and live labels.
 * @module @ephemeral-ai/mayfly/tests/transcript/process-activity
 */
import { describe, expect, it } from 'vitest'
import { interpolateLocaleMessage, type MayflyTranslate } from '../../src/frontend/locale.ts'
import {
  preparingLabel,
  processTitle,
  runningLabel,
  SHARED_DONE_PREFIX_KEY,
  summarizeProcess,
  toolActivity,
  type ProcessMemberFact,
} from '../../src/transcript/process-activity.ts'
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

  it('titles settled groups in the past tense, in English and Chinese', () => {
    const t = interpolateLocaleMessage
    // Nothing settled: no title at all.
    expect(processTitle(summarizeProcess([]), t)).toBe('')
    expect(processTitle(summarizeProcess([member('read')]), t)).toBe('Read files')
    expect(processTitle(summarizeProcess([member('read'), member('search')]), t)).toBe('Read files and searched code')
    expect(processTitle(summarizeProcess([member('read'), member('search'), member('commands')]), t)).toBe('Read files, searched code, ran commands')
    expect(processTitle(summarizeProcess([member('read'), member('search'), member('commands'), member('edit')]), t)).toBe('Read files, searched code, ran commands, etc.')
    expect(processTitle(summarizeProcess([member('subagents')]), zh)).toBe('已协调子智能体')
    // Chinese joins drop the repeated done prefix `已`.
    expect(processTitle(summarizeProcess([member('read'), member('search')]), zh)).toBe('已读取文件并搜索代码')
    expect(processTitle(summarizeProcess([member('read'), member('edit')]), zh)).toBe('已读取文件并修改了文件')
    expect(processTitle(summarizeProcess([member('read'), member('search'), member('commands'), member('edit')]), zh)).toBe('已读取文件，已搜索代码，执行了命令等')
    expect(TRANSCRIPT_LOCALE.en[SHARED_DONE_PREFIX_KEY]).toBe('')
  })

  it('names running and preparing categories for the activity row', () => {
    expect(runningLabel('commands')).toBe('Running commands')
    expect(runningLabel('subagents')).toBe('Coordinating subagents')
    expect(preparingLabel('edit')).toBe('Preparing to edit files')
    expect(ACTIVITY_LOCALE.zh[runningLabel('commands')]).toBe('正在运行命令')
    expect(ACTIVITY_LOCALE.zh[preparingLabel('write')]).toBe('准备写入文件')
    // The retired reasoning-group titles are gone from both catalogs.
    expect(TRANSCRIPT_LOCALE.zh['Analyzing the request']).toBeUndefined()
    expect(TRANSCRIPT_LOCALE.zh['Analysis completed']).toBeUndefined()
  })
})
