/**
 * The scenario catalog: every named state of the live product that review, frames, goldens, and perf read. A scenario
 * names its source (a replay of `replays.mjs`, an empty session, or the UI gallery), the sources it `covers` (the
 * change-based selection reads them), its sizes, and the script the runner plays: `play` to a mark or the end, keys,
 * mouse, resizes, and named checkpoints (see `steps.mjs`). `pnpm run scenario --list` prints it.
 * @module script/scenarios/catalog
 */

import { REPLAYS } from './replays.mjs'
import { checkpoint, play } from './steps.mjs'

/** The size a scenario runs at unless it names its own. */
export const DEFAULT_SIZE = Object.freeze([120, 40])

const TRANSCRIPT = 'packages/mayfly/src/transcript/'
const INTERACTION = 'packages/mayfly/src/interaction/'

/** What each replay shows, as the sources whose change it can reveal. */
const COVERS = {
  tour: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}process-*.ts`, `${TRANSCRIPT}thinking.ts`, `${TRANSCRIPT}pane-todo.ts`],
  toolkit: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}read-group.ts`, `${TRANSCRIPT}search-group.ts`, `${TRANSCRIPT}present.ts`],
  thinking: [`${TRANSCRIPT}thinking.ts`],
  markdown: [`${TRANSCRIPT}components.ts`, 'packages/mayfly/src/core/components.ts'],
  phases: [`${TRANSCRIPT}pane-activity.ts`, `${TRANSCRIPT}spinners.ts`, `${TRANSCRIPT}output-rate.ts`],
  prompts: [`${TRANSCRIPT}transcript-model.ts`, `${INTERACTION}attachments.ts`],
  errors: [`${TRANSCRIPT}tool-*.ts`, `${TRANSCRIPT}transcript-model.ts`],
  compaction: [`${TRANSCRIPT}compaction.ts`],
  manualCompact: [`${TRANSCRIPT}compaction.ts`, `${TRANSCRIPT}command-group.ts`],
  context: [`${TRANSCRIPT}status-context.ts`, `${TRANSCRIPT}compaction.ts`],
  subagents: [`${TRANSCRIPT}pane-agents.ts`, `${TRANSCRIPT}child-agent-model.ts`],
  childStream: [`${TRANSCRIPT}pane-agents.ts`, `${INTERACTION}agents-command.ts`],
  approvals: [`${INTERACTION}approval-plugin.ts`, `${INTERACTION}permission-panel.ts`],
  questions: [`${INTERACTION}questions-plugin.ts`, `${INTERACTION}questionnaire.ts`],
  plan: [`${INTERACTION}plan-review-panel.ts`, `${INTERACTION}plan-document.ts`],
  goal: [`${TRANSCRIPT}status-goal.ts`],
  jobs: [`${TRANSCRIPT}status-jobs.ts`, `${INTERACTION}jobs.ts`],
  queued: [`${INTERACTION}pane-queue.ts`],
  retries: [`${TRANSCRIPT}transcript-model.ts`, `${INTERACTION}trace-*.ts`],
  sideQuestion: [`${INTERACTION}btw-command.ts`, `${INTERACTION}conversation-view-status.ts`],
  notices: [`${INTERACTION}notifications.ts`],
  modes: [`${INTERACTION}mode-status.ts`, `${TRANSCRIPT}status-model.ts`],
  edge: [`${TRANSCRIPT}tool-line.ts`, 'packages/mayfly/src/core/width.ts'],
  history: [`${TRANSCRIPT}conversation-feed.ts`, `${TRANSCRIPT}transcript-model.ts`],
}

/**
 * Scripts that differ from playing to the end. A settled job wakes the agent for a real turn on the stub, which runs
 * at real time, so the jobs replay is captured while all three jobs run.
 */
const SCRIPTS = {
  jobs: [play('running'), checkpoint('running')],
}

/** A replay played to its end (or to the prompt that waits for an answer), captured there. */
const replayScenario = (name, replay) => ({
  summary: replay.summary,
  source: { replay: name },
  covers: COVERS[name] ?? [],
  sizes: [DEFAULT_SIZE],
  script: SCRIPTS[name] ?? [play(), checkpoint('end')],
})

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
  ...Object.fromEntries(Object.entries(REPLAYS).map(([name, replay]) => [name, replayScenario(name, replay)])),
})

/**
 * Look a scenario up.
 * @param {string} name
 * @returns the scenario with its name, or undefined.
 */
export function scenarioNamed(name) {
  return Object.hasOwn(CATALOG, name) ? { name, ...CATALOG[name] } : undefined
}
