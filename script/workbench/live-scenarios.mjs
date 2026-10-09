/**
 * The workbench scenarios that open the real product (against the mock LLM). Fixture scenarios, scripted over fake
 * services, are listed by `pnpm run scenario --list` too but only paint frames. @module script/workbench/live-scenarios
 */

import { APP_SCENARIOS } from '../shots/app-manifest.mjs'
import { REPLAYS } from './replays.mjs'

/**
 * Live scenarios. `idle` and `gallery` answer nothing; each replay of `replays.mjs` is a scenario named after it and
 * sends its task as the first prompt.
 */
export const LIVE_SCENARIOS = {
  idle: { summary: 'the product on an empty session' },
  gallery: { summary: 'the UI gallery: a side pane, a view in status row 2, and a bottom prompt pane', gallery: true },
  ...Object.fromEntries(Object.entries(REPLAYS).map(([name, replay]) => [name, { summary: `replay: ${replay.summary}`, replay: name }])),
}

/** Fixture scenario ids, painted by `pnpm run frame`. */
export const FIXTURE_SCENARIOS = APP_SCENARIOS.map(scenario => scenario.id)

/**
 * Resolve a scenario name.
 * @param name - the name given on the command line.
 * @returns `{ kind: 'live', ... }`, `{ kind: 'fixture' }`, or `{ kind: 'unknown' }`.
 */
export function resolveScenario(name) {
  if (Object.hasOwn(LIVE_SCENARIOS, name)) return { kind: 'live', name, ...LIVE_SCENARIOS[name] }
  if (FIXTURE_SCENARIOS.includes(name)) return { kind: 'fixture', name }
  return { kind: 'unknown', name }
}
