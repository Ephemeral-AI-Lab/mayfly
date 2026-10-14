/**
 * The replays of the workbench: conversations written as data, played into a live session by the replay driver so a
 * review needs no model, no quota, and no tools. Each replay shows a family of UI states; a component draft adds the
 * replay that shows its states. See `timeline.mjs` for the builders. @module script/scenarios/replays
 */

import { approval, compaction, edit, editHunks, write, goal as goalItem, goalRound, image, btw, job, mark, notify, pause, question, queue, raw, seed, step, subagent, text, todos, tool, turn } from './timeline.mjs'

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

/** The presenter metadata of a `read` result: `shown` numbered lines of a file of `total`. */
const readMeta = (path, shown, total, offset = 1) => ({ path, offset, totalLines: total, lines: Array.from({ length: shown }, (_, index) => ({ number: offset + index, text: `export const value${String(offset + index)} = render(${String(offset + index)}) // ${path}` })) })
/** The presenter metadata of a `grep` result: `total` matches spread over `files` files. */
const grepMeta = (files, total) => ({ shape: 'matches', truncated: false, total, files: Array.from({ length: files }, (_, index) => ({ path: `src/module${String(index + 1)}.mjs`, matches: [{ lineNumber: index + 3, line: 'const activity = phase' }] })) })
/** The presenter metadata of a `glob` result. */
const globMeta = (paths) => ({ shape: 'paths', truncated: false, total: paths.length, paths })
/** The text of a `read` result: the envelope the presenter recognizes around the file's lines. */
const readText = (path, body) => `<path>${path}</path>\n<type>file</type>\n<content>\n${body}\n</content>`
const PANE_ACTIVITY = 'packages/mayfly/src/transcript/pane-activity.ts'
const LONG_COMMAND = 'pnpm run check -- --tier round --base origin/main --plan --why && pnpm run scenarios -- --png toollines toolkit errors'

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

const live = {
  summary: 'a long streamed answer, then two more turns with a tool call: what a view scrolled away from the tail has not seen',
  items: [
    turn('Explain the rendering pipeline.', [step({ text: reply(), textMs: 6000, chunk: 24, marks: [{ name: 'half', block: 'text', at: 0.5 }] })]),
    turn('Check the readme too.', [
      step({ text: 'Reading it.', tools: [tool('read', { file_path: 'README.md' }, { result: '# replay-app\n\nA tiny service used by the Mayfly workbench replays.', runMs: 500 })] }),
      step({ text: 'The readme confirms it: the service is tiny.' }),
    ]),
    turn('And the tests?', [step({ text: 'All of them pass.' })]),
  ],
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
    turn('Try again, but I will stop you.', [step({ text: 'Starting a long task… ', tools: [tool('bash', { command: 'sleep 60', description: 'Wait' }, { result: '', runMs: 4000, unanswered: true })] })], { outcome: 'aborted' }),
    turn('And once more.', [step({ text: 'Working on it, then the request is cut off.' })], { outcome: 'aborted' }),
  ],
}

const compactionReplay = {
  summary: 'an automatic compaction between steps: summarizing, applying with the bar draining, then settled, and the turn continues',
  options: { contextWindow: 65_536 },
  items: [turn('Read the readme and summarise it.', [
    step({ text: 'Reading the readme.', usage: { inputTokens: 40_000, outputTokens: 120, cacheReadTokens: 19_500 }, tools: [tool('read', { file_path: 'README.md' }, { result: '# replay-app\n\nA tiny service used by the Mayfly workbench replays.', runMs: 500 })] }),
    compaction({ ms: 4000, applyMs: 1600, shadowedTokens: 53_000, shadowedItems: 14, summaryTokens: 900, marks: [{ name: 'summarizing', stage: 'summarize', at: 0.7 }, { name: 'applying', stage: 'apply', at: 0.4 }], summary: 'The user asked for a summary of README.md.\nIt was read: a tiny service with a config module and a client module.\nNo files were changed.' }),
    pause(1800),
    mark('settled'),
    step({ text: 'The readme describes a tiny service with a config module and a client module.', usage: { inputTokens: 6_500, outputTokens: 40, cacheReadTokens: 0 } }),
  ])],
}

const compactionFailed = {
  summary: 'a compaction that fails: the summarizing stage, then the failure row with its reason',
  options: { contextWindow: 65_536 },
  items: [turn('Keep going with the long task.', [
    step({ text: 'Working through the files.', usage: { inputTokens: 40_000, outputTokens: 120, cacheReadTokens: 19_500 } }),
    compaction({ ms: 3000, error: 'context still over budget after summary', marks: [{ name: 'summarizing', stage: 'summarize', at: 0.6 }] }),
    pause(600),
    mark('failed'),
    step({ text: 'The compaction failed, so I carry on with the full context.', usage: { inputTokens: 41_000, outputTokens: 60, cacheReadTokens: 20_000 } }),
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
  summary: 'a command that deletes files waits for your permission: its call is the request, a card decides; a digit chooses, Esc rejects',
  items: [turn('Clean the build output.', [
    step({
      text: 'This deletes the build directory, which needs your approval.',
      tools: [tool('bash', { command: 'rm -rf dist build', description: 'Delete the build output' }, { ask: approval('bash', 'The command removes files outside the tracked sources.'), result: '[exit code: 0]', outcomes: { rejected: { result: 'The user rejected this call.', error: true } }, runMs: 900 })],
    }),
    step({ text: 'That is settled; tell me what is next.' }),
  ])],
}

const approvalsRejected = {
  summary: 'a rejection with a note: the note goes to the agent, the call settles as rejected, and the agent changes course',
  items: [turn('Publish the release.', [
    step({
      text: 'Publishing means pushing the tag to main.',
      tools: [tool('bash', { command: 'git push --force origin main', description: 'Force-push the release' }, { ask: approval('bash', 'A force push rewrites the remote history.'), result: 'The user rejected this call.', error: true, runMs: 300 })],
    }),
    step({ text: 'Understood: I will push a branch and open a pull request instead.', tools: [tool('bash', { command: 'git push origin release/1.4', description: 'Push the release branch' }, { result: '[exit code: 0]', runMs: 700 })] }),
    step({ text: 'The branch is pushed.' }),
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
        tool('read', { file_path: 'src/config.mjs' }, { result: readText('src/config.mjs', CONFIG.trimEnd()), runMs: 500, meta: readMeta('src/config.mjs', 8, 8) }),
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

/** A plan review as the plan-mode tool puts it: the plan is its argument, and the question offers the tool's own two labels. */
const planReview = (planText, runMs = 500) => tool('exit_plan_mode', { plan: planText }, {
  ask: question([{
    id: 'plan-review',
    header: 'Plan review',
    question: 'Approve this plan and leave plan mode?',
    detail: planText,
    options: [{ label: 'Approve', description: 'Leave plan mode; the plan is carried out from the next step.' }, { label: 'Keep planning', description: 'Stay in plan mode; feedback goes back to the model.' }],
    intent: { kind: 'plan-review', approve: 'Approve' },
  }]),
  result: 'Plan approved — plan mode exited; carry out the plan starting with your next step.',
  // What the plan-mode tool answers when the plan is sent back: with the user's revision, or without it.
  outcomes: {
    declined: { result: 'The user chose to keep planning; revise the plan and present it again.', error: true },
    revised: { result: 'The user chose to keep planning; their feedback: {feedback}', error: true },
  },
  runMs,
})

const plan = {
  summary: 'plan mode: read-only exploration, then the plan as a request in the stream and a card to approve, keep planning (with a revision), or reject; the call settles as you answer',
  items: [turn('Plan the migration to ESM before changing anything.', [
    raw('plan/mode', { active: true }),
    step({
      reasoning: 'In plan mode I should only read, then present a plan for review.',
      text: 'Exploring the code first; nothing will be changed.',
      tools: [tool('grep', { pattern: 'require\\(', include: '*.cjs' }, { result: 'src/a.cjs:1\nsrc/b.cjs:3', runMs: 700 }), tool('read', { file_path: 'package.json' }, { result: '{ "type": "commonjs" }', runMs: 500 })],
    }),
    step({ text: 'The plan is ready for your review.', tools: [planReview(PLAN)] }),
    step({ text: 'Understood; I will go on from your decision.' }),
  ])],
}

const PLAN_LONG = ['# Plan: split the painter into layers', '', 'The painter grows by one row kind per release; this plan separates the layers before the next one lands.', '', ...Array.from({ length: 14 }, (_, index) => [`## Phase ${String(index + 1)}: ${['inventory', 'contracts', 'facts', 'rows', 'blocks', 'cards', 'motion', 'keys', 'widths', 'themes', 'locale', 'perf', 'docs', 'release'][index]}`, '', `${String(index * 4 + 1)}. Read every caller of the layer and list what it assumes.`, `${String(index * 4 + 2)}. Write the contract the layer will keep, with one example per state.`, `${String(index * 4 + 3)}. Move the code behind the contract and delete what it replaces.`, `${String(index * 4 + 4)}. Check the scenario of the layer at every width and fix what moves.`, '', '```ts', `export function layer${String(index + 1)}(facts: Facts): Node {`, '  return compose(facts)', '}', '```', ''].join('\n')), '**Risk:** the layers share two caches; the plan moves them last.'].join('\n')

const planLong = {
  summary: 'a plan of any length under review: the whole plan is the request block, windowed as it scrolls, with no cutoff',
  items: [turn('Plan how to split the painter into layers.', [
    raw('plan/mode', { active: true }),
    step({ text: 'Here is the plan; it is long because it names every phase.', tools: [planReview(PLAN_LONG)] }),
    step({ text: 'Understood; I will go on from your decision.' }),
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

/** How long the live `scenario` stays on one state of `footerCutover`, for the owner to look at it (the frame runner stops at the marks instead). */
const DWELL = 10_000
/** The states the owner enters views in, which need time for `Alt+↓`, `←/→`, and `Esc`. */
const DWELL_VIEWS = 25_000

const footerCutover = {
  summary: 'one long conversation through the footer and the goal: one line by default, plan mode, then a goal with its rounds, a todo list, and a job in the status row (summaries; their detail opens with Alt+Down), the goal paused, resumed, blocked, and completed, a /btw side question, and back to one line; each state stays 10 to 25 s',
  options: { contextWindow: 65_536 },
  items: [
    turn('Find where the settings live and read them.', [
      step({
        reasoning: 'Start with the project layout, then the file that holds the timeout.',
        text: 'Looking at the sources first.',
        usage: { inputTokens: 3200, outputTokens: 120, cacheReadTokens: 900 },
        tools: [
          tool('glob', { pattern: '**/*.mjs' }, { result: 'src/config.mjs\nsrc/client.mjs\ntests/config.test.mjs', runMs: 500 }),
          tool('grep', { pattern: 'timeoutMs', include: '*.mjs' }, { result: 'src/config.mjs:3:  timeoutMs: 3000,\nsrc/client.mjs:4:  signal: AbortSignal.timeout(config.timeoutMs)', runMs: 700 }),
        ],
      }),
      step({ text: 'The settings are in `src/config.mjs`.', usage: { inputTokens: 3900, outputTokens: 60, cacheReadTokens: 3200 }, tools: [tool('read', { file_path: 'src/config.mjs' }, { result: CONFIG, runMs: 600 })] }),
      step({ text: 'Nothing is running besides me, so the footer is one line: the model, the directory, and the context meter.', usage: { inputTokens: 4300, outputTokens: 90, cacheReadTokens: 3900 } }),
      mark('one-line'),
      pause(DWELL),
    ]),
    turn('Add a retries option and run the tests.', [
      step({
        text: 'Adding the option next to the timeout.',
        usage: { inputTokens: 5000, outputTokens: 140, cacheReadTokens: 4300 },
        tools: [edit('src/config.mjs', "  timeoutMs: 3000,\n}", "  timeoutMs: 3000,\n  retries: 2,\n}")],
      }),
      step({
        text: 'Running the tests.',
        usage: { inputTokens: 5600, outputTokens: 70, cacheReadTokens: 5000 },
        tools: [tool('bash', { command: 'npm test 2>&1 | tail -12', description: 'Run the test suite' }, { result: `${TEST_OUTPUT}\n[exit code: 0]`, runMs: 2500 })],
      }),
      step({ text: 'The suite passes with the new option.', usage: { inputTokens: 6200, outputTokens: 60, cacheReadTokens: 5600 } }),
    ]),
    turn('Plan the landing page work before editing.', [
      raw('plan/mode', { active: true }),
      step({ text: 'Plan mode is on: the plan chip sits beside the model.', usage: { inputTokens: 6700, outputTokens: 80, cacheReadTokens: 6200 } }),
      mark('plan'),
      pause(DWELL),
      raw('permission/preset', { preset: 'danger-full-access' }),
      raw('sandbox/mode', { mode: 'danger-full-access' }),
      raw('approval/policy', { policy: 'never' }),
      step({ text: 'Yolo joins it: both chips show at once, plan then yolo.', usage: { inputTokens: 6900, outputTokens: 60, cacheReadTokens: 6700 } }),
      mark('plan-yolo'),
      pause(DWELL),
      raw('plan/mode', { active: false }),
      step({ text: 'Plan mode is off; yolo stays.', usage: { inputTokens: 7000, outputTokens: 40, cacheReadTokens: 6900 } }),
      mark('yolo'),
      pause(DWELL),
      raw('permission/preset', { preset: 'workspace-write' }),
      raw('sandbox/mode', { mode: 'workspace-write' }),
      raw('approval/policy', { policy: 'ask' }),
    ]),
    turn('Work towards the goal: refresh the landing page.', [
      goalItem('create', { objective: 'Ship the landing page hero refresh and keep all 214 tests green', maxGoalRounds: 8 }),
      step({ text: 'A goal is set: its item joins the status row after the model and the chips. The replay never arms it, so it reads off.', usage: { inputTokens: 7400, outputTokens: 90, cacheReadTokens: 7000 } }),
      mark('goal'),
      pause(DWELL),
      goalRound(1),
      step({
        text: 'Round 1: the todo list joins the goal.',
        usage: { inputTokens: 7900, outputTokens: 160, cacheReadTokens: 7400 },
        tools: [todos([['completed', 'Update the landing page hero'], ['in_progress', 'Run the tests'], ['pending', 'Update the screenshots'], ['pending', 'Bump the changelog'], ['pending', 'Open the pull request'], ['pending', 'Announce it'], ['pending', 'Tag the release'], ['pending', 'Update the docs site'], ['pending', 'Publish the release notes'], ['pending', 'Notify the translators'], ['pending', 'Archive the old banner'], ['pending', 'Close the milestone']])],
      }),
      mark('goal-todo'),
      pause(DWELL),
      goalRound(2),
      job('npm run watch', { lines: [[300, 'watching for changes…'], [20_000, 'rebuilt src/config.mjs in 41 ms']], endMs: 110_000, status: 'completed', detail: 'exit code: 0' }),
      step({ text: 'Round 2: a background job joins them in the status row. Press Alt+↓ to open the views.', usage: { inputTokens: 8400, outputTokens: 100, cacheReadTokens: 7900 } }),
      mark('goal-todo-job'),
      pause(DWELL_VIEWS),
      goalItem('pause'),
      step({ text: 'The goal is paused: the mark is ⏸ and the panel says how to continue.', usage: { inputTokens: 8600, outputTokens: 80, cacheReadTokens: 8400 } }),
      mark('paused'),
      pause(DWELL_VIEWS),
      goalItem('resume', { ifNeeded: true }),
      step({ text: 'Resumed.', usage: { inputTokens: 8700, outputTokens: 40, cacheReadTokens: 8600 } }),
      goalItem('block', { code: 'round-limit', message: 'The goal used all 8 rounds without finishing' }),
      step({ text: 'Blocked: the round cap was reached.', usage: { inputTokens: 8800, outputTokens: 70, cacheReadTokens: 8700 } }),
      mark('blocked'),
      pause(DWELL_VIEWS),
    ]),
    btw('Which release channel does semver suggest for a breaking change?', [
      step({ reasoning: 'A short factual answer is enough.', text: 'A breaking change goes out as a new major version, on the next channel first.', reasoningMs: 1200, textMs: 2500 }),
    ], { label: 'release channel' }),
    mark('btw'),
    pause(DWELL),
    turn('Pick the stable channel and wrap up.', [
      goalItem('resume', { ifNeeded: true }),
      goalItem('complete'),
      step({
        text: 'The goal is complete and the list is done; only the job is left in the status row.',
        usage: { inputTokens: 9300, outputTokens: 120, cacheReadTokens: 8800 },
        tools: [todos([['completed', 'Update the landing page hero'], ['completed', 'Run the tests'], ['completed', 'Update the screenshots'], ['completed', 'Bump the changelog'], ['completed', 'Open the pull request'], ['completed', 'Announce it'], ['completed', 'Tag the release'], ['completed', 'Update the docs site'], ['completed', 'Publish the release notes'], ['completed', 'Notify the translators'], ['completed', 'Archive the old banner'], ['completed', 'Close the milestone']])],
      }),
      mark('job'),
      pause(25_000),
      goalItem('clear'),
      mark('settled'),
      pause(DWELL),
    ]),
  ],
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
      marks: [{ name: 'overloaded', block: 'retry', attempt: 0, at: 0.4 }, { name: 'timeout', block: 'retry', attempt: 1, at: 0.4 }],
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
  summary: 'the notification pane above the editor: info, success, warning, error with detail, and a running operation, one at a time',
  items: [turn('Show me every kind of notice.', [
    notify('info', 'Session saved to ~/.dsh/sessions', { holdMs: 3000, marks: [{ name: 'info', at: 0.5 }] }),
    notify('success', 'Copied the last answer to the clipboard', { holdMs: 3000, marks: [{ name: 'success', at: 0.5 }] }),
    notify('warning', 'The clipboard tool is missing; falling back to OSC 52', { holdMs: 3000, detail: 'Install xclip or wl-clipboard for a system clipboard.', marks: [{ name: 'warning', at: 0.5 }] }),
    notify('error', 'Could not write the export: permission denied', { holdMs: 3000, detail: 'EACCES: permission denied, open /root/export.md', marks: [{ name: 'error', at: 0.5 }] }),
    notify('info', 'Indexing the workspace…', { holdMs: 3500, purpose: 'progress', marks: [{ name: 'progress', at: 0.5 }] }),
    step({ text: 'Those were all four severities plus a running operation.' }),
  ])],
}

const notificationPane = {
  summary: 'the notification pane: a rate-limit countdown, a lane notice over a turn, a context that fills up and is relieved, and a resumed session',
  options: { contextWindow: 32_768 },
  items: [
    seed([{ id: 'seed-earlier', at: -3 * 3_600_000, title: 'Earlier work', items: [
      turn('Draft the release notes.', [step({ text: 'Release notes drafted.', usage: { inputTokens: 4_000, outputTokens: 300, cacheReadTokens: 0 } })]),
      turn('Add the install section.', [step({ text: 'The install section is in.', usage: { inputTokens: 5_000, outputTokens: 200, cacheReadTokens: 0 } })]),
    ] }]),
    turn('Summarise the changelog.', [
      step({
        failedAttempts: [{ text: 'The changelog lists', failure: { message: 'Rate limit reached for requests', code: 'rate_limited', status: 429 }, delayMs: 9000 }],
        marks: [{ name: 'rate-limited', block: 'retry', attempt: 0, at: 0.3 }],
        text: 'The changelog lists three changes: a faster parser, a new CLI flag, and a fix for Windows paths.',
        usage: { inputTokens: 6_000, outputTokens: 80, cacheReadTokens: 2_000 },
      }),
    ]),
    turn('Copy it, then keep reading the logs.', [
      notify('success', 'Copied the last answer to the clipboard', { holdMs: 4500, marks: [{ name: 'toast', at: 0.4 }] }),
      step({ text: 'First log.', usage: { inputTokens: 12_000, outputTokens: 80, cacheReadTokens: 6_000 }, tools: [tool('read', { file_path: 'a.log' }, { result: LONG_LOG, runMs: 500 })] }),
      step({ text: 'Second log: the context is nearly full.', usage: { inputTokens: 24_000, outputTokens: 80, cacheReadTokens: 14_000 }, tools: [tool('read', { file_path: 'b.log' }, { result: LONG_LOG, runMs: 500 })] }),
      pause(1500),
      mark('context-full'),
      compaction({ ms: 2500, applyMs: 1000, shadowedTokens: 30_000, shadowedItems: 8, summaryTokens: 500, summary: 'The user asked to read two logs; both were read.' }),
      pause(800),
      mark('relieved'),
      step({ text: 'The context is small again.', usage: { inputTokens: 2_400, outputTokens: 40, cacheReadTokens: 0 } }),
    ]),
  ],
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
  summary: 'a small context window filling up step by step until a warning shows, then an automatic compaction relieves it',
  options: { contextWindow: 32_768 },
  items: [turn('Keep reading until the context is nearly full.', [
    step({ text: 'First chunk.', usage: { inputTokens: 4_000, outputTokens: 80, cacheReadTokens: 2_000 }, tools: [tool('read', { file_path: 'a.log' }, { result: LONG_LOG, runMs: 500 })] }),
    step({ text: 'Second chunk.', usage: { inputTokens: 6_000, outputTokens: 80, cacheReadTokens: 6_000 }, tools: [tool('read', { file_path: 'b.log' }, { result: LONG_LOG, runMs: 500 })] }),
    step({ text: 'Third chunk.', usage: { inputTokens: 8_000, outputTokens: 80, cacheReadTokens: 10_000 }, tools: [tool('read', { file_path: 'c.log' }, { result: LONG_LOG, runMs: 500 })] }),
    step({ text: 'Fourth chunk: three quarters full.', usage: { inputTokens: 10_000, outputTokens: 80, cacheReadTokens: 14_000 }, tools: [tool('read', { file_path: 'd.log' }, { result: LONG_LOG, runMs: 500 })] }),
    step({ text: 'Fifth chunk: nearly full, the notification pane warns.', usage: { inputTokens: 10_500, outputTokens: 80, cacheReadTokens: 20_000 } }),
    pause(1500),
    mark('full'),
    compaction({ ms: 3000, applyMs: 1200, shadowedTokens: 28_000, shadowedItems: 9, summaryTokens: 500, summary: 'The user asked to read four log files; all four were read and contain build step lines.' }),
    pause(1500),
    mark('relieved'),
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
      step({ text: 'Starting the full gate.', tools: [tool('bash', { command: 'pnpm run check -- --tier full', description: 'Run the full gate' }, { result: '', runMs: 1500, unanswered: true })] }),
    ], { startAt: '10:14', outcome: 'aborted' }),
    mark('settled'),
    turn('Now regenerate the screenshots and check that they are fresh.', [
      queue(['Then update the changelog', { steer: 'Keep the diff small' }], { holdMs: 8000 }),
      mark('queued'),
      step({ text: 'Running shots:sync first.', textMs: 1500, tools: [tool('bash', { command: 'pnpm run shots:sync', description: 'Regenerate the screenshots' }, { result: 'wrote 14 screenshots', runMs: 1200 })] }),
      step({ text: 'Screenshots are fresh: shots:sync wrote 14 files.' }),
    ], { startAt: '10:16' }),
  ],
}

const toollines = {
  summary: 'settled tool calls as one line each: reads, searches, commands, web, other tools, failures, and a call cut off by an interrupt',
  items: [
    turn('Survey the transcript code and check that it still builds.', [
      step({
        text: 'Reading the files first.',
        tools: [
          tool('read', { file_path: 'src/config.mjs' }, { result: readText('src/config.mjs', CONFIG.trimEnd()), runMs: 400, meta: readMeta('src/config.mjs', 8, 8) }),
          tool('read', { file_path: PANE_ACTIVITY, offset: 1, limit: 40 }, { result: readText(PANE_ACTIVITY, 'export const value1 = render(1)'), runMs: 500, meta: readMeta(PANE_ACTIVITY, 40, 481) }),
          tool('read', { file_path: 'src/missing.ts' }, { result: 'File not found: src/missing.ts', error: true, runMs: 300 }),
        ],
      }),
      step({
        text: 'Searching for the label.',
        tools: [
          tool('grep', { pattern: 'activity', path: 'packages' }, { result: 'src/module1.mjs:3:const activity = phase', runMs: 700, meta: grepMeta(12, 47) }),
          tool('grep', { pattern: 'neverUsedName', path: 'packages' }, { result: 'No matches found', runMs: 500, meta: grepMeta(0, 0) }),
          tool('glob', { pattern: '**/*.test.mjs' }, { result: 'tests/a.test.mjs', runMs: 400, meta: globMeta(['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs']) }),
        ],
      }),
      mark('searched'),
      step({
        text: 'Building and linting.',
        tools: [
          tool('bash', { command: 'pnpm run check:lib', description: 'Check the exports' }, { result: '> check:lib\nexports ok\nentries ok\nfiles ok\nsize budget ok\n4 packages checked', runMs: 4200 }),
          tool('bash', { command: 'pnpm run lint', description: 'Lint' }, { result: 'src/client.mjs:4:3  error  no-unused-vars  "signal" is assigned but never used\nsrc/client.mjs:9:1  warning  prefer-const\n2 problems (1 error, 1 warning)\n[exit code: 1]', runMs: 3000 }),
          tool('bash', { command: LONG_COMMAND, description: 'The long gate' }, { result: 'plan: 3 steps\nok', runMs: 1200 }),
        ],
      }),
      mark('built'),
      step({
        text: 'Checking the docs online.',
        tools: [
          tool('web_search', { queries: ['pi tui overflow truncate'] }, { result: '1. pi.dev\n2. example.com', runMs: 1500, meta: { sources: [{ url: 'https://pi.dev/docs/latest/tui', title: 'TUI' }, { url: 'https://example.com', title: 'Example' }], truncated: false } }),
          tool('web_fetch', { url: 'https://pi.dev/docs/latest/tui' }, { result: `# Terminal UI\n\nThe TUI library draws rows and clips them to the width.\n\n## Overflow\n\nA row either wraps or truncates.\n${lines(300, n => `Documentation line ${String(n)} of the page.`)}`, runMs: 2200, meta: { url: 'https://pi.dev/docs/latest/tui', statusCode: 200, truncated: false } }),
          tool('web_fetch', { url: 'https://example.com/big' }, { result: lines(2000, n => `Big page line ${String(n)} that is long enough.`), runMs: 3100, meta: { url: 'https://example.com/big', statusCode: 200, truncated: true } }),
        ],
      }),
      step({
        text: 'Other tools.',
        tools: [
          tool('skill', { name: 'release-notes' }, { result: 'Loaded skill release-notes (3 steps).', runMs: 500 }),
          tool('mcp__github__search_issues', { query: 'is:open label:bug' }, { result: '#412 Crash on empty config', runMs: 1500 }),
          tool('custom_inventory_tool', { scope: 'all' }, { result: '{"items": 12}', runMs: 600 }),
        ],
      }),
      step({ text: 'Everything is checked; the lint failure is the only open item.' }),
    ], { startAt: '10:20' }),
    turn('Run the long build, and I will stop you.', [
      step({
        text: 'Starting the build.',
        tools: [
          tool('read', { file_path: 'package.json' }, { result: readText('package.json', '{}'), runMs: 300, meta: readMeta('package.json', 1, 1) }),
          tool('bash', { command: 'pnpm run lint', description: 'Lint' }, { result: 'src/client.mjs:4:3  error  no-unused-vars\n[exit code: 1]', runMs: 1000 }),
          tool('bash', { command: 'pnpm run build', description: 'Build' }, { result: '', runMs: 4000, unanswered: true }),
          tool('bash', { command: 'pnpm run deploy', description: 'Deploy' }, { result: '', runMs: 50, unanswered: 'before-dispatch' }),
        ],
      }),
    ], { startAt: '10:24', outcome: 'aborted' }),
  ],
}

/** Calls that join a run while it is open: web searches are lone tool entries that gather into one block, and a fourth arrives later. */
const toolgrow = {
  summary: 'a run of web searches (separate tool entries) that gains a call after the reader opened it, and a command below it',
  items: [
    turn('Look up how the terminal clips rows, from several angles.', [
      step({
        text: 'Searching the web.',
        tools: [
          tool('web_search', { queries: ['pi tui overflow truncate'] }, { result: '1. pi.dev\n2. example.com', runMs: 600, meta: { sources: [{ url: 'https://pi.dev/docs/latest/tui', title: 'TUI' }, { url: 'https://example.com', title: 'Example' }], truncated: false } }),
          tool('web_search', { queries: ['terminal row wrap width'] }, { result: '1. wcwidth.dev\n2. unicode.org', runMs: 700, meta: { sources: [{ url: 'https://wcwidth.dev', title: 'Width' }, { url: 'https://unicode.org', title: 'Unicode' }], truncated: false } }),
          tool('web_search', { queries: ['ansi escape sequences clip'] }, { result: '1. ecma-48.org', runMs: 800, meta: { sources: [{ url: 'https://ecma-48.org', title: 'ECMA-48' }], truncated: false } }),
        ],
      }),
      mark('three'),
      step({
        tools: [
          tool('web_search', { queries: ['grapheme cluster width'] }, { result: '1. unicode.org/reports/tr29', runMs: 600, meta: { sources: [{ url: 'https://unicode.org/reports/tr29', title: 'UAX #29' }], truncated: false } }),
        ],
      }),
      mark('four'),
      step({
        text: 'Checking the build.',
        tools: [tool('bash', { command: 'pnpm run build', description: 'Build' }, { result: 'built 4 packages', runMs: 900 })],
      }),
      step({ text: 'The sources agree.' }),
    ], { startAt: '11:02' }),
  ],
}

/** One tall answer and one command output that hold a term several times each, for a search that steps through the matches of one block. */
const findings = {
  summary: 'a 60-line answer and a command output that each repeat a term, so a search has many matches inside one block',
  items: [
    turn('Find where the needle is mentioned.', [
      step({
        text: 'Checking the logs.',
        tools: [tool('bash', { command: 'grep -rn needle logs', description: 'Search the logs' }, { result: lines(14, n => (n % 4 === 0 ? `logs/app-${String(n)}.log:${String(n)}: needle found in request ${String(n)}` : `logs/app-${String(n)}.log:${String(n)}: nothing here`)), runMs: 500 })],
      }),
      step({ text: lines(60, n => (n === 3 || n === 20 || n === 45 || n === 58 ? `Line ${String(n)} of the report mentions the needle once more.\n` : `Line ${String(n)} of the report is about something else.\n`)).split('\n').filter(line => line !== '').join('\n\n') }),
    ], { startAt: '12:00' }),
    turn('Thanks, and one more needle for good measure.', [step({ text: 'Noted: needle needle.' })], { startAt: '12:05' }),
  ],
}

/** Three lines of code around a change, the context the edit tool sends on each side of a hunk. */
const around = (at, removed, added) => {
  const head = lines(3, n => `  const row${String(at + n)} = paint(${String(at + n)})`)
  const tail = lines(3, n => `  const row${String(at + 10 + n)} = paint(${String(at + 10 + n)})`)
  const join = (middle) => [head, ...(middle === '' ? [] : [middle]), tail].join('\n')
  return [join(removed), join(added)]
}
const CONFIG_BEFORE = "export const config = {\n  baseUrl: 'http://localhost:8080',\n  timeoutMs: 3000,\n}\n\nexport function describe() {\n  return `${config.baseUrl} (timeout ${config.timeoutMs} ms)`"
const CONFIG_AFTER = "export const config = {\n  baseUrl: 'http://localhost:8080',\n  timeoutMs: 3000,\n  retries: 2,\n}\n\nexport function describe() {\n  return `${config.baseUrl} (timeout ${config.timeoutMs} ms, ${config.retries} retries)`"
const RETRY_MODULE = "// Retry the call with a growing delay.\nimport { setTimeout as sleep } from 'node:timers/promises'\n\nexport interface RetryOptions {\n  readonly retries: number\n  readonly baseMs?: number\n}\n\nexport async function withRetry<T>(run: () => Promise<T>, options: RetryOptions): Promise<T> {\n  const { retries, baseMs = 250 } = options\n  for (let attempt = 0; attempt <= retries; attempt += 1) {\n    try {\n      return await run()\n    } catch (error) {\n      if (attempt === retries) throw new Error(`gave up after ${retries} retries`, { cause: error })\n      await sleep(baseMs * 2 ** attempt)\n    }\n  }\n  return run()\n}\n"
const RETRY_TEST = "import assert from 'node:assert/strict'\nimport test from 'node:test'\nimport { describe } from '../src/config.mjs'\n\ntest('describe shows the retries', () => {\n  assert.match(describe(), /2 retries/)\n})\n"
const REPORT = lines(84, n => n % 12 === 1 ? `## Section ${String(Math.ceil(n / 12))}` : `export const metric${String(n)} = { name: 'metric ${String(n)}', value: ${String(n * 7)} }`)

const edits = {
  summary: 'file changes at the three tiers: a single edit, a multi-hunk edit, a large edit, a new file, an overwrite, a run of mixed changes, a failed edit, and a write cut off by an interrupt',
  items: [
    turn('Add a retries setting, read it in the client, and cover it with a test.', [
      step({ text: 'The setting goes into the config first.', tools: [edit('src/config.mjs', CONFIG_BEFORE, CONFIG_AFTER)] }),
      // One line for one, two lines for one, one line for two, and a line removed alone: the numbers before and after a change differ.
      step({
        text: 'The client names the timeout in four places.',
        tools: [editHunks('src/client.mjs', [
          around(10, '  const wait = timeout', '  const wait = timeoutMs'),
          around(48, '  const half = timeout / 2\n  return half * 4', '  return timeoutMs * 2'),
          around(120, '  log(timeout)', '  log(timeoutMs)\n  log(retries)'),
          around(150, '  legacyCleanup()', ''),
        ])],
      }),
      mark('edited'),
      step({ text: 'Now the test for it.', tools: [write('tests/retry.test.mjs', RETRY_TEST)] }),
      step({ text: 'And the helper itself.', tools: [write('src/retry.ts', RETRY_MODULE)] }),
      mark('written'),
      step({
        text: 'Then a handful of files together.',
        tools: [
          edit('src/limits.mjs', ...around(30, '  max: 10,', '  max: 12,\n  min: 2,')),
          edit('src/paint.mjs', ...around(70, '  paint(row)\n  paint(next)', '  paint(row, width)')),
          write('docs/retries.md', REPORT),
          edit('src/index.mjs', ...around(5, '', "  export * from './retries.mjs'")),
          tool('bash', { command: 'pnpm run lint', description: 'Lint' }, { result: 'ok', runMs: 1800 }),
        ],
      }),
      mark('run'),
      step({
        text: 'A large rewrite of the painter.',
        tools: [edit('src/painter.mjs', ...around(200, lines(18, n => `  rows.push(old${String(n)}(width))`), lines(26, n => `  rows.push(next${String(n)}(width, mode))`)))],
      }),
      mark('large'),
      step({
        text: 'The report is rewritten whole.',
        tools: [write('docs/report.md', REPORT, { meta: { operation: 'update', diffs: [{ path: 'docs/report.md', oldText: lines(6, n => `old metric ${String(n)}`), newText: lines(8, n => `new metric ${String(n)}`) }] } })],
      }),
      step({ text: 'A stale edit that cannot apply.', tools: [tool('edit', { file_path: 'src/client.mjs', old_string: 'const gone = 1', new_string: 'const gone = 2' }, { result: 'old_string was not found in src/client.mjs; read the file again before editing', error: true, runMs: 300 })] }),
      mark('failed'),
      step({ text: 'The file changes are in; the lint is clean.' }),
    ], { startAt: '10:30' }),
    turn('Rewrite the client from scratch, and I will stop you.', [
      step({
        text: 'Replacing the client.',
        tools: [
          edit('src/client.mjs', ...around(300, '  send(request)', '  send(request, signal)')),
          write('src/client.mjs', lines(40, n => `export const call${String(n)} = () => request(${String(n)})`), { result: '', runMs: 4000, unanswered: true }),
        ],
      }),
    ], { startAt: '10:34', outcome: 'aborted' }),
  ],
}

const phases = {
  summary: 'activity phases: waiting for the first token, reasoning, a running command, answer text, and a call being prepared',
  items: [
    turn('Show me every activity phase.', [
      step({
        firstTokenMs: 6000, marks: [{ block: 'wait', at: 0.85, name: 'diving' }, { block: 'reasoning', at: 0.85, name: 'thinking' }, { block: 'tool', at: 0.6, name: 'tool' }],
        reasoning: 'Checking how the loader reads its settings.\nThe config has two keys and both have defaults.\nI will run the build to be sure nothing else reads them.',
        reasoningMs: 6000, stream: true,
        tools: [tool('bash', { command: 'pnpm run build:changed', description: 'Build the changed packages' }, { result: 'built 3 packages', runMs: 7000 })],
      }),
      step({ text: 'The build passed. A text-only step that streams slowly so the writing phase stays visible for a while.', textMs: 6000, marks: [{ block: 'text', at: 0.7, name: 'writing' }] }),
      step({ text: 'Now a large edit is prepared.', textMs: 800, prepareMs: 6000, marks: [{ block: 'prepare', at: 0.6, name: 'preparing' }], tools: [edit('src/config.mjs', lines(6, n => `  setting${String(n)}: ${String(n)},`), lines(6, n => `  setting${String(n)}: ${String(n + 1)},`))] }),
      step({ text: 'Done.' }),
    ]),
  ],
}

const thinkingLadder = {
  summary: 'one long reasoning phase: the thinking label deepens through its four stages (Pondering, Mulling, DeepThinking, Fathoming)',
  items: [turn('Think about this for a long while.', [
    step({
      firstTokenMs: 1500,
      marks: [{ block: 'reasoning', at: 0.02, name: 'pondering' }, { block: 'reasoning', at: 0.15, name: 'mulling' }, { block: 'reasoning', at: 0.4, name: 'deep' }, { block: 'reasoning', at: 0.95, name: 'fathoming' }],
      reasoning: lines(40, n => `Line ${String(n)} of a long chain of thought about how the activity row and the stream should share the work.`),
      reasoningMs: 55_000, stream: true,
    }),
    step({ text: 'That took a while, but the answer is short.' }),
  ])],
}

const pending = {
  summary: 'calls that run for a while: a command, two commands at once, a failing command, and a command cut off by an interrupt',
  items: [
    turn('Run the checks.', [
      step({ text: 'Running the tests first.', textMs: 600, marks: [{ block: 'tool', at: 0.5, name: 'running' }], tools: [tool('bash', { command: 'pnpm test', description: 'Run the tests' }, { result: '214 passed', runMs: 9000 })] }),
      step({
        text: 'Now the build and the lint at once.', textMs: 600, marks: [{ block: 'tool', at: 0.4, name: 'parallel' }],
        tools: [tool('bash', { command: 'pnpm run build', description: 'Build' }, { result: 'built 3 packages', runMs: 8000 }), tool('bash', { command: 'pnpm run lint', description: 'Lint' }, { result: 'ok', runMs: 4000 })],
      }),
      step({ text: 'And a last one that fails.', textMs: 600, marks: [{ block: 'tool', at: 0.8, name: 'failing' }], tools: [tool('bash', { command: 'pnpm run check:lib', description: 'Check exports' }, { result: 'missing export\n[exit code: 1]', runMs: 5000 })] }),
      step({ text: 'One check failed.' }),
    ]),
    turn('Run the long migration, and I will stop you.', [
      step({ text: 'Starting the migration.', textMs: 600, tools: [tool('bash', { command: 'pnpm run migrate', description: 'Run the migration' }, { result: '', runMs: 30_000, unanswered: 'unknown' })] }),
    ], { outcome: 'interrupted' }),
  ],
}

const blocks = {
  summary: 'calls in flight of every kind: a read, a search, a multi-line command, a web search and a web fetch, each a pending line with its input at the level',
  items: [
    turn('Look into the config loader and run the long build.', [
      step({
        text: 'Starting several lookups at once.', textMs: 600, marks: [{ block: 'tool', at: 0.3, name: 'kinds' }],
        tools: [
          tool('read', { file_path: 'packages/mayfly/src/transcript/tool-calls.ts', offset: 120, limit: 80 }, { result: 'export function callsOf() {}', runMs: 20_000 }),
          tool('read', { file_path: 'packages/mayfly/src/transcript/tool-kinds.ts' }, { result: 'export function kindOf() {}', runMs: 20_000 }),
          tool('grep', { pattern: 'callsOf', path: 'packages/mayfly/src' }, { result: 'transcript/tool-calls.ts:340', runMs: 20_000 }),
          tool('bash', { command: 'set -e\nexport CI=1\npnpm run build:changed\npnpm run check:lib\npnpm run typecheck\npnpm test -- --run tool-calls\necho done', description: 'Build and check' }, { result: 'ok', runMs: 20_000 }),
          tool('bash', { command: 'pnpm run lint', description: 'Lint' }, { result: 'ok', runMs: 20_000 }),
          tool('web_search', { queries: ['pi-tui loader animation', 'terminal shimmer text'] }, { result: 'two sources', runMs: 20_000 }),
          tool('web_fetch', { url: 'https://nodejs.org/api/test.html' }, { result: '# Test runner', runMs: 20_000 }),
        ],
      }),
      step({
        text: 'One long command on its own.', textMs: 500, marks: [{ block: 'tool', at: 0.5, name: 'command' }],
        tools: [tool('bash', { command: lines(14, n => `echo "step ${String(n)} of the release script" && sleep 1`), description: 'The release script' }, { result: 'released', runMs: 12_000 })],
      }),
      step({ text: 'Everything settled.' }),
    ]),
  ],
}

const EDIT_LINES = Array.from({ length: 12 }, (_, index) => `  setting${String(index + 1)}: ${String(index + 1)},`)

const streaming = {
  summary: 'a write and an edit being generated: the code appears line by line before the call is committed, then the call runs and settles in place',
  items: [
    turn('Write the report script, then tighten the config.', [
      step({
        text: 'Writing the script.', textMs: 500, prepareMs: 9000,
        marks: [{ block: 'prepare', at: 0.12, name: 'write-early' }, { block: 'prepare', at: 0.5, name: 'write-half' }, { block: 'prepare', at: 0.97, name: 'write-late' }, { block: 'tool', at: 0.5, name: 'write-running' }],
        tools: [write('scripts/report.mjs', lines(34, n => `export const metric${String(n)} = () => compute(${String(n)}, { window: ${String(n * 5)} })`), { runMs: 3000 })],
      }),
      step({
        text: 'Now the edit.', textMs: 500, prepareMs: 6000,
        marks: [{ block: 'prepare', at: 0.2, name: 'edit-early' }, { block: 'prepare', at: 0.6, name: 'edit-half' }, { block: 'prepare', at: 0.97, name: 'edit-late' }, { block: 'tool', at: 0.5, name: 'edit-running' }],
        tools: [edit('src/config.mjs', EDIT_LINES.join('\n'), [...EDIT_LINES.slice(0, 3), '  retries: 3,', '  backoff: { base: 100, max: 5000 },', '  jitter: true,', '  signal: AbortSignal.timeout(30_000),', ...EDIT_LINES.slice(6)].join('\n'), { runMs: 3000 })],
      }),
      step({ text: 'Both are in place.' }),
    ]),
  ],
}

const sync = {
  summary: 'the activity row in step with the stream: two calls of different kinds in flight, one settles, then the model thinks again',
  items: [
    turn('Build and read the changelog together.', [
      step({
        text: 'Running both at once.', textMs: 500,
        marks: [{ block: 'tool', at: 0.1, name: 'mixed' }, { block: 'tool', at: 0.55, name: 'one' }],
        tools: [
          tool('bash', { command: 'pnpm run build', description: 'Build' }, { result: 'built 3 packages', runMs: 10_000 }),
          tool('read', { file_path: 'CHANGELOG.md' }, { result: '# Changelog', runMs: 3000 }),
        ],
      }),
      step({
        firstTokenMs: 800, reasoning: 'The build passed and the changelog is short.\nI can summarise both now.', reasoningMs: 5000, stream: true,
        marks: [{ block: 'reasoning', at: 0.6, name: 'thinking' }],
      }),
      step({ text: 'Both finished.' }),
    ]),
  ],
}

const activityWait = {
  summary: 'the activity row while the turn waits on you: a command approval, then a question; answer the panels with the keys',
  items: [turn('Clean the build output, then ask me which runtime to target.', [
    step({
      text: 'This deletes the build directory, which needs your approval.',
      tools: [tool('bash', { command: 'rm -rf dist build', description: 'Delete the build output' }, { ask: approval('bash', 'The command removes files outside the tracked sources.'), result: '[exit code: 0]', runMs: 900 })],
    }),
    step({
      text: 'One question before I continue.',
      tools: [tool('ask_user_question', { questions: [] }, {
        ask: question([{ id: 'runtime', header: 'Runtime', question: 'Which runtime should the project target?', options: [{ label: 'Node 22 (Recommended)', description: 'Current LTS line' }, { label: 'Node 24', description: 'Latest release' }] }]),
        result: 'The user answered: Node 22.',
        runMs: 500,
      })],
    }),
    step({ text: 'Thanks. I will target Node 22.' }),
  ])],
}

const compactionNoWindow = {
  summary: 'a compaction in a session whose model advertises no context window: the bar counts the stages instead of the occupancy',
  options: { contextWindow: null },
  items: [turn('Read the readme and summarise it.', [
    step({ text: 'Reading the readme.', usage: { inputTokens: 40_000, outputTokens: 120, cacheReadTokens: 19_500 }, tools: [tool('read', { file_path: 'README.md' }, { result: '# replay-app', runMs: 500 })] }),
    compaction({ ms: 4000, applyMs: 1600, shadowedTokens: 53_000, shadowedItems: 14, summaryTokens: 900, marks: [{ name: 'summarizing', stage: 'summarize', at: 0.7 }, { name: 'applying', stage: 'apply', at: 0.4 }], summary: 'The user asked for a summary of README.md.' }),
    pause(1800),
    mark('settled'),
    step({ text: 'The readme describes a tiny service.', usage: { inputTokens: 6_500, outputTokens: 40, cacheReadTokens: 0 } }),
  ])],
}

const manualCompact = {
  summary: 'a manual /compact after a turn: its own block below the turn\'s closing line, with the command row and its checkpoint',
  options: { contextWindow: 65_536 },
  items: [
    turn('Read the readme.', [step({ text: 'Reading.', usage: { inputTokens: 26_000, outputTokens: 100, cacheReadTokens: 12_000 }, tools: [tool('read', { file_path: 'README.md' }, { result: '# replay-app', runMs: 500 })] }), step({ text: 'Done reading.', usage: { inputTokens: 26_300, outputTokens: 40, cacheReadTokens: 12_000 } })]),
    compaction({ manual: true, ms: 3000, applyMs: 1200, shadowedTokens: 30_000, shadowedItems: 5, summaryTokens: 700, marks: [{ name: 'summarizing', stage: 'summarize', at: 0.6 }], summary: 'The user asked to read README.md, which was read.' }),
    pause(1800),
    mark('settled'),
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

/** What a call that was put to the user answers when the user rejects it. */
const REJECTED = { rejected: { result: 'The user rejected this call.', error: true } }

const approvalsEdit = {
  summary: 'a file change waits for your permission: the diff is the request, then a new file; Ctrl+G opens it in your editor',
  items: [turn('Add a retries setting.', [
    step({ text: 'The setting goes into the config first.', tools: [edit('src/config.mjs', CONFIG_BEFORE, CONFIG_AFTER, { ask: approval('edit', 'Edits a file in the workspace.'), outcomes: REJECTED })] }),
    step({ text: 'Then the report that names it.', tools: [write('docs/retries.md', REPORT, { ask: approval('write', 'Creates a file in the workspace.'), outcomes: REJECTED })] }),
    step({ text: 'Both files are in place.' }),
  ])],
}

const approvalsQueue = {
  summary: 'three calls of one step wait on you together: the first is on the card with 1 of 3 waiting, and each answer brings the next',
  items: [turn('Reset the workspace, then fix the config.', [
    step({
      text: 'Three actions need your approval.',
      tools: [
        tool('bash', { command: 'rm -rf dist build', description: 'Delete the build output' }, { ask: approval('bash', 'The command removes files outside the tracked sources.', { queued: true }), result: '[exit code: 0]', outcomes: REJECTED, runMs: 900 }),
        edit('src/config.mjs', CONFIG_BEFORE, CONFIG_AFTER, { ask: approval('edit', 'Edits a file in the workspace.', { queued: true }), outcomes: REJECTED }),
        tool('bash', { command: 'set -e\ngit clean -fd\nrm -rf node_modules/.cache', description: 'Remove untracked files and the cache' }, { ask: approval('bash', 'The command removes untracked files.', { queued: true }), result: '[exit code: 0]', outcomes: REJECTED, runMs: 700 }),
      ],
    }),
    step({ text: 'All three are done.' }),
  ])],
}

/*
 * The Phase 3 session: one conversation that meets every state a complete real session shows, so the Phase 3 parts can
 * be audited together. Each state sits behind a mark; a prompt (approval, plan review, question) stops playback until
 * the scenario answers it with keys (see `PHASE3_PROMPTS` in catalog.mjs).
 */
const PHASE3_CJK = '请把下面这一段说明翻译成中文，并且保留原来的标点：the client aborts after 3000 ms 🚀 and retries twice 👩‍💻, every failure goes to the log 🔥. 日本語のテキストと한국어 텍스트も混ざっています。'.repeat(2)
const PHASE3_ANSWER = ['## Verdict', '', 'The retry loop is **correct**, but the timeout is not applied to the retry itself.', '', '| attempt | delay | outcome |', '| --- | ---: | --- |', '| 1 | 250 ms | retried |', '| 2 | 500 ms | retried |', '| 3 | - | gave up |', '', '- the delay doubles on each attempt', '- the last error is kept as `cause`', '', '```ts', 'export async function withRetry<T>(run: () => Promise<T>, retries: number): Promise<T> {', '  // one call, then up to `retries` more', '  return run()', '}', '```'].join('\n')
const PHASE3_PLAN_REVISED = ['## Plan: migrate to ESM (revised)', '', '1. Rename `*.cjs` entry points to `*.mjs`.', '2. Replace `require` with `import`, then run the tests.', '3. Add a rollback step: keep the CJS entry until the ESM build passes.', '4. Update the build and the test runner configuration.'].join('\n')
const PHASE3_QUESTION = [{ id: 'runtime', header: 'Runtime', question: 'Which runtime should the project target?', options: [{ label: 'Node 22 (Recommended)', description: 'Current LTS line' }, { label: 'Node 24', description: 'Latest release' }] }]
const PHASE3_NEEDLE = lines(12, n => (n % 4 === 0 ? `Line ${String(n)} mentions the needle again.` : `Line ${String(n)} is about something else.`))

const phase3 = {
  summary: 'one long session through every Phase 3 state: prompts, thinking, answers, tool runs, edits, approvals, plan review, subagents, jobs, goal, retries, compaction, queued messages, search, interrupts, and a live stream',
  options: { contextWindow: 32_768 },
  items: [
    seed([{ id: 'seed-earlier', at: -3 * 3_600_000, title: 'Earlier work', items: [
      turn('Draft the release notes.', [step({ text: 'Release notes drafted.', usage: { inputTokens: 4_000, outputTokens: 300, cacheReadTokens: 0 } })]),
      turn('Add the install section.', [step({ text: 'The install section is in.', usage: { inputTokens: 5_000, outputTokens: 200, cacheReadTokens: 0 } })]),
    ] }]),
    turn([text('Here is the timeout on the client:'), image('timeout.png')], [step({ text: 'The screenshot shows a timeout error: the request is aborted, but the retry never starts.' })], { startAt: '10:00' }),
    mark('image'),
    turn(PHASE3_CJK, [step({ reasoning: '用户用中文提问，我应当用中文回答。', text: '已翻译；标点保持不变。客户端在 3000 毫秒后中止，然后重试两次 🚀。' })], { startAt: '10:02' }),
    mark('cjk'),
    turn('Why does this print 42, and does renaming the value change anything?\n\n```js\nexport const answer = 42\nconsole.log(answer)\n```', [step({ text: 'It prints `42`. Renaming the binding changes nothing at runtime:\n\n```js\nexport const reply = 42\nconsole.log(reply)\n```' })], { startAt: '10:03' }),
    mark('code'),
    turn('Is the retry loop right? Think it through, then answer with a table.', [
      step({
        firstTokenMs: 1500,
        marks: [{ block: 'reasoning', at: 0.02, name: 'pondering' }, { block: 'reasoning', at: 0.15, name: 'mulling' }, { block: 'reasoning', at: 0.4, name: 'deep' }, { block: 'reasoning', at: 0.95, name: 'fathoming' }, { block: 'text', at: 0.5, name: 'answer' }],
        reasoning: lines(40, n => `Line ${String(n)} of a long chain of thought about whether the retry delays grow as intended.`),
        reasoningMs: 55_000,
        text: PHASE3_ANSWER,
        textMs: 4000,
        usage: { inputTokens: 2400, outputTokens: 900, cacheReadTokens: 1800 },
      }),
    ], { startAt: '10:05' }),
    turn('Survey the project, then run the tests while I read the docs.', [
      mark('explore'),
      step({
        text: 'Searching and reading first.',
        tools: [
          todos([['in_progress', 'Check the retry path'], ['pending', 'Run the tests'], ['pending', 'Summarise']]),
          tool('glob', { pattern: '**/*.mjs' }, { result: 'src/config.mjs\nsrc/client.mjs\ntests/config.test.mjs', runMs: 500 }),
          tool('grep', { pattern: 'retries', include: '*.mjs' }, { result: 'src/config.mjs:4:  retries: 2,\nsrc/client.mjs:12:  withRetry(run, config.retries)', runMs: 700 }),
          tool('read', { file_path: 'src/client.mjs' }, { result: readText('src/client.mjs', 'export async function get(path) {}'), runMs: 600, meta: readMeta('src/client.mjs', 1, 1) }),
          tool('web_search', { query: 'node:test describe it nesting' }, { result: '1. Node.js test runner docs — https://nodejs.org/api/test.html', runMs: 1500, meta: { sources: [{ url: 'https://nodejs.org/api/test.html', title: 'Test runner' }], truncated: false } }),
          tool('web_fetch', { url: 'https://nodejs.org/api/test.html' }, { result: '# Test runner\n\nThe node:test module facilitates the creation of JavaScript tests.', runMs: 1800, meta: { url: 'https://nodejs.org/api/test.html', statusCode: 200, truncated: false } }),
        ],
      }),
      step({
        text: 'Running the suite while I finish reading.',
        marks: [{ block: 'tool', at: 0.5, name: 'pending' }],
        tools: [tool('bash', { command: 'pnpm test', description: 'Run the tests' }, { result: '214 passed\n[exit code: 0]', runMs: 9000 })],
      }),
      step({ text: 'The suite passes and the docs agree.' }),
      mark('explored'),
    ], { startAt: '10:12' }),
    turn('Add the retries setting, rewrite the client, and write the test.', [
      mark('edits'),
      step({ text: 'The setting goes into the config first.', tools: [edit('src/config.mjs', CONFIG_BEFORE, CONFIG_AFTER)] }),
      step({ text: 'The client names the timeout in three places.', tools: [editHunks('src/client.mjs', [around(10, '  const wait = timeout', '  const wait = timeoutMs'), around(48, '  return timeout * 2', '  return timeoutMs * 2'), around(120, '  log(timeout)', '  log(timeoutMs)')])] }),
      mark('edited'),
      step({ text: 'Now the test, written as a new file.', tools: [write('tests/retry.test.mjs', RETRY_TEST)] }),
      mark('written'),
      step({ text: 'The report is rewritten whole.', tools: [write('docs/report.md', REPORT, { meta: { operation: 'update', diffs: [{ path: 'docs/report.md', oldText: lines(6, n => `old metric ${String(n)}`), newText: lines(8, n => `new metric ${String(n)}`) }] } })] }),
      mark('overwritten'),
      step({ text: 'A stale edit that cannot apply.', tools: [tool('edit', { file_path: 'src/client.mjs', old_string: 'const gone = 1', new_string: 'const gone = 2' }, { result: 'old_string was not found in src/client.mjs; read the file again before editing', error: true, runMs: 300 })] }),
      mark('failed-edit'),
    ], { startAt: '10:16' }),
    turn('Clean the build output, reset the workspace, and publish the branch.', [
      mark('approval'),
      step({ text: 'This deletes the build directory, which needs your approval.', tools: [tool('bash', { command: 'rm -rf dist build', description: 'Delete the build output' }, { ask: approval('bash', 'The command removes files outside the tracked sources.'), result: '[exit code: 0]', outcomes: REJECTED, runMs: 900 })] }),
      mark('approved'),
      mark('queue'),
      step({
        text: 'Three actions need your approval.',
        tools: [
          tool('bash', { command: 'rm -rf coverage .nyc_output', description: 'Delete the coverage output' }, { ask: approval('bash', 'The command removes files outside the tracked sources.', { queued: true }), result: '[exit code: 0]', outcomes: REJECTED, runMs: 900 }),
          edit('src/config.mjs', CONFIG_BEFORE, CONFIG_AFTER, { ask: approval('edit', 'Edits a file in the workspace.', { queued: true }), outcomes: REJECTED }),
          tool('bash', { command: 'set -e\ngit clean -fd', description: 'Remove untracked files' }, { ask: approval('bash', 'The command removes untracked files.', { queued: true }), result: '[exit code: 0]', outcomes: REJECTED, runMs: 700 }),
        ],
      }),
      mark('queued'),
    ], { startAt: '10:22' }),
    turn('Publish the release now.', [
      mark('reject'),
      step({ text: 'Publishing means pushing the tag to main.', tools: [tool('bash', { command: 'git push --force origin main', description: 'Force-push the release' }, { ask: approval('bash', 'A force push rewrites the remote history.'), result: '[exit code: 0]', outcomes: REJECTED, runMs: 300 })] }),
      mark('rejected'),
      step({ text: 'Understood: I will push a branch instead.', tools: [tool('bash', { command: 'git push origin release/1.4', description: 'Push the release branch' }, { result: '[exit code: 0]', runMs: 700 })] }),
    ], { startAt: '10:26' }),
    turn('Plan the migration before changing anything, then ask me one question.', [
      raw('plan/mode', { active: true }),
      mark('plan'),
      step({ text: 'Here is the plan; it names every phase.', tools: [planReview(PLAN_LONG)] }),
      mark('plan-revised'),
      step({ text: 'Revised with a rollback step; here it is again.', tools: [planReview(PHASE3_PLAN_REVISED)] }),
      mark('plan-accepted'),
      mark('question'),
      step({ text: 'One question before I start.', tools: [tool('ask_user_question', { questions: [] }, { ask: question(PHASE3_QUESTION), result: 'The user answered: Node 22.', runMs: 500 })] }),
      mark('answered'),
      step({ text: 'Thanks. I will target Node 22.' }),
    ], { startAt: '10:28' }),
    turn('Rewrite the client retry in the background and keep the watcher running.', [
      goalItem('create', { objective: 'Land the retries setting and keep the tests green', maxGoalRounds: 8 }),
      mark('live'),
      step({
        text: 'A subagent rewrites the client, a watcher runs, and the goal is tracked.',
        tools: [
          todos([['in_progress', 'Rewrite the client retry'], ['pending', 'Run the watcher checks']]),
          subagent('Rewrite the client retry', 'Rewrite the client retry around withRetry', {
            mode: 'continuable',
            live: true,
            startMs: 0,
            items: [step({
              reasoning: 'Reading the current client first, then wrapping the call in withRetry. The timeout stays on each attempt.',
              reasoningMs: 2000,
              text: 'Draft client:\n\nexport async function get(path) {\n  return withRetry(() => request(path), { retries: config.retries })\n}\n\nThe timeout is set per attempt, so a slow retry does not extend the first wait.',
              textMs: 2000,
              chunk: 10,
            })],
          }, { runMs: 800 }),
          tool('bash', { command: 'npm run watch', description: 'Watch the sources', run_in_background: true }, { result: 'Started job job-1 in the background.', runMs: 500 }),
        ],
      }),
      job('npm run watch', { lines: [[300, 'watching for changes…'], [3000, 'rebuilt src/config.mjs in 42 ms']], progress: [[500, 'watching'], [3000, 'rebuilt 1']] }),
      mark('watching'),
      step({ text: 'The watcher keeps running and the subagent finishes its draft.' }),
    ], { startAt: '10:34' }),
    turn('Summarise the changelog, then run the check that failed before.', [
      step({
        failedAttempts: [{ text: 'The changelog lists', failure: { message: 'Rate limit reached for requests', code: 'rate_limited', status: 429 }, delayMs: 9000 }],
        marks: [{ name: 'rate-limited', block: 'retry', attempt: 0, at: 0.3 }],
        text: 'The changelog lists three changes: a faster parser, a new CLI flag, and a fix for Windows paths.',
        usage: { inputTokens: 6_000, outputTokens: 80, cacheReadTokens: 2_000 },
      }),
      notify('success', 'Copied the last answer to the clipboard', { holdMs: 4500, marks: [{ name: 'toast', at: 0.4 }] }),
      notify('warning', 'The clipboard tool is missing; falling back to OSC 52', { holdMs: 4500, detail: 'Install xclip or wl-clipboard for a system clipboard.', marks: [{ name: 'footer', at: 0.5 }] }),
      step({ text: 'One check fails.', tools: [tool('bash', { command: 'pnpm run check:lib', description: 'Check exports' }, { result: 'missing export\n[exit code: 1]', error: true, runMs: 900 })] }),
      mark('failed-check'),
    ], { startAt: '10:40' }),
    turn('Keep reading the logs until the context is nearly full.', [
      step({ text: 'First log.', usage: { inputTokens: 4_000, outputTokens: 80, cacheReadTokens: 2_000 }, tools: [tool('read', { file_path: 'a.log' }, { result: LONG_LOG, runMs: 500 })] }),
      step({ text: 'Second log: the context is nearly full.', usage: { inputTokens: 18_000, outputTokens: 80, cacheReadTokens: 12_000 }, tools: [tool('read', { file_path: 'b.log' }, { result: LONG_LOG, runMs: 500 })] }),
      pause(1500),
      mark('context-full'),
      compaction({ ms: 2500, applyMs: 1000, shadowedTokens: 22_000, shadowedItems: 8, summaryTokens: 500, marks: [{ name: 'compacting', stage: 'summarize', at: 0.6 }], summary: 'The user asked to read two logs; both were read.' }),
      pause(800),
      mark('relieved'),
      step({ text: 'The context is small again.', usage: { inputTokens: 2_400, outputTokens: 40, cacheReadTokens: 0 } }),
    ], { startAt: '10:44' }),
    compaction({ manual: true, ms: 2000, error: 'context still over budget after summary', marks: [{ name: 'manual-failing', stage: 'summarize', at: 0.5 }] }),
    pause(600),
    mark('manual-failed'),
    compaction({ manual: true, ms: 2000, applyMs: 1000, shadowedTokens: 1_600, shadowedItems: 3, summaryTokens: 400, summary: 'The user asked to read two logs; both were read, and the context was compacted once more.' }),
    pause(1200),
    mark('manual-settled'),
    turn('Refactor the parser, I will add more while you work.', [
      queue(['Then update the README', { steer: 'Also keep the public API unchanged' }, 'And bump the version'], { holdMs: 6000 }),
      mark('queued-rows'),
      step({ reasoning: 'Reading the parser first. Follow-up messages are already waiting.', text: 'Reading the parser; the pane above the editor shows what you queued.', reasoningMs: 1500, textMs: 3000, tools: [tool('read_file', { path: 'src/parser.ts' }, { result: 'export function parse() {}', runMs: 800 })] }),
      step({ text: 'The refactor is done; the queued messages were withdrawn.' }),
    ], { startAt: '10:50' }),
    btw('What does semver say about a breaking change?', [
      mark('side'),
      step({ reasoning: 'A short factual answer is enough.', text: 'A breaking change bumps the major version (for 0.x versions, the minor).', reasoningMs: 1200, textMs: 2500 }),
    ], { label: 'semver breaking change', closeAfterMs: 4000 }),
    turn('Find where the needle is mentioned.', [
      mark('needle'),
      step({
        text: 'Checking the logs and the notes.',
        tools: [
          tool('bash', { command: 'grep -rn needle logs', description: 'Search the logs' }, { result: lines(8, n => (n % 2 === 0 ? `logs/app-${String(n)}.log:${String(n)}: needle found in request ${String(n)}` : `logs/app-${String(n)}.log:${String(n)}: nothing here`)) + '\n[exit code: 0]', runMs: 500 }),
          edit('docs/notes.md', 'Keep the needle short.', 'Keep the needle short and named.'),
        ],
      }),
      step({ text: PHASE3_NEEDLE.split('\n').join('\n\n') }),
      mark('searched'),
    ], { startAt: '10:54' }),
    turn('Keep going with the cleanup, and I will stop you.', [
      mark('interrupted'),
      step({
        text: 'Reading the config, then building and rewriting the client.',
        tools: [
          tool('read', { file_path: 'src/config.mjs' }, { result: readText('src/config.mjs', CONFIG.trimEnd()), runMs: 300, meta: readMeta('src/config.mjs', 8, 8) }),
          tool('bash', { command: 'pnpm run build', description: 'Build' }, { result: '', runMs: 4000, unanswered: true }),
          write('src/client.mjs', lines(40, n => `export const call${String(n)} = () => request(${String(n)})`), { result: '', runMs: 4000, unanswered: true }),
          tool('bash', { command: 'pnpm run deploy', description: 'Deploy' }, { result: '', runMs: 50, unanswered: 'before-dispatch' }),
        ],
      }),
    ], { startAt: '10:58', outcome: 'aborted' }),
    mark('cut-off'),
    turn('Run the checks.', [
      step({ text: 'Running the checks.', tools: [tool('bash', { command: 'npm run lint', description: 'Lint the project' }, { result: 'src/client.mjs:4:3  error  no-unused-vars  "signal" is assigned but never used\n[exit code: 1]', error: true, runMs: 1500 })] }),
    ], { startAt: '11:02', outcome: { error: { message: 'The provider returned an invalid request: replay error', code: 'INVALID_REQUEST' } } }),
    mark('error'),
    turn('Now write the report, and keep editing.', [
      step({
        firstTokenMs: 2500,
        reasoning: 'The report needs a short summary first, then the file list. I will write it in one go and check the result.',
        reasoningMs: 6000,
        text: 'Writing the report now.',
        textMs: 4000,
        prepareMs: 6000,
        marks: [{ block: 'wait', at: 0.8, name: 'wait' }, { block: 'reasoning', at: 0.5, name: 'reasoning' }, { block: 'text', at: 0.5, name: 'writing' }, { block: 'prepare', at: 0.6, name: 'prepare' }, { block: 'tool', at: 0.5, name: 'tool' }],
        tools: [write('docs/phase3.md', lines(20, n => `## Finding ${String(n)}: the state of row ${String(n)} is settled.`), { ask: approval('write', 'Creates a file in the workspace.'), runMs: 3000 })],
      }),
    ], { startAt: '11:05', outcome: 'open' }),
  ],
}

export const REPLAYS = { tour, toolkit, thinking, markdown, live, phases, thinkingLadder, pending, blocks, streaming, sync, activityWait, prompts, turns, toollines, toolgrow, findings, edits, errors, compaction: compactionReplay, compactionNoWindow, compactionFailed, manualCompact, context, subagents, childStream, approvals, approvalsRejected, approvalsEdit, approvalsQueue, questions, plan, planLong, goal, footerCutover, jobs, queued, retries, sideQuestion, notices, notificationPane, modes, edge, history, wheel, content, phase3 }

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
