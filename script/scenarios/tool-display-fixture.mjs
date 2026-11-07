/**
 * The scripted session of the tool-display demo: the stub model asks for the real tools the design preview shows, in the
 * preview's order, so the owner judges the real product. A prompt names a script (`demo:session`, `demo:goal`, `demo:background`), each model
 * request answers the next step of it, and a step the running preset does not offer is left out and named in the last
 * reply. Subagents are told what to do through their own prompts (`demo:child:<ms>`, `demo:child-fail:<ms>`).
 * @module script/scenarios/tool-display-fixture
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const LINES = Array.from({ length: 180 }, (_, index) => `// line ${String(index + 1)} of the list module`)
const SOURCE = `${LINES.slice(0, 119).join('\n')}\nexport function reorder(items, from, to) {\n  const next = items.slice()\n  next.splice(to, 0, items[from])\n  next.splice(from, 1)\n  return next\n}\nexport function onSelect(index) {\n  select(index)\n}\n`
const MENU = "import './menu-old.css'\nconst onPick = useCallback(pick, [])\nexport const menu = onPick\n"
const LEGACY = '// the old list\nexport const legacy = true\n'
const SPEC = `import { describe, expect, it } from 'vitest'\nimport { reorder } from '../src/reorder.ts'\n\ndescribe('reorder', () => {\n  it('keeps the selected id', () => {\n    const items = [{ id: 'a' }, { id: 'b' }]\n    expect(reorder(items, 0, 1)[1].id).toBe('a')\n  })\n${Array.from({ length: 30 }, (_, index) => `  it('holds case ${String(index)}', () => { expect(true).toBe(true) })`).join('\n')}\n})\n`
const PATCH = [
  '*** Begin Patch',
  '*** Add File: src/reorder.ts',
  '+export function move(items, from, to) {',
  '+  return items.toSpliced(from, 1).toSpliced(to, 0, items[from])',
  '+}',
  '*** Delete File: src/legacy-list.ts',
  '*** Update File: src/menu-old.ts',
  '*** Move to: src/menu.ts',
  '@@',
  "-import './menu-old.css'",
  "+import './menu.css'",
  '*** End Patch',
].join('\n')

/** One model turn's worth of calls: `think` and `say` come first and `pace` slows the arguments so a change fills in. */
const SESSION = [
  { think: 'The selection is keyed by index, so a reorder would point it at the wrong row. I should read reorder() first and see who calls onSelect.', calls: [['todo_write', { todos: [
    { content: 'Find why the selection is lost', status: 'in_progress' }, { content: 'Key the selection by id', status: 'pending' }, { content: 'Cover it with a test', status: 'pending' }, { content: 'Review the diff with subagents', status: 'pending' }, { content: 'Audit the dependencies', status: 'pending' },
  ] }]] },
  { calls: [['read', { file_path: 'src/list.ts', offset: 120, limit: 8 }], ['read', { file_path: 'package.json' }], ['read', { file_path: 'src/missing.ts' }]] },
  { calls: [['grep', { pattern: 'onSelect', path: 'src', include: '*.ts' }], ['glob', { pattern: '**/*.ts', path: 'src' }]] },
  { calls: [['mcp__github__search_issues', { query: 'is:open label:bug', per_page: 30 }], ['mcp__github__get_issue', { owner: 'acme', repo: 'web', issue_number: 1423 }], ['mcp__linear__search_issues', { query: 'list selection' }]] },
  { calls: [['mcp__browser__screenshot', { url: 'https://pi.dev' }]] },
  { calls: [['web_search', { queries: ['keep selection after array reorder'] }]] },
  { calls: [['web_fetch', { url: '@stub/demo/rendering-lists' }]] },
  { calls: [['read_image', { file_path: 'docs/shot.png' }]] },
  { say: 'The reorder keeps the index of the selected row instead of its id. I will key the selection by id and split the helper out.', pace: 40, calls: [['edit', { file_path: 'src/list.ts', old_string: '  next.splice(to, 0, items[from])\n  next.splice(from, 1)', new_string: '  const [moved] = next.splice(from, 1)\n  next.splice(to, 0, moved)' }]] },
  { pace: 40, calls: [['edit', { file_path: 'src/list.ts', old_string: '  select(index)', new_string: '  select(items[index].id)' }]] },
  { calls: [['edit', { file_path: 'src/menu-old.ts', old_string: 'text that is not there', new_string: 'anything' }]] },
  { pace: 25, calls: [['apply_patch', { input: PATCH }]] },
  { pace: 8, calls: [['write', { file_path: 'tests/selection.spec.ts', content: SPEC }]] },
  { calls: [['bash', { command: 'sleep 2 && echo "Found 0 warnings and 0 errors."', description: 'Lint the ui package', workdir: 'src' }]] },
  { calls: [['bash', { command: 'sleep 4; echo " FAIL  tests/selection.spec.ts"; echo "  x keeps the selected id"; exit 1', description: 'Run the ui tests' }]] },
  { calls: [['bash', { command: 'for f in src/*.ts; do\n  sleep 0.5\n  echo "checked: $f"\ndone', description: 'Check every source file' }]] },
  { calls: [['run_code', { description: 'Count the selection call sites', code: 'console.log(17)' }]] },
  { calls: [['bash', { command: 'i=0; while true; do i=$((i+1)); echo "rebuilt $i"; sleep 3; done', description: 'Start the dev server', run_in_background: true }]] },
  { calls: [['job_list', {}]] },
  { calls: [
    ['subagent', { description: 'Explore every caller', prompt: 'demo:child:9000 Explore every caller of reorder.' }],
    ['subagent', { description: 'Sweep the lint findings', prompt: 'demo:child-fail:14000 Sweep the oxlint findings.' }],
    ['subagent', { description: 'Review the diff', prompt: 'demo:child:12000 Review the diff for regressions.' }],
  ] },
  { wait: 16_000, calls: [['workflow', { meta: { name: 'audit-deps', description: 'Audit the dependencies.', phases: [{ title: 'scan' }, { title: 'verify' }, { title: 'report' }] }, script: `
phase('scan')
await Promise.all([agent('demo:child:4000 Scan.', { label: 'scan packages/ui' }), agent('demo:child:6000 Scan.', { label: 'scan packages/host' }), agent('demo:child:5000 Scan.', { label: 'scan packages/cli' })])
phase('verify')
await Promise.all([agent('demo:child:5000 Verify.', { label: 'verify the licences' }), agent('demo:child:7000 Verify.', { label: 'verify the pins' }), agent('demo:child:3000 Verify.', { label: 'verify the exclusions' })])
phase('report')
return await agent('demo:child:3000 Report.', { label: 'write the report' })
` }]] },
  { calls: [['job_kill', { job_id: '@first-job' }]] },
  { calls: [['todo_write', { todos: ['Find why the selection is lost', 'Key the selection by id', 'Cover it with a test', 'Review the diff with subagents', 'Audit the dependencies'].map(content => ({ content, status: 'completed' })) }]] },
  { say: 'Done. The selection now follows the id through a reorder, the helper moved to `src/reorder.ts`, and `tests/selection.spec.ts` covers it. One lint sweep failed on its own and is listed under agents; the rest are clean.', pace: 30 },
]

const GOAL = [
  { calls: [['create_goal', { objective: 'Ship the release notes and keep the tests green' }]] },
  { calls: [['read', { file_path: 'package.json' }]] },
  { calls: [['bash', { command: 'sleep 3 && echo "Tests  42 passed"', description: 'Run the tests' }]] },
  { calls: [['mcp__github__create_issue', { title: 'Release notes', teamId: 'ENG', description: 'Draft the notes for 0.1.5 and link every merged change.', labels: ['docs'], draft: true }]] },
  { say: 'The github token has expired, so the issue is not filed. The notes and tests are ready.', pace: 30 },
  { calls: [['update_goal', { goal_id: '@goal', revision: '@goal', action: 'complete' }]] },
  { say: 'The goal is complete.', pace: 30 },
]

/** A run that outlives its call: its job is what `x` stops in the Workflow view. */
const BACKGROUND = [
  { calls: [['workflow', { run_in_background: true, meta: { name: 'nightly-audit', description: 'Audit in the background.', phases: [{ title: 'scan' }] }, script: `
phase('scan')
return await Promise.all([agent('demo:child:40000 Scan.', { label: 'scan the lockfile' }), agent('demo:child:50000 Scan.', { label: 'scan the licences' })])
` }]] },
  { say: 'The audit runs in the background. Open the workflow view to stop it.', pace: 30 },
]

const SCRIPTS = { session: SESSION, goal: GOAL, background: BACKGROUND }

const textOf = message => JSON.stringify(message.content ?? '')

/** The goal `create_goal` answered with, whose exact id and revision `update_goal` must name. */
function goalOf(messages) {
  const text = messages.map(textOf).filter(value => value.includes('tool_result')).join('\n')
  const id = /"id\\*":\s*\\*"([^"\\]+)/u.exec(text)?.[1]
  const revision = /"revision\\*":\s*(\d+)/u.exec(text)?.[1]
  return { goal_id: id ?? 'unknown', revision: revision === undefined ? 1 : Number(revision) }
}

/** The id of the first job a tool answered with, so `job_kill` names the job the demo really started. */
function firstJobId(messages) {
  return /background job (\S+?)[.\s\\"]|"jobId\\*":\s*\\*"([^"\\]+)/u.exec(messages.map(textOf).filter(text => text.includes('tool_result')).join('\n'))?.slice(1).find(id => id !== undefined)
}

/**
 * The next step of the script the latest demo prompt names.
 * @param body - the model request.
 * @param stubURL - the stub's own address, which a local page is fetched from, so the demo reaches no outside site.
 * @returns the step to answer with, `{ fail: true }` for a child told to fail, or `undefined` when no script applies.
 */
export function toolDisplayInstruction(body, stubURL) {
  if (!Array.isArray(body.tools) || body.tools.length === 0) return undefined
  const messages = body.messages ?? []
  const child = messages.findLast(message => message.role === 'user' && /demo:child(?:-fail)?:\d+/u.test(textOf(message)))
  if (child !== undefined) {
    const [, failing, ms] = /demo:child(-fail)?:(\d+)/u.exec(textOf(child))
    const done = messages.at(-1) !== child
    if (done && failing !== undefined) return { fail: true }
    const offered = new Set(body.tools.map(tool => tool.name))
    return done ? { say: 'The child looked and found nothing further.', pace: 12 } : { wait: Number(ms) / 2, calls: offered.has('bash') ? [['bash', { command: `sleep ${String(Number(ms) / 2000)}`, description: 'Work' }]] : [] }
  }
  const index = messages.findLastIndex(message => message.role === 'user' && /demo:(session|goal|background)\b/u.test(textOf(message)) && !textOf(message).includes('tool_result'))
  if (index < 0) return undefined
  const [, name] = /demo:(session|goal|background)\b/u.exec(textOf(messages[index]))
  const offered = new Set(body.tools.map(tool => tool.name))
  // A step whose tools the running preset lacks is left out, so the script keeps going and its last reply can name it.
  const steps = SCRIPTS[name].filter(step => step.calls === undefined || step.calls.some(([tool]) => offered.has(tool)))
  const position = messages.slice(index + 1).filter(message => message.role === 'assistant').length
  const step = steps[position]
  if (step === undefined) return { say: 'The demo script has finished.' }
  const missing = [...new Set(SCRIPTS[name].flatMap(each => each.calls ?? []).map(([tool]) => tool))].filter(tool => !offered.has(tool))
  const closing = position === steps.length - 1 && missing.length > 0 ? ` This preset does not offer ${missing.join(', ')}.` : ''
  const jobId = firstJobId(messages)
  const goal = goalOf(messages)
  const resolved = input => input.goal_id === '@goal' ? { ...input, ...goal } : input.job_id === '@first-job' ? { job_id: jobId ?? 'unknown' } : typeof input.url === 'string' ? { ...input, url: input.url.replace('@stub', stubURL) } : input
  return {
    ...step,
    ...(step.say === undefined ? {} : { say: `${step.say}${closing}` }),
    calls: (step.calls ?? []).filter(([tool]) => offered.has(tool)).map(([tool, input]) => [tool, resolved(input)]),
  }
}

/**
 * The workspace the script works in.
 * @param cwd - an empty directory the demo owns.
 */
export function seedToolDisplayWorkspace(cwd) {
  mkdirSync(join(cwd, 'src'), { recursive: true })
  mkdirSync(join(cwd, 'tests'), { recursive: true })
  mkdirSync(join(cwd, 'docs'), { recursive: true })
  writeFileSync(join(cwd, 'src/list.ts'), SOURCE)
  writeFileSync(join(cwd, 'src/menu-old.ts'), MENU)
  writeFileSync(join(cwd, 'src/legacy-list.ts'), LEGACY)
  writeFileSync(join(cwd, 'package.json'), `${JSON.stringify({ name: 'demo', version: '0.1.5', private: true }, null, 2)}\n`)
  writeFileSync(join(cwd, 'docs/shot.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'))
}
