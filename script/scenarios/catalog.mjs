/**
 * The scenario catalog: every named state of the live product that review, frames, goldens, and perf read. A scenario
 * names its source (a replay of `replays.mjs`, an empty session, or the UI gallery), the sources it `covers` (the
 * change-based selection reads them), its sizes, and the script the runner plays: `play` to a mark or the end, keys,
 * mouse, resizes, and named checkpoints (see `steps.mjs`). `pnpm run scenario --list` prints it.
 * @module script/scenarios/catalog
 */

import { REPLAYS } from './replays.mjs'
import { checkpoint, idle, key, measure, paste, play, resize, type, until, wait, wheel } from './steps.mjs'

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

/** What draws the panels of Phase 6 and the chrome every overlay now shares. */
const PANELS = [
  'packages/mayfly/src/components/', 'packages/mayfly/src/core/ui-patterns.ts', 'packages/mayfly/src/core/ui-compiler.ts', 'packages/mayfly/src/core/ui-stacks.ts',
  'packages/mayfly/src/core/ui-interaction-surface.ts', 'packages/mayfly/src/core/surface-renderer.ts', 'packages/mayfly/src/core/screen.ts', `${INTERACTION}*-command*.ts`,
  `${INTERACTION}model-commands.ts`, `${INTERACTION}stats-*.ts`, `${INTERACTION}plugin-*.ts`, `${INTERACTION}jobs.ts`, `${INTERACTION}help.ts`, `${INTERACTION}settings-*.ts`,
]

/** What each replay shows, as the sources whose change it can reveal. */
const COVERS = {
  mergePanels: [...PANELS, `${TRANSCRIPT}status-*.ts`, 'packages/mayfly/src/core/views-lane.ts', `${INTERACTION}questions-plugin.ts`],
  mergeHeights: [...PANELS, 'packages/mayfly/src/core/views-lane.ts', `${TRANSCRIPT}view-items.ts`, `${TRANSCRIPT}status-*.ts`, `${TRANSCRIPT}pane-todo.ts`, `${INTERACTION}questions-plugin.ts`],
  mergeEsc: ['packages/mayfly/src/app/agent-interrupt.ts', 'packages/mayfly/src/app/index.ts', `${INTERACTION}input-plugin.ts`, `${TRANSCRIPT}status-agents.ts`, `${TRANSCRIPT}status-jobs.ts`, ...NOTIFICATION],
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
  mergePanels: {
    scene: 23,
    reference: 'the merge of Phase 6 (PR 16, the panels) into main (Phases 4 and 5) · component-development-spec §1 · roadmap Phase 6',
    implemented: [
      'Every overlay has the /stats chrome: a full-width `━` rule, the bold title, the muted description, a two-column gutter, and one hint row; no panel draws buttons any more.',
      'Former buttons are keys on the hint row: Close and Cancel are Esc; r refresh, c copy, Ctrl+S save, Ctrl+G settings.yaml, Ctrl+F search all, Enter submits a form, and a letter for the rest (x stop, o open or output, a add or archive, s sign in, p preview, m more, v resources, t templates, u copy URL). Lists with letter keys filter with `/`, as /plugin does.',
      'The shared Yes/No confirm is keys: `y` yes, `n` no, Esc no (a view\'s `x`, /jobs stop, /agents stop, /update).',
      'Phase 4\'s editor keeps its rounded frame (`chrome: \'surface\'`); only overlays are borderless. A panel stands in for the editor and the status row; when one opens over an entered view, the view leaves.',
    ],
    focus: [
      { look: '/model and /effort over the merged dock', how: 'checkpoints `model`, `effort`' },
      { look: '/stats: each tab, the same height', how: 'checkpoints `stats-session` to `stats-models`' },
      { look: '/plugin: Browse and Updates', how: 'checkpoints `plugin`, `plugin-updates`' },
      { look: 'The restyled panels: no buttons, keys on the hint row', how: 'checkpoints `agents`, `jobs`, `mcp`, `help`, `settings`' },
      { look: 'A view\'s `x`: the y/n confirm, then `n`', how: 'checkpoints `view-jobs`, `confirm`, `declined`' },
      { look: 'A question arriving while a view is entered: the view leaves, the question takes the dock; a digit answers it', how: 'checkpoints `question`, `answered`' },
      { look: 'The panels at 60 and 40 columns', how: 'checkpoints `stats-60`, `jobs-60`, `stats-40`' },
    ],
    differs: ['The panels\' contents are as they were: only their chrome changed. The per-panel redesign is R6 to R8.'],
    pending: ['/update needs a published version to confirm; its y/n is the shared confirm\'s and is not scripted.'],
  },
  mergeHeights: {
    scene: 26,
    reference: 'component-development-spec §1 rule 13: a surface that switches pages in place keeps the height of its tallest page · `holdHeight` in core/ui-stacks.ts',
    implemented: [
      'Tab pages (/stats, /plugin, the wizard\'s steps and review, any `tab` child of a stack) are padded to the tallest page at this width and viewport.',
      'The views of the status row (Agents, Jobs, Goal, Todo) keep one height: the tallest enterable view, within the lane\'s third of the screen.',
      'A shorter terminal lowers the height (the peak is remembered per width and viewport rows); a filter that narrows a list does not shrink the panel.',
      '/stats no longer pads its own scrolls, and the scroll `hold` field is gone.',
    ],
    focus: [
      { look: '/stats: the rule under the panel stays put across the four tabs', how: 'checkpoints `stats-session`, `stats-account`, `stats-history`, `stats-models`' },
      { look: '/plugin: the three tabs, then a filter with no match', how: 'checkpoints `plugin-browse`, `plugin-updates`, `plugin-installed`, `plugin-filtered`' },
      { look: 'The views: Agents (one row) as tall as Todo (six todos)', how: 'checkpoints `view-agents`, `view-jobs`, `view-goal`, `view-todo`' },
      { look: 'A shorter terminal: the views and /stats lower their height', how: 'checkpoints `view-short`, `stats-short`' },
      { look: 'The question wizard: three steps and the review, one height', how: 'checkpoints `wizard-auth`, `wizard-scopes`, `wizard-notes`, `wizard-review`' },
    ],
    differs: [],
    pending: ['The split view of /plugin keeps its own viewport bands for the detail beside the list (the detail follows the cursor, not a tab); it is not a page switch.'],
  },
  mergeEsc: {
    scene: 15,
    reference: 'docs/interaction-model.md, Interrupt scope · Phase 4 round 3, kept by the merge of Phase 6',
    implemented: [
      'Esc, or Ctrl+C on an empty prompt, stops the current turn of the conversation on screen and nothing else: background and continuable subagents, jobs and their watchers, the goal, todos, and the queued messages stay (the queue is sent next).',
      'Esc on an open panel closes the panel only; the turn under it keeps running.',
      'The one accepted limit: a foreground subagent is the turn\'s own tool call, and Harness stops it with the turn.',
    ],
    focus: [
      { look: 'Your turn running beside a real background subagent and the watcher', how: 'checkpoint `running` (`spawn:… child-hold:240000` starts the child)' },
      { look: 'A message typed while it runs, queued', how: 'checkpoint `queued`' },
      { look: 'Esc: the turn stops; agents and jobs stay ● in the status row; the queued message is sent next', how: 'checkpoints `interrupted`, `agents-live`' },
      { look: 'The kept message on its row; `s` sends it now', how: 'checkpoints `kept`, `sent`' },
      { look: 'Esc on /help closes the panel; the turn keeps running; a second Esc stops it', how: 'checkpoints `panel`, `panel-closed`, `interrupted-again`' },
      { look: 'A foreground subagent stops with the turn', how: 'checkpoints `foreground`, `foreground-stopped`' },
    ],
    differs: ['The turns and the subagents are the stub model\'s: `child-hold:` holds the child\'s turn, and every later prompt of the session holds too, since the stub reads the whole conversation.'],
    pending: [],
  },
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

/** Open a panel by its command and wait for its title; the wait first lets focus return to the prompt from a panel just closed. */
const open = (command, title) => [wait(300), type(command), key('enter'), until(title)]

/** The script of each replay: `play` to its marks, the keys a person would press, resizes, and named checkpoints. */
const SCRIPTS = {
  // The panels over the merged dock: each in the /stats chrome with its keys on the hint row, the y/n confirm, and a question
  // arriving while a view is entered.
  mergePanels: [
    play('ready'), checkpoint('ready'),
    ...open('/model', 'Select a model'), checkpoint('model'), key('esc'),
    ...open('/effort', 'Effort'), checkpoint('effort'), key('esc'),
    ...open('/stats', 'Stats'), checkpoint('stats-session'),
    key('right'), checkpoint('stats-account'),
    key('right'), until('Less'), checkpoint('stats-history'),
    key('right'), checkpoint('stats-models'), key('esc'),
    ...open('/plugin', 'Plugin marketplace'), until('Browse'), checkpoint('plugin'),
    key('alt+left'), checkpoint('plugin-updates'), key('esc'),
    ...open('/agents', 'Subagents'), checkpoint('agents'), key('esc'),
    ...open('/jobs', 'Jobs'), checkpoint('jobs'), key('esc'),
    ...open('/mcp', 'MCP'), checkpoint('mcp'), key('esc'),
    ...open('/help', 'Help'), checkpoint('help'), key('esc'),
    ...open('/settings', 'Settings'), checkpoint('settings'), key('esc'),
    wait(300), key('alt+down'), key('right'), checkpoint('view-jobs'),
    key('x'), checkpoint('confirm'), key('n'), checkpoint('declined'),
    play(), until('Which runtime'), checkpoint('question'), key('1'), wait(500), checkpoint('answered'),
    resize(60, 30), ...open('/stats', 'Stats'), checkpoint('stats-60'), key('esc'),
    ...open('/jobs', 'Jobs'), checkpoint('jobs-60'), key('esc'),
    resize(40, 30), ...open('/stats', 'Stats'), checkpoint('stats-40'), key('esc'),
    resize(100, 30), checkpoint('closed'),
  ],
  // One height for pages switched in place: the /stats and /plugin tabs, the views, a shorter terminal, and the wizard.
  mergeHeights: [
    play('ready'),
    ...open('/stats', 'Stats'), checkpoint('stats-session'),
    key('right'), checkpoint('stats-account'),
    key('right'), until('Less'), checkpoint('stats-history'),
    key('right'), checkpoint('stats-models'), key('esc'),
    ...open('/plugin', 'Plugin marketplace'), until('Browse'), checkpoint('plugin-browse'),
    key('alt+left'), checkpoint('plugin-updates'),
    key('alt+left'), checkpoint('plugin-installed'),
    // Esc ends the search, then steps back from the filter, then closes the panel.
    type('/'), type('zzz'), checkpoint('plugin-filtered'), key('esc'), wait(200), key('esc'), wait(200), key('esc'),
    wait(300), key('alt+down'), checkpoint('view-agents'),
    key('right'), checkpoint('view-jobs'),
    key('right'), checkpoint('view-goal'),
    key('right'), checkpoint('view-todo'), key('esc'),
    resize(100, 22), wait(300), key('alt+down'), checkpoint('view-short'), key('esc'),
    ...open('/stats', 'Stats'), checkpoint('stats-short'), key('esc'),
    resize(100, 30),
    play(), until('Auth'), checkpoint('wizard-auth'),
    key('right'), checkpoint('wizard-scopes'),
    key('right'), checkpoint('wizard-notes'),
    key('right'), checkpoint('wizard-review'),
  ],
  // Esc stops your turn only: a real background subagent, the watcher, and a queued message stay; Esc on a panel closes it;
  // a foreground subagent stops with the turn.
  mergeEsc: [
    play('ready'), checkpoint('ready'),
    type('spawn:Background reviewer child-hold:240000 review the README'), key('enter'), wait(3000), checkpoint('running'),
    type('Then bump the version'), key('enter'), wait(400), checkpoint('queued'),
    key('esc'), wait(1000), checkpoint('interrupted'),
    wait(300), key('alt+down'), checkpoint('agents-live'), key('esc'), wait(150),
    // The kept message, sent now from its row, is a turn that runs (the stub holds every prompt of this conversation).
    key('alt+up'), checkpoint('kept'), key('s'), wait(1000), key('esc'), wait(150), checkpoint('sent'),
    ...open('/help', 'Help'), checkpoint('panel'), key('esc'), wait(400), checkpoint('panel-closed'),
    key('esc'), wait(1000), checkpoint('interrupted-again'),
    type('spawn-fg:Foreground checker child-hold:240000 check the links'), key('enter'), wait(3000), checkpoint('foreground'),
    key('esc'), wait(1500), checkpoint('foreground-stopped'),
    resize(60, 30), checkpoint('narrow-60'),
    resize(100, 30),
  ],
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
  mergePanels: [[100, 30]],
  mergeHeights: [[100, 30]],
  mergeEsc: [[100, 30]],
  mergeDock: [[100, 30]],
  mergeConversations: [[100, 30]],
}

/** What a replay's session needs beyond the replay: the /plugin catalog of the bench profile, a DeepSeek balance. */
const OPTIONS = {
  mergePanels: { market: { installed: 'full' }, account: { balance: 'ok' } },
  mergeHeights: { market: { installed: 'full' }, account: { balance: 'ok' } },
}

/** A replay as a scenario: its script, covers, sizes, options, and brief from the tables above. */
const replayScenario = (name, replay) => ({
  summary: replay.summary,
  source: { replay: name },
  ...OPTIONS[name],
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
