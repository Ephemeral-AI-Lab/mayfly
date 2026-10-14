/**
 * The scenario catalog: every named state of the live product that review, frames, goldens, and perf read. A scenario
 * names its source (a replay of `replays.mjs`, an empty session, or the UI gallery), the sources it `covers` (the
 * change-based selection reads them), its sizes, and the script the runner plays: `play` to a mark or the end, keys,
 * mouse, resizes, and named checkpoints (see `steps.mjs`). `pnpm run scenario --list` prints it.
 * @module script/scenarios/catalog
 */

import { REPLAYS } from './replays.mjs'
import { compile } from './timeline.mjs'
import { checkpoint, idle, key, measure, play, resize, type, wait, wheel } from './steps.mjs'

/** The size a scenario runs at unless it names its own. */
export const DEFAULT_SIZE = Object.freeze([120, 40])

const TRANSCRIPT = 'packages/mayfly/src/transcript/'
const INTERACTION = 'packages/mayfly/src/interaction/'
/** What draws the conversation stream: the facts of its rows and the component that lays them out. */
const STREAM = [`${TRANSCRIPT}stream-facts.ts`, 'packages/mayfly/src/components/']

/** What draws a compaction row: the stream's facts, the row, and the facts that carry its occupancy. */
const COMPACTION = [...STREAM, 'packages/mayfly/src/conversation/facts.ts', 'packages/mayfly/src/conversation/projection.ts']
/** What draws the notification pane: the pane, the line, and the notices the facts raise into it. */
const NOTIFICATION = [`${TRANSCRIPT}pane-notification.ts`, `${TRANSCRIPT}notices.ts`, 'packages/mayfly/src/components/notification-line.ts', 'packages/mayfly/src/conversation/facts.ts', `${INTERACTION}notifications.ts`]

/** What draws a request that waits on the user: its block in the stream, the decision card, and what they share. */
const REQUEST = [
  `${INTERACTION}decision-actions.ts`, `${INTERACTION}request-overlay.ts`, 'packages/mayfly/src/components/decision-card.ts',
  `${TRANSCRIPT}request-facts.ts`, `${TRANSCRIPT}tool-calls.ts`, 'packages/mayfly/src/conversation/facts.ts', ...STREAM,
]

/** What the phase3 session shows: every source of its states (tools, edits, prompts, plan, compaction, notices, jobs, queue, search). */
const PHASE3_COVERS = [...new Set([
  `${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}process-*.ts`, `${TRANSCRIPT}presentation-policy.ts`, `${TRANSCRIPT}official-model.ts`, 'packages/mayfly/src/frontend/models.ts',
  `${TRANSCRIPT}pane-activity.ts`, `${TRANSCRIPT}transcript-model.ts`, `${TRANSCRIPT}status-goal.ts`, `${TRANSCRIPT}status-jobs.ts`, `${TRANSCRIPT}pane-agents.ts`, `${TRANSCRIPT}child-agent-model.ts`,
  `${INTERACTION}pane-queue.ts`, `${INTERACTION}btw-command.ts`, `${INTERACTION}approval-plugin.ts`, `${INTERACTION}questions-plugin.ts`, `${INTERACTION}plan-review-panel.ts`, `${INTERACTION}jobs.ts`, `${INTERACTION}trace-*.ts`,
  ...STREAM, ...COMPACTION, ...NOTIFICATION, ...REQUEST,
])]

/** What each replay shows, as the sources whose change it can reveal. */
const COVERS = {
  phase3: PHASE3_COVERS,
  levels: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}process-*.ts`, `${TRANSCRIPT}presentation-policy.ts`, `${TRANSCRIPT}disclosure.ts`, `${TRANSCRIPT}official-model.ts`, 'packages/mayfly/src/frontend/models.ts', ...STREAM],
  tour: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}process-*.ts`, `${TRANSCRIPT}pane-todo.ts`, ...STREAM],
  toolkit: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}present.ts`, ...STREAM],
  thinking: [...STREAM, `${TRANSCRIPT}presentation-policy.ts`, 'packages/mayfly/src/core/ui-list-paint.ts'],
  live: [...STREAM],
  markdown: [...STREAM, 'packages/mayfly/src/core/components.ts', 'packages/mayfly/src/core/content-rows.ts', 'packages/mayfly/src/core/markdown-rows.ts', 'packages/mayfly/src/core/ui-list-paint.ts'],
  phases: [`${TRANSCRIPT}pane-activity.ts`, `${TRANSCRIPT}output-rate.ts`, 'packages/mayfly/src/components/activity-row.ts'],
  thinkingLadder: [`${TRANSCRIPT}pane-activity.ts`, 'packages/mayfly/src/components/activity-row.ts'],
  pending: [`${TRANSCRIPT}pane-activity.ts`, `${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}transcript-model.ts`, `${TRANSCRIPT}tick.ts`, 'packages/mayfly/src/components/activity-row.ts', ...STREAM],
  blocks: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}process-*.ts`, `${TRANSCRIPT}official-model.ts`, `${TRANSCRIPT}transcript-model.ts`, ...STREAM],
  streaming: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}partial-json.ts`, `${TRANSCRIPT}official-model.ts`, 'packages/mayfly/src/conversation/stream-accumulator.ts', 'packages/mayfly/src/core/content-rows.ts', 'packages/mayfly/src/core/diff-align.ts', ...STREAM],
  sync: [`${TRANSCRIPT}pane-activity.ts`, `${TRANSCRIPT}session-facts.ts`, `${TRANSCRIPT}tick.ts`, 'packages/mayfly/src/conversation/facts.ts', 'packages/mayfly/src/components/activity-row.ts', ...STREAM],
  activityWait: [`${TRANSCRIPT}pane-activity.ts`, 'packages/mayfly/src/components/activity-row.ts', `${INTERACTION}approval-plugin.ts`, `${INTERACTION}questions-plugin.ts`],
  prompts: [`${TRANSCRIPT}transcript-model.ts`, `${INTERACTION}attachments.ts`, ...STREAM],
  turns: [`${TRANSCRIPT}transcript-model.ts`, `${TRANSCRIPT}process-groups.ts`, `${TRANSCRIPT}presentation-policy.ts`, `${INTERACTION}pane-queue.ts`, 'packages/mayfly/src/core/node-slot.ts', ...STREAM],
  errors: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}transcript-model.ts`, ...STREAM],
  toollines: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}process-*.ts`, `${TRANSCRIPT}official-model.ts`, 'packages/mayfly/src/frontend/models.ts', ...STREAM],
  edits: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}process-*.ts`, `${TRANSCRIPT}official-model.ts`, 'packages/mayfly/src/frontend/models.ts', 'packages/mayfly/src/core/content-rows.ts', 'packages/mayfly/src/core/diff-align.ts', 'packages/mayfly/src/core/highlight.ts', ...STREAM],
  compaction: [...COMPACTION],
  compactionFailed: [...COMPACTION],
  compactionNoWindow: [...COMPACTION],
  manualCompact: [...COMPACTION],
  context: [`${TRANSCRIPT}status-context.ts`, `${TRANSCRIPT}notices.ts`, ...COMPACTION],
  subagents: [`${TRANSCRIPT}pane-agents.ts`, `${TRANSCRIPT}child-agent-model.ts`],
  childStream: [`${TRANSCRIPT}pane-agents.ts`, `${INTERACTION}agents-command.ts`],
  approvals: [`${INTERACTION}approval-plugin.ts`, `${INTERACTION}permission-panel.ts`, ...REQUEST],
  approvalsRejected: [`${INTERACTION}approval-plugin.ts`, ...REQUEST],
  approvalsEdit: [`${INTERACTION}approval-plugin.ts`, ...REQUEST, 'packages/mayfly/src/core/content-rows.ts'],
  approvalsQueue: [`${INTERACTION}approval-plugin.ts`, ...REQUEST],
  questions: [`${INTERACTION}questions-plugin.ts`, `${INTERACTION}questionnaire.ts`],
  plan: [`${INTERACTION}plan-review-panel.ts`, `${INTERACTION}questions-plugin.ts`, ...REQUEST],
  planLong: [`${INTERACTION}plan-review-panel.ts`, `${INTERACTION}questions-plugin.ts`, ...REQUEST, 'packages/mayfly/src/core/markdown-rows.ts'],
  goal: [`${TRANSCRIPT}status-goal.ts`],
  jobs: [`${TRANSCRIPT}status-jobs.ts`, `${INTERACTION}jobs.ts`],
  queued: [`${INTERACTION}pane-queue.ts`],
  retries: [`${TRANSCRIPT}transcript-model.ts`, `${INTERACTION}trace-*.ts`, ...NOTIFICATION, ...STREAM],
  sideQuestion: [`${INTERACTION}btw-command.ts`, `${INTERACTION}conversation-view-status.ts`],
  notices: [...NOTIFICATION],
  notificationPane: [...NOTIFICATION, ...COMPACTION],
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
  select: {
    scene: 18,
    reference: 'prototype scene 18 (Conversation stream: Alt+Up select a row, Enter expand, c copy, Ctrl+G open in editor) · component-library §5.6 · part 3e.2',
    implemented: [
      'Alt+Up (or F4) with an empty prompt moves focus up into the stream; the cursor starts on the newest selectable row and the view returns to the tail (a history scrolled away comes back), ↑/↓ walk the rows. Blank rows, the `✻ Worked for …` line and `■ interrupted` are not rows to select. Esc or Alt+Down (F5) gives focus back to the prompt.',
      'The selected block is a gray band, inset one column from each edge of the screen and covering the whole block: a call with its output, an answer with all its lines, a run head with the calls under it. A selected call inside a run is only its own line.',
      'Mode: while focus is off the prompt the status line carries a `conversation` chip (at the place of the plan/yolo badges, `bar` when a view of the bottom bar is entered, `search` with the search in 3e.3); the prompt frame turns gray, and the notification pane (the row above the editor) teaches the stream\'s keys at the left (a copy notice keeps the right); with no notice and focus on the prompt, it teaches `Alt+↑ conversation · Alt+↓ bar` at the right.',
      'Enter on a turn header (or a Compact `▸ N tool calls` line) opens that turn at Verbose and the cursor follows to the turn\'s new header; Enter again folds it. Enter on a call line inside a run opens only that call, in place under its line, and the run stays as it is; on the run head it opens every call, and Enter again folds them all. Enter on a prompt, an answer, or a diff lifts its cap.',
      '`c` copies what a person reads: a message as its Markdown, an edit as a diff, a command with its output, a read with its lines, a plan as Markdown. `Ctrl+C` (not the interrupt, while the stream has focus) copies the model\'s raw JSON of the row. A header or title stands for its whole turn. The notification pane says what was copied; Ctrl+G reads the same text in $EDITOR.',
    ],
    focus: [
      { look: 'The cursor lands on the newest row as a gray band and the status line says `conversation`; at 60 columns the hint row and the band fit', how: 'checkpoints `end`, `focused` (`--png` shows the band), and `--width 60`' },
      { look: 'An inner call of a run: the run stays whole, only that call opens in place under its line (the band covers the line and its output), Enter again folds it', how: 'checkpoints `item`, `item-open`, `item-closed`' },
      { look: 'The run head: Enter opens every call in place, Enter again folds them all', how: 'checkpoints `head`, `head-open`, `head-closed`' },
      { look: 'c and Ctrl+C notices (try pasting both live)', how: 'checkpoints `copied`, `copied-raw`' },
      { look: 'The turn header opens the whole turn and the cursor follows to the new header', how: 'checkpoints `header`, `turn-open`, `turn-closed`' },
      { look: 'Esc and Alt+Down return to the prompt; the chip and the gray frame go', how: 'checkpoints `back`, `back-alt`' },
      { look: 'Focus after scrolling the history away: the view comes back to the tail', how: '`pnpm run scenario select-away`' },
      { look: 'At Compact the title line is a row and Enter opens its turn', how: '`pnpm run scenario select-compact`' },
    ],
    differs: [
      'The mouse wheel does not scroll while the stream is focused (the stream shows the window around its cursor); PageUp/PageDown walk the cursor.',
      'A request waiting on you is not reachable with Alt+Up: the decision card takes the prompt\'s place and its keys.',
    ],
    pending: [],
  },
  search: {
    scene: 18,
    reference: 'prototype scene 18 (Conversation stream: search) · component-library §5.6 · part 3e.3',
    implemented: [
      'Search starts in conversation mode (Alt+Up first), as in vim: `/` searches toward the newer rows, `?` toward the older. There is no Ctrl+F (editors and terminals bind it). A search line opens above the editor (two rows: `/ pattern` and a muted line with the count and the keys); the editor stays in its parked frame and the status line says `search`.',
      'The pattern is a JavaScript regular expression, matched in any case unless it holds a capital letter (smart case); one that does not compile says `Invalid regular expression`. It is matched against the text a person reads (a command and its output, a diff, a plan, an answer, reasoning), so what a level hides is found too, in every turn of the session.',
      'While typing, the stream only highlights (matches drawn reversed in the rows it shows) and counts; the cursor stays where it was. `Enter` accepts: the input stops, the cursor goes to the first match past where it stood (before it for `?`, wrapping), and the stream is in selection mode. `Esc` (or Backspace on an empty pattern) abandons the search and returns to conversation mode.',
      'Selection mode is conversation mode over the matches: `↑`/`↓` go to the previous or next match, `n`/`N` go on and back in the direction of the search, wrapping; Enter expands the row, `c`, `Ctrl+C` and `Ctrl+G` copy or open it, and `/` or `?` starts a new search. The turn holding the current match, and the turns already visited, open at Verbose and stay mounted until the search ends (a hit in a turn the stream does not mount mounts it). The notification pane teaches these keys.',
      '`Esc` (or Alt+Down) in selection mode ends the search: the levels come back, the highlight is cleared, and conversation mode keeps the cursor on that row (or on its turn header). A second Esc returns to the prompt.',
    ],
    focus: [
      { look: 'Typing only highlights and counts; nothing is selected', how: '`pnpm run scenario search`, checkpoints `opened`, `typed`, `regex`' },
      { look: 'Enter selects the first match past the cursor; the input stops', how: 'checkpoint `selected`' },
      { look: 'Walking the matches: ↑/↓, n/N, wrapping; c and Ctrl+C copy the match row', how: 'checkpoints `prev`, `next`, `again`, `copied`' },
      { look: '? searches toward the older rows', how: 'checkpoint `backward`' },
      { look: 'Every occurrence is a stop, also several inside one tall block: the current one is bold and underlined, the window centers on it', how: '`pnpm run scenario search-block`, checkpoints `answer-last` … `answer-first`' },
      { look: 'Esc ends the search and keeps the cursor', how: 'checkpoints `ended`, `prompt`' },
      { look: 'A hit in an old turn the stream does not mount, and a call that arrives while searching is found', how: '`pnpm run scenario search-history`, `pnpm run scenario search-live`' },
      { look: 'A 40-column terminal', how: '`pnpm run scenario search-narrow`' },
    ],
    differs: [
      'Shift+Enter does nothing; there is no backward step in the input phase (the pattern is accepted first).',
    ],
    pending: [],
  },
  levels: {
    scene: 18,
    reference: 'prototype scene 18 (Conversation stream, every level) · component-library §5.6 · part 3e.1',
    implemented: [
      'What you open sits on top of the level: Ctrl+O draws the newest three turns at their Verbose tier and a second Ctrl+O closes them again; nothing else changes.',
      'The level table is the only place that says what a level shows: a compaction row is one line at Compact and opens its summary at Verbose (it used to ask the mode directly).',
      'Behind the scenes, the reader\'s openings are one value (Ctrl+O reach, single turns, single rows, turns a search holds open); Enter on a header (3e.2) and search (3e.3) use the same value.',
    ],
    focus: [
      { look: 'Detail is in exactly one place per level: the same turns at Compact, Standard, Detailed and Verbose', how: '`pnpm run scenario levels`, `levels-compact`, `levels-detailed`, `levels-verbose`, checkpoint `end`' },
      { look: 'Ctrl+O opens the newest three turns; older turns stay as the level draws them', how: 'checkpoint `open`' },
      { look: 'The second Ctrl+O puts the turns back exactly as they were', how: 'checkpoint `closed`' },
      { look: 'The `Ctrl+O to expand` hints appear only while there is more to open', how: 'compare `end`, `open`, `closed`' },
    ],
    differs: [
      'Enter on a turn header and the row cursor arrive with part 3e.2; this scenario shows only the Ctrl+O side.',
    ],
    pending: [],
  },
  pending: {
    scene: 17,
    reference: 'prototype scene 17 (Tool rows) and 14 (Activity row) · component-library §5.3.1 (division of labor) · part 3b.4',
    implemented: [
      'A call is in the stream the moment it is committed: `● Bash(pnpm test) · 4s`, the dot breathing and the call\'s own time ticking, then `✓`, `✗`, or `⊘` in place.',
      'Two commands running together are two pending lines; when they settle they regroup into the run block.',
      'While a call runs the activity row says only `Running commands` (no time, no detail) with a tip under it, at every level; at Compact the stream still holds the pending line, since the row has one effect.',
    ],
    focus: [
      { look: 'The stream is never empty while the row says Running commands', how: 'checkpoint `running`' },
      { look: 'Two pending lines, each with its own time', how: 'checkpoint `parallel`' },
      { look: 'The pending line becomes a failure with its reason', how: 'checkpoint `failing`, then `end`' },
      { look: 'The same at Compact: the pending line is there, the row is unchanged', how: '`pnpm run scenario pending-compact`, checkpoint `running`' },
    ],
    differs: ['Partial output is not shown: the Harness reports a foreground command\'s output only with its result; a multi-line command shows its own lines as input (see `blocks`).'],
    pending: ['The interrupted call (`⊘`) is the last turn of the replay; the approval row in the stream is part 3d.'],
  },
  thinkingLadder: {
    scene: 14,
    reference: 'prototype scene 14 (Activity row) · component-library §5.3.1 (the thinking ladder)',
    implemented: ['The thinking label deepens with the seconds spent in the phase: Pondering, Mulling, DeepThinking, Fathoming, its tone stepping muted, default, primary, accent bold.'],
    focus: [
      { look: 'Four words, four tones, the glyph blooming throughout', how: 'checkpoints `pondering`, `mulling`, `deep`, `fathoming`' },
      { look: 'The reasoning text in the stream shows no ticking time', how: 'checkpoint `deep`' },
    ],
    differs: [],
    pending: [],
  },
  phases: {
    scene: 14,
    reference: 'prototype scene 14 (Activity row, `v`/`V` next phase) · spec §5.3 · ActivityRow in mayfly-components.mjs · part 3c.1',
    implemented: [
      'Deep diving fills its glyph, Thinking blooms its glyph, Writing fills like Deep diving; the label stays still in all three.',
      'A running tool keeps a still ● while only its label shimmers; a call being prepared reads Preparing to edit files while its code streams into the stream (see `streaming`).',
      'The block is two rows while a turn runs: the header and one line under it, at the stream\'s left margin; the row under it is the notification pane\'s, so the editor never shifts.',
      'The header tail (`· 8s · ↑30.2k ↓1.1k · 38 tok/s`) ticks once a second; the glyph and the shimmer move on core\'s clock, and reduced motion freezes them.',
    ],
    focus: [
      { look: 'Glyph moves over a still label (Deep diving, Thinking, Writing); label moves over a still ● (tool)', how: 'checkpoints `diving`, `thinking`, `writing`, `tool`' },
      { look: 'The block keeps its height: the editor never moves between phases', how: 'checkpoints `diving` against `tool`' },
      { look: 'What hides first as the row narrows: the tail, then the ⎿ connector', how: '`pnpm run scenario phases --width 60`, then `--width 40`, at checkpoints `tool` and `thinking`' },
      { look: 'Reduced motion stops the glyph and the shimmer', how: '`/settings`, Reduced motion, then play to checkpoint `diving`' },
    ],
    differs: [
      'The block is two lines, with the notification pane\'s row under it, as the owner drew it; the spec\'s up-to-three `⎿` lines and the interrupt cue in the right gap are gone.',
      'Waiting on the user breathes its ● like an external wait (no static `?`); see `activityWait`.',
    ],
    pending: ['The stop acknowledgment (a static red ■ `interrupting…`) needs a live turn: press Esc in a real session.'],
  },
  blocks: {
    scene: 17,
    reference: 'component-development-spec §7.1 (tool block base) · component-library §5.3.1 · parts 3b.4 and 3b.5',
    implemented: [
      'A call in flight is a pending line at every level, Compact included, with the dot breathing and the time ticking in whole seconds.',
      'A running multi-line command is `● Bash` with its own lines under it (3 at Standard, 6 at Detailed and Verbose, 40 with Ctrl+O, then `… +N more`); Compact shows `● Bash(first line …)`. After it completes it reads `✓ Bash(first line …)`.',
      'Calls of one kind form ONE group block from the first call on, in place: `● Read · 2 files` with a branch line per file (each with its own state), the head turning ✓ when all are done.',
      'The activity row says `Running 7 tools` while they run, and its second line lists their arguments.',
    ],
    focus: [
      { look: 'Groups of two reads and two commands, three single kinds, the long command with 3 rows of its own lines', how: 'checkpoint `kinds`' },
      { look: 'A 14-line command: how many rows each level shows', how: 'checkpoint `command` here, then `blocks-compact`, `blocks-detailed`, `blocks-verbose`' },
      { look: 'Ctrl+O lifts the input to 40 rows', how: '`blocks-verbose`, checkpoint `open`' },
    ],
    differs: ['Subagent and job progress is not drawn in the block; the bottom bar will carry it.'],
    pending: ['Foreground output is not streamed by the Harness, so the input stands in for it.'],
  },
  streaming: {
    scene: 17,
    reference: 'component-library §5.3 (Edit is a diff; Write is code) · component-development-spec §7.1 · part 3b.5',
    implemented: [
      'The moment the model names a write or an edit, the stream holds its pending line; the code appears row by row as the model writes the arguments, before the call is committed.',
      'While the model writes, the block shows the last rows that fit the level\'s cap (6 at Standard, 12 at Verbose, 40 with Ctrl+O), newest at the bottom, under `… +N earlier`; once the call is committed it shows the first rows above `… +N more`.',
      'A write shows its code; an edit shows the old text removed and the new text added as it arrives. The path joins the line once the model has written it.',
      'Committing the call and its result change the dot and the line in place: the rows do not jump.',
    ],
    focus: [
      { look: 'The write\'s code scrolling: early, half, late (its line numbers keep their own count)', how: 'checkpoints `write-early`, `write-half`, `write-late`' },
      { look: 'The committed call switches to its first rows', how: 'checkpoint `write-running`' },
      { look: 'The edit growing as a diff', how: 'checkpoints `edit-early`, `edit-half`, `edit-late`' },
      { look: 'Live rows beyond the cap with Ctrl+O', how: '`pnpm run scenario streaming-open`, checkpoints `half`, `late`' },
      { look: 'The narrow terminal', how: '`pnpm run scenario streaming --width 60`' },
    ],
    differs: ['The edit\'s diff is numbered from its first row (the Harness gives no start line); the whole old text shows as removed until the new text arrives.'],
    pending: ['An interrupt during the arguments needs a live turn.'],
  },
  sync: {
    scene: 14,
    reference: 'component-library §5.3.1 (division of labor) · part 3c.1',
    implemented: [
      'The row\'s tool phase names the calls in flight: `Running 2 tools` while a command and a read run, `Running commands` once the read settled, and it ends with the last result.',
      'The pending lines and the row take their time from one tick and one format (whole seconds), so the seconds agree.',
      'The thinking ladder counts from the session\'s own timestamp.',
      'The second line carries what the turn is doing that the stream does not say: the arguments of the calls in flight; else a tip. A provider retry is the notification pane\'s (see `notificationPane`).',
      'Thinking is a block like a write: `● Thinking` with its first lines filling in (3 at Standard, 8 at Verbose, 40 open), then `… +N more`.',
    ],
    focus: [
      { look: 'Row says Running 2 tools; the stream has two pending lines', how: 'checkpoint `mixed`' },
      { look: 'The read has settled (✓), the row says Running commands', how: 'checkpoint `one`' },
      { look: 'After the last result the row is Pondering, not a tool label; the thinking block fills in the stream', how: 'checkpoint `thinking`' },
      { look: 'The second line names the arguments of the calls in flight', how: 'checkpoints `mixed` and `one`' },
    ],
    differs: [],
    pending: ['Reload mid-thought (the ladder keeps its stage) needs a live session.'],
  },
  activityWait: {
    scene: 14,
    reference: 'prototype scene 14 (Activity row, phase 5) and scene 21 (approval) · spec §5.3 · part 3c.2',
    implemented: [
      'While an approval or a question waits on you, the row stays above the panel with a breathing ● and `Waiting for your approval` or `Waiting for your answer`, a tip under it, and the wait time.',
      'The row clears when you answer; other dialogs still hide it.',
    ],
    focus: [
      { look: 'Breathing ●, still label, elapsed wait time', how: 'checkpoints `approval` and `question`' },
      { look: 'The row is gone after the answer', how: 'checkpoint `end`' },
    ],
    differs: ['The decision cards of part 3d replace the panels under this row; the approval is the card, and the wait is also the call in the stream (`approvals`).'],
    pending: ['The question panel stays an overlay (part 6e).'],
  },
  approvals: {
    scene: 21,
    reference: 'prototype scene 21 (Approval, variant B) and scene 18 (request) · spec §5.7 · part 3d.1',
    implemented: [
      'A tool call that waits on you is the request: its own line turns into `? Bash(command) · waiting`, open, with the command, `⚠ deletes files` when it removes files, and what the asker said.',
      'The decision is a lane card where the editor sits: `── Decide ──`, three numbered rows (Allow once, Allow {tool} for this session, Reject), a `Feedback:` note, and the hint row; a digit chooses at once and `Esc` rejects.',
      'For a moment after the card opens every key but `Esc` is swallowed (`ready in a moment`), so a stray key typed into the editor grants nothing.',
      'The settled line says what you decided: `✓ Bash(rm -rf dist build) · allowed · 0.9s`.',
    ],
    focus: [
      { look: 'The call is the request; the activity row breathes above the card', how: 'checkpoint `asking`' },
      { look: 'The same request at 80 columns', how: 'checkpoint `narrow`, and `--width 60`' },
      { look: 'The settled line with `allowed`', how: 'checkpoint `allowed` (key `1` chose Allow once)' },
      { look: 'The arm delay: press a key the moment the card opens', how: '`pnpm run scenario approvals`, then mash `1` as the card appears; checkpoint `asking` is taken after the delay' },
    ],
    differs: [
      'The request is the call\'s own block, not a second `Approve command` row (owner, R8).',
      'One Reject row; `Feedback:` is its note, so there is no `Reject and tell the agent why…` row (owner, R8).',
      'The `in <directory>` line is not drawn: the stream does not know the working directory yet.',
    ],
    pending: ['The settled line says `allowed` for a session grant as well: the audit event does not tell them apart.'],
  },
  approvalsRejected: {
    scene: 21,
    reference: 'prototype scene 21 (Approval, feedback) · spec §5.7 · part 3d.1',
    implemented: [
      '`↓` from the last row focuses `Feedback:`; typing there and Enter rejects and sends the text to the agent.',
      'The rejected call settles as `✗ Bash(…) · rejected`, and the agent changes course.',
    ],
    focus: [
      { look: 'The note under the rows, with its cursor', how: 'checkpoint `note`' },
      { look: 'The rejected line and the agent\'s next step', how: 'checkpoint `rejected`' },
    ],
    differs: ['The replay cannot fork on the answer, so it always plays the rejection; answering `1` still shows the card.'],
    pending: ['The note appears as a queued message until the agent reads it, as every steering message does.'],
  },
  approvalsEdit: {
    scene: 21,
    reference: 'prototype scene 21 (Approval, edit) · spec §5.7 · part 3d.1',
    implemented: [
      'An edit waits as `? Edit(path) · waiting` with its diff open (up to 40 rows); a write waits with its code.',
      '`Ctrl+G` opens the diff or the code in `$EDITOR` and returns to the same card; the card keeps the choice open.',
    ],
    focus: [
      { look: 'The diff is the request, whatever the level', how: 'checkpoint `edit`, and `approvalsEdit-compact` / `approvalsEdit-verbose`' },
      { look: 'The write\'s code as the request', how: 'checkpoint `write`' },
      { look: 'Ctrl+G with and without `$EDITOR`', how: 'in the live scenario press `Ctrl+G` on the card of checkpoint `edit`' },
    ],
    differs: ['The hint row names `open diff` only for file changes; a command says `open command`.'],
    pending: ['A very large diff shows 40 rows; `Ctrl+G` shows the rest.'],
  },
  approvalsQueue: {
    scene: 21,
    reference: 'prototype scene 21 (Approval, queue) · spec §5.7 · part 3d.1',
    implemented: [
      'Three calls wait together: the first is `? … · 1 of 3 waiting` with the card; the others keep their running dots until their turn.',
      'Each answer brings the next request, first in first out; the card says how many wait.',
    ],
    focus: [
      { look: 'Only the first call is a request, the card says `1 of 3 waiting`', how: 'checkpoint `first`' },
      { look: 'The next request takes over after an answer', how: 'checkpoints `second` and `third`' },
    ],
    differs: ['A session grant (`2`) on a tool resolves the queued requests of that tool at once; here the three calls are different.'],
    pending: [],
  },
  plan: {
    scene: 21,
    reference: 'prototype scene 21 (Plan review) and scene 18 · spec §5.7 · part 3d.2',
    implemented: [
      'The plan under review is the request block: `? Plan ready for review · 4 steps` with the whole plan as Markdown, wrapped under the line.',
      'The card has Approve and start, Keep planning…, and Reject, a `Revise:` note, `c` to copy and `Ctrl+G` to open the plan.',
      'A decided plan stays readable: its line ends in `Ctrl+O to expand`, and `Ctrl+O` (or the Verbose level) shows the whole plan again.',
      'The call settles as you answered: `✓ Plan approved · 4 steps`, `✗ Plan rejected · 4 steps`, or `↩ Plan sent back · 4 steps · "your revision"`.',
    ],
    focus: [
      { look: 'The plan as the request and the card under it', how: 'checkpoint `review`' },
      { look: 'The narrow card', how: 'checkpoint `narrow`, and `--width 60`' },
      { look: 'The settled plan line, with its hint', how: 'checkpoint `approved`; `planRejected` and `planRevised` show the other two' },
      { look: 'Ctrl+O reads the decided plan again', how: 'checkpoint `opened` (press `Ctrl+O` again to fold it)' },
    ],
    differs: ['No `Approve and auto-accept edits` row: the Harness offers only the native outcomes (D3).', 'Reject and Keep planning… both decline; only Keep planning… sends your revision, which is how the stream tells them apart (the note beside Reject is not sent).'],
    pending: [],
  },
  planRevised: {
    scene: 21,
    reference: 'prototype scene 21 (Plan review, revise) · spec §5.7 · part 3d.2',
    implemented: [
      '`Keep planning…` with an empty `Revise:` asks for the revision and focuses the field; Enter with text sends it.',
      'The plan settles as `↩ Plan sent back · 4 steps · "add a rollback step"`: the revision is on the line, which is what tells it from a rejection.',
    ],
    focus: [
      { look: 'The prompt to write the revision', how: 'checkpoint `needs-note`' },
      { look: 'The sent-back line with your words', how: 'checkpoint `revised`' },
    ],
    differs: [],
    pending: [],
  },
  planRejected: {
    scene: 21,
    reference: 'prototype scene 21 (Plan review) · spec §5.7 · part 3d.2',
    implemented: ['`Reject` declines the plan with no revision; the call settles as `✗ Plan rejected · 4 steps` (red cross, no words), unlike `↩ Plan sent back`.'],
    focus: [
      { look: 'The rejected line next to the other two outcomes', how: 'checkpoint `rejected`' },
    ],
    differs: ['The Harness gives Reject and Keep planning… (without text) the same answer; here only a revision makes a plan "sent back".'],
    pending: [],
  },
  planLong: {
    scene: 21,
    reference: 'prototype scene 21 (Plan review, long plan) · spec §5.7 · roadmap §4.2 · part 3d.2',
    implemented: [
      'A plan of any length is the request block, with no cutoff: it scrolls with the stream while the card stays at the foot.',
      '`PgUp`/`PgDn` scroll the plan behind the card.',
    ],
    focus: [
      { look: 'The end of a long plan above the card', how: 'checkpoint `review`' },
      { look: 'Scrolled back into the plan', how: 'checkpoint `scrolled`' },
    ],
    differs: [],
    pending: [],
  },
  notificationPane: {
    scene: 16,
    reference: 'prototype scene 16 (Notices and banners) · component-library §5.2 · part 3c.3',
    implemented: [
      'One row between the activity block and the editor carries the notice to read now: right-aligned, never wider than half the terminal, one notice at a time (the most severe, then the newest) with a muted `· +N` for the ones waiting.',
      'It shows the notification lane (commands\' and extensions\' feedback: `✓`/`ℹ` leave after 5 s, `⚠`/`✗` stay) and three notices the session\'s facts raise: a rate limit or provider error with its countdown (`Rate limited · retrying in 9s · 1/5`), a context 92% full (`Context 93% full · /compact now`), and a resumed session (`Resumed session · 2 turns · last active 3h ago`, which leaves after 5 s).',
      'The row is there when nothing shows (blank), so the editor never moves; the footer under the editor keeps only the slash hint.',
    ],
    focus: [
      { look: 'The rate-limit notice counts down, right-aligned, under the activity block', how: 'checkpoint `rate-limited`' },
      { look: 'A success toast over a running turn, gone after 5 s', how: 'checkpoints `toast` and the one after it' },
      { look: 'The context warning stays, the compaction clears it', how: 'checkpoints `context-full` and `relieved`' },
      { look: 'The resumed notice after opening a stored conversation', how: 'checkpoint `resumed` (`/sessions`, then the stored conversation)' },
      { look: 'The half-width cap and the truncation', how: '`pnpm run scenario notificationPane --width 60`' },
    ],
    differs: [
      'The prototype\'s banners carry keys (`Esc cancel`, `r retry`); only the rate limit names Esc through the activity row\'s interrupt cue, and nothing here binds `r`.',
      'The toast has no `Ctrl+J view` or `u undo` (the notification view and undo are not built).',
    ],
    pending: ['Offline and a low balance are not raised: the Harness has no offline signal and the balance is not read yet.'],
  },
  compaction: {
    scene: 20,
    reference: 'prototype scene 20 (Compaction) · component-library §5.6 (Compaction) · part 3c.4',
    implemented: [
      'While it runs: `● Compacting context ▰▰▰▰▱▱▱▱▱▱ 42% summarizing · 4s · auto` with the dot breathing; the percentage is an estimate that grows with the time (about 80% at the expected time, never past 90%); when the summary lands the stage reads `applying` and the bar fills to 100% over 800 ms.',
      'Settled: `✓ Compacted 84 items ▰▰▰▰▰▰▰▰▰▰ context 91% → 9% · ~148k → ~12k tokens · auto` and `⎿ Ctrl+O summary` (the summary\'s first lines with Ctrl+O).',
      'A narrow row sheds the bar, then the token estimate, then `auto`; below 56 columns and at Compact it is one line (`✓ Compacted 14 items · 91% → 9%`).',
    ],
    focus: [
      { look: 'The estimated percentage growing with the seconds', how: 'checkpoint `summarizing` (frames compress time: run `pnpm run scenario compaction` live to watch it climb)' },
      { look: 'The bar filling to 100% and the stage `applying`', how: 'checkpoint `applying` (the fill is 800 ms: watch it live)' },
      { look: 'The settled row and its summary line', how: 'checkpoint `settled`; Ctrl+O is `open`' },
      { look: 'Compact and narrow', how: '`pnpm run scenario compaction-compact`, and `--width 60` / `--width 40`' },
      { look: 'The failure row', how: '`pnpm run scenario compactionFailed`' },
      { look: 'A manual /compact: its own block below the turn\'s closing line', how: '`pnpm run scenario manualCompact`' },
    ],
    differs: ['The bar\'s edge cell does not breathe: the leading dot breathes while it runs (one motion channel, as every pending row).'],
    pending: ['Stage 2 is inferred from the summary landing before the end record; a real compaction applies within a tick, so `applying` may be too brief to see outside a replay.'],
  },
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
      'A failed call is ✗ with its reason on the line (the first line of the error, clipped), at every tier. A block of calls where only some failed has a `⚠` head with `N failed` in the warning tone (✗ is for a block where every call failed), and the Compact line counts its failures in the same tone.',
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
      'A failed call keeps its reason on its line at every tier; a call the user stopped reads `⊘ Bash(cmd) · interrupted`, one that never ran `⊘ Bash(cmd) · not started`, and one whose outcome is unknown (the session ended while it ran) `✗ Bash(cmd) · outcome unknown`. A call in flight is a pending line at every level (see `blocks`).',
      'A blank row separates every row of a turn, as in Claude Code.',
    ],
    focus: [
      { look: 'Standard blocks: head with counts and time, tree of items, failures marked ✗', how: 'checkpoint `standard`' },
      { look: 'Verbose bodies: read lines, matches, output tail, sources, page head, and the `… +N more · Ctrl+O` row', how: 'Ctrl+O is `open` (all rows); `pnpm run scenario toollines-verbose` is the capped form' },
      { look: 'Compact merged line and the folded header', how: '`pnpm run scenario toollines-compact`, checkpoint `end`' },
      { look: 'Detailed collapse: earlier steps become Standard blocks when the next step starts', how: '`pnpm run scenario toollines-detailed`, checkpoint `live` (stopped after step 3)' },
      { look: 'The ⊘ line of the interrupted build and the failed lint', how: 'checkpoint `open`, the last turn' },
      { look: 'Long paths and commands clip at the end; the tree and glyphs stay', how: 'checkpoint `standard`, at `--width 60` and `--width 40`' },
      { look: 'Spacing: a blank row between every row', how: 'checkpoint `standard`' },
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
      'A failed edit is `✗ Edit(path) · <first line of the reason>` at every tier, with no diff; a write the user stopped is `⊘ Write(path) · interrupted`. A running edit or write is a pending line whose code fills as the model writes it (see `streaming`).',
      'The diff is syntax-highlighted by the file extension and has one quiet line-number gutter that numbers every row (a removed line by its place before the edit, the others by their place after it); the tint behind a changed line stops 4 columns short of the right edge. The Harness sends three lines of context around a hunk, the diff body keeps one.',
    ],
    focus: [
      { look: 'The single edit: line, diffstat bar, highlighted code, the inset bands, the gutter and signs, one context line each side', how: 'checkpoint `standard`, the first edit' },
      { look: 'The multi-hunk edit and the `⋯` between hunks: four hunks of one replaced line, two lines for one, one line for two, and one line removed alone; each counts from 1, a removed row shows its old number and the others the new one, so `−` and `+` rows of a replaced line share a number and a hunk that adds or removes lines shifts the numbers below it', how: 'checkpoint `multi-hunk` (Standard, 6 rows) and `multi-hunk-open` (Ctrl+O, every hunk); or `pnpm run scenario edits-verbose`; at `--width 40` the gutter keeps its columns and the code clips' },
      { look: 'Several changes in a row stay separate open blocks', how: 'checkpoint `standard`, the "handful of files" step' },
      { look: 'The large edit capped at 6 / 12 / 40 rows with its `… +N rows` row', how: 'compare checkpoint `standard`, `edits-verbose` and `open`' },
      { look: 'The write: highlighted numbered code, 6 rows at Standard and 12 at Verbose', how: 'checkpoint `standard`, then `pnpm run scenario edits-verbose`' },
      { look: 'The failed edit and the cancelled write', how: 'checkpoint `open`, last lines of each turn' },
      { look: 'Narrow widths: the diff rows clip with `…`, the line clips at the end, the gutter takes 5 columns', how: 'checkpoint `standard`, at `--width 60` and `--width 40`' },
      { look: 'Compact and Detailed', how: '`pnpm run scenario edits-compact`, `pnpm run scenario edits-detailed` (checkpoint `live`)' },
    ],
    differs: [
      'The line numbers are relative to the hunk: the Harness gives hunk text with no start line, so each hunk counts from its first row, and the gutter is as wide as the largest number of any hunk (accepted behavior). A removed row shows its number in the file before the edit, every other row its number in the file after it.',
      'A call is named by its tool (`Edit`, `Write`), not the prototype\'s `Edited`/`Wrote`; the verbs stay in the head of a run (owner decision).',
      'The failure reason is on the call\'s line, not on a `⎿` row (owner decision, 3b.1).',
      'Edits and writes are open at Standard and fold only at Compact (owner decision), so they never form a tree.',
      'A diff that exceeds its rows ends with the painter\'s own `… +N rows · Ctrl+O`, in English, even when Ctrl+O is already open.',
    ],
    pending: [
      'Command rows are finished in 3b.1 (no `⎿` tails); there is no command work in this part.',
      'The 400 ms flash when an edit settles is unscheduled.',
      'Enter, copy, and opening the diff in the editor are row selection (3e.2).',
    ],
  },
}

/**
 * Scripts that differ from playing to the end. A settled job wakes the agent for a real turn on the stub, which runs
 * at real time, so the jobs replay is captured while all three jobs run.
 */
/** Play at the replay's own pace: the activity row is a function of time (a phase lasts seconds, the tail ticks). */
const TIMED = { timed: true }
/** A decision card ignores every key but Esc for 300 ms after it opens (wall clock); a checkpoint waits that out. */
const ARMED = 400
/** The marks of the phase3 session in playing order: the tour stops at each of them. */
const PHASE3_MARKS = [...new Set(compile(REPLAYS.phase3.items, REPLAYS.phase3.options).filter(action => action.op === 'mark').map(action => action.name))]
/**
 * The prompts the phase3 session raises before a mark, in order: the checkpoint of each card and the keys that answer it.
 * A prompt stops playback, so the script plays to the prompt, answers it, and plays to the mark again.
 */
const PHASE3_PROMPTS = {
  approved: [['approval-card', [key('1')]]],
  queued: [['queue-card-1', [key('1')]], ['queue-card-2', [key('1')]], ['queue-card-3', [key('1')]]],
  rejected: [['reject-card', [key('3')]]],
  'plan-revised': [['plan-card', [key('2'), type('add a rollback step'), key('enter')]]],
  'plan-accepted': [['plan-card-2', [key('1')]]],
  answered: [['question-card', [key('enter')]]],
  tool: [['open-card', [key('1')]]],
}
/**
 * Play the phase3 session to the mark `name`, answering the prompts before it. Each card is checkpointed before its
 * keys: a key sent straight after the prompt is announced can land in the editor instead of on the card (the card's
 * arm window opens on the frame that shows it), so the checkpoint is what makes the answer reliable. Each prompt
 * sends one `ask` to the runner, and every `ask` but the first is still queued when the first is answered: one
 * `play` per prompt drains them and then the mark, or the runner would wait for a mark that comes after the asks.
 */
const goto = name => {
  const prompts = PHASE3_PROMPTS[name] ?? []
  if (prompts.length === 0) return [play(name)]
  return [play(name), ...prompts.flatMap(([card, keys]) => [wait(ARMED), checkpoint(card), ...keys]), ...prompts.map(() => play(name))]
}
/** Play the phase3 session through the mark `name` without a checkpoint. */
const through = name => PHASE3_MARKS.slice(0, PHASE3_MARKS.indexOf(name) + 1).flatMap(mark => goto(mark))
/**
 * Play the phase3 session to each stop in order, checkpointing the stop's mark; `after` runs at the stop (keys and
 * checkpoints of the state there). Marks between two stops are passed without a checkpoint.
 */
const visit = (stops) => {
  const steps = []
  let at = -1
  for (const stop of stops) {
    const index = PHASE3_MARKS.indexOf(stop.name)
    if (index < 0) throw new Error(`the phase3 session has no mark ${stop.name}`)
    for (const name of PHASE3_MARKS.slice(at + 1, index)) steps.push(...goto(name))
    steps.push(...goto(stop.name), checkpoint(stop.name), ...(stop.after ?? []))
    at = index
  }
  return steps
}
/** The phase3 session played to its end, every prompt answered (the end is the open turn, live). */
const PHASE3_END = [...through('tool'), play(), checkpoint('end')]
/** The brief of the phase3 tour: what the whole session is for, and the checkpoints to judge each part at. */
const PHASE3_REVIEW = {
  reference: 'component-development-spec §7.1 and parts 3a to 3e, every session state in one conversation · the briefs select, search, levels, approvals, plan, compaction, and notificationPane',
  implemented: [
    'One session carries the states the Phase 3 parts draw: prompts and answers, the thinking ladder, tool lines and blocks, edits and writes, approval and plan cards, subagents, jobs, the goal, the notice lane, compaction, queued messages, the side question, search, interrupts, failed and open turns.',
    'Each state sits behind a mark; the tour checkpoints every mark in order, and each prompt is answered with its key after its own card is checkpointed.',
  ],
  focus: [
    { look: 'The image prompt, the CJK and emoji line, the code block, and the four thinking labels', how: 'checkpoints `image`, `cjk`, `code`, `pondering`, `fathoming`' },
    { look: 'The Markdown answer with a table, a list, and a fence', how: 'checkpoint `answer`' },
    { look: 'The exploration run: todos, search, web, and the pending command', how: 'checkpoints `pending`, `explored`' },
    { look: 'Edits, a multi-hunk edit, a write, an overwrite, and the failed edit', how: 'checkpoints `edited`, `written`, `overwritten`, `failed-edit`' },
    { look: 'Approval cards: allow once, three queued (1 of 3 waiting), one rejected', how: 'checkpoints `approval-card`, `queue-card-1`, `reject-card`' },
    { look: 'Plan review: the long plan, revised, accepted, then the question', how: 'checkpoints `plan-card`, `plan-revised`, `question-card`' },
    { look: 'A live subagent, a background job, and the goal in the status rows', how: 'checkpoints `live`, `watching`' },
    { look: 'Retry countdown, toast, notice lane, failed bash, compaction, queued messages, search, interrupt, and the open turn', how: 'checkpoints `rate-limited`, `toast`, `footer`, `compacting`, `manual-failed`, `queued-rows`, `needle`, `cut-off`, `prepare`, `tool`' },
  ],
  differs: [
    'The replay cannot fork on an answer, so the tour answers each prompt with the key its card names (1 allow, 2 keep planning, 3 reject).',
    'Notices are the notification pane, not stream rows: no walk stops on one.',
  ],
  pending: [],
}

const SCRIPTS = {
  phase3: PHASE3_END,
  // A command that runs, two at once, one that fails, and one cut off; the row names the phase while the stream holds the calls.
  pending: [
    play('running', TIMED), checkpoint('running'),
    play('parallel', TIMED), checkpoint('parallel'),
    play('failing', TIMED), checkpoint('failing'),
    play(), checkpoint('end'),
  ],
  thinkingLadder: [
    play('pondering', TIMED), checkpoint('pondering'),
    play('mulling', TIMED), checkpoint('mulling'),
    play('deep', TIMED), checkpoint('deep'),
    play('fathoming', TIMED), checkpoint('fathoming'),
  ],
  // Each phase of one turn, stopped part-way through it.
  phases: [
    play('diving', TIMED), checkpoint('diving'),
    play('thinking', TIMED), checkpoint('thinking'),
    play('tool', TIMED), checkpoint('tool'),
    play('writing', TIMED), checkpoint('writing'),
    play('preparing', TIMED), checkpoint('preparing'),
    play(), checkpoint('end'),
  ],
  // Calls in flight of every kind, then one long command alone.
  blocks: [
    play('kinds', TIMED), checkpoint('kinds'),
    play('command', TIMED), checkpoint('command'),
    play(), checkpoint('end'),
  ],
  // A write and an edit growing before the call is committed, then running, then settled.
  streaming: [
    play('write-early', TIMED), checkpoint('write-early'),
    play('write-half', TIMED), checkpoint('write-half'),
    play('write-late', TIMED), checkpoint('write-late'),
    play('write-running', TIMED), checkpoint('write-running'),
    play('edit-early', TIMED), checkpoint('edit-early'),
    play('edit-half', TIMED), checkpoint('edit-half'),
    play('edit-late', TIMED), checkpoint('edit-late'),
    play(), checkpoint('end'),
  ],
  // Two kinds in flight, one settled, then the model thinks.
  sync: [
    play('mixed', TIMED), checkpoint('mixed'),
    play('one', TIMED), checkpoint('one'),
    play('thinking', TIMED), checkpoint('thinking'),
    play(), checkpoint('end'),
  ],
  // The approval panel and the question panel, each answered with the keys.
  activityWait: [
    play(), checkpoint('approval'),
    key('down'), key('enter'),
    play(), checkpoint('question'),
    key('enter'),
    play(), checkpoint('end'),
  ],
  // A command that deletes files waits on you: the request and the card, the narrow card, and Allow once.
  approvals: [
    play(), wait(ARMED), checkpoint('asking'),
    resize(80, 28), checkpoint('narrow'),
    key('1'), play(), checkpoint('allowed'),
  ],
  // A rejection with a note: down to the field, type, Enter.
  approvalsRejected: [
    play(), wait(ARMED), checkpoint('asking'),
    key('down', { repeat: 3 }), type('use a branch instead'), checkpoint('note'),
    key('enter'), play(), checkpoint('rejected'),
  ],
  // An edit and a write, each allowed with its digit.
  approvalsEdit: [
    play(), wait(ARMED), checkpoint('edit'),
    key('1'), play(), wait(ARMED), checkpoint('write'),
    key('1'), play(), checkpoint('end'),
  ],
  // Three requests in a queue, each answered in turn.
  approvalsQueue: [
    play(), wait(ARMED), checkpoint('first'),
    key('1'), wait(ARMED), checkpoint('second'),
    key('1'), wait(ARMED), checkpoint('third'),
    key('1'), play(), checkpoint('end'),
  ],
  plan: [
    play(), wait(ARMED), checkpoint('review'),
    resize(80, 28), checkpoint('narrow'),
    key('1'), play(), checkpoint('approved'),
    key('ctrl+o'), checkpoint('opened'),
  ],
  // Keep planning with nothing written asks for the revision; then the revision is sent.
  planRevised: [
    play(), wait(ARMED), checkpoint('review'),
    key('2'), checkpoint('needs-note'),
    type('add a rollback step'), key('enter'), play(), checkpoint('revised'),
  ],
  planRejected: [
    play(), wait(ARMED), checkpoint('review'),
    key('3'), play(), checkpoint('rejected'),
  ],
  planLong: [
    play(), wait(ARMED), checkpoint('review'),
    key('pageup', { repeat: 3 }), checkpoint('scrolled'),
    key('1'), play(), checkpoint('approved'),
  ],
  // A compaction stopped while it summarizes, while it applies, and settled; Ctrl+O opens the summary.
  compaction: [
    play('summarizing', TIMED), checkpoint('summarizing'),
    play('applying', TIMED), checkpoint('applying'),
    play('settled', TIMED), checkpoint('settled'),
    key('ctrl+o'), checkpoint('open'),
    play(), checkpoint('end'),
  ],
  compactionNoWindow: [
    play('summarizing', TIMED), checkpoint('summarizing'),
    play('applying', TIMED), checkpoint('applying'),
    play('settled', TIMED), checkpoint('settled'),
    play(), checkpoint('end'),
  ],
  compactionFailed: [
    play('summarizing', TIMED), checkpoint('summarizing'),
    play('failed', TIMED), checkpoint('failed'),
    play(), checkpoint('end'),
  ],
  manualCompact: [
    play('summarizing', TIMED), checkpoint('summarizing'),
    play('settled', TIMED), checkpoint('settled'),
    play(), checkpoint('end'),
  ],
  // The context warning once the window is nearly full, and after the compaction relieved it.
  context: [
    play('full', TIMED), checkpoint('full'),
    play('relieved', TIMED), checkpoint('relieved'),
    play(), checkpoint('end'),
  ],
  // Each severity of the lane over a running turn, one at a time.
  notices: [
    play('info', TIMED), checkpoint('info'),
    play('success', TIMED), checkpoint('success'),
    play('warning', TIMED), checkpoint('warning'),
    play('error', TIMED), checkpoint('error'),
    play('progress', TIMED), checkpoint('progress'),
    play(), checkpoint('end'),
  ],
  retries: [
    play('overloaded', TIMED), checkpoint('overloaded'),
    play('timeout', TIMED), checkpoint('timeout'),
    play(), checkpoint('end'),
  ],
  // The rate-limit countdown, a toast over a turn, the context filling and relieved, then a stored conversation resumed.
  notificationPane: [
    play('rate-limited', TIMED), checkpoint('rate-limited'),
    play('toast', TIMED), checkpoint('toast'),
    play('context-full', TIMED), checkpoint('context-full'),
    play('relieved', TIMED), checkpoint('relieved'),
    play(), checkpoint('end'),
    type('/sessions'), key('enter'), key('enter'), key('down'), key('down'), checkpoint('sessions'), key('enter'), key('enter'), checkpoint('resumed'),
  ],
  // A settled turn folds behind its title; Ctrl+O opens its calls as lines; the interrupted turn leaves a call cancelled.
  toollines: [
    play(), checkpoint('standard'),
    key('ctrl+o'), checkpoint('open'),
    resize(72, 30), checkpoint('resized'),
  ],
  // The multi-hunk edit as it settles (removed, added and context rows, numbered per hunk), then Standard (single edit and write, a run), Ctrl+O (every body at 40 rows), then a narrow terminal.
  edits: [
    play('edited'), checkpoint('multi-hunk'),
    key('ctrl+o'), checkpoint('multi-hunk-open'), key('ctrl+o'),
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
  phases: [DEFAULT_SIZE, [60, 24], [40, 24]],
  blocks: [[120, 56], [60, 56]],
  streaming: [[120, 64], [60, 56]],
  sync: [[120, 40], [60, 30]],
  notificationPane: [[120, 40], [60, 30]],
  compaction: [[120, 40], [60, 30]],
  compactionFailed: [[120, 40], [60, 30]],
  compactionNoWindow: [[120, 40], [60, 30]],
  manualCompact: [[120, 40], [60, 30]],
  context: [[120, 40], [60, 30]],
  notices: [[120, 40], [60, 30]],
  approvals: [[120, 40], [60, 30]],
  approvalsRejected: [[120, 40], [60, 30]],
  approvalsEdit: [[120, 56], [60, 44]],
  approvalsQueue: [[120, 56], [60, 44]],
  plan: [[120, 40], [60, 30]],
  planRevised: [[120, 40], [60, 30]],
  planRejected: [[120, 40], [60, 30]],
  planLong: [[120, 40], [60, 30]],
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
  // The plan answered the other two ways (the replay's results follow the answer, so `plan` takes any of the three).
  planRevised: {
    summary: 'a plan you send back with a revision: Keep planning… asks for the text, and the call settles as sent back with your words',
    source: { replay: 'plan' },
    covers: COVERS.plan,
    sizes: SIZES.planRevised,
    script: SCRIPTS.planRevised,
    review: REVIEW.planRevised,
  },
  planRejected: {
    summary: 'a plan you reject: the call settles as rejected and the agent goes on',
    source: { replay: 'plan' },
    covers: COVERS.plan,
    sizes: SIZES.planRejected,
    script: SCRIPTS.planRejected,
    review: REVIEW.planRejected,
  },
  // The edit and the write waiting on you at the other levels: the request is open at every one.
  ...Object.fromEntries(['compact', 'verbose'].map(level => [`approvalsEdit-${level}`, {
    summary: `a file change waiting on you at the ${level[0].toUpperCase()}${level.slice(1)} level: the diff is open all the same`,
    source: { replay: 'approvalsEdit' },
    config: { mayfly: { transcriptView: level } },
    covers: COVERS.approvalsEdit,
    sizes: [[120, 56]],
    script: [play(), wait(ARMED), checkpoint('edit'), key('1'), play(), wait(ARMED), checkpoint('write'), key('1'), play(), checkpoint('end')],
  }])),
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
  // Compact hides the settled process of a running turn but keeps what is in flight.
  'pending-compact': {
    summary: 'the pending calls at the Compact level: a pending line each, no rows; the activity row is the same as at every level',
    source: { replay: 'pending' },
    config: { mayfly: { transcriptView: 'compact' } },
    covers: COVERS.pending,
    sizes: [DEFAULT_SIZE],
    script: [play('running', TIMED), checkpoint('running'), play(), checkpoint('end')],
  },
  'pending-verbose': {
    summary: 'the pending calls at the Verbose level',
    source: { replay: 'pending' },
    config: { mayfly: { transcriptView: 'verbose' } },
    covers: COVERS.pending,
    sizes: [DEFAULT_SIZE],
    script: [play('running', TIMED), checkpoint('running'), play('parallel', TIMED), checkpoint('parallel'), play(), checkpoint('end')],
  },
  // The calls in flight at the other work-details levels (the default, Standard, is `blocks`).
  ...Object.fromEntries(['compact', 'detailed', 'verbose'].map(level => [`blocks-${level}`, {
    summary: `the calls in flight at the ${level[0].toUpperCase()}${level.slice(1)} level`,
    source: { replay: 'blocks' },
    config: { mayfly: { transcriptView: level } },
    covers: COVERS.blocks,
    sizes: [[120, 56], [60, 56]],
    script: [play('kinds', TIMED), checkpoint('kinds'), play('command', TIMED), checkpoint('command'), ...(level === 'verbose' ? [key('ctrl+o'), checkpoint('open')] : []), play(), checkpoint('end')],
  }])),
  // The streaming code at the other levels, and with the turn open (the default, Standard, is `streaming`).
  'streaming-compact': {
    summary: 'the write and the edit being generated at the Compact level: a pending line each, no rows',
    source: { replay: 'streaming' },
    config: { mayfly: { transcriptView: 'compact' } },
    covers: COVERS.streaming,
    sizes: [[120, 40]],
    script: [play('write-half', TIMED), checkpoint('half'), play('edit-half', TIMED), checkpoint('edit'), play(), checkpoint('end')],
  },
  'streaming-verbose': {
    summary: 'the write and the edit being generated at the Verbose level: 12 rows, then the counter',
    source: { replay: 'streaming' },
    config: { mayfly: { transcriptView: 'verbose' } },
    covers: COVERS.streaming,
    sizes: [[120, 64]],
    script: [play('write-half', TIMED), checkpoint('half'), play('write-late', TIMED), checkpoint('late'), play('edit-late', TIMED), checkpoint('edit'), play(), checkpoint('end')],
  },
  'streaming-open': {
    summary: 'the write being generated with Ctrl+O open: the new rows are drawn live, up to 40',
    source: { replay: 'streaming' },
    covers: COVERS.streaming,
    sizes: [[120, 64]],
    script: [play('write-early', TIMED), key('ctrl+o'), play('write-half', TIMED), checkpoint('half'), play('write-late', TIMED), checkpoint('late'), play(), checkpoint('end')],
  },
  // The row cursor: Alt+Up from the prompt, walk, open a row, copy it, and come back with Esc.
  select: {
    summary: 'Alt+Up moves focus up into the stream; the cursor walks the rows, Enter opens one, c copies it, Esc returns to the prompt',
    source: { replay: 'toollines' },
    covers: COVERS.levels,
    sizes: [[120, 60], [60, 50]],
    review: REVIEW.select,
    script: [
      play(), checkpoint('end'),
      key('alt+up'), checkpoint('focused'),
      // An inner call of a run: the run stays as it is and only that call opens in place; Enter again folds it.
      key('up'), checkpoint('item'),
      key('enter'), checkpoint('item-open'),
      key('enter'), checkpoint('item-closed'),
      // The head of the run: Enter opens every call in place, Enter again folds them all.
      key('up'), checkpoint('head'),
      key('enter'), checkpoint('head-open'),
      key('enter'), checkpoint('head-closed'),
      // Copy: c is for a person (a command with its output), Ctrl+C the model's JSON.
      key('c'), checkpoint('copied'),
      key('ctrl+c'), checkpoint('copied-raw'),
      // The turn header opens the whole turn, and the cursor follows to it.
      key('up', { repeat: 3 }), checkpoint('header'),
      key('enter'), checkpoint('turn-open'),
      key('enter'), checkpoint('turn-closed'),
      key('ctrl+g'), checkpoint('editor'),
      key('esc'), checkpoint('back'),
      key('alt+up'), key('alt+down'), checkpoint('back-alt'),
    ],
  },
  // Focus entered after scrolling the history away: the view comes back to the newest rows, where the cursor starts.
  'select-away': {
    summary: 'scroll far up the history, then Alt+Up: the view returns to the tail with the cursor on the newest row, and the cursor walks up from there',
    source: { replay: 'history' },
    covers: COVERS.levels,
    sizes: [[100, 30]],
    script: [
      play(), wheel('up', { count: 30 }), checkpoint('away'),
      key('alt+up'), checkpoint('focused'),
      key('up', { repeat: 12 }), checkpoint('walk'),
      key('esc'), checkpoint('back'),
    ],
  },
  // An open run keeps its shape: calls that join it follow its state, one call folds alone, and the cursor stays where it is.
  'select-grow': {
    summary: 'open a run of web searches from its head, then a fourth search joins it: it arrives open; folding one call leaves the others open',
    source: { replay: 'toolgrow' },
    covers: COVERS.levels,
    sizes: [[100, 40], [60, 40]],
    script: [
      play('three'), checkpoint('three'),
      key('alt+up'), key('up', { repeat: 3 }), checkpoint('head'),
      key('enter'), checkpoint('head-open'),
      // A call completes while the run is open as a whole: it joins open, and the cursor stays on the head.
      play('four'), checkpoint('joined'),
      key('down'), key('enter'), checkpoint('call-folded'),
      // The run is no longer open as a whole: a call that joins later would come in folded; Enter on the head opens all again.
      key('up'), key('enter'), checkpoint('head-open-again'),
      key('enter'), checkpoint('head-closed'),
      play(), checkpoint('end'),
    ],
  },
  // `/` and `?` in conversation mode: type a pattern (highlight only), Enter selects, the arrows walk the matches, Esc ends.
  search: {
    summary: 'in conversation mode / and ? open the search line: typing highlights, Enter selects the first match, ↑/↓ and n/N walk the matches, Esc ends the search',
    source: { replay: 'toollines' },
    config: { mayfly: { transcriptView: 'compact' } },
    covers: COVERS.levels,
    sizes: [[100, 40], [60, 40]],
    review: REVIEW.search,
    script: [
      play(), checkpoint('end'),
      key('alt+up'), key('/'), checkpoint('opened'),
      type('lint'), checkpoint('typed'),
      key('backspace', { repeat: 4 }), type('(build|lint)$'), checkpoint('regex'),
      key('backspace', { repeat: 13 }), type('lint'),
      key('enter'), checkpoint('selected'),
      key('up'), checkpoint('prev'),
      key('down'), checkpoint('next'),
      key('n'), checkpoint('again'),
      key('c'), checkpoint('copied'),
      key('?'), type('lint'), key('enter'), checkpoint('backward'),
      key('esc'), checkpoint('ended'),
      key('esc'), checkpoint('prompt'),
    ],
  },
  // A hit in an old turn of a long session: the stream mounts only the newest turns, the search reaches the rest.
  'search-history': {
    summary: 'in a 150-turn session, a pattern that only the first turns hold is found and its turn mounted; Esc ends the search',
    source: { replay: 'history' },
    covers: COVERS.levels,
    sizes: [[100, 30]],
    script: [
      play(), checkpoint('end'),
      key('alt+up'), key('/'), type('number 7:'), checkpoint('typed'),
      key('enter'), checkpoint('found'),
      key('esc'), checkpoint('ended'),
    ],
  },
  // A call that completes while the search is open is found.
  'search-live': {
    summary: 'a web search arrives while the search is open: the count follows',
    source: { replay: 'toolgrow' },
    covers: COVERS.levels,
    sizes: [[100, 40]],
    script: [
      play('three'), key('alt+up'), key('/'), type('width'), checkpoint('three'),
      play('four'), checkpoint('four'),
      key('esc'), key('esc'),
      play(), checkpoint('end'),
    ],
  },
  // Every match is a stop: the matches of one block (a tall answer, an output) are walked one by one.
  'search-block': {
    summary: 'a term that repeats inside one tall answer and one command output: ↑/↓ stop on each match, the window follows it, the current match is drawn stronger',
    source: { replay: 'findings' },
    covers: COVERS.levels,
    sizes: [[100, 30], [60, 24]],
    script: [
      play(), checkpoint('end'),
      // The search line adds two rows to the editor: the stream re-fits before the first key lands (a settle, not a checkpoint).
      key('alt+up'), key('/'), wait(300), type('needle'), checkpoint('typed'),
      key('enter'), checkpoint('first'),
      // Walking back (↑) from the last match: the second prompt, then the four matches of the tall answer one by one.
      key('up', { repeat: 3 }), checkpoint('answer-last'),
      key('up'), checkpoint('answer-third'),
      key('up'), checkpoint('answer-second'),
      key('up'), checkpoint('answer-first'),
      key('down', { repeat: 2 }), checkpoint('forward'),
      key('esc'), key('esc'),
    ],
  },
  'search-narrow': {
    summary: 'the search line at 40 columns',
    source: { replay: 'toollines' },
    covers: COVERS.levels,
    sizes: [[40, 30]],
    script: [
      play(), key('alt+up'), key('/'), type('pnpm run lint'), checkpoint('typed'),
      key('enter'), checkpoint('selected'),
      key('esc'), key('esc'),
    ],
  },
  // The same at the Compact level: a turn is one `▸ N tool calls` line, and Enter on it opens the turn.
  'select-compact': {
    summary: 'at Compact the cursor walks title lines; Enter on one opens its turn at Verbose and Enter again folds it',
    source: { replay: 'toollines' },
    config: { mayfly: { transcriptView: 'compact' } },
    covers: COVERS.levels,
    sizes: [[120, 50]],
    script: [
      play(), checkpoint('end'),
      key('alt+up'), checkpoint('walk'),
      key('enter'), checkpoint('opened'),
      key('enter'), checkpoint('closed'),
    ],
  },
  // The reader's openings over each level: the same turns at the four levels, Ctrl+O to open the newest three and again to close.
  ...Object.fromEntries(['standard', 'compact', 'detailed', 'verbose'].map(level => [level === 'standard' ? 'levels' : `levels-${level}`, {
    summary: `the newest turns at the ${level[0].toUpperCase()}${level.slice(1)} level, then opened and closed with Ctrl+O`,
    source: { replay: 'toollines' },
    config: { mayfly: { transcriptView: level } },
    covers: COVERS.levels,
    sizes: level === 'standard' ? [[120, 80], [60, 64], [40, 64]] : [[120, 80]],
    script: [play(), checkpoint('end'), key('ctrl+o'), checkpoint('open'), key('ctrl+o'), checkpoint('closed')],
    ...(level === 'standard' ? { review: REVIEW.levels } : {}),
  }])),
  // At Compact a turn's calls are one line that counts up and stays; Ctrl+O opens the turn.
  fold: {
    summary: 'the Compact level: a turn\'s calls are one `▸ N tool calls` line where the first call was; Ctrl+O opens them',
    source: { replay: 'toollines' },
    config: { mayfly: { transcriptView: 'compact' } },
    covers: COVERS.toollines,
    sizes: [[120, 60]],
    script: [play(), checkpoint('folded'), key('ctrl+o'), checkpoint('open')],
  },
  // The quiet-hints setting (the default, full, is `phases`): the line under the header stays blank.
  'phases-off': {
    summary: 'the activity row with quiet hints off: no teaching tip under the header',
    source: { replay: 'phases' },
    config: { mayfly: { quietHints: 'off' } },
    covers: COVERS.phases,
    sizes: [DEFAULT_SIZE],
    script: [play('diving', TIMED), checkpoint('diving'), play('writing', TIMED), checkpoint('writing')],
  },
  // The file changes at the other work-details levels (the default, Standard, is `edits`).
  ...Object.fromEntries(['compact', 'detailed', 'verbose'].map(level => [`edits-${level}`, {
    summary: `the file changes at the ${level[0].toUpperCase()}${level.slice(1)} level`,
    source: { replay: 'edits' },
    config: { mayfly: { transcriptView: level } },
    covers: COVERS.edits,
    sizes: [[120, 90], [60, 70]],
    script: level === 'detailed' ? [play('run'), checkpoint('live'), play(), checkpoint('end')] : [play(), checkpoint('end')],
  }])),
  // The compaction at the other work-details levels (the default, Standard, is `compaction`).
  ...Object.fromEntries(['compact', 'verbose'].map(level => [`compaction-${level}`, {
    summary: `a compaction at the ${level[0].toUpperCase()}${level.slice(1)} level`,
    source: { replay: 'compaction' },
    config: { mayfly: { transcriptView: level } },
    covers: COVERS.compaction,
    sizes: [[120, 40], [60, 30]],
    script: [play('summarizing', TIMED), checkpoint('summarizing'), play('applying', TIMED), checkpoint('applying'), play('settled', TIMED), checkpoint('settled'), play(), checkpoint('end')],
  }])),
  // The chip back to the bottom shares the notification row: centered, with the notice to its right.
  'notification-chip': {
    summary: 'scrolled away from the tail while a notice shows: the chip back to the bottom is centered on the notification row and the notice takes the room to its right',
    source: { replay: 'notificationPane' },
    covers: COVERS.notificationPane,
    sizes: [[100, 22], [60, 22]],
    script: [
      play('context-full', TIMED), key('pageup'), checkpoint('away'),
      key('ctrl+down'), checkpoint('tail'),
      key('pageup'), play('relieved', TIMED), checkpoint('new'),
    ],
  },
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
  // The Phase 3 session (replays.mjs `phase3`): every mark in order, each prompt answered, the end is the open turn.
  'phase3-tour': {
    summary: 'the Phase 3 session played to each of its marks in order: every state once, prompts answered and their cards checkpointed on the way',
    source: { replay: 'phase3' },
    covers: PHASE3_COVERS,
    sizes: [DEFAULT_SIZE],
    review: PHASE3_REVIEW,
    script: [...visit(PHASE3_MARKS.map(name => ({ name }))), play(), checkpoint('end')],
  },
  // The four work-details levels of the same session, one scenario each (the level is config; no key switches it).
  ...Object.fromEntries(['standard', 'compact', 'detailed', 'verbose'].map(level => [level === 'standard' ? 'phase3-levels' : `phase3-levels-${level}`, {
    summary: `the Phase 3 session at the ${level} work-details level${level === 'standard' ? ', then Ctrl+O opens the newest turns and closes them again' : ''}`,
    source: { replay: 'phase3' },
    config: { mayfly: { transcriptView: level } },
    covers: PHASE3_COVERS,
    sizes: [DEFAULT_SIZE],
    script: level === 'standard' ? [...PHASE3_END, key('ctrl+o'), checkpoint('open'), key('ctrl+o'), checkpoint('closed')] : PHASE3_END,
  }])),
  // Alt+Up on four kinds of row: a tool line, an edit card, an approval row, and a compaction row, with the arrows walking up.
  'phase3-select': {
    summary: 'Alt+Up in the Phase 3 session: the cursor on a tool line, an edit card, an approval row, and a compaction row, the arrows walking up from each',
    source: { replay: 'phase3' },
    covers: PHASE3_COVERS,
    sizes: [[120, 50]],
    script: visit([
      { name: 'pending', after: [key('alt+up'), checkpoint('tool-line'), key('alt+down')] },
      { name: 'edited', after: [key('alt+up'), checkpoint('edit-card'), key('up'), checkpoint('edit-walk'), key('alt+down')] },
      { name: 'approved', after: [key('alt+up'), checkpoint('approval-row'), key('up', { repeat: 2 }), checkpoint('approval-walk'), key('alt+down')] },
      { name: 'manual-settled', after: [key('alt+up'), checkpoint('compaction-row'), key('up'), checkpoint('compaction-walk'), key('esc')] },
    ]),
  },
  // / and ? over a compaction summary, then over a command output, an answer, and an edit hunk, with n, N, and Esc.
  'phase3-search': {
    summary: 'search in the Phase 3 session: ? over a compaction summary, then ? and / over a command output, an answer, and an edit hunk, with n and N and Esc',
    source: { replay: 'phase3' },
    covers: PHASE3_COVERS,
    sizes: [[100, 40]],
    script: visit([
      { name: 'manual-settled', after: [key('alt+up'), key('?'), type('once more'), key('enter'), checkpoint('compaction-text'), key('esc'), checkpoint('ended'), key('esc')] },
      { name: 'searched', after: [key('alt+up'), key('?'), type('needle'), key('enter'), checkpoint('selected'), key('n'), checkpoint('next'), key('N'), checkpoint('prev'), key('/'), type('needle'), key('enter'), checkpoint('forward'), key('esc'), checkpoint('ended-again'), key('esc')] },
    ]),
  },
  // The open turn streams: waiting, reasoning, a write being prepared, its decision card, and the write running. The replay
  // writes events and no Agent runs, so Esc interrupts nothing here; a live Esc needs a real turn (the live profile).
  'phase3-live': {
    summary: 'the live stream of the open turn: waiting, reasoning, a write being prepared, its decision card, and the write running (Esc interrupts nothing: no Agent runs the replayed turn)',
    source: { replay: 'phase3' },
    covers: PHASE3_COVERS,
    sizes: [DEFAULT_SIZE],
    script: visit([
      { name: 'wait' },
      { name: 'reasoning' },
      { name: 'prepare' },
      { name: 'tool' },
    ]),
  },
  // The same session at the two narrow sizes: a table answer, an edit, a decision card, and a plan.
  'phase3-narrow': {
    summary: 'the Phase 3 session at 60 and 40 columns: a Markdown answer with a table, an edit, a decision card, and a plan review',
    source: { replay: 'phase3' },
    covers: PHASE3_COVERS,
    sizes: [[60, 30], [40, 24]],
    script: visit([{ name: 'answer' }, { name: 'edited' }, { name: 'approved' }, { name: 'plan' }]),
  },
  // Lifecycle: after the first turn, /sessions lists the stored conversation, and opening it shows the resumed notice.
  'phase3-resume': {
    summary: 'the Phase 3 session after its first turn, then /sessions and the stored conversation opened: the resumed notice',
    source: { replay: 'phase3' },
    covers: [...PHASE3_COVERS, `${INTERACTION}native-sessions.ts`],
    sizes: [DEFAULT_SIZE],
    script: visit([{ name: 'image', after: [type('/sessions'), key('enter'), key('enter'), key('down'), key('down'), checkpoint('sessions'), key('enter'), key('enter'), checkpoint('resumed')] }]),
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
