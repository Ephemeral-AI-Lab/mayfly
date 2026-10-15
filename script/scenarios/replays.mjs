/**
 * The replays of the workbench: conversations written as data, played into a live session by the replay driver so a
 * review needs no model, no quota, and no tools. Each replay is one long conversation that shows a round's states; the
 * scenes are the timelines of the perf and app scenarios. See `timeline.mjs` for the builders. @module script/scenarios/replays
 */

import { btw, dequeue, goal as goalItem, job, mark, pause, queue, seed, step, subagent, todos, tool, turn } from './timeline.mjs'
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

const lines = (count, make) => Array.from({ length: count }, (_, index) => make(index + 1)).join('\n')

/** How long the live `scenario` stays on one state, for the owner to look at it (the frame runner stops at the marks instead). */
const DWELL = 10_000
/** The states the owner enters views in, which need time for `Alt+↓`, `←/→`, and `Esc`. */
const DWELL_VIEWS = 25_000

/** A spawn with a name and a task, so the Agents panel row has both columns: `● review   Audit the facts projection`. */
const agent = (name, task, prompt, child, options = {}) => tool('subagent', { name, description: task, prompt }, { runMs: 400, child: { prompt, ...child }, ...options })

/** A reviewer that works in the background for minutes (continuable, live), so the Agents item of the merge scenarios stays live. */
const reviewer = () => agent('review', 'Audit the hero copy', 'Audit the hero copy against the brand notes and list what to change', {
  mode: 'continuable', live: true, startMs: 400,
  items: [step({ reasoning: 'Reading the hero and the brand notes side by side.', reasoningMs: 4000, text: 'Three changes: shorten the headline to five words, name the three pillars in the subtitle, and move the install line above the fold. The rest of the copy already matches the brand notes, so nothing else needs to move before the screenshots are retaken.', textMs: 400_000, chunk: 4 })],
}, { runMs: 600 })

/**
 * Where Phase 4 (the editor) and Phase 5 (the status row) meet at the bottom of the screen, after the two were merged: the
 * notification row, the editor frame, and the one status row with its items and views. The turn ends at `items` so the person
 * (or the frame script) can run a real turn of their own (`hold:240000 …`) while the reviewer and the watcher keep going.
 */
const mergeDock = {
  summary: 'where the editor (Phase 4) and the status row (Phase 5) meet: the idle hint and placeholder over the status row\'s items, the `/` palette, a pasted token and its keys, a turn of your own (`hold:240000 keep going`) with the hint rotating every 15 s, the history counter, a view entered under the row, 60 and 40 columns, and Esc interrupting your turn while the reviewer and the watcher go on until the watcher settles (`✓ jobs 1/1`, then gone)',
  items: [
    turn('Refresh the landing page hero.', [
      goalItem('create', { objective: 'Refresh the landing page hero and keep every test green', maxGoalRounds: 8 }),
      step({
        text: 'A reviewer runs in the background and the todo list is set.',
        usage: { inputTokens: 5200, outputTokens: 140, cacheReadTokens: 3000 },
        tools: [reviewer(), todos([['completed', 'Read the brand notes'], ['in_progress', 'Rewrite the hero'], ['pending', 'Retake the screenshots'], ['pending', 'Run the tests']])],
      }),
      job('npm run watch', { lines: [[300, 'watching for changes…'], [20_000, 'rebuilt src/hero.css in 41 ms']], progress: [[500, 'watching'], [20_000, 'rebuilt 1']], endMs: 150_000, status: 'completed', detail: 'exit code: 0' }),
      step({
        text: 'The status row now carries the agents, jobs, goal, and todo items under the editor. Try the bottom of the screen: `/` opens the palette over the stream; a long paste becomes a token (`←` onto it names its keys); send `hold:240000 keep going` for a turn that keeps running (the hint above the editor rotates every 15 s; `↑` walks the history; `Alt+↓` enters a view); `Esc` interrupts that turn while the reviewer and the watcher go on.',
        usage: { inputTokens: 5600, outputTokens: 160, cacheReadTokens: 5000 },
      }),
    ]),
    mark('items'),
    // The watcher settles 1 s before `closing`, so its `✓ jobs 1/1` line is held there.
    pause(145_000),
    pause(2000),
    mark('closing'),
    pause(8000),
    mark('gone'),
    pause(DWELL),
  ],
}

/** Three messages typed while the main turn runs: a queued one, a steering one, and a second queued one (the newest). */
const MERGE_ROWS = [
  'Update the README once the parser is done',
  { steer: 'Keep the public API unchanged' },
  'Then bump the version and tag the release candidate',
]

/**
 * The conversations after the merge: Phase 4's queued and steering rows with Phase 5's shed keys and tailed notices on the
 * notification row, then a /btw side conversation and a subagent opened from the Agents view, each with Phase 5's chip and
 * `F7`/`F8` keys beside Phase 4's placeholder and frame title.
 */
const mergeConversations = {
  summary: 'the conversations after the merge: queued and steering rows (Alt+↑) with their keys on the notification row, a rate-limit notice beside those keys, d and u, the keys shed at 60 and 40 columns, the agent reading the rows, then a /btw side question (its chip, frame title, placeholder, and `F7 main · F8 close` with the history counter after it) and a subagent opened from the Agents view (`F8 detach` returns to the view); each state stays 25 s',
  items: [
    turn('Refactor the parser, I will add more while you work.', [
      queue(MERGE_ROWS, { holdMs: null, name: 'rows' }),
      step({
        text: 'A reviewer audits the hero in the background while I read the parser.',
        usage: { inputTokens: 4200, outputTokens: 120, cacheReadTokens: 2000 },
        tools: [reviewer(), tool('read', { file_path: 'src/parser.ts' }, { result: 'export function parse() {}', runMs: 600 })],
      }),
      step({ text: 'Your three messages wait at the end of the stream. Alt+↑ reaches them: e edits, s sends now, d cancels (u undoes).', usage: { inputTokens: 4500, outputTokens: 60, cacheReadTokens: 4000 } }),
      mark('queued'),
      step({
        failedAttempts: [{ text: 'Rewriting the entry', failure: { message: 'Rate limit reached for requests', code: 'rate_limited', status: 429 }, delayMs: 30_000 }],
        marks: [{ name: 'rate-limited', block: 'retry', attempt: 0, at: 0.2 }],
        text: 'Rewriting the parser entry point now.',
        usage: { inputTokens: 5000, outputTokens: 80, cacheReadTokens: 4500 },
      }),
      pause(DWELL_VIEWS),
      dequeue('rows'),
      step({ text: 'I read your messages: they are prompts in the stream now.', usage: { inputTokens: 5400, outputTokens: 60, cacheReadTokens: 5000 } }),
      mark('read'),
      pause(DWELL),
    ]),
    btw('Does the install section need Windows notes?', [
      step({ reasoning: 'A short answer is enough.', text: 'Yes: one line on PowerShell, one on WSL. Send `hold:240000 and the WSL line?` to keep this side question running; F7 goes back to main.', reasoningMs: 800, textMs: 1500 }),
    ], { label: 'windows notes' }),
    mark('btw'),
    pause(DWELL_VIEWS),
    pause(DWELL_VIEWS),
  ],
}

export const REPLAYS = { mergeDock, mergeConversations }

/*
 * The scenes: the timelines of the perf scenarios (a long streamed answer, a megabyte write) and of the Website's app
 * shots. Each is the source of a catalog scenario; they are not listed as replays of their own.
 */

const markdown = {
  summary: 'a long streamed answer with headings, lists, tables, and code in two languages',
  items: [turn('Explain the rendering pipeline.', [step({ reasoning: 'Plan the answer: sections on caching, width ladders, and code.', text: reply(), textMs: 6000, chunk: 24, marks: [{ name: 'half', block: 'text', at: 0.5 }], usage: { inputTokens: 1200, outputTokens: 2600 } })])],
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
  summary: 'one step spawning three subagents, done, running, and waiting, shown in the Agents item',
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

export const SCENES = { markdown, content, appConversation, appAgents, appSessions }

/** A replay or a scene by name. */
export const timelineNamed = name => Object.hasOwn(REPLAYS, name) ? REPLAYS[name] : Object.hasOwn(SCENES, name) ? SCENES[name] : undefined
