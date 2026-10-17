/**
 * The replays of the workbench: conversations written as data, played into a live session by the replay driver so a
 * review needs no model, no quota, and no tools. Each replay is one long conversation that shows a round's states; the
 * scenes are the timelines of the perf and app scenarios. See `timeline.mjs` for the builders. @module script/scenarios/replays
 */

import { btw, compaction, dequeue, edit, goal as goalItem, job, mark, notify, pause, queue, question, seed, step, subagent, todos, tool, turn } from './timeline.mjs'
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

/** One settled turn of the long history: a read, an edit, a bash call, and a long answer, so the window holds many rows and lazy Markdown. */
const historyTurn = (n) => turn(`Round ${String(n)}: tighten the width ladder of section ${String(n)}.`, [
  step({ stream: false, reasoning: `Section ${String(n)} wraps twice; read it, change the ladder, and run the suite.`, text: `Reading section ${String(n)} first.`, tools: [tool('read', { file_path: `src/section${String(n)}.ts` }, { result: lines(30, row => `export const row${String(row)} = ${String(row)}`), runMs: 300 })] }),
  step({ stream: false, tools: [edit(`src/section${String(n)}.ts`, 'const gap = 2', 'const gap = 1'), tool('bash', { command: 'pnpm run test' }, { result: lines(12, row => `✓ suite ${String(row)} passed`), runMs: 1200 })] }),
  step({ stream: false, text: reply() }),
])

const perfSubagent = {
  summary: 'a long history (16 settled turns with tool rows and long answers), then a foreground subagent running for a minute while its child streams steps, then a long closing answer',
  items: [
    ...Array.from({ length: 16 }, (_, index) => historyTurn(index + 1)),
    mark('history'),
    turn('Audit the whole renderer with a subagent.', [
      step({
        text: 'I will hand the audit to a subagent and wait for it.',
        // The call runs for a minute: the scenario types and scrolls while it ticks.
        marks: [{ name: 'child-running', block: 'tool', at: 0.1 }],
        tools: [subagent('Audit the renderer', 'Audit the renderer for wasted work and report what to cut', {
          mode: 'continuable', live: true, startMs: 400,
          items: Array.from({ length: 12 }, (_, index) => step({
            reasoning: `Checking pass ${String(index + 1)} of the renderer.`, reasoningMs: 800,
            text: `Pass ${String(index + 1)}: the list painter walks every item on each publish; the cache hits, but the walk itself is the cost. `.repeat(6), textMs: 3000, chunk: 8,
            tools: [tool('read', { file_path: `src/pass${String(index + 1)}.ts` }, { result: lines(20, row => `export const pass${String(row)} = ${String(row)}`), runMs: 800 })],
          })),
        }, { runMs: 60_000 })],
      }),
      mark('child-done'),
      step({ text: reply(), textMs: 6000, chunk: 24 }),
    ]),
  ],
}

/** The advertised window and one step's usage: 170k input + 120k cache read is 290k, 92% of 315k. */
const CONTEXT_WINDOW = 315_000
const CONTEXT_USAGE = Object.freeze({ inputTokens: 170_000, outputTokens: 800, cacheReadTokens: 120_000 })

/** A nested live subagent of a renderer audit: its own Agent streams rows while its parent waits. */
const rendererSurvey = (description, prompt, text) => subagent(description, prompt, {
  mode: 'continuable', live: true, startMs: 250,
  items: [step({
    reasoning: `Walk the renderer rows for ${description.toLowerCase()}.`,
    text,
    textMs: 42_000,
    chunk: 8,
  })],
}, { runMs: 45_000 })

/** A live continuable background child: one prepareMs step hands a nested live survey its own Agent. */
const rendererChild = (description, prompt, survey, startMs) => subagent(description, prompt, {
  mode: 'continuable', live: true, startMs,
  items: [step({
    reasoning: `Split ${description.toLowerCase()} into a nested survey and a pass over the paint path.`,
    prepareMs: 1800,
    text: `I am handing ${description.toLowerCase()} to a nested survey and walking the paint path in the same pass. `,
    textMs: 4500,
    tools: [survey],
  })],
}, { runMs: 600, toolArgs: { run_in_background: true } })

/** One long streamed answer at 92% of the advertised window; `marks` can stop playback inside it. */
const longContextStep = (pass, marks) => step({
  reasoning: `Pass ${String(pass)}: read the renderer rows, find the paints that repeat, and cut the walk.`,
  text: reply(),
  textMs: 6500,
  chunk: 24,
  usage: CONTEXT_USAGE,
  ...(marks === undefined ? {} : { marks }),
})

/**
 * The combined long scene: 200 settled turns with two compactions, a turn that leaves two live background children (each
 * with a nested live survey) and two running jobs while three high-context answers stream, then a /btw. The script types,
 * scrolls, wheels, enters the views, and searches over them before it settles the rest.
 */
const perfLong = {
  summary: '200 settled turns with two compactions, 2 live background subagents with nested live surveys, 2 running jobs, a goal and todos, 3 high-context streamed steps, and a /btw, with typing, scrolling, the wheel, views, and search over them',
  options: { contextWindow: CONTEXT_WINDOW },
  items: [
    ...Array.from({ length: 200 }, (_, index) => {
      const settled = historyTurn(index + 1)
      return index === 59 || index === 139
        ? [settled, compaction({ ms: 1800, summary: `The first ${String(index + 1)} sections are settled; the width ladders hold and the suite is green. Keep the pipeline notes and the remaining sections in view.`, shadowedTokens: 42_000, summaryTokens: 700 })]
        : [settled]
    }).flat(),
    mark('load'),
    turn('Audit the renderer while the preview and tests keep running.', [
      goalItem('create', { objective: 'Audit the renderer and keep the preview and tests green', maxGoalRounds: 8 }),
      step({
        text: 'Two renderer audits run in the background, and the todo list is set.',
        prepareMs: 600,
        tools: [
          rendererChild('Audit the renderer rows', 'Audit the renderer rows and report the expensive paints', rendererSurvey('Nested row survey', 'Survey the renderer rows and report which paints can be avoided', 'The row survey repaints every visible row: the markdown fences, the diff bands, and the wrapped list rows each walk the width ladder again. '.repeat(9)), 250),
          rendererChild('Profile the renderer', 'Profile the renderer while the preview reloads', rendererSurvey('Nested profile pass', 'Profile the renderer pass and report the hot rows', 'The profile pass finds the same rows hot: the diff bands rebuild their width ladders and the wrapped list rows repaint twice per publish. '.repeat(9)), 700),
          todos([['completed', 'Read the renderer'], ['in_progress', 'Profile the paint path'], ['pending', 'Trim the row work'], ['pending', 'Re-run the preview']]),
        ],
      }),
      job('pnpm run watch', { lines: [[300, 'watching for changes…'], [18_000, 'rebuilt src/renderer.ts in 38 ms']], progress: [[500, 'watching'], [18_000, 'rebuilt 1']] }),
      job('pnpm run preview', { lines: [[400, 'preview ready at http://localhost:4173'], [11_000, 'hmr update src/renderer.ts']], progress: [[600, 'serving'], [11_000, 'hmr 1']] }),
      longContextStep(1, [{ name: 'combined', block: 'text', at: 0.5 }]),
      mark('type'),
      longContextStep(2),
      mark('scroll'),
      longContextStep(3),
      mark('wheel'),
      step({ text: 'The renderer audit is in: the diff bands and the wrapped list rows walk the width ladder twice. The preview, the watcher, and both nested surveys are still running.', usage: CONTEXT_USAGE }),
      mark('views'),
    ]),
    btw('Does the renderer cache survive a theme switch?', [
      step({ reasoning: 'A short answer: the cache is keyed by the palette, so a switch starts a new one.', text: 'Yes, but it starts cold: the cache is keyed by the active palette, so the first frame after a switch rebuilds the rows once and then settles.', textMs: 1600, usage: CONTEXT_USAGE }),
    ], { label: 'renderer cache' }),
    mark('search'),
    mark('settle'),
  ],
}

/**
 * The swarm scene: six live background children (each with a nested live survey), a running job, a /btw side
 * conversation, and a main stream, so the agents view, child view, BTW view, and main view can be switched between
 * while every child is still streaming. The script enters the agents view, opens a child, returns, toggles the BTW,
 * and types/scrolls on main.
 */
const perfSwarm = {
  summary: 'six live background subagents with nested surveys, a running job, a /btw, and a main stream; enters the agents view, opens a child, switches back, toggles the BTW, then types and scrolls on main',
  items: [
    ...Array.from({ length: 30 }, (_, index) => historyTurn(index + 1)),
    mark('load'),
    turn('Coordinate six live renderer audits and keep the preview running.', [
      step({
        text: 'Six renderer audits start in the background, each with a nested survey.',
        prepareMs: 300,
        tools: Array.from({ length: 6 }, (_, index) => rendererChild(
          `Audit renderer pass ${String(index + 1)}`,
          `Audit renderer pass ${String(index + 1)} and report the expensive paints`,
          rendererSurvey(`Nested survey ${String(index + 1)}`, `Survey renderer pass ${String(index + 1)}`, `Pass ${String(index + 1)} finds the same rows hot: the markdown fences, the diff bands, and the wrapped list rows each walk the width ladder again. `.repeat(4)),
          150 + index * 90,
        )),
      }),
      step({ text: 'All six audits and their nested surveys are running in the background.', textMs: 1200 }),
      mark('swarm'),
      job('pnpm run preview', { lines: [[400, 'preview ready'], [10_000, 'hmr update src/renderer.ts']], progress: [[600, 'serving'], [10_000, 'hmr 1']] }),
      step({ text: 'The agents view lists all six, live first; the preview keeps serving.', textMs: 900, marks: [{ name: 'agents', block: 'text', at: 0.2 }] }),
    ]),
    mark('btw'),
    btw('Which audit found the widest redundant paint?', [
      step({ reasoning: 'The pass with the most wrapped rows.', text: 'Pass four: its wrapped list rows repaint the width ladder twice, and the diff bands rebuild every hunk.', textMs: 1200 }),
    ], { label: 'audit notes' }),
    mark('switch'),
    mark('settle'),
  ],
}

export const SCENES = { markdown, content, appConversation, appAgents, appSessions, perfSubagent, perfLong, perfSwarm }

/** A replay or a scene by name. */
export const timelineNamed = name => Object.hasOwn(REPLAYS, name) ? REPLAYS[name] : Object.hasOwn(SCENES, name) ? SCENES[name] : undefined

/*
 * The merge of Phase 6 (PR 16, the panels) into main (Phases 4 and 5): the panels over the merged dock, the one height of
 * pages switched in place, and Esc that stops your turn only.
 */

/**
 * A year of stored conversations for /stats: about a hundred and fifty sessions over 52 weeks on up to nine models that change
 * with the period, some in the sibling workspaces `docs` and `api`, so History has a heatmap and Models its columns.
 */
const STATS_POOLS = [
  [['deepseek-official', 'deepseek-flash', 6, 1], ['bravo', 'bravo-mini', 2, 0.6], ['acme', 'acme-think', 1, 0.8]],
  [['deepseek-official', 'deepseek-flash', 5, 1], ['deepseek-official', 'deepseek-v4-pro', 3, 2.2], ['anthropic', 'claude-sonnet-5-5', 2, 2.8], ['bravo', 'bravo-mini', 1, 0.6]],
  [['deepseek-official', 'deepseek-flash', 5, 1], ['deepseek-official', 'deepseek-v4-pro', 3, 2.2], ['anthropic', 'claude-sonnet-5-5', 3, 2.8], ['openai', 'gpt-5', 2, 2.4], ['moonshotai', 'kimi-k2', 2, 1.4], ['zhipuai', 'glm-5', 1, 1.2], ['openrouter', 'deepseek/deepseek-flash', 1, 1], ['acme', 'acme-think', 1, 0.8]],
]
const statsSeeds = () => {
  const sessions = []
  for (let day = 1; day <= 360; day += 1) {
    const hash = (day * 2_654_435_761) % 100
    const weekday = (4 - (day % 7) + 7) % 7
    const busy = weekday >= 1 && weekday <= 5
    const recent = day <= 120
    const active = day <= 5 || hash < (busy ? (day <= 60 ? 92 : recent ? 66 : 30) : (day <= 60 ? 40 : recent ? 18 : 6))
    if (!active) continue
    const pool = STATS_POOLS[day > 240 ? 0 : day > 120 ? 1 : 2]
    const perDay = day <= 60 ? 1 + (hash % 4) : recent ? 1 + (hash % 3 === 0 ? 1 : 0) + (hash % 5 === 0 ? 1 : 0) : 1 + (hash % 6 === 0 ? 1 : 0)
    for (let nth = 0; nth < perDay; nth += 1) {
      const pick = (day * 31 + nth * 17 + hash) % pool.reduce((sum, entry) => sum + entry[2], 0)
      let at = 0
      const [provider, model, , spend] = pool.find(entry => (at += entry[2]) > pick)
      const turns = 1 + ((hash + nth) % 5)
      sessions.push({
        id: `seed-stats-${String(day)}-${String(nth)}`, at: -day * DAY - (day % 3) * 5 * HOUR - nth * 2 * HOUR, title: `Stats seed ${String(day)}.${String(nth)}`,
        ...day % 5 === 0 ? { cwd: day % 10 === 0 ? 'docs' : 'api' } : {}, provider, model,
        items: Array.from({ length: turns }, (_unused, index) => turn(`Question ${String(index + 1)} of day ${String(day)}.`, [step({
          text: `Answer ${String(index + 1)}.`,
          usage: { inputTokens: Math.round((4_000 + hash * 300) * spend), outputTokens: Math.round((600 + hash * 40) * spend), cacheReadTokens: Math.round((30_000 + hash * 900) * spend) },
        })])),
      })
    }
  }
  return sessions
}

/** Three questions of every kind (a choice, a multiple choice, a typed answer): the wizard's pages and its review differ in height. */
const MERGE_QUESTIONS = [
  { id: 'auth', header: 'Auth', question: 'Which auth method should the CLI use?', options: [{ label: 'OAuth', description: 'browser sign-in, tokens refresh automatically' }, { label: 'API key', description: 'paste a token; you rotate it yourself' }] },
  { id: 'scopes', header: 'Scopes', question: 'Which scopes should the token carry?', multiSelect: true, options: [{ label: 'read', description: 'list and fetch resources' }, { label: 'write', description: 'create and update resources' }, { label: 'admin', description: 'manage members and billing' }, { label: 'audit', description: 'read the audit log' }] },
  { id: 'notes', header: 'Notes', question: 'Anything else I should know?' },
]

/** One question: no strip and no review; a digit answers it. */
const MERGE_QUESTION = [{ id: 'runtime', question: 'Which runtime should the project target?', options: [{ label: 'Node 22 (Recommended)', description: 'Current LTS line' }, { label: 'Node 24', description: 'Latest release' }, { label: 'Bun', description: 'Alternative runtime' }] }]

/** A watcher that keeps running for the whole scenario. */
const watcher = (endMs = 3_600_000) => job('npm run watch', { lines: [[300, 'watching for changes…'], [20_000, 'rebuilt src/hero.css in 41 ms']], progress: [[500, 'watching'], [20_000, 'rebuilt 1']], endMs, status: 'completed', detail: 'exit code: 0' })

/**
 * The live work every view shows: a goal, a reviewer in the background, six todos, and a watcher, then a year of stored
 * conversations for /stats; then the agent asks `questions` (the script plays on to them).
 */
const panelItems = (prompt, text, questions) => [
  seed(statsSeeds()),
  turn(prompt, [
    goalItem('create', { objective: 'Refresh the landing page hero and keep every test green', maxGoalRounds: 8 }),
    step({
      text: 'A reviewer runs in the background, the todo list is set, and a watcher rebuilds the styles.',
      usage: { inputTokens: 5200, outputTokens: 140, cacheReadTokens: 3000 },
      tools: [reviewer(), todos([['completed', 'Read the brand notes'], ['completed', 'Collect the screenshots'], ['in_progress', 'Rewrite the hero'], ['pending', 'Retake the screenshots'], ['pending', 'Update the README'], ['pending', 'Run the tests']])],
    }),
    watcher(),
    step({ text, usage: { inputTokens: 5600, outputTokens: 160, cacheReadTokens: 5000 } }),
  ]),
  mark('ready'),
  pause(DWELL_VIEWS),
  // The question waits for an answer: a script plays on to it with `play()`.
  turn('Set up the service; ask me what you need.', [
    step({
      text: questions.length === 1 ? 'One question before I start.' : 'A few questions before I start.',
      tools: [tool('ask_user_question', { questions }, { ask: question(questions), result: '{answers}', runMs: 500 })],
    }),
    step({ text: 'Thanks. I will use those answers.' }),
  ]),
  mark('answered'),
  pause(DWELL),
]

/** The panels of Phase 6 over the merged dock (Phase 4's editor frame, Phase 5's status row and views). */
const mergePanels = {
  summary: 'the panels after the merge: /model, /effort, /stats (each tab), /plugin (each tab), and the restyled /agents, /jobs, /mcp, /help, /settings in the /stats chrome (rule and title, no buttons, the keys on the hint row), the y/n confirm of a view\'s x, and a question arriving while a view is entered (the view leaves); the editor frame and the status row return when a panel closes',
  items: panelItems('Refresh the landing page hero.', 'Every panel now has the /stats look: a rule and a title, the keys on one hint row, no buttons. Try /model, /effort, /stats, /plugin, /agents, /jobs, /mcp, /help, /settings; Alt+↓ enters the views, where x asks y/n.', MERGE_QUESTION),
}

/** Pages switched in place keep one height: the tallest page's (component-development-spec §1 rule 13). */
const mergeHeights = {
  summary: 'one height for pages switched in place: the /stats tabs, the /plugin tabs, the question wizard\'s steps and review, and the views of the status row (Agents, Jobs, Goal, Todo); the rows around them never move, and a shorter terminal lowers the height',
  items: panelItems('Refresh the landing page hero.', 'Switch pages and watch the rows under each panel: /stats (←/→), /plugin (Alt+←/→), the views (Alt+↓ then ←/→). None of them moves.', MERGE_QUESTIONS),
}

/**
 * Esc after the merge: your turn stops; a background subagent (a real one, `spawn:`), the watcher, and the queued message
 * stay. A foreground subagent is the turn's own tool call, so it stops with the turn (the one accepted limit).
 */
const mergeEsc = {
  summary: 'Esc stops your turn only: with a real background subagent running (`spawn:… child-hold:240000`), a watcher job, and a queued message, Esc ends your turn while the subagent and the job stay live and the queued message is sent next; Esc on an open panel closes the panel and leaves the turn running; a foreground subagent (`spawn-fg:`) stops with the turn that waits on it',
  items: [
    turn('Watch the styles while we work.', [
      watcher(),
      step({ text: 'The watcher runs in the background. Send `spawn:Background reviewer child-hold:240000 review the README` for a turn that starts a real background subagent and keeps running; type a message while it runs (it queues), then press Esc.', usage: { inputTokens: 3000, outputTokens: 90, cacheReadTokens: 1000 } }),
    ]),
    mark('ready'),
    pause(DWELL_VIEWS),
  ],
}

/** A checklist long enough that the first turn alone fills more than a screen. */
const CHECKLIST = lines(30, n => `- Release step ${String(n)}: confirm the package ${String(n)} builds, passes its specs, and has its changelog entry`)

/** A turn that arrives while the reader is away: a prompt, a call, and an answer taller than a screen, so Ctrl+↓ can stand the rule at the top. */
const arrival = (prompt, file, answer) => turn(prompt, [
  step({ text: `Looking at ${file} first.`, tools: [tool('read', { file_path: file }, { result: `# ${file}\n\nNothing out of date.`, runMs: 400 })] }),
  step({ text: `${answer}\n\n${lines(24, n => `- ${file}, finding ${String(n)}: nothing to change before the release`)}`, usage: { inputTokens: 4000, outputTokens: 60, cacheReadTokens: 3000 } }),
])

/**
 * The new-messages marker: a long first turn to scroll away from, then turns that arrive while the reader is scrolled up,
 * far apart so the rule's 5 s on screen, Ctrl+↓, and scrolling past it can each be tried before the next arrival.
 */
const newMessages = {
  summary: 'a long turn to scroll up from (mouse wheel), then three short turns that arrive while the view is away: the rule before the first unseen block, Ctrl+↓ bringing it to the top, the rule leaving after 5 s on screen or once scrolled past, and the chip naming the key',
  items: [
    turn('Walk me through the release checklist.', [
      step({ reasoning: 'Collect the steps in order, then summarise what is left.', text: `Here is the checklist, one line per package:\n\n${CHECKLIST}`, usage: { inputTokens: 3000, outputTokens: 900, cacheReadTokens: 1000 } }),
    ]),
    mark('history'),
    // The reader scrolls up with the wheel during this pause (the frame script does it with `wheel('up')`).
    pause(DWELL),
    arrival('Check the docs for the release notes.', 'docs/release-notes.md', 'The release notes are current: they name every package in the checklist.'),
    mark('first'),
    pause(DWELL),
    arrival('Check the changelog as well.', 'CHANGELOG.md', 'The changelog has an entry for each package, newest first.'),
    mark('second'),
    pause(DWELL),
    arrival('And the migration guide.', 'docs/migration.md', 'The migration guide covers the one incompatible change and nothing else.'),
    mark('third'),
    pause(DWELL),
  ],
}

/**
 * The view items after the owner's polish: no time in the status row, the hint row at the bottom of every panel, the job
 * time at the right edge, and the subagent row `name(bg) activity` with its facts at the right.
 */
const viewItems = {
  summary: 'the view items: the status row without times, then Alt+↓ through Agents (name(bg|fg), what each is doing, tokens in and out, rate, and time at the right edge), Jobs (the time at the right edge), Goal, and Todo, each with its hint row at the bottom of the panel; a narrow width; and the jobs\' closing line without a time',
  items: [
    turn('Refresh the landing page hero.', [
      goalItem('create', { objective: 'Refresh the landing page hero and keep every test green', maxGoalRounds: 8 }),
      step({
        text: 'A reviewer works in the background, a survey finished, the todo list is set, and two jobs run.',
        usage: { inputTokens: 5200, outputTokens: 140, cacheReadTokens: 3000 },
        tools: [
          reviewer(),
          agent('survey', 'Survey the shot embeds', 'Survey every website page that embeds component shots', { items: [step({ stream: false, tools: [tool('read', { file_path: 'website/features/index.md' }, { result: 'three pages reference the gallery', runMs: 600 })] }), step({ stream: false, text: 'Found three pages embedding shots.', usage: { inputTokens: 5500, outputTokens: 120 } })] }, { runMs: 800 }),
          todos([['completed', 'Read the brand notes'], ['completed', 'Collect the screenshots'], ['in_progress', 'Rewrite the hero'], ['pending', 'Retake the screenshots'], ['pending', 'Run the tests']]),
        ],
      }),
      job('pnpm run build', { lines: [[300, 'building…']], progress: [[500, 'building'], [15_000, 'bundling']], endMs: 40_000, status: 'completed', detail: 'exit code: 0' }),
      watcher(140_000),
      step({ text: 'Press Alt+↓ to enter the views: Agents first, then ←/→ through Jobs, Goal, and Todo. The status row shows no times; the panels keep theirs.', usage: { inputTokens: 5600, outputTokens: 160, cacheReadTokens: 5000 } }),
    ]),
    mark('ready'),
    pause(DWELL_VIEWS),
    // The watcher is the last job to end; its closing line is held five seconds without a time, then the item leaves.
    pause(113_000),
    pause(2000),
    mark('closing'),
    pause(8000),
    mark('gone'),
    pause(DWELL),
  ],
}

/** An answer that paints every role of a palette: a heading, strong text, inline code, a link, a list, a quote, highlighted code, and a diff fence. */
const PALETTE_ANSWER = [
  '## What a palette paints',
  'Every row takes its color from **one semantic table**: the brand hue for `primary` and its tints, four neutral inks for text, and the status colors kept apart from the brand. The recipe is in [the palette sketches](docs/design/prototypes/theme-palettes.mjs).',
  ['- `primary`: the focus arrow, the panel rule, the scroll thumb', '- `accent`: inline code, list bullets, tokens in the prompt', '- `muted` and `textMuted`: secondary text and the hints'].join('\n'),
  '> Scarce violet ink: one primary per surface.',
  ['```ts', '// The banner mark has five inks: body, wings, and three trail shades.', 'export const LOGO_INK_COUNT: number = 5', "export function inkOf(key: string): number {", "  return key === 'W' ? 1 : 0", '}', '```'].join('\n'),
  ['```diff', "-theme: ocean", "+theme: tide", '```'].join('\n'),
].join('\n\n')

/**
 * The palettes and the banner of the theme round: the s10 mark flies in on the empty session (live; the frame runner has
 * reduced motion), then one answer, an edit, a failed call, and a warning paint every role, for a walk through the ten
 * named palettes. A `/clear` greets the fresh conversation with the fly-in again; a `/theme` switch never replays it.
 */
const brandThemes = {
  summary: 'the welcome banner with the s10 mark flying in, then an answer, an edit, a failed call, and a warning that paint every color role: walk the ten named palettes with `/theme` (the picker) or `/theme <key>`, look at the banner at 60 and 40 columns, and `/clear` for the fly-in on a fresh conversation',
  items: [
    // The fly-in plays while the session is empty: nothing else moves on screen until the turn starts.
    pause(DWELL),
    mark('banner'),
    turn('Show me every color the theme paints.', [
      step({ reasoning: 'One answer that touches every token: a heading, emphasis, code, a link, a quote, a diff.', text: PALETTE_ANSWER, usage: { inputTokens: 2400, outputTokens: 420, cacheReadTokens: 1000 } }),
      step({
        usage: { inputTokens: 3100, outputTokens: 120, cacheReadTokens: 2400 },
        tools: [
          edit('settings.yaml', 'mayfly:\n  theme: ocean\n  reducedMotion: false\n', 'mayfly:\n  theme: tide\n  reducedMotion: false\n'),
          tool('bash', { command: 'pnpm run check:themes', description: 'Check the palettes' }, { result: 'paper: primary is 16° from error\n[exit code: 1]', error: true, runMs: 900 }),
        ],
      }),
      step({
        text: 'Now walk the palettes. `/theme` opens the picker, grouped for dark and for light terminals: Mayfly\'s palettes, then the ports, each by name with a line about it, the live one checked; `Enter` switches. `/theme <key>` switches at once: `tide`, `dusk`, `graphite`, `obsidian`, `light`, `linen`, `mist`, `heather`, `porcelain`, and the ports `catppuccin-mocha`, `catppuccin-latte`, `rose-pine`, `rose-pine-dawn`, `dracula`, `nord`, `tokyo-night`, `tokyo-night-day`, `solarized-dark`, `solarized-light`, `gruvbox-dark`, `gruvbox-light`, `one-dark`, `one-light`, `kanagawa-wave`, `kanagawa-lotus`, `everforest-dark`, `everforest-light`; `/theme auto` follows the terminal. Narrow the terminal below 42 columns for the banner without its mark. `/clear` starts a fresh conversation: the mark flies in again. A `/theme` switch never replays it.',
        usage: { inputTokens: 3300, outputTokens: 160, cacheReadTokens: 3000 },
      }),
    ]),
    mark('dark'),
    notify('warning', 'Rate limited · retrying in 4 s', { holdMs: 600_000 }),
    pause(100),
    mark('ready'),
    pause(DWELL_VIEWS * 8),
  ],
}

/**
 * The start round: a start with no session. Four stored conversations (two here, two in sibling projects) stand in for the
 * recent list of the launch screen; nothing else is played, because the session does not exist until the script sends the
 * first message. The product answers that message itself, from the stub endpoint.
 */
const startSplash = {
  summary: 'a start with no session: the launch screen over stored sessions, /settings, /theme and a refused /model before any message, the first message creating the session, and /clear returning to the launch screen',
  items: [
    seed([
      { id: 'seed-splash', at: -3 * HOUR, title: 'Redesign the launch screen', items: earlier('Sketch the launch screen.', 'Mark, wordmark, slogan, recent sessions.', { inputTokens: 12_000, outputTokens: 800, cacheReadTokens: 9_000 }) },
      { id: 'seed-archive', at: -DAY, title: 'Archive sessions without a rescan', items: earlier('Archive without a rescan.', 'The archive reads headers only.', { inputTokens: 5_000, outputTokens: 300, cacheReadTokens: 2_000 }) },
      { id: 'seed-harness', at: -2 * DAY, cwd: 'harness', title: 'Fix the flaky scheduler test', items: earlier('The scheduler test is flaky.', 'A timer raced the clock; it now awaits the tick.', { inputTokens: 8_000, outputTokens: 600, cacheReadTokens: 6_000 }) },
      { id: 'seed-dock', at: -3 * DAY, cwd: 'mayfly-dock', title: 'Port the dock overlay to panes', items: earlier('Port the dock overlay.', 'The overlay is a pane now.', { inputTokens: 20_000, outputTokens: 1_100, cacheReadTokens: 15_000 }) },
    ]),
    mark('splash'),
    pause(DWELL),
    mark('end'),
  ],
}

export const REPLAYS = { mergeDock, mergeConversations, mergePanels, mergeHeights, mergeEsc, viewItems, newMessages, brandThemes, startSplash }
