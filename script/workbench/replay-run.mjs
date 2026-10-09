/**
 * Prepare a replay run: compile the replay, write the overlay that loads the replay driver into `dsh`, and start the
 * stub model endpoint. @module script/workbench/replay-run
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { REPLAYS } from './replays.mjs'
import { startStubModel } from './stub-model.mjs'
import { compile } from './timeline.mjs'

const DRIVER = fileURLToPath(new URL('./replay-driver.mjs', import.meta.url))

/**
 * Start a replay.
 * @param options - `name` (a key of REPLAYS, or undefined to open an empty session), `artifacts` (the `.artifacts`
 *   directory), `speed` (playback multiplier, default 1).
 * @returns `{ cwd, env, patch, close }`: the working directory, the environment (stub model endpoint and the replay for
 *   the driver), the overlay file for `dsh --patch`, and a stopper.
 */
export async function prepareReplay({ name, artifacts, speed = 1 }) {
  const replay = name === undefined ? undefined : REPLAYS[name]
  if (name !== undefined && replay === undefined) throw new Error(`unknown replay "${name}"`)
  const dir = join(artifacts, 'replay')
  const cwd = join(dir, 'workspace')
  rmSync(cwd, { recursive: true, force: true })
  mkdirSync(cwd, { recursive: true })
  const patch = join(dir, 'overlay.yml')
  writeFileSync(patch, `- insert:\n    - id: mayfly-replay-driver\n      name: ${pathToFileURL(DRIVER).href}\n`)
  const file = join(dir, 'replay.json')
  writeFileSync(file, JSON.stringify(replay === undefined ? [] : compile(replay.items, replay.options), null, 1))
  const log = join(dir, 'driver.log')
  rmSync(log, { force: true })
  const stub = await startStubModel()
  return {
    cwd,
    patch,
    env: { DEEPSEEK_BASE_URL: `${stub.baseURL}/v1`, DEEPSEEK_API_KEY: 'replay-key', MAYFLY_REPLAY_FILE: file, MAYFLY_REPLAY_SPEED: String(speed), MAYFLY_REPLAY_LOG: log },
    close: () => stub.close(),
  }
}
