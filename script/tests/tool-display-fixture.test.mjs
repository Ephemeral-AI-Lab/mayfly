/** The scripted model of the tool-display demo. @module script/tests/tool-display-fixture */

import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { seedToolDisplayWorkspace, toolDisplayInstruction } from '../scenarios/tool-display-fixture.mjs'

const STUB = 'http://127.0.0.1:1'
const ALL = ['todo_write', 'read', 'grep', 'glob', 'mcp__github__search_issues', 'mcp__github__get_issue', 'mcp__linear__search_issues', 'mcp__browser__screenshot', 'web_search', 'web_fetch', 'read_image', 'edit', 'apply_patch', 'write', 'bash', 'run_code', 'job_list', 'subagent', 'workflow', 'job_kill', 'create_goal', 'mcp__github__create_issue']
const tools = names => names.map(name => ({ name }))
const user = text => ({ role: 'user', content: text })
const assistant = { role: 'assistant', content: [{ type: 'text', text: 'step' }] }
const after = (prompt, steps) => [user(prompt), ...Array.from({ length: steps }, () => assistant)]

test('a request that is not the demo is left to the rest of the stub', () => {
  assert.equal(toolDisplayInstruction({ tools: tools(ALL), messages: [user('hello')] }, STUB), undefined)
  // A title request offers no tools.
  assert.equal(toolDisplayInstruction({ messages: [user('demo:session')] }, STUB), undefined)
})

test('each model request answers the next step of the script', () => {
  const first = toolDisplayInstruction({ tools: tools(ALL), messages: after('demo:session', 0) }, STUB)
  assert.equal(first.calls[0][0], 'todo_write')
  const second = toolDisplayInstruction({ tools: tools(ALL), messages: after('demo:session', 1) }, STUB)
  assert.deepEqual(second.calls.map(([name]) => name), ['read', 'read', 'read'])
})

test('a step whose tools are missing is left out, and the last reply names them', () => {
  const offered = ALL.filter(name => name !== 'apply_patch' && name !== 'run_code')
  const steps = []
  for (let position = 0; position < 40; position += 1) {
    const step = toolDisplayInstruction({ tools: tools(offered), messages: after('demo:session', position) }, STUB)
    steps.push(step)
    if ((step.calls ?? []).length === 0 && step.say !== undefined && position > 5) break
  }
  const called = steps.flatMap(step => (step.calls ?? []).map(([name]) => name))
  assert.equal(called.includes('apply_patch'), false)
  assert.equal(called.includes('run_code'), false)
  assert.match(steps.at(-1).say, /does not offer apply_patch, run_code\.$/u)
})

test('the page is fetched from the stub, so the demo reaches no outside site', () => {
  for (let position = 0; position < 12; position += 1) {
    const step = toolDisplayInstruction({ tools: tools(ALL), messages: after('demo:session', position) }, STUB)
    for (const [name, input] of step.calls ?? []) if (name === 'web_fetch') assert.equal(input.url, `${STUB}/demo/rendering-lists`)
  }
})

test('job_kill names the job the session really started', () => {
  const position = 21
  const answered = (text) => [user('demo:session'), ...Array.from({ length: position }, (_, index) => assistant), { role: 'user', content: [{ type: 'tool_result', content: text }] }]
  const find = (messages) => {
    for (let at = 0; at < 40; at += 1) {
      const step = toolDisplayInstruction({ tools: tools(ALL), messages: [...messages, ...Array.from({ length: at }, () => assistant)] }, STUB)
      const kill = step.calls?.find(([name]) => name === 'job_kill')
      if (kill !== undefined) return kill[1].job_id
    }
    return undefined
  }
  assert.equal(find(answered('moved to background job j7.')), 'j7')
  assert.equal(find(answered('{"kind":"background","jobId":"j9"}')), 'j9')
  assert.equal(find(after('demo:session', 0)), 'unknown')
})

test('a child does as its own prompt says', () => {
  const offered = tools(['bash'])
  const first = toolDisplayInstruction({ tools: offered, messages: [user('demo:child:4000 Look.')] }, STUB)
  assert.equal(first.wait, 2000)
  assert.equal(first.calls[0][1].command, 'sleep 2')
  assert.equal(toolDisplayInstruction({ tools: offered, messages: [user('demo:child:4000 Look.'), assistant] }, STUB).calls, undefined)
  assert.deepEqual(toolDisplayInstruction({ tools: offered, messages: [user('demo:child-fail:4000 Look.'), assistant] }, STUB), { fail: true })
  assert.deepEqual(toolDisplayInstruction({ tools: tools(['read']), messages: [user('demo:child:4000 Look.')] }, STUB).calls, [])
})

test('the goal script runs on its own', () => {
  assert.equal(toolDisplayInstruction({ tools: tools(ALL), messages: after('demo:goal', 0) }, STUB).calls[0][0], 'create_goal')
  assert.equal(toolDisplayInstruction({ tools: tools(ALL), messages: after('demo:goal', 99) }, STUB).say, 'The demo script has finished.')
})

test('the workspace holds what the script reads and edits', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'tool-display-'))
  try {
    seedToolDisplayWorkspace(cwd)
    assert.match(readFileSync(join(cwd, 'src/list.ts'), 'utf8'), /next\.splice\(to, 0, items\[from\]\)/u)
    assert.match(readFileSync(join(cwd, 'src/menu-old.ts'), 'utf8'), /menu-old\.css/u)
  } finally { rmSync(cwd, { recursive: true, force: true }) }
})
