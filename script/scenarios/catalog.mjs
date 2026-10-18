/**
 * The scenario catalog: every named state of the live product that review, frames, goldens, and perf read. A scenario
 * names its source (a replay of `replays.mjs`, an empty session, or the UI gallery), its sizes, and the script the
 * runner plays: `play` to a mark or the end, keys,
 * mouse, resizes, and named checkpoints (see `steps.mjs`). `pnpm run scenario --list` prints it.
 * @module script/scenarios/catalog
 */

import { REPLAYS } from './replays.mjs'
import { checkpoint, idle, key, measure, paste, play, resize, type, until, wait, wheel } from './steps.mjs'

/** The size a scenario runs at unless it names its own. */
export const DEFAULT_SIZE = Object.freeze([120, 40])

const INTERACTION = 'packages/mayfly/src/interaction/'

/** Play at the replay's own pace: the activity row is a function of time (a phase lasts seconds, the tail ticks). */
const TIMED = { timed: true }
/** A pasted block long enough to fold into a `[paste #1 +12 lines]` token. */
const MERGE_PASTE = Array.from({ length: 12 }, (_, index) => `note ${String(index + 1)}: the hero copy and the install line disagree`).join('\n')

/** Open a panel by its command and wait for its title; the wait first lets focus return to the prompt from a panel just closed. */
const open = (command, title) => [wait(300), type(command), key('enter'), until(title)]

/** Mayfly's palettes after the default, then a port from each family: the theme round's walk. */
const PALETTE_WALK = [
  'tide', 'dusk', 'graphite', 'linen', 'mist', 'heather', 'obsidian', 'porcelain',
  'catppuccin-mocha', 'rose-pine-dawn', 'dracula', 'nord', 'tokyo-night', 'solarized-light', 'gruvbox-dark', 'one-light', 'kanagawa-wave', 'everforest-light',
]

/** Switch the theme by its key and wait for the switch to settle. */
const theme = name => [wait(300), type(`/theme ${name}`), key('enter'), wait(600)]

/** The script of each replay: `play` to its marks, the keys a person would press, resizes, and named checkpoints. */
const SCRIPTS = {
  // The start round: the first-run guide over the launch screen, the launch screen over four stored sessions, the new setting, the narrow and short sizes, a refused command, the
  // first message creating the session, and /clear back to the launch screen.
  startSplash: [
    // A first start: the guide opens over the launch screen, with the new `On start` field in its Preferences step; the stub accepts any key.
    until('Preferences'), checkpoint('guide'),
    key('enter'), wait(500), key('down'), key('enter'), wait(500), type('replay-key'), key('enter'), until('Select a model'), checkpoint('guide-model'), key('esc'), until('Welcome to Mayfly'), checkpoint('guide-ready'),
    key('enter'), wait(1000), checkpoint('after-guide'),
    play('splash'), wait(500), checkpoint('splash'),
    // `↑` on the empty prompt walks the recent list; `Esc` gives the keyboard back.
    key('up'), checkpoint('browse'), key('down'), checkpoint('browse-2'), key('esc'), wait(200),
    ...open('/settings', 'Settings'), key('down', { repeat: 24 }), until('Update check'), key('right'), key('down', { repeat: 40 }), until('On start'), checkpoint('settings'),
    // Esc leaves the namespace, then the search, then the panel.
    key('esc'), wait(300), key('esc'), wait(300), key('esc'), wait(300),
    resize(60, 30), checkpoint('narrow-60'),
    resize(40, 30), checkpoint('narrow-40'),
    resize(30, 30), checkpoint('tiny-30'),
    resize(100, 14), checkpoint('short'),
    resize(100, 30),
    // Settings that a session would take run before it exists: they set the default. A command on a session is refused.
    ...open('/model', 'Select a model'), checkpoint('model'), key('down'), key('enter'), wait(800), checkpoint('model-set'),
    wait(300), type('/fork'), key('enter'), wait(500), checkpoint('refused'),
    ...theme('tide'), checkpoint('tide'), ...theme('dark'),
    type('Plan the launch of the new splash.'), key('enter'), wait(1500), checkpoint('first-message'),
    wait(300), type('/clear'), key('enter'), wait(1000), checkpoint('cleared'),
    // `Enter` on a browsed row resumes that session.
    key('up'), key('down'), key('enter'), wait(1500), checkpoint('resumed'),
  ],
  // The theme round: the banner at rest (the runner has reduced motion), the picker, every palette on the answer, a fresh
  // conversation after `/clear`, and its banner at 60 and 40 columns.
  brandThemes: [
    play('banner'), checkpoint('banner'),
    play('dark'), checkpoint('dark'),
    play('ready'), wait(300), checkpoint('warning'),
    ...open('/theme', 'Select a theme'), checkpoint('picker'),
    key('down', { repeat: 19 }), checkpoint('picker-light'),
    key('esc'), wait(300), ...theme('light'), checkpoint('light'),
    ...PALETTE_WALK.flatMap(name => [...theme(name), checkpoint(name)]),
    ...theme('auto'), checkpoint('auto'),
    ...theme('dark'),
    wait(300), type('/clear'), key('enter'), wait(1000), checkpoint('fresh'),
    resize(60, 30), checkpoint('narrow-60'),
    resize(40, 30), checkpoint('narrow-40'),
    resize(100, 30),
  ],
  // The panels over the merged dock: each in the /stats chrome with its keys on the hint row, the y/n confirm, and a question
  // arriving while a view is entered.
  mergePanels: [
    play('ready'), checkpoint('ready'),
    ...open('/model', 'Select a model'), checkpoint('model'), key('esc'),
    ...open('/effort', 'Effort'), checkpoint('effort'), key('esc'),
    ...open('/stats', 'Stats'), checkpoint('stats-session'),
    key('alt+right'), checkpoint('stats-account'),
    key('alt+right'), wait(1000), until('Less'), wait(1000), checkpoint('stats-history'),
    key('alt+right'), wait(1000), checkpoint('stats-models'), key('esc'),
    ...open('/plugin', 'Plugin marketplace'), until('Browse'), wait(500), checkpoint('plugin'),
    key('alt+left'), wait(500), checkpoint('plugin-updates'), key('esc'),
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
    key('alt+right'), checkpoint('stats-account'),
    key('alt+right'), wait(1000), until('Less'), wait(1000), checkpoint('stats-history'),
    key('alt+right'), wait(1000), checkpoint('stats-models'), key('esc'),
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
    key('right'), wait(500), checkpoint('wizard-review'),
  ],
  // The new-messages rule: scroll away with the wheel, a block arrives (the rule and the chip), Ctrl+↓ brings the rule to the top, it
  // leaves after 5 s on screen; the next arrival is left unread and scrolled past, and a second Ctrl+↓ follows the tail; 60 columns.
  newMessages: [
    play('history'), checkpoint('history'),
    wheel('up', { count: 12 }),
    play('first'),
    key('ctrl+down'), checkpoint('jumped'),
    wait(6000), checkpoint('expired'),
    play('second'), checkpoint('second'),
    wheel('down', { count: 30 }),
    wheel('up', { count: 12 }), play('third'),
    key('ctrl+down'), key('ctrl+down'), checkpoint('tail'),
    resize(60, 30), checkpoint('narrow-60'),
    resize(100, 30),
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
  // The view items: the row without times, each view's panel with its hint row at the bottom, a narrow width, and the closing line.
  viewItems: [
    play('ready'), checkpoint('items'),
    // A view is entered where it was left, so each pass ends back on Agents.
    wait(300), key('alt+down'), checkpoint('agents'),
    key('right'), checkpoint('jobs'),
    key('right'), checkpoint('goal'),
    key('right'), checkpoint('todo'), key('left'), key('left'), key('left'), key('esc'), wait(150),
    resize(60, 30), wait(300), key('alt+down'), checkpoint('agents-60'),
    key('right'), checkpoint('jobs-60'), key('left'), key('esc'), wait(150),
    resize(100, 30),
    // Leaving the views returns focus to the prompt; End follows the tail again so the
    // jobs' closing line is on screen at this checkpoint.
  ],
  // The conversations after the merge: the keys of queued and steering rows as parts that shed, a notice beside them, d and u, 60 and 40
  // columns, the rows read, then a /btw side question (chip, frame corner, placeholder, `F7`/`F8` with the history counter) and a subagent
  // opened from the Agents view (`F8 detach` returns to the view).
  mergeConversations: [
    play('queued'), checkpoint('queued'),
    key('alt+up'), checkpoint('keys-queued'),
    key('up', { repeat: 2 }), checkpoint('keys-steering'), key('down', { repeat: 2 }),
    play('rate-limited', TIMED), checkpoint('keys-notice'),
    // `d` is checked through the undone pair below; the live retry countdown in this frame is wall-clock and not stable.
    key('d'),
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
  // Native capability alignment: the working directory, native todo/context/model, a managed activation, a bash job,
  // a Host reminder under standard, a migration-required session, a native file mention, /save, /btw, the minimal
  // preset, narrow widths, and the /permissions panel.
  harnessAlignment: [
    play('aligned'), checkpoint('aligned'),
    // The live elapsed time on this frame is wall-clock; the Agents view below checks the activation rows.
    play('activation-live'),
    key('alt+down'), checkpoint('agents-live'), key('esc'), wait(150),
    play('activated'), checkpoint('activated'),
    play('job-done'), checkpoint('job-done'),
    play('scheduled'), wait(1000), checkpoint('scheduled'),
    type('@hero'), checkpoint('mention'), key('enter'), type(' tighten the hero copy'), key('enter'), wait(1500), checkpoint('mention-sent'),
    type('/save'), key('enter'), wait(1000), checkpoint('save'),
    type('/sessions seed-legacy-hero'), key('enter'), wait(1000), until('Legacy hero notes'), checkpoint('migration'), key('esc'), key('esc'),
    type('/btw Does the hero need a dark variant?'), key('enter'), wait(2000), checkpoint('btw'), key('f7'), wait(300), checkpoint('main'),
    play('before-minimal'),
    type('/new minimal'), key('enter'), wait(500),
    type('Check the minimal tool surface.'), key('enter'), play('minimal'), checkpoint('minimal'),
    resize(60, 30), checkpoint('narrow-60'),
    resize(40, 30), checkpoint('narrow-40'),
    resize(100, 30),
    type('/permissions'), key('enter'), wait(1000), checkpoint('permissions'),
  ],
}

/** Replays that run at a size of their own. */
const SIZES = {
  startSplash: [[100, 30]],
  brandThemes: [[100, 30]],
  mergePanels: [[100, 30]],
  mergeHeights: [[100, 30]],
  mergeEsc: [[100, 30]],
  newMessages: [[100, 30]],
  viewItems: [[100, 30]],
  mergeDock: [[100, 30]],
  mergeConversations: [[100, 30]],
  harnessAlignment: [[100, 30]],
}

/** What a replay's session needs beyond the replay: the /plugin catalog of the bench profile, a DeepSeek balance. */
const OPTIONS = {
  // No session exists until the script sends a message; the setting pinned here asks for the launch screen.
  startSplash: { sessionless: true, firstRun: true, config: { mayfly: { startup: 'splash' } } },
  mergePanels: { market: { installed: 'full' }, account: { balance: 'ok' } },
  mergeHeights: { market: { installed: 'full' }, account: { balance: 'ok' } },
  // The Host Schedule service is inserted disabled; this scenario turns it on to compare standard and minimal.
  harnessAlignment: {
    workspace: {
      'src/hero.ts': "export const hero = 'Ship agent UI in a keystroke'\n",
      'README.md': '# Harness alignment\n\nThe hero lives in src/hero.ts.\n',
    },
    enable: ['schedule'],
  },
}

/** A replay as a scenario: its script, sizes, and options from the tables above. */
const replayScenario = (name, replay) => ({
  summary: replay.summary,
  source: { replay: name, ...OPTIONS[name]?.sessionless === true ? { sessionless: true } : {} },
  ...Object.fromEntries(Object.entries(OPTIONS[name] ?? {}).filter(([option]) => option !== 'sessionless')),
  sizes: SIZES[name] ?? [DEFAULT_SIZE],
  script: SCRIPTS[name] ?? [play(), checkpoint('end')],
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
    sizes: [APP_SIZE],
    shots: { end: 'app-conversation' },
    script: [play(), checkpoint('end')],
  },
  'app-trace': {
    summary: 'the Website shot of /trace: the finished turn\'s log with a tool result\'s raw detail open',
    source: { replay: 'appConversation' },
    sizes: [APP_SIZE],
    shots: { detail: 'app-trace' },
    script: [play(), type('/trace'), key('enter'), key('down', { repeat: 16 }), key('enter'), checkpoint('detail')],
  },
  'app-permission': {
    summary: 'the Website shot of /permission: the preset picker over the finished turn',
    source: { replay: 'appConversation' },
    sizes: [APP_SIZE],
    shots: { picker: 'app-permission' },
    script: [play(), type('/permission'), key('enter'), checkpoint('picker')],
  },
  'app-agents': {
    summary: 'the Website shot of subagents: done, running, and waiting in the agents pane',
    source: { replay: 'appAgents' },
    // Six rows taller, so the agents pane is not cut to its overflow row; the width keeps the shots' scale.
    sizes: [[80, 30]],
    shots: { running: 'app-agents' },
    script: [play('running'), checkpoint('running')],
  },
  'app-sessions': {
    summary: 'the Website shots of /sessions: the workspaces of stored conversations, then one workspace\'s lineage',
    source: { replay: 'appSessions' },
    sizes: [APP_SIZE],
    shots: { workspaces: 'app-sessions', workspace: 'app-session-workspace' },
    script: [play(), type('/sessions'), key('enter'), checkpoint('workspaces'), key('enter'), checkpoint('workspace')],
  },
}

/**
 * The compose review scene: the unified Panel, Rail, Browser, DecisionLane, and keys-only behaviour on the panels built
 * from the `compose` layer. It reuses the merge panels replay (one stored session per stats seed, a reviewer, a watcher,
 * and a question), then opens the rail and browser panels at 120, 70, and 40 columns. This is a live review scene, not a
 * golden: `demo` keeps it out of the scenario comparison while `pnpm run scenario composeDemo` and `pnpm run frame
 * composeDemo` can still play it.
 */
const DEMO = {
  composeDemo: {
    demo: true,
    summary: 'the compose layer: the /settings rail, the /plugin browser, /tools, /mcp and /jobs panels, the shared stop confirmation in the views, /agents, /help, the model picker, /stats, the settings rail at 70 and 40 columns, and the question lane',
    source: { replay: 'mergePanels' },
    sizes: [[120, 40]],
    market: { installed: 'full' },
    account: { balance: 'ok' },
    workspace: {
      'src/hero.ts': "export const hero = 'Ship agent UI in a keystroke'\n",
      'README.md': '# Mayfly compose demo\n\nOne panel, one rail, one browser.\n',
    },
    script: [
      play('ready'), checkpoint('ready'),
      ...open('/settings', 'Settings'), checkpoint('settings'),
      key('esc'),
      ...open('/plugin', 'Plugin marketplace'), until('Browse'), wait(300), checkpoint('plugin-browser'), key('esc'), wait(300),
      ...open('/tools', 'Tools'), checkpoint('tools'), key('esc'), wait(300),
      ...open('/mcp', 'MCP'), checkpoint('mcp'), key('esc'), wait(300),
      ...open('/jobs', 'Jobs'), checkpoint('jobs'), key('esc'), wait(300),
      key('alt+down'), key('right'), checkpoint('view-jobs'), key('x'), checkpoint('confirm'), key('n'), checkpoint('declined'), key('esc'),
      ...open('/agents', 'Subagents'), checkpoint('agents'), key('esc'),
      ...open('/help', 'Help'), checkpoint('help'), key('esc'),
      ...open('/model', 'Select a model'), checkpoint('model'), key('esc'),
      ...open('/stats', 'Stats'), checkpoint('stats'), key('esc'),
      resize(70, 24), ...open('/settings', 'Settings'), checkpoint('settings-70'), key('esc'),
      resize(40, 24), ...open('/settings', 'Settings'), checkpoint('settings-40'), key('esc'),
      resize(120, 40), play(), until('Which runtime'), checkpoint('question'), key('1'), wait(500), checkpoint('answered'),
    ],
  },
}

const SENTENCE = 'the quick brown fox jumps over the lazy dog and keeps typing until the prompt wraps onto a second row of the editor'
/** Open a panel by its command, measure its cursor keys, and close it. */
const nav = command => [type(command), key('enter'), measure(`nav ${command}`, [key('down', { repeat: 20 }), key('up', { repeat: 20 })]), key('esc'), key('esc'), key('ctrl+c')]
const FRAME_PATH = ['packages/mayfly/src/core/terminal/terminal.ts', 'packages/mayfly/src/core/hosts/surface-*.ts', 'packages/mayfly/src/core/keys/keymap.ts', 'packages/mayfly/src/core/keys/key-actions.ts', 'packages/mayfly/src/core/ui/compile/ui-compiler.ts', `${INTERACTION}editor-extension-runtime.ts`, `${INTERACTION}input-plugin.ts`]

/**
 * The perf scenarios: what `pnpm run perf` measures A/B against the merge base, and the absolute ceilings the full
 * tier holds each span to (`MAYFLY_PERF_SLACK` scales them on a shared runner). A ceiling names a span (a trailing `*`
 * matches a prefix) and a metric. They capture no checkpoints.
 */
const PERF = {
  'perf-focus': {
    summary: 'idle, typing, and the cursor keys of /settings, /model, /theme, and /help, with no pane',
    source: { idle: true },
    sizes: [DEFAULT_SIZE],
    perf: { ceilings: { 'idle': { cpuPct: 10 }, 'type': { keyP50Ms: 10, cpuPerKeyMs: 5 }, 'nav *': { cpuPerKeyMs: 12 } } },
    script: [idle(4000), measure('type', [type(SENTENCE)]), key('ctrl+c'), ...nav('/settings'), ...nav('/model'), ...nav('/theme'), ...nav('/help')],
  },
  'perf-gallery': {
    summary: 'idle and typing beside the gallery side pane',
    source: { gallery: true },
    sizes: [DEFAULT_SIZE],
    perf: { ceilings: { idle: { cpuPct: 10 }, type: { keyP50Ms: 20 } } },
    script: [idle(4000), measure('type', [type(SENTENCE)])],
  },
  'perf-stream': {
    summary: 'a long streamed answer at its own pace, then page keys and the mouse wheel over the transcript',
    source: { replay: 'markdown' },
    sizes: [DEFAULT_SIZE],
    // Measured on the dev machine at 27% / 3 ms; the ceilings keep the headroom of the other scenarios.
    perf: { ceilings: { stream: { cpuPct: 45 }, scroll: { keyP50Ms: 12, cpuPerKeyMs: 8 }, wheel: { keyP50Ms: 12, cpuPerKeyMs: 8 } } },
    script: [measure('stream', [play(undefined, { timed: true })]), measure('scroll', [key('pageup', { repeat: 10 }), key('pagedown', { repeat: 10 })]), measure('wheel', [wheel('up', { count: 10 }), wheel('down', { count: 10 })])],
  },
  'perf-subagent': {
    summary: 'a long history, a foreground subagent running for a minute, then a long answer ending: CPU and frames while the pending call ticks, scrolling, and the settle',
    source: { replay: 'perfSubagent' },
    sizes: [DEFAULT_SIZE],
    // Measured on the dev machine: subagent spans 5-8% CPU, typing 10%, scroll keys 4.5 ms and 7 ms CPU, settle 40-45%; the ceilings keep the headroom of the other scenarios.
    perf: { ceilings: { 'subagent *': { cpuPct: 25 }, type: { keyP50Ms: 15, cpuPerKeyMs: 10 }, scroll: { keyP50Ms: 15, cpuPerKeyMs: 20 }, wheel: { keyP50Ms: 15, cpuPerKeyMs: 12 }, settle: { cpuPct: 75 } } },
    script: [
      play('history'),
      measure('subagent start', [play('child-running', { timed: true })]),
      measure('type', [type(SENTENCE)]),
      measure('scroll', [key('pageup', { repeat: 10 }), key('pagedown', { repeat: 10 })]),
      measure('wheel', [wheel('up', { count: 10 }), wheel('down', { count: 10 })]),
      measure('subagent rest', [play('child-done', { timed: true })]),
      measure('settle', [play(undefined, { timed: true })]),
    ],
  },
  'perf-long': {
    summary: '200 settled turns with two compactions, 2 live background subagents with nested live surveys, 2 running jobs, a goal and todos, 3 high-context streamed steps, and a /btw, with typing, scrolling, the wheel, views, and search over them',
    source: { replay: 'perfLong' },
    sizes: [DEFAULT_SIZE],
    perf: {
      ceilings: {
        load: { cpuPct: 150 }, combined: { cpuPct: 80 },
        type: { keyP50Ms: 20, cpuPerKeyMs: 15 }, scroll: { keyP50Ms: 20, cpuPerKeyMs: 20 }, wheel: { keyP50Ms: 20, cpuPerKeyMs: 20 },
        views: { keyP50Ms: 20, cpuPerKeyMs: 20 }, search: { keyP50Ms: 30, cpuPerKeyMs: 40 }, settle: { cpuPct: 90 },
      },
    },
    script: [
      measure('load', [play('load')]),
      measure('combined', [play('combined', { timed: true })]),
      measure('type', [type(SENTENCE)]),
      measure('scroll', [key('pageup', { repeat: 10 }), key('pagedown', { repeat: 10 })]),
      measure('wheel', [wheel('up', { count: 10 }), wheel('down', { count: 10 })]),
      // The draft is still in the editor here; Ctrl+C empties it while the turn runs, so Alt+Down reaches the views.
      key('ctrl+c'),
      measure('views', [key('alt+down'), key('down', { repeat: 10 })]),
      // Leave the view, take the stream's focus, and open its search line: `/` is the stream's own key.
      measure('search', [key('esc'), key('alt+up'), key('/'), type('renderer'), key('enter')]),
      measure('settle', [play(undefined, { timed: true })]),
    ],
  },
  'perf-swarm': {
    summary: 'six live background subagents with nested surveys, a running job, a /btw, and a main stream: enter the agents view, open a child, switch back, toggle the BTW, then type and scroll on main',
    source: { replay: 'perfSwarm' },
    sizes: [DEFAULT_SIZE],
    perf: {
      ceilings: {
        load: { cpuPct: 150 }, swarm: { cpuPct: 60 },
        agents: { keyP50Ms: 30, cpuPerKeyMs: 30 }, open: { keyP50Ms: 100, cpuPerKeyMs: 120 },
        back: { keyP50Ms: 100, cpuPerKeyMs: 150 }, 'btw-open': { cpuPct: 60 }, btw: { keyP50Ms: 100, cpuPerKeyMs: 150 },
        main: { keyP50Ms: 100, cpuPerKeyMs: 150 },
        type: { keyP50Ms: 20, cpuPerKeyMs: 15 }, scroll: { keyP50Ms: 20, cpuPerKeyMs: 25 }, settle: { cpuPct: 90 },
      },
    },
    script: [
      measure('load', [play('load')]),
      measure('swarm', [play('btw', { timed: true })]),
      measure('agents', [key('alt+down'), key('down', { repeat: 6 })]),
      measure('open', [key('enter'), wait(500)]),
      measure('back', [key('f7'), wait(300)]),
      measure('btw-open', [play('switch', { timed: true })]),
      measure('btw', [key('f7'), wait(300)]),
      measure('main', [key('f7'), wait(300)]),
      measure('type', [type(SENTENCE)]),
      measure('scroll', [key('pageup', { repeat: 6 }), key('pagedown', { repeat: 6 })]),
      measure('settle', [play(undefined, { timed: true })]),
    ],
  },
  'perf-content': {
    summary: 'page keys, End, and a resize inside the trace detail of a megabyte write',
    source: { replay: 'content' },
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
  ...DEMO,
  ...PERF,
})

/** Each Website app shot, with the scenario checkpoint whose golden (at the scenario's first size) it is painted from. */
export const APP_SHOTS = Object.freeze(Object.entries(CATALOG).flatMap(([name, scenario]) => Object.entries(scenario.shots ?? {}).map(([checkpointName, id]) => ({ id, scenario: name, checkpoint: checkpointName, cols: scenario.sizes[0][0], rows: scenario.sizes[0][1] }))))

/** The perf scenarios. */
export const PERF_SCENARIOS = Object.keys(CATALOG).filter(name => CATALOG[name].perf !== undefined)

/**
 * Look a scenario up.
 * @param {string} name
 * @returns the scenario with its name, or undefined.
 */
export function scenarioNamed(name) {
  return Object.hasOwn(CATALOG, name) ? { name, ...CATALOG[name] } : undefined
}
