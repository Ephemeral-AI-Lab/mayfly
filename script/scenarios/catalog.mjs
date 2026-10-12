/**
 * The scenario catalog: every named state of the live product that review, frames, goldens, and perf read. A scenario
 * names its source (a replay of `replays.mjs`, an empty session, or the UI gallery), the sources it `covers` (the
 * change-based selection reads them), its sizes, and the script the runner plays: `play` to a mark or the end, keys,
 * mouse, resizes, and named checkpoints (see `steps.mjs`). `pnpm run scenario --list` prints it.
 * @module script/scenarios/catalog
 */

import { REPLAYS } from './replays.mjs'
import { checkpoint, idle, key, measure, play, resize, type, wheel } from './steps.mjs'

/** The size a scenario runs at unless it names its own. */
export const DEFAULT_SIZE = Object.freeze([120, 40])

const TRANSCRIPT = 'packages/mayfly/src/transcript/'
const INTERACTION = 'packages/mayfly/src/interaction/'
/** What draws the conversation stream: the facts of its rows and the component that lays them out. */
const STREAM = [`${TRANSCRIPT}stream-facts.ts`, 'packages/mayfly/src/components/']

/** What each replay shows, as the sources whose change it can reveal. */
const COVERS = {
  tour: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}process-*.ts`, `${TRANSCRIPT}pane-todo.ts`, ...STREAM],
  toolkit: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}present.ts`, ...STREAM],
  thinking: [...STREAM, `${TRANSCRIPT}presentation-policy.ts`, 'packages/mayfly/src/core/ui-list-paint.ts'],
  live: [...STREAM],
  markdown: [...STREAM, 'packages/mayfly/src/core/components.ts', 'packages/mayfly/src/core/content-rows.ts', 'packages/mayfly/src/core/markdown-rows.ts', 'packages/mayfly/src/core/ui-list-paint.ts'],
  phases: [`${TRANSCRIPT}pane-activity.ts`, `${TRANSCRIPT}spinners.ts`, `${TRANSCRIPT}output-rate.ts`],
  prompts: [`${TRANSCRIPT}transcript-model.ts`, `${INTERACTION}attachments.ts`, ...STREAM],
  turns: [`${TRANSCRIPT}transcript-model.ts`, `${TRANSCRIPT}process-groups.ts`, `${TRANSCRIPT}presentation-policy.ts`, `${INTERACTION}pane-queue.ts`, 'packages/mayfly/src/core/node-slot.ts', ...STREAM],
  errors: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}transcript-model.ts`, ...STREAM],
  toollines: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}process-*.ts`, `${TRANSCRIPT}official-model.ts`, 'packages/mayfly/src/frontend/models.ts', ...STREAM],
  edits: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}process-*.ts`, `${TRANSCRIPT}official-model.ts`, 'packages/mayfly/src/frontend/models.ts', 'packages/mayfly/src/core/content-rows.ts', 'packages/mayfly/src/core/diff-align.ts', 'packages/mayfly/src/core/highlight.ts', ...STREAM],
  compaction: [...STREAM],
  manualCompact: [...STREAM],
  context: [`${TRANSCRIPT}status-context.ts`, ...STREAM],
  subagents: [`${TRANSCRIPT}pane-agents.ts`, `${TRANSCRIPT}child-agent-model.ts`],
  childStream: [`${TRANSCRIPT}pane-agents.ts`, `${INTERACTION}agents-command.ts`],
  approvals: [`${INTERACTION}approval-plugin.ts`, `${INTERACTION}permission-panel.ts`],
  questions: [`${INTERACTION}questions-plugin.ts`, `${INTERACTION}questionnaire.ts`],
  plan: [`${INTERACTION}plan-review-panel.ts`, `${INTERACTION}plan-document.ts`],
  goal: [`${TRANSCRIPT}status-goal.ts`],
  jobs: [`${TRANSCRIPT}status-jobs.ts`, `${INTERACTION}jobs.ts`],
  queued: [`${INTERACTION}pane-queue.ts`],
  retries: [`${TRANSCRIPT}transcript-model.ts`, `${INTERACTION}trace-*.ts`, ...STREAM],
  sideQuestion: [`${INTERACTION}btw-command.ts`, `${INTERACTION}conversation-view-status.ts`],
  notices: [`${INTERACTION}notifications.ts`],
  modes: [`${INTERACTION}mode-status.ts`, `${TRANSCRIPT}status-model.ts`],
  edge: [...STREAM, 'packages/mayfly/src/core/width.ts'],
  history: [`${TRANSCRIPT}conversation-feed.ts`, `${TRANSCRIPT}transcript-model.ts`, ...STREAM],
  wheel: ['packages/mayfly/src/core/terminal.ts', 'packages/mayfly/src/core/node-slot.ts', `${TRANSCRIPT}conversation-feed.ts`, ...STREAM],
  content: [
    'packages/mayfly/src/core/content-*.ts', 'packages/mayfly/src/core/width-estimate.ts', 'packages/mayfly/src/core/plugin-view.ts',
    'packages/mayfly/src/core/ui-rows.ts', 'packages/mayfly/src/core/ui-scroll-region.ts',
    'packages/mayfly/src/core/ui-content-cache.ts', `${INTERACTION}trace-*.ts`, `${INTERACTION}jobs.ts`,
  ],
}

/**
 * The briefs of scenarios whose group is in review (docs/design/component-development-spec.md §5.1): the prototype
 * `scene`, the `reference`, and the effects `implemented`, to look at (`focus`: what to judge and `how` to reach it),
 * that `differs` from the prototype, and `pending`. `brief.mjs` prints them. Finalizing a group removes its entries.
 */
const REVIEW = {
  toolkit: {
    scene: 17,
    reference: 'prototype scene 17 (Tool rows and edits) · spec §5.3 · every kind of call in one turn',
    implemented: [
      'Reads, searches, web calls, skills, jobs, MCP and unknown tools each settle into the Standard block or line of their kind.',
      'Runs of calls of one kind share a block (the job tools and the skill are `Called 4 tools`).',
    ],
    focus: [
      { look: 'One block per run of one kind; a single call stays a line', how: 'checkpoint `end`' },
      { look: 'The verbose bodies of the same calls', how: '`pnpm run frame toolkit --keys ctrl+o`, checkpoint `keys`' },
    ],
    differs: ['The replay runs without most tool presenters, so some outcomes (matches, status, size) show only where the replay carries the presenter data.'],
    pending: ['The edit and the write are parts 3b.2 and 3b.3 (scenario `edits`).'],
  },
  errors: {
    scene: 17,
    reference: 'prototype scene 17 (Tool rows and edits) · spec §5.3 · failed and cut-off calls',
    implemented: [
      'A failed call is ✗ with its reason on the line (the first line of the error, clipped), at every tier.',
    ],
    focus: [
      { look: 'The failed lines of the failed turn', how: '`pnpm run frame errors --keys ctrl+o`, checkpoint `keys` (the ⊘ cancelled line is in `toollines`)' },
    ],
    differs: [],
    pending: [],
  },
  toollines: {
    scene: 17,
    reference: 'prototype scene 17 (Tool rows and edits) · spec §5.3 · docs/design/component-development-spec.md §7.1 (every tool at three tiers)',
    implemented: [
      'Standard (default): a run of calls of one kind is one block (`✓ Read 3 files · 48 lines` and a tree of paths with their lines); a single call is one line, `✓ Read(path) · 8 lines`, with the tool\'s own name in bold; a settled turn shows its blocks inline.',
      'Verbose (and Ctrl+O): one block per call, `✓ Bash(command) · 4.2s` with the output on the lines under it (no `⎿` mark) and a body of up to 6 rows: the lines read, the matches, the command output tail, the sources, the head of a fetched page; Ctrl+O shows every row the facts carry (40).',
      'Compact: the turn folds behind its header; an interrupted turn shows one merged line per run (`▸ Ran 2 commands · Read 1 file · 1.1s · 1 failed`).',
      'Detailed: the step the model works in draws verbose blocks and the steps before it collapse to Standard blocks; a settled turn is Standard.',
      'A failed call keeps its reason on its line at every tier; a call cut off by an interrupt reads ⊘ with no outcome. A running call has no block: the activity row names it at every level.',
      'A blank row separates every row of a turn, as in Claude Code.',
    ],
    focus: [
      { look: 'Standard blocks: head with counts and time, tree of items, failures marked ✗', how: 'checkpoint `standard`' },
      { look: 'Verbose bodies: read lines, matches, output tail, sources, page head, and the `… +N more · Ctrl+O` row', how: 'Ctrl+O is `open` (all rows); `pnpm run scenario toollines-verbose` is the capped form' },
      { look: 'Compact merged line and the folded header', how: '`pnpm run scenario toollines-compact`, checkpoint `end`' },
      { look: 'Detailed collapse: earlier steps become Standard blocks when the next step starts', how: '`pnpm run scenario toollines-detailed`, checkpoint `live` (stopped after step 3)' },
      { look: 'The ⊘ line of the interrupted build and the failed lint', how: 'checkpoint `open`, the last turn' },
      { look: 'Long paths and commands clip at the end; the tree and glyphs stay', how: '`--width 60` and `--width 40`' },
      { look: 'Spacing: a blank row between every row', how: 'any checkpoint' },
    ],
    differs: [
      'Targets are the paths as given, not shortened (owner decision), so a long path pushes the outcome off a narrow row.',
      'The fetch size is derived from the length of the result text (the tool reports only the status): it is approximate.',
      'The command output tail is drawn here in 3b.1 (the spec assigned command rows to 3b.3): the tier rule asks every tool for a verbose body; 3b.3 builds the Write card only.',
      'The prototype folds with `Read 3 files · …`; the real title also counts failures (`· 2 failed`) and caps at three categories plus `…`.',
    ],
    pending: [
      'Edit and write calls are in scenario `edits` (parts 3b.2 and 3b.3).',
      'Enter on a line, copy, and opening a row in the editor are row selection (3e.2).',
    ],
  },
  edits: {
    scene: 17,
    reference: 'prototype scene 17 (Tool rows and edits) · spec §5.3 EditCard and WriteCard · docs/design/component-development-spec.md §7.1',
    implemented: [
      'Standard: every edit and every write is its own open block, never folded into a run: an edit is its line (`✓ Edit(path) · +4 −2 ▮▮▮▮▮▮▯▯`) and its diff, a write is its line (`✓ Write(path) · 84 lines · 3.1 KB`) and its code, numbered and highlighted by the file extension; both show 6 rows.',
      'Verbose and Detailed (the current step): the same blocks at 12 rows (a `⋯` between hunks, `… +N rows` after); Ctrl+O lifts both to 40.',
      'Compact: the turn folds behind its header; the merged line counts the changes and the diffstat (`Edited 3 files · Wrote 1 file · Ran 1 command · 1.8s · +33 −8`).',
      'A failed edit is `✗ Edit(path) · <first line of the reason>` at every tier, with no diff; a write cut off by an interrupt is `⊘ Write(path)`. A running edit or write has no block: the activity row names it.',
      'The diff is syntax-highlighted by the file extension and has one quiet line-number gutter that numbers the modified file (a removed line has a blank cell); the tint behind a changed line stops 4 columns short of the right edge. The Harness sends three lines of context around a hunk, the diff body keeps one.',
    ],
    focus: [
      { look: 'The single edit: line, diffstat bar, highlighted code, the inset bands, the gutter and signs, one context line each side', how: 'checkpoint `standard`, the first edit' },
      { look: 'The multi-hunk edit and the `⋯` between hunks', how: 'Ctrl+O is `open`; or `pnpm run scenario edits-verbose`' },
      { look: 'Several changes in a row stay separate open blocks', how: 'checkpoint `standard`, the "handful of files" step' },
      { look: 'The large edit capped at 6 / 12 / 40 rows with its `… +N rows` row', how: 'compare checkpoint `standard`, `edits-verbose` and `open`' },
      { look: 'The write: highlighted numbered code, 6 rows at Standard and 12 at Verbose', how: 'checkpoint `standard`, then `pnpm run scenario edits-verbose`' },
      { look: 'The failed edit and the cancelled write', how: 'checkpoint `open`, last lines of each turn' },
      { look: 'Narrow widths: the diff rows clip with `…`, the line clips at the end, the gutter takes 5 columns', how: '`--width 60` and `--width 40`' },
      { look: 'Compact and Detailed', how: '`pnpm run scenario edits-compact`, `pnpm run scenario edits-detailed` (checkpoint `live`)' },
    ],
    differs: [
      'The line numbers are relative: the Harness gives hunk text with no start line, so each hunk counts from 1, and only the modified file is numbered (owner decision, until a real start line is available).',
      'A call is named by its tool (`Edit`, `Write`), not the prototype\'s `Edited`/`Wrote`; the verbs stay in the head of a run (owner decision).',
      'The failure reason is on the call\'s line, not on a `⎿` row (owner decision, 3b.1).',
      'Edits and writes are open at Standard and fold only at Compact (owner decision), so they never form a tree.',
      'A diff that exceeds its rows ends with the painter\'s own `… +N rows · Ctrl+O`, in English, even when Ctrl+O is already open.',
    ],
    pending: [
      'Command rows are finished in 3b.1 (no `⎿` tails); there is no command work in this part.',
      'The 400 ms flash when an edit settles and the counts ticking while it applies are unscheduled; the activity row names the edit while it runs (part 3c).',
      'Enter, copy, and opening the diff in the editor are row selection (3e.2).',
    ],
  },
}

/**
 * Scripts that differ from playing to the end. A settled job wakes the agent for a real turn on the stub, which runs
 * at real time, so the jobs replay is captured while all three jobs run.
 */
const SCRIPTS = {
  // A settled turn folds behind its title; Ctrl+O opens its calls as lines; the interrupted turn leaves a call cancelled.
  toollines: [
    play(), checkpoint('standard'),
    key('ctrl+o'), checkpoint('open'),
    resize(72, 30), checkpoint('resized'),
  ],
  // Standard (single edit and write, a run), Ctrl+O (every body at 40 rows), then a narrow terminal.
  edits: [
    play(), checkpoint('standard'),
    key('ctrl+o'), checkpoint('open'),
    resize(72, 30), checkpoint('resized'),
  ],
  // Settled turns, then the turn that holds queued messages, then its end; Ctrl+O opens the folds, and a resize narrows it.
  turns: [
    play('settled'), checkpoint('settled'),
    play('queued'), checkpoint('queued'),
    play(), checkpoint('end'),
    key('ctrl+o'), checkpoint('open'),
    resize(48, 24), checkpoint('narrow'),
  ],
  // Reasoning is a card of the open view: Standard folds it, Ctrl+O opens it, and a resize narrows the open turn.
  thinking: [
    play('thinking'), checkpoint('live'),
    play(), checkpoint('end'),
    key('ctrl+o'), checkpoint('open'),
    resize(48, 24), checkpoint('narrow'),
  ],
  // A long markdown answer, stopped half-way through its stream, then settled and narrowed.
  markdown: [
    play('half'), checkpoint('half'),
    play(), checkpoint('end'),
    resize(60, 24), checkpoint('narrow'),
  ],
  jobs: [play('running'), checkpoint('running')],
  // The wheel scrolls the transcript back: the two checkpoints differ only by the scroll.
  wheel: [play(), checkpoint('end'), wheel('up', { count: 3 }), checkpoint('wheel')],
  // The collapsed write card, then /trace on its tool call: the megabyte document in one scroll, paged and resized.
  content: [
    play(), checkpoint('card'),
    type('/trace'), key('enter'), key('end'), key('up', { repeat: 4 }), key('enter'), checkpoint('detail'),
    key('pagedown'), checkpoint('paged'), key('end'), checkpoint('tail'), resize(80, 24), checkpoint('resized'),
  ],
}
/** Replays that run at a size of their own. */
const SIZES = {
  turns: [DEFAULT_SIZE, [60, 24], [40, 24]],
  toollines: [[120, 80], [60, 64], [40, 64]],
  edits: [[120, 90], [60, 70], [40, 70]],
  wheel: [[40, 24]],
}

/** A replay played to its end (or to the prompt that waits for an answer), captured there. */
const replayScenario = (name, replay) => ({
  summary: replay.summary,
  source: { replay: name },
  covers: COVERS[name] ?? [],
  sizes: SIZES[name] ?? [DEFAULT_SIZE],
  script: SCRIPTS[name] ?? [play(), checkpoint('end')],
  ...(REVIEW[name] === undefined ? {} : { review: REVIEW[name] }),
})

/** The size of the Website's app shots. */
const APP_SIZE = Object.freeze([80, 24])

/**
 * The Website's app shots: scenes of the real product at 80x24. `shots` names, for each checkpoint, the shot under
 * `website/public/shots/` that `pnpm run shots:sync` paints from its golden.
 */
const APP = {
  'app-conversation': {
    summary: 'the Website hero: a finished turn above the editor and the status row',
    source: { replay: 'appConversation' },
    covers: [`${TRANSCRIPT}transcript-model.ts`, `${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}status-*.ts`, `${TRANSCRIPT}banner*.ts`, ...STREAM],
    sizes: [APP_SIZE],
    shots: { end: 'app-conversation' },
    script: [play(), checkpoint('end')],
  },
  'app-trace': {
    summary: 'the Website shot of /trace: the finished turn\'s log with a tool result\'s raw detail open',
    source: { replay: 'appConversation' },
    covers: [`${INTERACTION}trace-*.ts`],
    sizes: [APP_SIZE],
    shots: { detail: 'app-trace' },
    script: [play(), type('/trace'), key('enter'), key('down', { repeat: 16 }), key('enter'), checkpoint('detail')],
  },
  'app-permission': {
    summary: 'the Website shot of /permission: the preset picker over the finished turn',
    source: { replay: 'appConversation' },
    covers: [`${INTERACTION}permission-panel.ts`],
    sizes: [APP_SIZE],
    shots: { picker: 'app-permission' },
    script: [play(), type('/permission'), key('enter'), checkpoint('picker')],
  },
  'app-agents': {
    summary: 'the Website shot of subagents: done, running, and waiting in the agents pane',
    source: { replay: 'appAgents' },
    covers: [`${TRANSCRIPT}pane-agents.ts`, `${TRANSCRIPT}child-agent-model.ts`],
    // Six rows taller, so the agents pane is not cut to its overflow row; the width keeps the shots' scale.
    sizes: [[80, 30]],
    shots: { running: 'app-agents' },
    script: [play('running'), checkpoint('running')],
  },
  'app-sessions': {
    summary: 'the Website shots of /sessions: the workspaces of stored conversations, then one workspace\'s lineage',
    source: { replay: 'appSessions' },
    covers: [`${INTERACTION}native-sessions.ts`, `${INTERACTION}session-*.ts`],
    sizes: [APP_SIZE],
    shots: { workspaces: 'app-sessions', workspace: 'app-session-workspace' },
    script: [play(), type('/sessions'), key('enter'), checkpoint('workspaces'), key('enter'), checkpoint('workspace')],
  },
}

const SENTENCE = 'the quick brown fox jumps over the lazy dog and keeps typing until the prompt wraps onto a second row of the editor'
/** Open a panel by its command, measure its cursor keys, and close it. */
const nav = command => [type(command), key('enter'), measure(`nav ${command}`, [key('down', { repeat: 20 }), key('up', { repeat: 20 })]), key('esc'), key('esc'), key('ctrl+c')]
const FRAME_PATH = ['packages/mayfly/src/core/terminal.ts', 'packages/mayfly/src/core/surface-*.ts', 'packages/mayfly/src/core/keymap.ts', 'packages/mayfly/src/core/key-actions.ts', 'packages/mayfly/src/core/ui-compiler.ts', `${INTERACTION}editor-extension-runtime.ts`, `${INTERACTION}input-plugin.ts`]

/**
 * The perf scenarios: what `pnpm run perf` measures A/B against the merge base, and the absolute ceilings the full
 * tier holds each span to (`MAYFLY_PERF_SLACK` scales them on a shared runner). A ceiling names a span (a trailing `*`
 * matches a prefix) and a metric. They capture no checkpoints.
 */
const PERF = {
  'perf-focus': {
    summary: 'idle, typing, and the cursor keys of /settings, /model, /theme, and /help, with no pane',
    source: { idle: true },
    covers: FRAME_PATH,
    sizes: [DEFAULT_SIZE],
    perf: { ceilings: { 'idle': { cpuPct: 10 }, 'type': { keyP50Ms: 10, cpuPerKeyMs: 5 }, 'nav *': { cpuPerKeyMs: 12 } } },
    script: [idle(4000), measure('type', [type(SENTENCE)]), key('ctrl+c'), ...nav('/settings'), ...nav('/model'), ...nav('/theme'), ...nav('/help')],
  },
  'perf-gallery': {
    summary: 'idle and typing beside the gallery side pane',
    source: { gallery: true },
    covers: ['examples/ui-gallery/src/', 'packages/mayfly/src/core/views-lane.ts', ...FRAME_PATH],
    sizes: [DEFAULT_SIZE],
    perf: { ceilings: { idle: { cpuPct: 10 }, type: { keyP50Ms: 20 } } },
    script: [idle(4000), measure('type', [type(SENTENCE)])],
  },
  'perf-stream': {
    summary: 'a long streamed answer at its own pace, then page keys and the mouse wheel over the transcript',
    source: { replay: 'markdown' },
    covers: [`${TRANSCRIPT}conversation-feed.ts`, `${TRANSCRIPT}transcript-model.ts`, ...STREAM, 'packages/mayfly/src/core/components.ts'],
    sizes: [DEFAULT_SIZE],
    // Measured on the dev machine at 27% / 3 ms; the ceilings keep the headroom of the other scenarios.
    perf: { ceilings: { stream: { cpuPct: 45 }, scroll: { keyP50Ms: 12, cpuPerKeyMs: 8 }, wheel: { keyP50Ms: 12, cpuPerKeyMs: 8 } } },
    script: [measure('stream', [play(undefined, { timed: true })]), measure('scroll', [key('pageup', { repeat: 10 }), key('pagedown', { repeat: 10 })]), measure('wheel', [wheel('up', { count: 10 }), wheel('down', { count: 10 })])],
  },
  'perf-content': {
    summary: 'page keys, End, and a resize inside the trace detail of a megabyte write',
    source: { replay: 'content' },
    covers: [
      'packages/mayfly/src/core/content-*.ts', 'packages/mayfly/src/core/width-estimate.ts', 'packages/mayfly/src/core/plugin-view.ts',
      'packages/mayfly/src/core/ui-rows.ts', 'packages/mayfly/src/core/ui-scroll-region.ts',
      'packages/mayfly/src/core/ui-content-cache.ts', `${INTERACTION}trace-*.ts`, ...FRAME_PATH,
    ],
    sizes: [DEFAULT_SIZE],
    perf: { ceilings: { scroll: { keyP50Ms: 20, cpuPerKeyMs: 30 }, resize: { keyP50Ms: 50, cpuPerKeyMs: 50 } } },
    script: [
      play(), type('/trace'), key('enter'), key('end'), key('up', { repeat: 4 }), key('enter'),
      measure('scroll', [key('pagedown', { repeat: 8 }), key('end'), key('home')]),
      measure('resize', [resize(80, 24), resize(120, 40)]),
    ],
  },
}

/** The catalog, by scenario name. */
export const CATALOG = Object.freeze({
  idle: {
    summary: 'the product on an empty session: the banner, the editor, and the status row',
    source: { idle: true },
    covers: [`${TRANSCRIPT}banner*.ts`, `${TRANSCRIPT}status-*.ts`, `${INTERACTION}input-plugin.ts`],
    sizes: [DEFAULT_SIZE, [60, 24]],
    script: [checkpoint('boot')],
  },
  gallery: {
    summary: 'the UI gallery: a side pane, a view in status row 2, and a bottom prompt pane',
    source: { gallery: true },
    covers: ['examples/ui-gallery/src/', 'packages/mayfly/src/core/views-lane.ts', 'packages/mayfly/src/core/surface-*.ts'],
    sizes: [DEFAULT_SIZE],
    script: [checkpoint('boot')],
  },
  // The Host schedule service ships disabled, so /schedule degrades to its unavailable surface.
  schedule: {
    summary: 'the /schedule overlay on a composition without the Host service',
    source: { idle: true },
    covers: [`${INTERACTION}schedule-command.ts`],
    sizes: [DEFAULT_SIZE, [40, 24]],
    script: [type('/schedule'), key('enter'), checkpoint('catalog')],
  },
  ...Object.fromEntries(Object.entries(REPLAYS).map(([name, replay]) => [name, replayScenario(name, replay)])),
  // The same reasoning with every card open: the live row mid-stream, the settled row, and the narrow row.
  'thinking-verbose': {
    summary: 'a long reasoning block at the Verbose level: the live reasoning row, then the settled one with its whole text',
    source: { replay: 'thinking' },
    config: { mayfly: { transcriptView: 'verbose' } },
    covers: COVERS.thinking,
    sizes: [DEFAULT_SIZE],
    script: [
      play('thinking'), checkpoint('live'),
      play(), checkpoint('settled'),
      resize(48, 24), checkpoint('narrow'),
    ],
  },
  // The same tool lines at the other work-details levels (the default, Standard, is `toollines`).
  ...Object.fromEntries(['compact', 'detailed', 'verbose'].map(level => [`toollines-${level}`, {
    summary: `the tool lines at the ${level[0].toUpperCase()}${level.slice(1)} level`,
    source: { replay: 'toollines' },
    config: { mayfly: { transcriptView: level } },
    covers: COVERS.toollines,
    sizes: [[120, 80], [60, 64]],
    script: level === 'detailed' ? [play('built'), checkpoint('live'), play(), checkpoint('end')] : [play(), checkpoint('end')],
  }])),
  // The file changes at the other work-details levels (the default, Standard, is `edits`).
  ...Object.fromEntries(['compact', 'detailed', 'verbose'].map(level => [`edits-${level}`, {
    summary: `the file changes at the ${level[0].toUpperCase()}${level.slice(1)} level`,
    source: { replay: 'edits' },
    config: { mayfly: { transcriptView: level } },
    covers: COVERS.edits,
    sizes: [[120, 90], [60, 70]],
    script: level === 'detailed' ? [play('run'), checkpoint('live'), play(), checkpoint('end')] : [play(), checkpoint('end')],
  }])),
  // The pill: scroll away from a streaming answer, let the rest arrive, then follow it again with Ctrl+↓.
  live: {
    summary: 'a streamed answer: scroll away mid-stream, see the chip (`Back to bottom`, then `N new turns`), then Ctrl+↓ follows it',
    source: { replay: 'live' },
    covers: ['packages/mayfly/src/core/terminal.ts', 'packages/mayfly/src/core/surface-renderer.ts', ...COVERS.markdown],
    sizes: [DEFAULT_SIZE, [60, 24]],
    script: [
      play('half'), checkpoint('half'),
      wheel('up', { count: 3 }), checkpoint('scrolled'),
      play(), checkpoint('away'),
      key('ctrl+down'), checkpoint('followed'),
    ],
  },
  ...APP,
  ...PERF,
})

/** Each Website app shot, with the scenario checkpoint whose golden (at the scenario's first size) it is painted from. */
export const APP_SHOTS = Object.freeze(Object.entries(CATALOG).flatMap(([name, scenario]) => Object.entries(scenario.shots ?? {}).map(([checkpointName, id]) => ({ id, scenario: name, checkpoint: checkpointName, cols: scenario.sizes[0][0], rows: scenario.sizes[0][1] }))))

/** The scenarios checked against goldens, and the perf scenarios. */
export const GOLDEN_SCENARIOS = Object.keys(CATALOG).filter(name => CATALOG[name].perf === undefined)
export const PERF_SCENARIOS = Object.keys(CATALOG).filter(name => CATALOG[name].perf !== undefined)

/**
 * Look a scenario up.
 * @param {string} name
 * @returns the scenario with its name, or undefined.
 */
export function scenarioNamed(name) {
  return Object.hasOwn(CATALOG, name) ? { name, ...CATALOG[name] } : undefined
}
