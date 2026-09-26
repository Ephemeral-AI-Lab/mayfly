/**
 * End-to-end conversation-flow scenarios: one realistic multi-tool turn runs
 * through the official model mapping and the semantic transcript renderer in
 * every work-details mode, running and settled, with Ctrl-O and an anchored
 * local. Presenter fakes mirror the shapes of the Harness tool presenters
 * (fs read, grep, bash, edit, web, skill, jobs, goal, todo). Each assertion
 * pins one conversation-flow audit finding.
 *
 * @module @ephemeral-ai/mayfly/tests/transcript/flow-scenarios
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { ToolRuntime } from '@deepseek-ai/dsh-tools'
import type { MayflySemanticColors } from '../../src/core/index.ts'
import type { ConversationEntry, ConversationProjection } from '../../src/conversation/types.ts'
import type { TranscriptModel } from '../../src/frontend/models.ts'
import { conversationTranscriptModel } from '../../src/transcript/official-model.ts'
import type { ToolPresentationSource } from '../../src/transcript/present.ts'
import { TranscriptPresentationPolicy, type TranscriptViewMode } from '../../src/transcript/presentation-policy.ts'
import { setProcessRowTimers } from '../../src/transcript/process-rows.ts'
import { setThinkingTimers } from '../../src/transcript/thinking.ts'
import { TranscriptModelComponent } from '../../src/transcript/transcript-model.ts'
import { fakeMayflyComponents } from './helpers.ts'
import { COLORS } from './status-fakes.ts'

const strip = (row: string): string => row.replace(/\x1b\[[0-9;]*m/gu, '')
type Args = Record<string, unknown>
type Outcome = { readonly isError: boolean, readonly meta?: unknown, readonly content: readonly { readonly type: string, readonly text?: string }[] }
const meta = (outcome: Outcome): Record<string, unknown> => outcome.meta as Record<string, unknown>

/** Presenters shaped like the Harness tool packages' `presentCall`/`presentResult`. */
const PRESENTERS: Record<string, { presentCall?: (args: Args) => unknown, presentResult?: (args: Args, outcome: Outcome) => unknown }> = {
  read: {
    presentCall: args => ({ card: 'generic', title: `Read ${String(args['file_path'])}`, kind: 'read', locations: [{ path: args['file_path'] }] }),
    presentResult: (_args, outcome) => outcome.isError ? undefined : { card: 'read', ...meta(outcome) },
  },
  grep: {
    presentCall: args => ({ card: 'generic', title: `Grep ${String(args['pattern'])}`, kind: 'search', rawInput: args['pattern'] }),
    presentResult: (_args, outcome) => outcome.isError ? undefined : { card: 'search', ...meta(outcome) },
  },
  bash: {
    presentCall: args => ({ card: 'terminal', title: args['command'], description: args['description'] }),
    presentResult: (_args, outcome) => {
      const raw = outcome.content[0]?.text ?? ''
      const exit = /\n\[exit code: (\d+)\]$/u.exec(raw)
      return exit === null ? { card: 'terminal', output: raw, exitCode: 0 } : { card: 'terminal', output: raw.slice(0, exit.index), exitCode: Number(exit[1]) }
    },
  },
  edit: {
    presentCall: args => ({ card: 'diff', title: `Edit ${String(args['file_path'])}`, diffs: [{ path: args['file_path'], oldText: args['old_string'], newText: args['new_string'] }] }),
    presentResult: (args, outcome) => ({ card: 'diff', title: `Edit ${String(args['file_path'])}`, diffs: meta(outcome)['diffs'] }),
  },
  web_search: {
    presentCall: args => ({ card: 'generic', title: (args['queries'] as string[]).join(', '), kind: 'search', rawInput: (args['queries'] as string[]).join(', ') }),
    presentResult: (_args, outcome) => ({ card: 'web', kind: 'search', sources: meta(outcome)['sources'], truncated: false }),
  },
  web_fetch: {
    presentCall: args => ({ card: 'generic', title: args['url'], kind: 'fetch', rawInput: args['url'] }),
    presentResult: (_args, outcome) => ({ card: 'web', kind: 'fetch', url: meta(outcome)['url'], statusCode: 200, truncated: false }),
  },
  skill: { presentCall: args => ({ card: 'generic', title: `Load skill ${String(args['name'])}`, kind: 'read', rawInput: args['name'] }) },
  job_output: { presentCall: args => ({ card: 'generic', title: `Read output from background job ${String(args['job_id'])}`, kind: 'read', rawInput: args['job_id'] }) },
  job_list: { presentCall: () => ({ card: 'generic', title: 'List background jobs', kind: 'read' }) },
  get_goal: { presentCall: () => ({ card: 'generic', title: 'Read current goal', kind: 'read' }) },
  create_goal: { presentCall: args => ({ card: 'generic', title: 'Create goal', kind: 'other', rawInput: args['objective'] }) },
  todo_write: { presentCall: args => ({ card: 'generic', title: 'Update todo list', kind: 'other', rawInput: args['todos'] }) },
}
const tools: ToolPresentationSource = { get: name => PRESENTERS[name] as never } as Pick<ToolRuntime, 'get'>

let seq = 0
const T0 = 1_000_000
const user = (text: string): ConversationEntry => ({ kind: 'user', id: `user:${String(++seq)}`, seq, updatedSeq: seq, turn: 1, text, images: [] })
const thinking = (step: number, text: string): ConversationEntry => ({ kind: 'thinking', id: `thinking:1:${String(step)}`, seq: ++seq, updatedSeq: seq, turn: 1, step, text, streaming: false, durationMs: 4_200 })
const reply = (step: number, text: string): ConversationEntry => ({ kind: 'assistant', id: `assistant:1:${String(step)}`, seq: ++seq, updatedSeq: seq, turn: 1, step, text, streaming: false })
function tool(step: number, name: string, args: Args, result?: { readonly text: string, readonly isError?: boolean, readonly meta?: unknown }): ConversationEntry {
  const id = ++seq
  const channel = name === 'todo_write' ? 'todo' : name.startsWith('subagent') ? 'agents' : 'transcript'
  return {
    kind: 'tool', id: `tool:c${String(id)}`, seq: id, updatedSeq: id, turn: 1, step, callId: `c${String(id)}`, name, arguments: JSON.stringify(args), startedAt: T0 + id * 1_000, channel,
    ...(result === undefined ? {} : { result: { content: [{ type: 'text', text: result.text }], text: result.text, isError: result.isError ?? false, endedAt: T0 + id * 1_000 + 2_500, ...(result.meta === undefined ? {} : { meta: result.meta as never }) } }),
  }
}
const lines = (path: string, count: number) => Array.from({ length: count }, (_, index) => ({ number: index + 1, text: `${path} ${String(index + 1)}` }))

function scenario(running: boolean): ConversationProjection {
  seq = 0
  const entries: ConversationEntry[] = [
    user('Fix the flaky login test'),
    thinking(0, 'The user wants the flaky login test fixed.\nRead the test and the auth module first.'),
    tool(0, 'read', { file_path: 'src/auth.ts' }, { text: 'x', meta: { path: 'src/auth.ts', offset: 1, lines: lines('auth', 40), totalLines: 120 } }),
    tool(0, 'read', { file_path: 'tests/login.spec.ts' }, { text: 'x', meta: { path: 'tests/login.spec.ts', offset: 1, lines: lines('spec', 64), totalLines: 64 } }),
    tool(0, 'grep', { pattern: 'retry\\(' }, { text: 'x', meta: { shape: 'matches', files: [{ path: 'src/auth.ts', matches: [{ lineNumber: 12, line: 'await retry(login, 3)' }] }], truncated: false, total: 1 } }),
    reply(1, 'The retry wraps a non-idempotent call. Let me run the test.'),
    tool(1, 'bash', { command: 'pnpm vitest run tests/login.spec.ts', description: 'Run the login test' }, { text: 'AssertionError: expected 2 calls, got 3\n[exit code: 1]' }),
    thinking(2, 'The test fails because retry re-runs the side effect.'),
    tool(2, 'edit', { file_path: 'src/auth.ts', old_string: 'retry(login, 3)', new_string: 'retry(() => login(token), 3)' }, { text: 'ok', meta: { diffs: [{ path: 'src/auth.ts', oldText: 'retry(login, 3)', newText: 'retry(() => login(token), 3)' }] } }),
    tool(2, 'bash', { command: 'pnpm lint', description: 'Lint' }, { text: 'src/auth.ts:3 unused var\n[exit code: 1]' }),
    tool(2, 'bash', { command: 'git diff --stat', description: 'Diff' }, { text: ' 1 file changed' }),
    tool(3, 'todo_write', { todos: [{ content: 'Fix retry', status: 'completed' }, { content: 'Verify', status: 'in_progress' }] }, { text: 'ok' }),
    tool(3, 'subagent', { name: 'reviewer', description: 'Review the change' }, { text: 'Looks good' }),
    tool(3, 'web_search', { queries: ['vitest vi.fn reset'] }, { text: 'x', meta: { sources: [{ url: 'https://vitest.dev/api/vi.html', title: 'Vi' }] } }),
    tool(3, 'skill', { name: 'release-notes' }, { text: '<skill>notes</skill>' }),
    tool(3, 'job_output', { job_id: '7' }, { text: 'build ok\n[status: running]' }),
    tool(3, 'job_list', {}, { text: '[{"id":"7"}]' }),
    tool(3, 'get_goal', {}, { text: '{"phase":"active"}' }),
    tool(3, 'mcp__github__create_issue', { title: 'Flaky login' }, { text: '{"number":42}' }),
    ...(running ? [tool(3, 'read', { file_path: 'missing.ts' })] : [reply(4, 'Done. `login` is now idempotent under `retry`.')]),
  ]
  return {
    entries, streaming: running, settledSteps: [],
    turns: [{ turn: 1, startedAt: T0, ...(running ? {} : { endedAt: T0 + 38_000, outcome: 'completed' }) }],
  }
}

function render(model: TranscriptModel, mode: TranscriptViewMode, expanded = false): { readonly rows: string[], readonly component: TranscriptModelComponent } {
  const policy = new TranscriptPresentationPolicy()
  policy.apply({ transcriptView: mode })
  const component = new TranscriptModelComponent(() => model, {
    colors: COLORS as MayflySemanticColors, components: fakeMayflyComponents(), viewportRows: () => 40,
    images: () => ({}), requestRender: () => {}, presentation: policy,
  })
  component.setExpanded(expanded)
  return { rows: component.render(120).map(strip), component }
}

afterEach(() => {
  setThinkingTimers(undefined)
  setProcessRowTimers(undefined)
})

describe('conversation flow scenarios', () => {
  it('keeps chronology, honest statuses, and correct tool families when everything is shown', () => {
    const { rows, component } = render(conversationTranscriptModel(scenario(false), tools), 'verbose')
    const text = rows.join('\n')
    // Later-step reasoning renders after the command that prompted it.
    expect(text.indexOf('$ pnpm vitest run tests/login.spec.ts')).toBeLessThan(text.indexOf('The test fails because'))
    // A non-zero exit never reads as success, alone or inside a group.
    expect(text).toContain('✗ $ pnpm vitest run tests/login.spec.ts · exit 1 · 2s')
    expect(text).toContain('AssertionError: expected 2 calls, got 3')
    expect(text).toContain('◐ Ran 2 commands · 1 failed')
    expect(text).toContain('pnpm lint ✗ exit 1 · src/auth.ts:3 unused var')
    // Non-file reads and web search keep their own presentation.
    expect(text).toContain('✓ Read 2 files')
    expect(text).not.toContain('Read 0 files')
    expect(text).toContain('✓ Load skill release-notes')
    expect(text).toContain('✓ Read output from background job 7')
    expect(text).toContain('✓ List background jobs')
    expect(text).toContain('✓ Read current goal')
    expect(text).toContain('✓ Searched the web · vitest vi.fn reset · 1 source')
    expect(text).toContain('✓ Used github › create_issue (Flaky login)')
    // Pane-owned calls leave a trace in history.
    expect(text).toContain('✓ Updated the plan · 1/2 done · ● Verify')
    expect(text).toContain('✓ reviewer · Review the change · Looks good')
    // The header summarizes the turn; thinking reads distinctly from answers.
    expect(text).toContain('▾ Took 38s · 14 tool calls · 1 subagent')
    expect(text).toContain('✻ Thought for 4s · The user wants the flaky login test fixed.')
    component.invalidate()
    expect(component.render(120).map(strip)).toEqual(rows)
    component.dispose()
  })

  it('folds a settled turn to its guttered header and final answer in compact, standard, and detailed', () => {
    const model = conversationTranscriptModel(scenario(false), tools)
    for (const mode of ['compact', 'standard', 'detailed'] as const) {
      const { rows, component } = render(model, mode)
      // Blank separator rows carry the one-column gutter.
      expect(rows).toEqual([
        ' ',
        ' » Fix the flaky login test',
        ' ',
        ' ▸ Took 38s · 14 tool calls · 1 subagent · ctrl+o to expand',
        ' ',
        ' ● Done. `login` is now idempotent under `retry`.',
      ])
      // An anchored local (a `!cmd` echo) never disables folding.
      component.appendAnchored('local', { render: () => ['$ ls'], invalidate: () => {} }, 0)
      const anchored = component.render(120).map(strip)
      expect(anchored).toContain(' ▸ Took 38s · 14 tool calls · 1 subagent · ctrl+o to expand')
      expect(anchored).toContain(' $ ls')
      expect(anchored.join('\n')).not.toContain('pnpm lint')
      component.dispose()
    }
  })

  it('segments a running turn into chronological titled groups by mode', () => {
    const model = conversationTranscriptModel(scenario(true), tools)
    const standard = render(model, 'standard').rows.join('\n')
    expect(standard).toContain('▾ Deep diving for')
    // Live counts belong to the dock; the running header shows lifecycle only.
    expect(standard).not.toMatch(/Deep diving for[^\n]*(tool call|subagent)/)
    expect(standard).toContain('▸ Read files and searched code')
    expect(standard.indexOf('▸ Read files and searched code')).toBeLessThan(standard.indexOf('Let me run the test.'))
    expect(standard).toContain('▸ Reading files · missing.ts · 2 failed')
    const compact = render(model, 'compact').rows.join('\n')
    expect(compact).toContain('▸ Reading files · 2 failed')
    const detailed = render(model, 'detailed').rows.join('\n')
    expect(detailed).toContain('✗ $ pnpm vitest run tests/login.spec.ts · exit 1')
    expect(detailed).toContain('Reading 1 file…')
  })

  it('opens the recent turn with Ctrl-O and marks calls cut by a stopped turn', () => {
    const opened = render(conversationTranscriptModel(scenario(false), tools), 'standard', true).rows.join('\n')
    expect(opened).toContain('▾ Took 38s')
    expect(opened).toContain('│  1  auth 1')
    const cut = scenario(true)
    const stopped = conversationTranscriptModel({ ...cut, streaming: false, turns: [{ turn: 1, startedAt: T0, endedAt: T0 + 9_000, outcome: 'aborted' }] }, tools)
    const rows = render(stopped, 'verbose').rows.join('\n')
    expect(rows).toContain('▾ Stopped')
    expect(rows).toContain('Read 1 file · 1 cancelled')
    expect(rows).toContain('missing.ts ⊘')
  })
})
