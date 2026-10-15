/**
 * The scenario catalog: every named state of the live product that review, frames, goldens, and perf read. A scenario
 * names its source (a replay of `replays.mjs`, an empty session, or the UI gallery), the sources it `covers` (the
 * change-based selection reads them), its sizes, and the script the runner plays: `play` to a mark or the end, keys,
 * mouse, resizes, and named checkpoints (see `steps.mjs`). `pnpm run scenario --list` prints it.
 * @module script/scenarios/catalog
 */

import { REPLAYS } from './replays.mjs'
import { checkpoint, idle, key, measure, paste, play, resize, type, wait, wheel } from './steps.mjs'

/** The size a scenario runs at unless it names its own. */
export const DEFAULT_SIZE = Object.freeze([120, 40])

const TRANSCRIPT = 'packages/mayfly/src/transcript/'
const INTERACTION = 'packages/mayfly/src/interaction/'
/** What draws the conversation stream: the facts of its rows and the component that lays them out. */
const STREAM = [`${TRANSCRIPT}stream-facts.ts`, 'packages/mayfly/src/components/']

/** What draws the notification pane: the pane, the line, and the notices the facts raise into it. */
const NOTIFICATION = [`${TRANSCRIPT}pane-notification.ts`, `${TRANSCRIPT}notices.ts`, 'packages/mayfly/src/components/notification-line.ts', 'packages/mayfly/src/conversation/facts.ts', `${INTERACTION}notifications.ts`]

/** What draws and answers the queued rows of the stream: the rows, their keys, the notification row that teaches them, and the editor that restores the message. */
const QUEUE_COVERS = [`${TRANSCRIPT}transcript-model.ts`, `${TRANSCRIPT}pane-notification.ts`, 'packages/mayfly/src/components/notification-line.ts', `${INTERACTION}input-plugin.ts`, ...STREAM]

/** What each replay shows, as the sources whose change it can reveal. */
const COVERS = {
  mergeDock: [
    ...NOTIFICATION, `${TRANSCRIPT}status-rows.ts`, `${TRANSCRIPT}view-items.ts`, `${TRANSCRIPT}status-agents.ts`, `${TRANSCRIPT}status-jobs.ts`, 'packages/mayfly/src/core/views-lane.ts', 'packages/mayfly/src/core/screen.ts',
    'packages/mayfly/src/components/editor.ts', `${INTERACTION}input-plugin.ts`, `${INTERACTION}placeholder.ts`, 'packages/mayfly/src/core/completion-drawer.ts', 'packages/mayfly/src/core/editor-tokens.ts',
  ],
  mergeConversations: [
    ...QUEUE_COVERS, ...NOTIFICATION, `${INTERACTION}btw-command.ts`, `${INTERACTION}conversation-view-status.ts`, `${INTERACTION}placeholder.ts`, `${TRANSCRIPT}status-agents.ts`,
    'packages/mayfly/src/app/conversation-views.ts', 'packages/mayfly/src/components/editor.ts', 'packages/mayfly/src/core/views-lane.ts',
  ],
}

/**
 * The briefs of scenarios whose group is in review (docs/design/component-development-spec.md §5.1): the prototype
 * `scene`, the `reference`, and the effects `implemented`, to look at (`focus`: what to judge and `how` to reach it),
 * that `differs` from the prototype, and `pending`. `brief.mjs` prints them. Finalizing a group removes its entries.
 */
const REVIEW = {
  mergeDock: {
    scene: 15,
    reference: 'the merge of Phase 4 (PR 18, the editor) and Phase 5 (PR 19, the status row and views) · prototype scenes 15 and 13 · component-library §5.1, §5.2, and the notification pane in §5.2',
    implemented: [
      'The bottom of the screen after the merge: the notification row, the editor frame (Phase 4), and the one status row with its agents, jobs, goal, and todo items (Phase 5); a view\'s panel opens under the status row.',
      'With no notice, the right of the notification row shows what the prompt awaits (with the loader), the history counter (`↑ history 1/1`), the keys of the token under the caret, or else the hint of the keys that leave the prompt: `Alt+↑ conversation · Alt+↓ view` (Phase 4\'s first group now names the view, as Phase 5 renamed it); while a turn runs it rotates every 15 s through `Ctrl+Enter steer · Esc interrupt`, `Ctrl+C clear · Ctrl+G editor`, and `Shift+Tab plan · Alt+M model`.',
      'Information notices have no glyph (Phase 4 retired `ℹ`; Phase 5\'s notices follow).',
      'Esc interrupts only the displayed Agent\'s turn (Phase 4): the reviewer subagent and the watcher job stay live in the status row.',
    ],
    focus: [
      { look: 'Idle: the placeholder ladder, the idle hint, and the items in the status row under the frame', how: 'checkpoint `items`' },
      { look: 'The `/` palette over the stream, ending on the row above the frame, with the status row still under it', how: 'checkpoints `palette`, `palette-40`' },
      { look: 'A pasted block as a token; `←` onto it names its keys on the notification row', how: 'checkpoint `token`' },
      { look: 'Your own running turn (`hold:240000 keep going`): the running placeholder and the hint rotating beside the live items', how: 'checkpoints `hint-1` to `hint-4` (15 s apart)' },
      { look: 'The history counter on the notification row', how: 'checkpoint `history` (`↑` with an empty prompt)' },
      { look: 'A view entered from the running turn: its panel under the status row and the `━` line under the item', how: 'checkpoints `view`, `view-60`' },
      { look: 'The whole dock at 60 and 40 columns', how: 'checkpoints `narrow-60`, `narrow-40`' },
      { look: 'Esc interrupts your turn only; the watcher\'s closing line, then the item leaves', how: 'checkpoints `interrupted`, `closing`, `gone`' },
    ],
    differs: [
      'The turn you run is the stub model\'s: a prompt that holds `hold:240000` stays running for four minutes and then answers with the stub reply.',
      'When the watcher settles it wakes the agent (a finished job does), and since the session holds a `hold:` prompt the stub keeps that turn running too.',
    ],
    pending: ['The prompt wait (`Searching files…` with the loader) needs a slow file search; a workspace this small answers before the 150 ms the loader waits.'],
  },
  mergeConversations: {
    scene: 15,
    reference: 'the merge of Phase 4 (PR 18, queued rows, placeholders, the subagent send) and Phase 5 (PR 19, mode keys shed by priority, notice tails, the conversation chip and `F7`/`F8`) · component-library §5.2 and the notification pane',
    implemented: [
      'On a queued row the notification row reads `e edit · s send now · d cancel · Enter expand · c copy · ↑/↓ select · Esc back` (a steering row has no `s`): the row\'s verbs read first, and on a narrow row `Esc back`, `e edit`, and `d cancel` are the last to go. They are parts the row sheds by priority (Phase 5), so a notice beside them keeps its glyph and tail.',
      'In a side conversation the right of the notification row starts with `F7 main · F8 close` (`F8 detach` for a subagent). After it come, with no notice, what the prompt awaits, the history counter, or the token keys; the generic and rotating hint gives way to it.',
      'The conversation is named in two places: the status row\'s chip (` btw `, ` subagent `, ` main ` while a side one is open) and the frame\'s corner, which keeps the session title (in /btw the main session\'s, since the side Agent is forked from it; a subagent\'s is its own). The subagent placeholder names it by its task (`Message Audit the hero copy`), while the Agents panel names it `review`.',
      'With a warning on the row, `d`\'s `Cancelled · u undo` (information) waits behind it as `· +1`: the row shows the most severe notice first.',
    ],
    focus: [
      { look: 'The keys of a queued and of a steering row', how: 'checkpoints `keys-queued`, `keys-steering` (Alt+↑ lands on the newest queued row; the steering row is two rows up)' },
      { look: 'A rate-limit notice beside the keys: the glyph and the countdown kept, the front cut', how: 'checkpoint `keys-notice`' },
      { look: '`d` and `u` with their notice', how: 'checkpoints `cancelled`, `undone`' },
      { look: 'The keys shed at 60 and 40 columns', how: 'checkpoints `keys-60`, `keys-40`' },
      { look: 'The agent reading the rows: prompts in the stream', how: 'checkpoint `read`' },
      { look: 'The /btw side question: chip, frame corner, placeholder, `F7 main · F8 close`', how: 'checkpoint `btw`' },
      { look: 'A running side question (`hold:240000 …`): the toggle alone, then the history counter after it', how: 'checkpoints `btw-running`, `btw-history`' },
      { look: 'Back on main, then a subagent from the Agents view, and `F8 detach` back to the view', how: 'checkpoints `main`, `agents-view`, `subagent`, `detached`' },
    ],
    differs: ['The main turn and its queued rows are the replay\'s; the side question\'s running turn is the stub model\'s (`hold:240000`).'],
    pending: ['Sending to the subagent from the editor (Enter queues, Ctrl+Enter steers) is not scripted against the replay\'s child; `spawn:Stored writer` in the main prompt starts a real one to try it on.'],
  },
}

/** Play at the replay's own pace: the activity row is a function of time (a phase lasts seconds, the tail ticks). */
const TIMED = { timed: true }
/** A pasted block long enough to fold into a `[paste #1 +12 lines]` token. */
const MERGE_PASTE = Array.from({ length: 12 }, (_, index) => `note ${String(index + 1)}: the hero copy and the install line disagree`).join('\n')

/** The script of each replay: `play` to its marks, the keys a person would press, resizes, and named checkpoints. */
const SCRIPTS = {
  // Where the editor and the status row meet (the merge of Phases 4 and 5): the idle hint and placeholder over the items, the `/` palette,
  // a pasted token and its keys, a turn of the stub model (`hold:`) with the hint rotating, the history counter, a view entered, 60 and 40
  // columns, then Esc interrupting that turn while the reviewer and the watcher go on until the watcher's closing line.
  mergeDock: [
    play('items'), checkpoint('items'),
    type('/'), checkpoint('palette'), key('backspace'),
    type('compare '), paste(MERGE_PASTE), key('left'), checkpoint('token'), key('ctrl+c'), wait(150),
    type('hold:240000 keep refreshing the hero'), key('enter'), wait(800), checkpoint('hint-1'),
    wait(15_500), checkpoint('hint-2'),
    wait(15_500), checkpoint('hint-3'),
    wait(15_500), checkpoint('hint-4'),
    key('up'), checkpoint('history'), key('down'),
    key('alt+down'), checkpoint('view'), key('esc'), wait(150),
    resize(60, 30), checkpoint('narrow-60'),
    key('alt+down'), checkpoint('view-60'), key('esc'), wait(150),
    resize(40, 30), checkpoint('narrow-40'),
    type('/'), checkpoint('palette-40'), key('backspace'),
    resize(100, 30),
    key('esc'), wait(400), checkpoint('interrupted'),
    // The watcher's end wakes the agent, so its activity counter runs: one tick at the timeline time makes it exact.
    play('closing'), checkpoint('closing', { tick: true }),
    play('gone'), checkpoint('gone', { tick: true }),
  ],
  // The conversations after the merge: the keys of queued and steering rows as parts that shed, a notice beside them, d and u, 60 and 40
  // columns, the rows read, then a /btw side question (chip, frame corner, placeholder, `F7`/`F8` with the history counter) and a subagent
  // opened from the Agents view (`F8 detach` returns to the view).
  mergeConversations: [
    play('queued'), checkpoint('queued'),
    key('alt+up'), checkpoint('keys-queued'),
    key('up', { repeat: 2 }), checkpoint('keys-steering'), key('down', { repeat: 2 }),
    play('rate-limited', TIMED), checkpoint('keys-notice'),
    key('d'), checkpoint('cancelled'),
    key('u'), checkpoint('undone'),
    resize(60, 30), checkpoint('keys-60'),
    resize(40, 30), checkpoint('keys-40'),
    resize(100, 30),
    key('esc'), wait(150),
    play('read'), checkpoint('read'),
    play('btw'), checkpoint('btw'),
    type('hold:240000 and the WSL line?'), key('enter'), wait(800), checkpoint('btw-running'),
    key('up'), checkpoint('btw-history'), key('down'),
    key('f7'), checkpoint('main'),
    key('alt+down'), key('home'), checkpoint('agents-view'),
    key('enter'), checkpoint('subagent'),
    key('f8'), checkpoint('detached'), key('esc'),
  ],
}

/** Replays that run at a size of their own. */
const SIZES = {
  mergeDock: [[100, 30]],
  mergeConversations: [[100, 30]],
}

/** A replay as a scenario: its script, covers, sizes, and brief from the tables above. */
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
    covers: [`${TRANSCRIPT}status-agents.ts`, `${TRANSCRIPT}child-agent-model.ts`],
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

/** The catalog, by scenario name: the replays, the Website's app shots, and the perf scenarios. */
export const CATALOG = Object.freeze({
  ...Object.fromEntries(Object.entries(REPLAYS).map(([name, replay]) => [name, replayScenario(name, replay)])),
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
