/**
 * The workbench scenario registry: every named product state a review round can open or paint. A fixture scenario
 * runs scripted session events over the real Mayfly tree of `../app-shots/boot.ts`; a component draft adds its states
 * here (one entry per state) so `pnpm run frame <name>` and `pnpm run scenario <name>` find them.
 *
 * @module @ephemeral-ai/mayfly/tests/workbench/scenarios
 */

import { vi } from 'vitest'
import { APP_SCENE_RUNNERS, sceneAgentsAdvanceClock } from '../app-shots/scenes.ts'
import type { AppShotTree } from '../app-shots/boot.ts'
import { VtTerminal } from '../vt-terminal.ts'

export interface FixtureScenario {
  readonly kind: 'fixture'
  /** Terminal size when the run names none. */
  readonly cols: number
  readonly rows: number
  /** Script the state over the booted tree. */
  run(tree: AppShotTree): Promise<void>
  /** Let time-dependent labels reach their scripted values before the frame is read. */
  settle?(tree: AppShotTree, terminal: VtTerminal): Promise<void>
}

export type WorkbenchScenario = FixtureScenario

const fromShot = (id: string, settle?: FixtureScenario['settle']): FixtureScenario => ({
  kind: 'fixture',
  cols: 80,
  rows: 24,
  run: APP_SCENE_RUNNERS[id]!,
  ...(settle === undefined ? {} : { settle }),
})

/** The agents pane arms a waiting-hold window on first render; step the pinned clock past it. */
async function settleAgents(_tree: AppShotTree, terminal: VtTerminal): Promise<void> {
  sceneAgentsAdvanceClock()
  await vi.waitFor(async () => {
    if (!(await terminal.frame()).includes('waiting')) throw new Error('the agents pane has not reached waiting')
  }, { timeout: 5_000, interval: 50 })
}

export const WORKBENCH_SCENARIOS: Readonly<Record<string, WorkbenchScenario>> = {
  'app-conversation': fromShot('app-conversation'),
  'app-trace': fromShot('app-trace'),
  'app-agents': fromShot('app-agents', settleAgents),
  'app-permission': fromShot('app-permission'),
  'app-sessions': fromShot('app-sessions'),
  'app-session-workspace': fromShot('app-session-workspace'),
}
