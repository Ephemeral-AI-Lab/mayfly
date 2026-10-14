#!/usr/bin/env node
/**
 * Open the real product on a catalog scenario (`script/scenarios/catalog.mjs`) for a person to watch and use, without
 * a model, tools, or quota: its replay plays into the live session on its timeline, and
 * `.artifacts/replay/driver.log` records what the driver did.
 *
 *   pnpm run scenario <name> [--width N] [--height N] [--no-color] [--ascii] [--speed N]
 *   pnpm run scenario --list
 *
 * A scenario's brief (its `review` field) prints before the product opens, and `--list` marks the briefed ones.
 *
 * Like the runner, it gives the session a home, a session store, and storages of its own. @module script/scenario
 */

import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { assertDshVersion, resolveDshBin, root } from './smoke-lib.mjs'
import { briefText, listLine } from './scenarios/brief.mjs'
import { CATALOG, scenarioNamed } from './scenarios/catalog.mjs'
import { prepareSession } from './scenarios/session.mjs'
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
    for (const [name, scenario] of Object.entries(CATALOG)) console.log(listLine(name, scenario))
    console.log('\n* carries a brief (pnpm run scenario <name> prints it before the product opens)')
    process.exit(0)
  }
  const scenario = scenarioNamed(options.name)
  if (scenario === undefined) { console.error(`unknown scenario "${options.name}"; try pnpm run scenario --list`); process.exit(2) }

  const brief = briefText(scenario.name, scenario)
  if (brief !== '') console.log(brief)
  const dshBin = resolveDshBin()
  assertDshVersion(dshBin)
  const profile = ensureThrowawayProfile({ repo: root, gallery: scenario.source.gallery === true, dshBin, artifacts: join(root, '.artifacts/bench') })
  const replay = await prepareSession({ scenario, dir: join(root, '.artifacts/replay'), speed: options.speed, isolate: true })
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
