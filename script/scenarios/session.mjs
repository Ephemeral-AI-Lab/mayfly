/**
 * Prepare a scenario session: a throwaway workspace outside any checkout (so the header and status row name no git
 * branch, and the path differs only in a fixed-width tag the goldens mask), the `--patch` overlay that loads the replay
 * driver and an optional presentation row of the `mayfly` settings, the compiled replay, and the stub model endpoint.
 * @module script/scenarios/session
 */

import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { REPLAYS } from './replays.mjs'
import { startStubModel } from './stub-model.mjs'
import { compile } from './timeline.mjs'

const DRIVER = fileURLToPath(new URL('./driver.mjs', import.meta.url))

/** A workspace path of fixed width: `/tmp/mayfly-scenario-` and eight hex digits. */
export const WORKSPACE = /\/tmp\/mayfly-scenario-[0-9a-f]{8}/gu

/**
 * Start a session.
 * @param {object} options
 * @param {{ source: { replay?: string, idle?: boolean, gallery?: boolean } }} options.scenario - a catalog scenario.
 * @param {string} options.dir - where the overlay, the compiled replay, and the driver log go (created fresh).
 * @param {number} [options.speed] - timed playback speed when no runner controls the driver.
 * @param {string} [options.control] - the runner's control socket.
 * @param {Record<string, unknown>} [options.presentation] - `mayfly` settings the overlay pins (reduced motion, …).
 * @param {readonly string[]} [options.disabled] - composition rows the overlay disables.
 * @returns {Promise<{ cwd: string, patch: string, log: string, env: Record<string, string>, stub: { inFlight(): number }, close(): Promise<void> }>}
 */
export async function prepareSession({ scenario, dir, speed = 1, control, presentation, disabled = [] }) {
  const replay = scenario.source.replay === undefined ? undefined : REPLAYS[scenario.source.replay]
  if (scenario.source.replay !== undefined && replay === undefined) throw new Error(`unknown replay "${scenario.source.replay}"`)
  const cwd = `/tmp/mayfly-scenario-${randomBytes(4).toString('hex')}`
  mkdirSync(cwd, { recursive: true })
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const patch = join(dir, 'overlay.yml')
  const rows = [`- insert:\n    - id: mayfly-replay-driver\n      name: ${pathToFileURL(DRIVER).href}\n`]
  if (presentation !== undefined) rows.push(`- id: mayfly\n  config:\n${Object.entries(presentation).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}\n`).join('')}`)
  for (const id of disabled) rows.push(`- id: ${id}\n  disabled: true\n`)
  writeFileSync(patch, rows.join(''))
  const file = join(dir, 'replay.json')
  writeFileSync(file, JSON.stringify(replay === undefined ? [] : compile(replay.items, replay.options), null, 1))
  const log = join(dir, 'driver.log')
  const stub = await startStubModel()
  return {
    cwd,
    patch,
    log,
    stub,
    env: {
      DEEPSEEK_BASE_URL: `${stub.baseURL}/v1`, DEEPSEEK_API_KEY: 'replay-key',
      MAYFLY_REPLAY_FILE: file, MAYFLY_REPLAY_SPEED: String(speed), MAYFLY_REPLAY_LOG: log,
      ...(control === undefined ? {} : { MAYFLY_REPLAY_CONTROL: control }),
    },
    close: async () => {
      await stub.close()
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}
