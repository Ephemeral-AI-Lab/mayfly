#!/usr/bin/env node
/**
 * Open the real product on a named state, without a model, tools, or quota: a conversation written as a timeline is
 * played into the live session by the replay driver (see `script/workbench/replays.mjs`); `.artifacts/replay/driver.log`
 * records what it did.
 *
 *   pnpm run scenario <name> [--width N] [--height N] [--no-color] [--ascii] [--speed N]
 *   pnpm run scenario --list
 *
 * Replay, idle, and gallery scenarios run a live `dsh`. Fixture scenarios (scripted session events over fake services)
 * only paint frames: use `pnpm run frame <name>`. @module script/scenario
 */

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assertDshVersion, resolveDshBin, root } from './smoke-lib.mjs'
import { FIXTURE_SCENARIOS, LIVE_SCENARIOS, resolveScenario } from './workbench/live-scenarios.mjs'
import { prepareReplay } from './workbench/replay-run.mjs'
import { ensureThrowawayProfile } from './workbench/profile.mjs'
import { presentationEnv, superviseDsh } from './workbench/supervisor.mjs'

/**
 * Parse the command line.
 * @param argv - arguments after the script name.
 * @returns the options, or an error message.
 */
export function parseScenarioArgs(argv) {
  const options = { noColor: false, ascii: false, list: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') continue
    if (value === '--list') options.list = true
    else if (value === '--width') options.cols = Number(argv[++index])
    else if (value === '--height') options.rows = Number(argv[++index])
    else if (value === '--no-color') options.noColor = true
    else if (value === '--ascii') options.ascii = true
    else if (value === '--speed') options.speed = Number(argv[++index])
    else if (value.startsWith('--')) return { error: `unknown option ${value}` }
    else if (options.name === undefined) options.name = value
    else return { error: `unexpected argument ${value}` }
  }
  if (options.speed !== undefined && !(options.speed > 0)) return { error: '--speed needs a positive number' }
  for (const key of ['cols', 'rows']) if (options[key] !== undefined && !(Number.isInteger(options[key]) && options[key] > 0)) return { error: `--${key === 'cols' ? 'width' : 'height'} needs a positive integer` }
  if (!options.list && options.name === undefined) return { error: 'usage: pnpm run scenario <name> [--width N] [--height N] [--no-color] [--ascii] [--speed N] | --list' }
  return { options }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseScenarioArgs(process.argv.slice(2))
  if (parsed.error !== undefined) { console.error(parsed.error); process.exit(2) }
  const { options } = parsed
  if (options.list) {
    console.log('live (pnpm run scenario <name>):')
    for (const [name, scenario] of Object.entries(LIVE_SCENARIOS)) console.log(`  ${name.padEnd(24)}${scenario.summary}`)
    console.log('frame only (pnpm run frame <name>):')
    for (const name of FIXTURE_SCENARIOS) console.log(`  ${name}`)
    process.exit(0)
  }
  const scenario = resolveScenario(options.name)
  if (scenario.kind === 'unknown') { console.error(`unknown scenario "${scenario.name}"; try pnpm run scenario --list`); process.exit(2) }
  if (scenario.kind === 'fixture') { console.error(`"${scenario.name}" is a fixture scenario: it paints a frame only. Run: pnpm run frame ${scenario.name}`); process.exit(2) }

  const dshBin = resolveDshBin()
  assertDshVersion(dshBin)
  const profile = ensureThrowawayProfile({ repo: root, gallery: scenario.gallery === true, dshBin, artifacts: join(root, '.artifacts/bench') })
  const replay = await prepareReplay({ name: scenario.replay, artifacts: join(root, '.artifacts'), speed: options.speed })
  const session = superviseDsh({
    dshBin,
    profile: 'bench',
    cwd: replay.cwd,
    env: { ...profile.env, ...replay.env, ...presentationEnv(options) },
    patch: replay.patch,
    cols: options.cols,
    rows: options.rows,
  })
  const code = await session.done
  await replay.close()
  process.exit(code)
}
