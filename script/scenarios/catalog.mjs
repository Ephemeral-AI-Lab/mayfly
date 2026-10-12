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
  markdown: [...STREAM, 'packages/mayfly/src/core/components.ts', 'packages/mayfly/src/core/content-rows.ts', 'packages/mayfly/src/core/markdown-rows.ts', 'packages/mayfly/src/core/ui-list-paint.ts'],
  phases: [`${TRANSCRIPT}pane-activity.ts`, `${TRANSCRIPT}spinners.ts`, `${TRANSCRIPT}output-rate.ts`],
  prompts: [`${TRANSCRIPT}transcript-model.ts`, `${INTERACTION}attachments.ts`, ...STREAM],
  turns: [`${TRANSCRIPT}transcript-model.ts`, `${TRANSCRIPT}process-groups.ts`, `${TRANSCRIPT}presentation-policy.ts`, `${INTERACTION}pane-queue.ts`, 'packages/mayfly/src/core/node-slot.ts', ...STREAM],
  errors: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}transcript-model.ts`, ...STREAM],
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
  turns: {
    scene: 18,
    reference: 'prototype scenes 18 (Conversation stream) and 19 (Prompt styles, A) · spec §5.6 · TranscriptView and userItems in mayfly-components.mjs',
    implemented: [
      'The stream is one browse list on the conversation node slot and the outer view scrolls it: the wheel, PageUp, and End work as before.',
      'A blank row opens every turn after the first, and a turn that has ended closes with one muted row: `✻ Worked for 17s · done 10:13` (`Stopped after` / `Failed after` when it did not finish). No line is drawn.',
      'The prompt is a bold » row that wraps, keeps four lines, and hides the rest behind a muted `▸ N more lines · Enter` row; Ctrl+O opens the prompts of the last three turns.',
      'A message queued while the agent works shows after the last turn as a prompt row ending in `⏎ queued`, behind a blank row.',
      'An interrupted turn ends with `■ interrupted` in the warning tone.',
      'Answers, reasoning, tool calls and their groups, the turn header, and compaction are one-row stand-ins that the next parts replace.',
    ],
    focus: [
      { look: 'The closing row of each turn: its gray, its spacing around it, and whether the turn boundary reads without a line', how: 'checkpoint settled; node docs/design/prototypes/ui-preview.mjs 18 for the sketch\'s rule' },
      { look: 'A long prompt wrapped, a seven-line prompt folded, and a CJK prompt that wraps mid-sentence', how: 'checkpoint settled' },
      { look: 'Continuation lines of a wrapped prompt starting under the text, after the », and under a wrapped answer', how: 'checkpoint settled, then --width 60' },
      { look: 'The queued rows after the last turn, and the pane above the editor showing the same messages', how: 'checkpoint queued' },
      { look: 'The interrupted turn: its header, its group title, and the cut marker', how: 'checkpoint settled' },
      { look: 'Ctrl+O opening the folded prompts and the process of the last three turns', how: 'checkpoint open (Ctrl+O on end)' },
      { look: 'The closing row and the fold row at 60, 48, and 40 columns', how: 'checkpoint narrow, and --width 60 / --width 40' },
    ],
    differs: [
      'The sketch (and spec §5.6) separates turns with a timed rule; the owner asked for a quieter closing row at the end of each turn instead (like Claude Code), so the header drops its duration, which the closing row carries.',
      'The prototype draws no queued or interrupted row: both are placed from the spec text (§5.6).',
      'A queued message is also in the queue pane until Phase 4 deletes it; the sketch shows the queue line only above the editor.',
    ],
    pending: [
      'Answers show their source text line by line; markdown, blank-row rhythm, and wrap indent come with 3a.2.',
      'The live reasoning row shows its last line; the real reasoning row, the streamed turn, and the `↓ N new` pill are 3a.2 and 3a.3.',
      'Images are a label row; pictures are 3a.4. Tool lines, cards, and diffs are 3b; the activity row, banners, and compaction rows are 3c.',
      'Rows take no focus: Alt+↑, Enter expand, and c copy come with row selection (3e.2), so the list hint row is not shown.',
      'The running header of a read-only child shows no ticking duration until 3c.',
      'The `!` shell echo and the plan document sit below the stream, no longer at the tail of the turn that made them.',
      'The `userFoldLines` and `userFoldChars` settings no longer fold anything; they go with the settings surface once the four-line cap is accepted.',
    ],
  },
  markdown: {
    scene: 18,
    reference: 'prototype scene 18 (Conversation stream), the answer rows · spec §5.6 and Δ21 · turnItemsRaw in mayfly-components.mjs',
    implemented: [
      'An answer is Markdown: headings, bullets with nested items, tables drawn as boxes, fenced code highlighted by language, and inline emphasis, code, and links.',
      'A `● ` leads the answer\'s first row and every other row sits under it, two columns in; a long paragraph wraps under its own first letter.',
      'Blocks are separated by one blank row, the renderer\'s own rhythm.',
      'The answer grows in place while it streams and the view follows its tail; settling it changes no row above the last block.',
    ],
    focus: [
      { look: 'Headings, lists, the table, and both code fences against the sketch\'s plain wrapped lines', how: 'checkpoint end' },
      { look: 'The `● ` and the two-column hang on the first row and on a wrapped paragraph', how: 'checkpoint end, then --width 60' },
      { look: 'Half an answer: the open block at the tail and the tail in view', how: 'checkpoint half' },
      { look: 'A table and a fence at 60 columns', how: 'checkpoint narrow' },
    ],
    differs: [
      'The sketch draws an answer as plain wrapped lines; the spec (Δ21) keeps the shipped Markdown component, so headings, tables, and highlighted fences appear.',
      'The sketch indents every answer row by two columns; here the Markdown renderer\'s own list and quote indents add to those two.',
    ],
    pending: [
      'The `↓ N new · End` pill and the cost of very long answers are 3a.3 (a live answer still shows at most its last 32,000 characters).',
      'Reasoning, tool rows, and the activity row are the other parts\' work.',
    ],
  },
  thinking: {
    scene: 18,
    reference: 'prototype scene 18 (Conversation stream), the `think` rows · spec §5.6 · turnItemsRaw in mayfly-components.mjs',
    implemented: [
      'At Standard a finished turn folds its reasoning behind the header (`▸ Took 10s · Ctrl+O to expand`); Ctrl+O opens the last three turns and the reasoning shows whole.',
      'An opened reasoning is a header row of its own, `✻ Thinking · 9s` (how long it took), and the whole text under it, wrapped and aligned with the word `Thinking`, paragraphs kept.',
    ],
    focus: [
      { look: 'The folded turn, then the reasoning that Ctrl+O opens', how: 'checkpoint end, then checkpoint open' },
      { look: 'The wrap under the text at 48 columns', how: 'checkpoint narrow' },
    ],
    differs: [
      'The sketch\'s reasoning is one sentence; real reasoning is many paragraphs, shown whole when a turn is open (owner decision, no cap).',
      'R2\'s `Thought for 9s` row is now the header `✻ Thinking · 9s` with the text on the lines below it, not beside it.',
    ],
    pending: [
      'Which levels show reasoning, and the one-line preview that Detailed will show for a settled turn, come with the levels (3e.1); the preview row exists but a Detailed turn folds until then.',
      'Selecting a reasoning row, copying it, and searching it are 3e.',
    ],
  },
  'thinking-verbose': {
    scene: 18,
    reference: 'prototype scene 18 (Conversation stream) at level Verbose, the `think` rows · spec §5.6',
    implemented: [
      'At Verbose the reasoning streams in: a `✻ Thinking` header and the text growing line by line under it, aligned with the word `Thinking`; the activity row keeps the clock and counters.',
      'A settled turn at Verbose shows `✻ Thinking · 9s` and the whole text under it, wrapped.',
      'At the other levels that show live reasoning (Detailed) the stream still shows one italic row, `✻ <latest line>`.',
    ],
    focus: [
      { look: 'The reasoning growing under its header mid-stream, with no single-line scrolling', how: 'checkpoint live' },
      { look: 'The settled header with its duration, the text aligned under the word Thinking, the blank rows between paragraphs, and the answer after it', how: 'checkpoint settled' },
      { look: 'The same at 48 columns', how: 'checkpoint narrow' },
    ],
    differs: [
      'Reasoning is shown whole and uncapped, header and text on separate rows; the sketch has one sentence on one row (owner decision, Verbose is where reasoning is read).',
    ],
    pending: [
      'The Detailed level, its preview, and the policy that decides which level shows what are 3e.1.',
    ],
  },
  idle: {
    reference: 'spec §5.6 (the welcome banner as the stream\'s first row) · the Banner of the shipped product',
    implemented: [
      'A blank row closes the welcome banner, the same gap every turn after the first has, so the first prompt no longer sits against the logo.',
    ],
    focus: [
      { look: 'The banner and the row after it, at 120 and 60 columns', how: 'checkpoint boot' },
    ],
    differs: [
      'The banner is still its own block above the stream, not a row of it: its per-row logo gradient and model highlight are theme colors the list\'s tones do not carry. Moving it into the list needs new tones, which is a question for the owner.',
    ],
    pending: [
      'The banner scrolls away with the history as before; selecting or copying it is not part of 3e.',
    ],
  },
}

/**
 * Scripts that differ from playing to the end. A settled job wakes the agent for a real turn on the stub, which runs
 * at real time, so the jobs replay is captured while all three jobs run.
 */
const SCRIPTS = {
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
    perf: { ceilings: {} },
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
    review: REVIEW.idle,
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
    review: REVIEW['thinking-verbose'],
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
