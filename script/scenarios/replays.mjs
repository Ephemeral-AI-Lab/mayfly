/**
 * The replays of the workbench: conversations written as data, played into a live session by the replay driver so a
 * review needs no model, no quota, and no tools. Each replay shows a family of UI states; a component draft adds the
 * replay that shows its states. See `timeline.mjs` for the builders. @module script/scenarios/replays
 */

import { approval, compaction, edit, goal as goalItem, image, btw, job, mark, notify, pause, question, queue, raw, seed, step, subagent, text, todos, tool, turn } from './timeline.mjs'

/** A reply shaped like a real answer: prose, lists, a table, and fenced code in two languages. */
function reply() {
  const parts = []
  for (let section = 1; section <= 8; section += 1) {
    parts.push(`## Section ${section}: rendering pipeline notes`)
    parts.push(`The **renderer** walks the tree once per frame and only repaints rows whose content changed since the last frame. This paragraph is long enough to wrap at ordinary widths, with \`inline code\`, *emphasis*, and a [link](https://example.com/${section}) to exercise the inline painter.`)
    parts.push(['- first point about caches and identity', '- second point about `width` ladders', '- third point, with a nested list:', '  - nested one', '  - nested two'].join('\n'))
    parts.push(['```ts', `export function section${section}(input: readonly string[], width: number): string[] {`, '  const rows: string[] = []', '  for (const line of input) {', "    if (line.length === 0) { rows.push(''); continue }", '    for (let at = 0; at < line.length; at += width) rows.push(line.slice(at, at + width))', '  }', "  return rows.map(row => row.padEnd(width, ' '))", '}', '```'].join('\n'))
    if (section % 2 === 0) {
      parts.push(['| workload | validated | compiled | rows |', '| --- | ---: | ---: | ---: |', '| W1 | 2 | 2 | 2 |', '| W2 | 0 | 0 | 1 |', '| W3 | 0 | 0 | 2 |'].join('\n'))
      parts.push(['```python', 'def wrap(lines, width):', '    rows = []', '    for line in lines:', '        if not line:', "            rows.append('')", '            continue', '        rows.extend(line[i:i + width] for i in range(0, len(line), width))', '    return rows', '```'].join('\n'))
    }
  }
  return parts.join('\n\n')
}

const SUMMARY = [
  '## Summary',
  '',
  'I added a `retries` option and a test for it. All tests pass.',
  '',
  '| File | Change |',
  '| --- | --- |',
  '| `src/config.mjs` | new `retries` setting, shown by `describe()` |',
  '| `tests/retry.test.mjs` | covers the new output |',
  '',
  '```js',
  'export const config = {',
  "  baseUrl: 'http://localhost:8080',",
  '  timeoutMs: 3000,',
  '  retries: 2,',
  '}',
  '```',
  '',
  '- Run `npm test` to check it.',
  '- The client does not read `retries` yet; that is the next step.',
].join('\n')

const CONFIG = "export const config = {\n  baseUrl: 'http://localhost:8080',\n  timeoutMs: 3000,\n}\n\nexport function describe() {\n  return `${config.baseUrl} (timeout ${config.timeoutMs} ms)`\n}\n"
const TEST_OUTPUT = '✔ describe names the base url and timeout (0.8ms)\n✔ describe shows the retries (0.3ms)\nℹ tests 2\nℹ pass 2\nℹ fail 0'

const tour = {
  summary: 'a full agent turn: reasoning, todos, search, read, edits, a write, bash (running, failing, passing), and a markdown answer',
  items: [turn('Add a retries option to the config and run the tests.', [
    step({
      reasoning: 'The user wants a retries option. I should look at how the config is organised first, then change it and cover it with a test. I will plan the work and search the sources before reading anything.',
      text: 'I will start by planning and looking at the project layout.',
      usage: { inputTokens: 4200, outputTokens: 180, cacheReadTokens: 1200 },
      tools: [
        todos([['in_progress', 'Find where the settings live'], ['pending', 'Add the retries option'], ['pending', 'Write a test for it'], ['pending', 'Run the tests']]),
        tool('glob', { pattern: '**/*.mjs' }, { result: 'src/config.mjs\nsrc/client.mjs\ntests/config.test.mjs', runMs: 500 }),
        tool('grep', { pattern: 'timeoutMs', include: '*.mjs' }, { result: 'src/config.mjs:3:  timeoutMs: 3000,\nsrc/client.mjs:4:  signal: AbortSignal.timeout(config.timeoutMs)', runMs: 700 }),
      ],
    }),
    step({
      text: 'The settings are in `src/config.mjs`. Let me read it.',
      usage: { inputTokens: 4800, outputTokens: 60, cacheReadTokens: 3600 },
      tools: [tool('read', { file_path: 'src/config.mjs' }, { result: CONFIG, runMs: 600 })],
    }),
    step({
      text: 'Adding the option next to the timeout, and showing it in `describe()`.',
      usage: { inputTokens: 5400, outputTokens: 140, cacheReadTokens: 4800 },
      tools: [
        edit('src/config.mjs', "  baseUrl: 'http://localhost:8080',\n  timeoutMs: 3000,\n}", "  baseUrl: 'http://localhost:8080',\n  timeoutMs: 3000,\n  retries: 2,\n}"),
        edit('src/config.mjs', '  return `${config.baseUrl} (timeout ${config.timeoutMs} ms)`', '  return `${config.baseUrl} (timeout ${config.timeoutMs} ms, ${config.retries} retries)`'),
      ],
    }),
    step({
      usage: { inputTokens: 5900, outputTokens: 150, cacheReadTokens: 5400 },
      tools: [
        todos([['completed', 'Find where the settings live'], ['completed', 'Add the retries option'], ['in_progress', 'Write a test for it'], ['pending', 'Run the tests']]),
        tool('write', { file_path: 'tests/retry.test.mjs', content: "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { describe } from '../src/config.mjs'\n\ntest('describe shows the retries', () => {\n  assert.match(describe(), /2 retries/)\n})\n" }, { result: 'Wrote tests/retry.test.mjs', runMs: 500 }),
      ],
    }),
    step({
      text: 'Running the tests, and one command that should fail.',
      usage: { inputTokens: 6300, outputTokens: 70, cacheReadTokens: 5900 },
      tools: [
        tool('bash', { command: 'sleep 3; npm test 2>&1 | tail -12', description: 'Run the test suite' }, { result: `${TEST_OUTPUT}\n[exit code: 0]`, runMs: 3500 }),
        tool('bash', { command: 'cat missing-file.txt', description: 'Read a file that does not exist' }, { result: 'cat: missing-file.txt: No such file or directory\n[exit code: 1]', error: true, runMs: 900 }),
      ],
    }),
    step({
      reasoning: 'The suite passes; the missing-file error was deliberate. Close the todo list and summarise.',
      usage: { inputTokens: 7900, outputTokens: 60, cacheReadTokens: 7400 },
      tools: [todos([['completed', 'Find where the settings live'], ['completed', 'Add the retries option'], ['completed', 'Write a test for it'], ['completed', 'Run the tests']])],
    }),
    step({ text: SUMMARY, usage: { inputTokens: 8100, outputTokens: 220, cacheReadTokens: 7900 } }),
  ])],
}

const thinking = {
  summary: 'a long reasoning block streamed before a short answer',
  items: [turn('Is 2^31 - 1 prime? Think it through.', [step({
    reasoning: Array.from({ length: 14 }, (_, n) => `Step ${n + 1}: consider whether a factor below ${100 * (n + 1)} could divide 2^31 - 1. The number is a Mersenne number, and a Mersenne exponent being prime is necessary but not sufficient, so the exponent 31 alone settles nothing. Lucas–Lehmer gives the answer directly.`).join('\n\n'),
    reasoningMs: 9000,
    marks: [{ name: 'thinking', block: 'reasoning', at: 0.5 }],
    text: 'Yes. 2^31 - 1 = 2147483647 is a Mersenne prime (the Lucas–Lehmer test with exponent 31 returns zero).',
    usage: { inputTokens: 900, outputTokens: 1400 },
  })])],
}

const markdown = {
  summary: 'a long streamed answer with headings, lists, tables, and code in two languages',
  items: [turn('Explain the rendering pipeline.', [step({ reasoning: 'Plan the answer: sections on caching, width ladders, and code.', text: reply(), textMs: 6000, chunk: 24, marks: [{ name: 'half', block: 'text', at: 0.5 }], usage: { inputTokens: 1200, outputTokens: 2600 } })])],
}

const errors = {
  summary: 'failing tools, then a turn that ends in an error, one that is interrupted, and one that is aborted',
  items: [
    turn('Run the checks.', [step({
      text: 'Running the checks.',
      tools: [
        tool('bash', { command: 'npm run lint', description: 'Lint the project' }, { result: 'src/client.mjs:4:3  error  no-unused-vars  "signal" is assigned but never used\n[exit code: 1]', error: true, runMs: 1500 }),
        tool('read', { file_path: 'src/missing.mjs' }, { result: 'Error: ENOENT: no such file or directory, open src/missing.mjs', error: true, runMs: 400 }),
      ],
    })], { outcome: { error: { message: 'The provider returned an invalid request: replay error', code: 'INVALID_REQUEST' } } }),
    turn('Try again, but I will stop you.', [step({ text: 'Starting a long task… ', tools: [tool('bash', { command: 'sleep 60', description: 'Wait' }, { result: '', runMs: 4000 })] })], { outcome: 'interrupted' }),
    turn('And once more.', [step({ text: 'Working on it, then the request is cut off.' })], { outcome: 'aborted' }),
  ],
}

const compactionReplay = {
  summary: 'an automatic compaction between steps, with its summary, then the turn continues',
  items: [turn('Read the readme and summarise it.', [
    step({ text: 'Reading the readme.', tools: [tool('read', { file_path: 'README.md' }, { result: '# replay-app\n\nA tiny service used by the Mayfly workbench replays.', runMs: 500 })] }),
    compaction({ ms: 2500, shadowedTokens: 42_000, shadowedItems: 14, summary: 'The user asked for a summary of README.md. It was read: a tiny service with a config module and a client module.' }),
    step({ text: 'The readme describes a tiny service with a config module and a client module.', usage: { inputTokens: 1800, outputTokens: 40, cacheReadTokens: 0 } }),
  ])],
}

const subagents = {
  summary: 'one step spawning five subagents: done, running, waiting, failed, and interrupted; open them from the agents pane',
  items: [turn('Split the rebranding into parallel tracks.', [
    step({
      text: 'I will run three tracks in parallel.',
      tools: [
        subagent('Survey shot embeds', 'Survey every website page that embeds component shots', { items: [step({ stream: false, tools: [tool('read', { file_path: 'website/features/index.md' }, { result: 'three pages reference the gallery', runMs: 600 })] }), step({ stream: false, text: 'Found three pages embedding shots.' })] }, { runMs: 800 }),
        subagent('Rewrite README hero', 'Rewrite the README hero section around the new brand', { startMs: 800, outcome: 'open', items: [step({ stream: false, reasoning: 'Mapping the hero copy against the brand tokens…', tools: [tool('bash', { command: 'sleep 600', description: 'Wait for the build' }, { result: '', runMs: 600_000 })] })] }, { runMs: 800 }),
        subagent('Regenerate shot gallery', 'Regenerate the component shot gallery', { startMs: 1500, outcome: 'open', items: [] }, { runMs: 800 }),
        subagent('Check the links', 'Check every external link in the docs', { startMs: 600, outcome: { error: { message: 'The provider returned an invalid request', code: 'INVALID_REQUEST' } }, items: [step({ stream: false, text: 'Checking links…', tools: [tool('bash', { command: 'linkcheck docs', description: 'Check links' }, { result: '[exit code: 2]', error: true, runMs: 700 })] })] }, { runMs: 800 }),
        subagent('Draft release notes', 'Draft the release notes', { startMs: 700, outcome: 'interrupted', items: [step({ stream: false, text: 'Collecting commits…' })] }, { runMs: 800 }),
      ],
    }),
    pause(1500),
    step({ text: 'All three tracks are started. I will wait for the survey to finish.' }),
  ])],
}

const childStream = {
  summary: 'a continuable subagent with a live Agent that streams for about a minute; open /agents, pick it, and watch its view stream',
  items: [turn('Rewrite the README hero in the background.', [
    step({
      text: 'A background subagent is rewriting the hero. Open /agents to follow it.',
      tools: [subagent('Rewrite README hero', 'Rewrite the README hero section around the new brand', {
        mode: 'continuable',
        live: true,
        outcome: 'open',
        startMs: 500,
        items: [step({
          reasoning: 'Reading the current hero first, then matching its tone to the brand notes. The headline should stay short and the subtitle should name the three product pillars.',
          reasoningMs: 6000,
          text: 'Draft hero:\n\n# Mayfly\n\nEphemeral agents, enduring works.\n\nMayfly runs your coding agents in a terminal that stays readable: streamed answers, tool cards that fold, and a transcript that survives a restart. Every turn is recorded as facts, so a resumed session shows exactly what happened, and a long task never loses its place.\n\nWhat is next: tighten the subtitle, add the install line, and check the links.',
          textMs: 50_000,
          chunk: 10,
        })],
      }, { runMs: 800 })],
    }),
    step({ text: 'The subagent is running; I will check on it later.' }),
  ])],
}

const approvals = {
  summary: 'a tool call that waits for your permission, then runs; answer the panel with the keys',
  items: [turn('Clean the build output.', [
    step({
      text: 'This deletes the build directory, which needs your approval.',
      tools: [tool('bash', { command: 'rm -rf dist build', description: 'Delete the build output' }, { ask: approval('bash', 'The command removes files outside the tracked sources.'), result: '[exit code: 0]', runMs: 900 })],
    }),
    step({ text: 'The build output is gone.' }),
  ])],
}

const questions = {
  summary: 'a question panel with options; answer it with the keys, then the turn continues',
  items: [turn('Set up the project for me; ask me what you need.', [
    step({
      text: 'Two quick questions before I start.',
      tools: [tool('ask_user_question', { questions: [] }, {
        ask: question([
          { id: 'runtime', header: 'Runtime', question: 'Which runtime should the project target?', options: [{ label: 'Node 22 (Recommended)', description: 'Current LTS line' }, { label: 'Node 24', description: 'Latest release' }, { label: 'Bun', description: 'Alternative runtime' }] },
          { id: 'tests', header: 'Tests', question: 'Which test runner do you want?', options: [{ label: 'node:test', description: 'Built in, no dependency' }, { label: 'vitest', description: 'Fast, watch mode' }] },
        ]),
        result: 'The user answered: Node 22, node:test.',
        runMs: 500,
      })],
    }),
    step({ text: 'Thanks. I will target Node 22 and use node:test.' }),
  ])],
}


const lines = (count, make) => Array.from({ length: count }, (_, index) => make(index + 1)).join('\n')
const LONG_LOG = lines(90, n => `[${String(n).padStart(2, '0')}] build step ${String(n)} finished in ${String(10 + n * 3)} ms`)
const LONG_FILE = lines(140, n => `export const value${String(n)} = ${String(n)} // generated line ${String(n)}`)

const toolkit = {
  summary: 'every kind of tool card: grouped reads and searches, web, skill, jobs, present, image, MCP, unknown, and long folded outputs',
  items: [turn('Survey the project and report what you find.', [
    step({
      reasoning: 'I will read the entry points in parallel, search for usages, and check the docs online.',
      text: 'Reading and searching several things at once.',
      firstTokenMs: 900,
      prepareMs: 1200,
      tools: [
        tool('read', { file_path: 'src/config.mjs' }, { result: CONFIG, runMs: 500 }),
        tool('read', { file_path: 'src/client.mjs' }, { result: "import { config } from './config.mjs'\n\nexport async function get(path) {}", runMs: 600 }),
        tool('read', { file_path: 'README.md', offset: 1, limit: 40 }, { result: '# replay-app\n\nA tiny service.', runMs: 700 }),
        tool('grep', { pattern: 'config', include: '*.mjs' }, { result: 'src/client.mjs:1:import { config } from \'./config.mjs\'\nsrc/client.mjs:4:  config.baseUrl', runMs: 800 }),
        tool('glob', { pattern: '**/*.test.mjs' }, { result: 'tests/config.test.mjs', runMs: 400 }),
        tool('web_search', { query: 'node:test describe it nesting' }, { result: '1. Node.js test runner docs — https://nodejs.org/api/test.html\n2. Writing tests with node:test — https://example.com/node-test', runMs: 1800 }),
        tool('web_fetch', { url: 'https://nodejs.org/api/test.html' }, { result: '# Test runner\n\nThe node:test module facilitates the creation of JavaScript tests.', runMs: 2200 }),
      ],
    }),
    step({
      text: 'Now skills, background work, and files for you.',
      tools: [
        tool('skill', { name: 'release-notes' }, { result: 'Loaded skill release-notes (3 steps).', runMs: 500 }),
        tool('job_list', {}, { result: 'job-1 running  npm run watch\njob-2 done     npm run build', runMs: 300 }),
        tool('job_output', { job_id: 'job-1', wait: false }, { result: 'watching for changes…\nrebuilt in 42 ms', runMs: 400 }),
        tool('present', { files: [{ path: 'README.md', description: 'The project overview' }] }, { result: 'Presented 1 file.', runMs: 300 }),
        tool('read_image', { file_path: 'docs/diagram.png' }, { result: '[image: docs/diagram.png, 1280×720]', runMs: 500 }),
        tool('mcp__github__search_issues', { query: 'is:open label:bug' }, { result: '#412 Crash on empty config\n#398 Timeout is ignored', runMs: 1500 }),
        tool('custom_inventory_tool', { scope: 'all' }, { result: '{"items": 12, "stale": 3}', runMs: 600 }),
      ],
    }),
    step({
      text: 'Finally some long outputs, which fold.',
      tools: [
        tool('bash', { command: 'npm run build', description: 'Build the project' }, { result: `${LONG_LOG}\n[exit code: 0]`, runMs: 2500 }),
        tool('read', { file_path: 'src/generated.mjs' }, { result: LONG_FILE, runMs: 700 }),
        edit('src/generated.mjs', lines(12, n => `export const value${String(n)} = ${String(n)}`), lines(12, n => `export const value${String(n)} = ${String(n * 2)}`)),
      ],
    }),
    step({ text: 'That covers every card type.', usage: { inputTokens: 9000, outputTokens: 40, cacheReadTokens: 8000 } }),
  ])],
}

const PLAN = ['## Plan: migrate to ESM', '', '1. Rename `*.cjs` entry points to `*.mjs`.', '2. Replace `require` with `import` and add `.js` extensions.', '3. Update the build and the test runner configuration.', '4. Run the tests and fix the fallout.', '', '**Risk:** dynamic `require` calls need `createRequire`.'].join('\n')

const plan = {
  summary: 'plan mode: read-only exploration, a plan review you approve or revise, then implementation',
  items: [turn('Plan the migration to ESM before changing anything.', [
    raw('plan/mode', { active: true }),
    step({
      reasoning: 'In plan mode I should only read, then present a plan for review.',
      text: 'Exploring the code first; nothing will be changed.',
      tools: [tool('grep', { pattern: 'require\\(', include: '*.cjs' }, { result: 'src/a.cjs:1\nsrc/b.cjs:3', runMs: 700 }), tool('read', { file_path: 'package.json' }, { result: '{ "type": "commonjs" }', runMs: 500 })],
    }),
    step({
      text: 'The plan is ready for your review.',
      tools: [tool('exit_plan_mode', { plan: PLAN }, {
        ask: question([{
          id: 'plan-review',
          header: 'Plan',
          question: 'Approve this plan?',
          detail: PLAN,
          options: [{ label: 'Approve plan', description: 'Start implementing' }, { label: 'Revise plan', description: 'Send feedback first' }],
          intent: { kind: 'plan-review', approve: 'Approve plan' },
        }]),
        result: 'The user approved the plan.',
        runMs: 500,
      })],
    }),
    raw('plan/mode', { active: false }),
    step({ text: 'Plan approved. Starting with step 1.', tools: [tool('bash', { command: 'git mv src/a.cjs src/a.mjs', description: 'Rename the first entry point' }, { result: '[exit code: 0]', runMs: 600 })] }),
    step({ text: 'Step 1 is done; the rest follows the plan.' }),
  ])],
}

const goal = {
  summary: 'a goal moving through active, blocked, resumed, and complete, shown in the status row and the todo pane',
  items: [turn('Work towards the goal: migrate to ESM.', [
    goalItem('create', { objective: 'Migrate the project to ESM and keep the tests green', maxGoalRounds: 8 }),
    step({ text: 'Working on round 1 of the goal.', tools: [todos([['in_progress', 'Rename the entry points'], ['pending', 'Fix the imports']])] }),
    pause(2500),
    goalItem('block', { code: 'needs-input', message: 'Waiting for a decision on the build tool' }),
    step({ text: 'Blocked: I need a decision on the build tool before continuing.' }),
    pause(2500),
    goalItem('resume'),
    step({ text: 'Resumed. Finishing the imports.', tools: [todos([['completed', 'Rename the entry points'], ['completed', 'Fix the imports']])] }),
    pause(2500),
    goalItem('complete'),
    step({ text: 'The goal is complete.' }),
  ])],
}

const queued = {
  summary: 'messages typed while the agent works, waiting in the queued-message pane (Queued: for the next turn, Steer: for the next step)',
  items: [turn('Refactor the parser, I will add more while you work.', [
    queue(['Then update the README', { steer: 'Also keep the public API unchanged' }], { holdMs: 6000 }),
    step({
      reasoning: 'Reading the parser first. Two follow-up messages are already waiting.',
      text: 'Reading the parser and listing the call sites. While this runs, the pane above the editor shows what you queued.',
      reasoningMs: 1500,
      textMs: 4000,
      tools: [tool('read_file', { path: 'src/parser.ts' }, { result: 'export function parse() {}', runMs: 800 })],
    }),
    queue([{ steer: 'Skip the lexer for now' }, 'And bump the version', 'Finally run the full tests'], { holdMs: 5000 }),
    step({ text: 'Rewriting the parser entry point now.', textMs: 3000, tools: [tool('bash', { command: 'pnpm test parser', description: 'Run the parser tests' }, { result: 'ok\n[exit code: 0]', runMs: 2500 })] }),
    step({ text: 'The refactor is done; the queued messages were withdrawn.' }),
  ])],
}

const retries = {
  summary: 'provider retries: failed attempts leave partial output that the retry replaces, with the retry policy records in the trace',
  items: [turn('Summarise the changelog.', [
    step({
      failedAttempts: [
        { text: 'The changelog lists three', failure: { message: 'The provider is overloaded', code: 'overloaded', status: 529 }, delayMs: 2500 },
        { reasoning: 'Trying again after the overload.', failure: { message: 'The request timed out', code: 'timeout', status: 504 }, delayMs: 4000, ms: 900 },
      ],
      text: 'The changelog lists three changes: a faster parser, a new CLI flag, and a fix for Windows paths.',
    }),
  ])],
}

const sideQuestion = {
  summary: 'a /btw side question answered by an Agent of its own while the main conversation waits behind it (F7 goes back)',
  items: [
    turn('Plan the release.', [step({ text: 'Release plan: bump the version, update the changelog, tag, and publish.' })]),
    btw('What does semver say about a breaking change?', [
      step({ reasoning: 'A short factual answer is enough.', text: 'A breaking change bumps the major version (for 0.x versions, the minor).', reasoningMs: 1200, textMs: 2500 }),
    ], { label: 'semver breaking change' }),
  ],
}

const notices = {
  summary: 'the footer notices above the editor: info, success, warning, error with detail, and a running operation',
  items: [turn('Show me every kind of notice.', [
    notify('info', 'Session saved to ~/.dsh/sessions', { holdMs: 3000 }),
    notify('success', 'Copied the last answer to the clipboard', { holdMs: 3000 }),
    notify('warning', 'The clipboard tool is missing; falling back to OSC 52', { holdMs: 3000, detail: 'Install xclip or wl-clipboard for a system clipboard.' }),
    notify('error', 'Could not write the export: permission denied', { holdMs: 3000, detail: 'EACCES: permission denied, open /root/export.md' }),
    notify('info', 'Indexing the workspace…', { holdMs: 3500, purpose: 'progress' }),
    step({ text: 'Those were all four severities plus a running operation.' }),
  ])],
}

const header = (model, effort, reason = 'change') => raw('request/header', { header: { config: { provider: 'deepseek-official', model, reasoningEffort: effort } }, reason })

const modes = {
  summary: 'plan and yolo badges, the permission preset, and a model and effort switch mid-session',
  items: [
    turn('First, in the default mode.', [step({ text: 'This runs in workspace-write mode, asking before wider access.' })]),
    turn('Now with full access and no approvals.', [
      raw('permission/preset', { preset: 'danger-full-access' }),
      raw('sandbox/mode', { mode: 'danger-full-access' }),
      raw('approval/policy', { policy: 'never' }),
      step({ text: 'The yolo badge is on: full file access and no approval prompts.' }),
    ]),
    turn('Switch the model.', [
      header('deepseek-pro', 'max'),
      step({ reasoning: 'Now on the larger model with maximum effort.', text: 'Switched to deepseek-pro at max effort.' }),
    ]),
    turn('And plan mode on top.', [
      raw('plan/mode', { active: true }),
      step({ text: 'Plan mode is on together with yolo.' }),
    ]),
    turn('Back to the safe defaults.', [
      raw('plan/mode', { active: false }),
      raw('permission/preset', { preset: 'workspace-write' }),
      raw('sandbox/mode', { mode: 'workspace-write' }),
      raw('approval/policy', { policy: 'ask' }),
      header('deepseek-flash', 'high'),
      step({ text: 'Defaults restored.' }),
    ]),
  ],
}

const context = {
  summary: 'a small context window filling up step by step until an automatic compaction relieves it',
  options: { contextWindow: 32_768 },
  items: [turn('Keep reading until the context is nearly full.', [
    step({ text: 'First chunk.', usage: { inputTokens: 6_000, outputTokens: 80, cacheReadTokens: 2_000 }, tools: [tool('read', { file_path: 'a.log' }, { result: LONG_LOG, runMs: 500 })] }),
    step({ text: 'Second chunk.', usage: { inputTokens: 12_000, outputTokens: 80, cacheReadTokens: 6_000 }, tools: [tool('read', { file_path: 'b.log' }, { result: LONG_LOG, runMs: 500 })] }),
    step({ text: 'Third chunk; the footer should now warn.', usage: { inputTokens: 18_000, outputTokens: 80, cacheReadTokens: 10_000 }, tools: [tool('read', { file_path: 'c.log' }, { result: LONG_LOG, runMs: 500 })] }),
    step({ text: 'Fourth chunk: nearly full.', usage: { inputTokens: 24_000, outputTokens: 80, cacheReadTokens: 14_000 }, tools: [tool('read', { file_path: 'd.log' }, { result: LONG_LOG, runMs: 500 })] }),
    step({ text: 'Fifth chunk: over the limit.', usage: { inputTokens: 30_500, outputTokens: 80, cacheReadTokens: 20_000 } }),
    compaction({ ms: 3000, shadowedTokens: 28_000, shadowedItems: 9, summary: 'The user asked to read four log files; all four were read and contain build step lines.' }),
    step({ text: 'After compaction the context is small again.', usage: { inputTokens: 2_400, outputTokens: 40, cacheReadTokens: 0 } }),
  ])],
}

const prompts = {
  summary: 'user message variants: very long and folded, multi-line with code, CJK, and an attached image',
  items: [
    turn(lines(40, n => `Line ${String(n)} of a very long pasted prompt that should fold in the transcript instead of taking the whole screen.`), [step({ text: 'I read the long prompt.' })]),
    turn('Please look at this:\n\n```js\nexport const answer = 42\nconsole.log(answer)\n```\n\nand tell me what it prints.', [step({ text: 'It prints `42`.' })]),
    turn('请用中文解释这个函数的作用，并给出一个简短的例子。', [step({ reasoning: '用户用中文提问，我应当用中文回答。', text: '这个函数把配置里的基础地址和超时时间格式化成一行文字，例如 `http://localhost:8080 (timeout 3000 ms)`。' })]),
    turn([text('Here is a screenshot of the error:'), image('error.png')], [step({ text: 'The screenshot shows a timeout error on the client.' })]),
  ],
}

const turns = {
  summary: 'the stream of turns: the turn rule with its start time, prompts of every shape (wrapped, folded, CJK), an interrupted turn, and queued messages',
  items: [
    turn('Update the landing page hero copy and run the tests.', [
      step({ text: 'I will read the hero first.', tools: [tool('read', { file_path: 'website/index.md' }, { result: '# Mayfly\n\nBuild agents faster.', runMs: 400 })] }),
      step({ text: 'Done — the hero now reads “Ship agent UI in a keystroke”; all 214 tests pass.' }),
    ], { startAt: '10:02' }),
    turn('Before the release, audit every place that still prints "Working" instead of "Deep diving": the activity row, the tips, the website pages, and the screenshots. List each file you changed, keep the diff small, and do not touch the locale files for other languages. Run the width scan when you are done and tell me which cases cover narrow terminals.', [
      step({ text: 'Searching for the old label.', tools: [tool('grep', { pattern: 'Working', path: 'src' }, { result: 'src/tips.ts:12: Working · @ files', runMs: 400 })] }),
      step({ text: 'Done — 5 files updated; the width scan has 6 narrow cases (24 to 60 columns) and all pass.' }),
    ], { startAt: '10:03' }),
    turn(lines(7, n => `Check ${String(n)}: the ${['header', 'footer', 'editor', 'banner', 'queue', 'status row', 'overlay'][n - 1]} still fits at 40 columns.`), [step({ text: 'All seven fit; the overlay needed a one-column trim.' })], { startAt: '10:09' }),
    turn('请把这一段说明翻译成中文，并且保留原来的标点：each turn ends with one quiet closing row, and a prompt longer than four lines folds behind a muted row that opens with Enter.', [step({ text: '已翻译；标点保持不变。' })], { startAt: '10:11' }),
    turn('Run the full gate, and I will stop you halfway.', [
      step({ text: 'Starting the full gate.', tools: [tool('bash', { command: 'pnpm run check -- --tier full', description: 'Run the full gate' }, { result: 'stopped', runMs: 1500 })] }),
    ], { startAt: '10:14', outcome: 'interrupted' }),
    mark('settled'),
    turn('Now regenerate the screenshots and check that they are fresh.', [
      queue(['Then update the changelog', { steer: 'Keep the diff small' }], { holdMs: 8000 }),
      mark('queued'),
      step({ text: 'Running shots:sync first.', textMs: 1500, tools: [tool('bash', { command: 'pnpm run shots:sync', description: 'Regenerate the screenshots' }, { result: 'wrote 14 screenshots', runMs: 1200 })] }),
      step({ text: 'Screenshots are fresh: shots:sync wrote 14 files.' }),
    ], { startAt: '10:16' }),
  ],
}

const phases = {
  summary: 'activity phases: waiting for the first token, reasoning only, text only, and a tool call being prepared',
  items: [
    turn('Show me every activity phase.', [
      step({ firstTokenMs: 4000, reasoning: 'Thinking only, with no visible answer yet.', reasoningMs: 4000, stream: true, tools: [tool('read', { file_path: 'README.md' }, { result: '# replay-app', runMs: 500 })] }),
      step({ text: 'A text-only step that streams slowly so the composing phase stays visible for a while.', textMs: 5000 }),
      step({ text: 'Now a large edit is prepared.', textMs: 800, prepareMs: 5000, tools: [edit('src/config.mjs', lines(6, n => `  setting${String(n)}: ${String(n)},`), lines(6, n => `  setting${String(n)}: ${String(n + 1)},`))] }),
      step({ text: 'Done.' }),
    ]),
  ],
}

const manualCompact = {
  summary: 'a manual /compact between turns, with the command row and its checkpoint',
  items: [
    turn('Read the readme.', [step({ text: 'Reading.', tools: [tool('read', { file_path: 'README.md' }, { result: '# replay-app', runMs: 500 })] }), step({ text: 'Done reading.' })]),
    compaction({ manual: true, ms: 2500, shadowedTokens: 9_000, shadowedItems: 5, summary: 'The user asked to read README.md, which was read.' }),
    turn('What did I ask before?', [step({ text: 'You asked me to read the readme.' })]),
  ],
}

const history = {
  summary: 'a long conversation of 150 short turns, for scrolling, windowing, and performance',
  items: Array.from({ length: 150 }, (_, index) => turn(`Question number ${String(index + 1)}: what does module ${String(index + 1)} do?`, [
    step({ stream: false, waitMs: 20, gapMs: 10, text: `Module ${String(index + 1)} exports one helper.`, tools: index % 3 === 0 ? [tool('read', { file_path: `src/module${String(index + 1)}.mjs` }, { result: `export const helper${String(index + 1)} = () => ${String(index + 1)}`, runMs: 20 })] : [] }),
    step({ stream: false, waitMs: 20, gapMs: 10, text: 'That is all it does.' }),
  ], { gapMs: 20 })),
}

const jobs = {
  summary: 'background jobs in the registry: one running with live output, one completed, one failed; open them with /jobs',
  items: [turn('Start the background work.', [
    step({ text: 'Starting three background jobs.', tools: [tool('bash', { command: 'npm run watch', description: 'Watch the sources', run_in_background: true }, { result: 'Started job job-1 in the background.', runMs: 500 })] }),
    job('npm run watch', { lines: [[300, 'watching for changes…'], [3000, 'rebuilt src/config.mjs in 42 ms'], [7000, 'rebuilt src/client.mjs in 38 ms']], progress: [[500, 'watching'], [3000, 'rebuilt 1'], [7000, 'rebuilt 2']] }),
    job('npm run build', { lines: [[200, 'compiling…'], [1500, 'done in 1.4 s']], endMs: 1800, status: 'completed', detail: 'exit code: 0' }),
    job('npm test', { lines: [[200, '✔ config'], [900, '✖ client: timeout ignored']], endMs: 1200, status: 'failed', detail: 'exit code: 1' }),
    // All three run here; a job that settles later wakes the agent for a real turn on the stub, at real time.
    mark('running'),
    step({ text: 'All three are registered; the watcher keeps running.' }),
    pause(10_000),
  ])],
}

const RICH = [
  '## Rich markdown',
  '',
  '> A blockquote with **bold**, *italic*, `code`, and a [link](https://example.com).',
  '',
  '- [x] done task',
  '- [ ] open task',
  '  - nested item one',
  '    - deeper item',
  '',
  '1. first',
  '2. second',
  '',
  '| 名称 | 说明 | 状态 |',
  '| --- | --- | :-: |',
  '| 配置 | 读取设置并格式化 | ✅ |',
  '| client | makes requests with a timeout that is long enough to wrap the cell at narrow widths | ⚠️ |',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[Prompt] --> B{Model}',
  '  B -->|tool| C[Run]',
  '  B -->|text| D[Answer]',
  '```',
  '',
  '```diff',
  '- const timeout = 1000',
  '+ const timeout = 3000',
  '```',
  '',
  '---',
  '',
  'Wide text: 日本語のテキストと한국어 텍스트, and emoji 🚀🔥👩‍💻 mixed with ASCII.',
].join('\n')

const edge = {
  summary: 'rendering edge cases: wide characters, emoji, ANSI colour in output, a very long line, empty results, and rich markdown',
  items: [turn('Show me the awkward cases.', [
    step({
      text: 'Output with colour codes, tabs, wide characters, and an extremely long line.',
      tools: [
        tool('bash', { command: 'ls --color=always', description: 'List with colour' }, { result: '\u001b[34msrc\u001b[0m  \u001b[32mrun.sh\u001b[0m  \u001b[1;31mERROR\u001b[0m\tcolumns\talign\n[exit code: 0]', runMs: 600 }),
        tool('bash', { command: 'cat wide.txt', description: 'Show wide text' }, { result: '日本語のとても長い行がここにあります、幅の計算が正しいことを確認します。\n한국어 텍스트도 마찬가지입니다 🚀 👩‍💻\n[exit code: 0]', runMs: 600 }),
        tool('bash', { command: 'cat one-line.json', description: 'A single huge line' }, { result: `${'x'.repeat(600)}\n[exit code: 0]`, runMs: 600 }),
        tool('bash', { command: 'true', description: 'No output' }, { result: '[exit code: 0]', runMs: 300 }),
        tool('read', { file_path: 'empty.txt' }, { result: '', runMs: 300 }),
        tool('grep', { pattern: 'nothing-matches' }, { result: 'No matches found', runMs: 300 }),
      ],
    }),
    step({ reasoning: '推理内容也可能包含中文，以及 emoji 🤔 和很长的一行，用来检查思考块的换行与宽度计算是否正确。'.repeat(3), text: RICH, textMs: 4000, chunk: 20 }),
  ])],
}

const lines60 = lines(60, n => `mouse-line-${String(n - 1).padStart(2, '0')}`)
const wheel = {
  summary: 'a 60-line answer in a narrow terminal, for the mouse wheel to scroll',
  items: [turn('ping', [step({ text: lines60, textMs: 1500 })])],
}

/** Roughly a megabyte of generated source: the write card clips it and /trace keeps the whole document in its scroll. */
const GENERATED_RECORDS = lines(4_000, n => `export const record${String(n).padStart(5, '0')} = { index: ${String(n)}, payload: '${'x'.repeat(200)}' }`)

const content = {
  summary: 'a megabyte write: its card keeps to head rows, and the trace detail pages, ends, and resizes inside the document scroll',
  items: [turn('Generate the large fixture.', [
    step({ text: 'I will write the generated records to one file.' }),
    step({ tools: [tool('write', { file_path: 'fixtures/generated.ts', content: GENERATED_RECORDS }, { result: 'Wrote fixtures/generated.ts', runMs: 900 })] }),
  ])],
}

export const REPLAYS = { tour, toolkit, thinking, markdown, phases, prompts, turns, errors, compaction: compactionReplay, manualCompact, context, subagents, childStream, approvals, questions, plan, goal, jobs, queued, retries, sideQuestion, notices, modes, edge, history, wheel, content }

/*
 * The scenes of the Website's app shots. Each is the source of an `app-*` scenario of the catalog, whose goldens the
 * shots are painted from; they are not listed as replays of their own.
 */

const HERO = turn('Update the landing page hero copy and run the tests.', [
  step({
    reasoning: 'The hero lives in website/index.md; read it first, then edit, then run the suite.',
    text: 'I will update the hero copy first, then run the tests.',
    usage: { inputTokens: 12_410, outputTokens: 96, cacheReadTokens: 8_192 },
    tools: [tool('read', { file_path: 'website/index.md' }, { result: '# Mayfly\n\nThe terminal UI for DeepSeek Harness.\n\nShip agent UI in a keystroke.', runMs: 600 })],
  }),
  step({ usage: { inputTokens: 13_020, outputTokens: 40, cacheReadTokens: 8_192 }, tools: [tool('bash', { command: 'pnpm run test' }, { result: '✓ 214 tests passed (12 suites)', runMs: 3400 })] }),
  step({ text: 'Done — the hero now reads “Ship agent UI in a keystroke”, and all 214 tests pass.', usage: { inputTokens: 15_234, outputTokens: 128, cacheReadTokens: 8_192 } }),
])

const appConversation = {
  summary: 'a finished turn: thinking, a read and a bash tool card, and the answer',
  items: [HERO],
}

const appAgents = {
  summary: 'one step spawning three subagents, done, running, and waiting, shown in the agents pane',
  items: [
    turn('Split the rebranding into parallel tracks.', [
      step({
        stream: false,
        tools: [
          subagent('Survey shot embeds', 'Survey every website page that embeds component shots', { items: [step({ stream: false, tools: [tool('read', { file_path: 'website/features/index.md' }, { result: 'three pages reference the gallery', runMs: 600 })] }), step({ stream: false, text: 'Found three pages embedding shots.' })] }, { runMs: 800 }),
          subagent('Rewrite README hero', 'Rewrite the README hero section around the new brand', { startMs: 500, outcome: 'open', items: [step({ stream: false, reasoning: 'Mapping the hero copy against the brand tokens…', tools: [tool('bash', { command: 'pnpm run build', description: 'Build the site' }, { result: '', runMs: 600_000 })] })] }, { runMs: 800 }),
          subagent('Regenerate shot gallery', 'Regenerate the component shot gallery', { startMs: 1500, outcome: 'open', items: [] }, { runMs: 800 }),
        ],
      }),
      pause(4000),
      step({ text: 'The survey is done; the other two tracks are running.' }),
    ]),
    // The running track's build ends ten minutes later; the scene is captured before it.
    mark('running'),
  ],
}

const DAY = 86_400_000
const HOUR = 3_600_000
/** One finished turn of a stored conversation. */
const earlier = (prompt, answer, usage) => [turn(prompt, [step({ text: answer, usage })])]
const appSessions = {
  summary: 'earlier conversations in this workspace and in two others, listed by /sessions',
  items: [
    seed([
      { id: 'seed-branding', at: -3 * DAY, title: 'Mayfly branding exploration', items: earlier('Explore a brand for Mayfly.', 'Three directions, with the mayfly mark as the anchor.', { inputTokens: 32_000, outputTokens: 1_900, cacheReadTokens: 28_000 }) },
      { id: 'seed-trace', at: -2 * DAY, parent: 'seed-branding', title: 'Trace panel polish', items: earlier('Tighten the trace panel rows.', 'The rows now align on the event type.', { inputTokens: 10_300, outputTokens: 400, cacheReadTokens: 9_000 }) },
      { id: 'seed-panes', at: -DAY, parent: 'seed-branding', title: 'Sidebar panes', items: earlier('Add a side pane for todos.', 'The todo pane docks beside the transcript.', { inputTokens: 544_000, outputTokens: 12_000, cacheReadTokens: 480_000 }) },
      { id: 'seed-hotfix', at: -4 * DAY, title: 'Hotfix release notes', items: earlier('Write the hotfix release notes.', 'Release notes drafted for 0.1.1.', { inputTokens: 4_000, outputTokens: 300, cacheReadTokens: 0 }) },
      { id: 'seed-hotfix-2', at: -4 * DAY + HOUR, parent: 'seed-hotfix', title: 'Hotfix follow-up', items: earlier('Link the issue from the notes.', 'Linked.', { inputTokens: 2_000, outputTokens: 50, cacheReadTokens: 0 }) },
      { id: 'seed-docs', at: -DAY, cwd: 'docs', title: 'Docs navigation', items: earlier('Reorder the docs sidebar.', 'Guide first, then reference.', { inputTokens: 3_000, outputTokens: 200, cacheReadTokens: 0 }) },
      { id: 'seed-api', at: -2 * DAY, cwd: 'api', title: 'API pagination', items: earlier('Add cursor pagination.', 'Cursors replace page numbers.', { inputTokens: 6_000, outputTokens: 500, cacheReadTokens: 0 }) },
    ]),
    turn('Paint the app screenshots from the scenario goldens.', [step({ text: 'The Website app shots now come from the accepted goldens.' })]),
  ],
}

export const SCENES = { appConversation, appAgents, appSessions }

/** A replay or a scene by name. */
export const timelineNamed = name => Object.hasOwn(REPLAYS, name) ? REPLAYS[name] : Object.hasOwn(SCENES, name) ? SCENES[name] : undefined
