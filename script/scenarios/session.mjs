/**
 * Prepare a scenario session: a throwaway workspace outside any checkout (so the header and status row name no git
 * branch, and the path differs only in a fixed-width tag the goldens mask), the `--patch` overlay that loads the replay
 * driver and the configuration it pins on composition rows, the compiled replay, and the stub model endpoint.
 * An isolated session also has a home of its own (the workspace is `~/workspace`, and nothing reads or writes the real
 * home) and its own session store and storages, so a `/sessions` listing holds only what the replay seeds.
 * @module script/scenarios/session
 */

import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { prepareMarket } from './market.mjs'
import { clipboardImage, externalEditor, workspaceFiles } from './fixtures.mjs'
import { timelineNamed } from './replays.mjs'
import { startStubModel } from './stub-model.mjs'
import { compile } from './timeline.mjs'

const DRIVER = fileURLToPath(new URL('./driver.mjs', import.meta.url))
const FAKE_ACCOUNT = fileURLToPath(new URL('./fake-account.mjs', import.meta.url))
const EXTENSIONS = fileURLToPath(new URL('./extensions.mjs', import.meta.url))

/** A workspace path of fixed width: `/tmp/mayfly-scenario-` and eight hex digits. */
export const WORKSPACE = /\/tmp\/mayfly-scenario-[0-9a-f]{8}/gu

/**
 * Make `cwd` a git repository on `branch` with one committed file and an uncommitted change of `added` and `deleted` lines,
 * so the status row shows a branch with its changes. The commit is dated, so a run's repository does not depend on the clock.
 * @param {string} cwd - the directory to initialise.
 * @param {{ branch: string, added: number, deleted: number }} change - the branch and the size of the change.
 */
function initRepository(cwd, { branch, added, deleted }) {
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Replay', '-c', 'user.email=replay@example.com', ...args], { cwd, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' } })
  const lines = prefix => Array.from({ length: Math.max(added, deleted) + 2 }, (_, index) => `${prefix} ${String(index)}`)
  git('init', '-q', '-b', branch)
  writeFileSync(join(cwd, 'hero.css'), `${lines('rule').join('\n')}\n`)
  git('add', '.')
  git('commit', '-q', '-m', 'Add the hero styles')
  const kept = lines('rule').slice(deleted)
  writeFileSync(join(cwd, 'hero.css'), `${[...kept, ...Array.from({ length: added }, (_, index) => `new ${String(index)}`)].join('\n')}\n`)
}

/**
 * Start a session.
 * @param {object} options
 * @param {{ source: { replay?: string, idle?: boolean, gallery?: boolean, sessionless?: boolean }, workspace?: Record<string, string>, extensions?: boolean, clipboard?: { image: number, delayMs?: number }, editor?: { append: string } }} options.scenario - a catalog scenario;
 *   `workspace` seeds files, `extensions` loads the editor extensions of `extensions.mjs`, `clipboard.image` puts a PNG of that many KB on the clipboard, `editor.append` is an external editor.
 * @param {string} options.dir - where the overlay, the compiled replay, and the driver log go (created fresh).
 * @param {number} [options.speed] - timed playback speed when no runner controls the driver.
 * @param {string} [options.control] - the runner's control socket.
 * @param {Record<string, Record<string, unknown>>} [options.config] - settings the overlay pins, by composition row id
 *   (the `mayfly` presentation, the banner's version, …).
 * @param {readonly string[]} [options.disabled] - composition rows the overlay disables (a scenario adds its own `disabled`).
 * @param {boolean} [options.isolate] - give the session a home, a session store, and storages of its own.
 * @param {string} [options.dshHome] - the `bench` profile's home, which a scenario with a `market` seeds (`market.mjs`).
 * @returns {Promise<{ cwd: string, patch: string, log: string, env: Record<string, string>, stub: { inFlight(): number }, close(): Promise<void> }>}
 */
export async function prepareSession({ scenario, dir, speed = 1, control, config = {}, disabled = [], isolate = false, dshHome }) {
  const replay = scenario.source.replay === undefined ? undefined : timelineNamed(scenario.source.replay)
  if (scenario.source.replay !== undefined && replay === undefined) throw new Error(`unknown replay "${scenario.source.replay}"`)
  const tmp = `/tmp/mayfly-scenario-${randomBytes(4).toString('hex')}`
  // The bench profile's credential file is shared by every run: a `firstRun` scenario that saves a key must not leave it for the next.
  if (scenario.firstRun === true && dshHome !== undefined) rmSync(join(dshHome, '.credentials.yaml'), { force: true })
  const base = isolate ? join(tmp, 'workspace') : tmp
  const cwd = replay?.workspace?.path === undefined ? base : join(base, replay.workspace.path)
  mkdirSync(cwd, { recursive: true })
  if (replay?.workspace?.git !== undefined) initRepository(cwd, replay.workspace.git)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const patch = join(dir, 'overlay.yml')
  const rows = [`- insert:\n    - id: mayfly-replay-driver\n      name: ${pathToFileURL(DRIVER).href}\n`]
  // An `account` scenario swaps the Platform account service for one that answers from memory (fake-account.mjs).
  if (scenario.account?.signed !== undefined) rows.push(`- insert:\n    - id: mayfly-scenario-account\n      name: ${pathToFileURL(FAKE_ACCOUNT).href}\n`, '- id: deepseek-account\n  disabled: true\n')
  if (scenario.extensions === true) rows.push(`- insert:\n    - id: mayfly-scenario-extensions\n      name: ${pathToFileURL(EXTENSIONS).href}\n`)
  // A scenario may pin settings of its own (a work-details mode) over the runner's.
  const pinned = { ...config }
  let market
  if (scenario.market !== undefined) {
    if (dshHome === undefined) throw new Error('a market scenario seeds the bench profile: run it with pnpm run scenario or pnpm run frame')
    market = await prepareMarket({ market: scenario.market, dshHome, dir })
    for (const [id, settings] of Object.entries(market.config)) pinned[id] = { ...pinned[id], ...settings }
  }
  for (const [id, settings] of Object.entries(scenario.config ?? {})) pinned[id] = { ...pinned[id], ...settings }
  for (const [id, settings] of Object.entries(pinned)) rows.push(`- id: ${id}\n  config:\n${Object.entries(settings).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}\n`).join('')}`)
  for (const id of new Set([...disabled, ...(scenario.disabled ?? [])])) rows.push(`- id: ${id}\n  disabled: true\n`)
  if (isolate) {
    rows.push(`- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(join(dir, 'store/sessions'))}\n`)
    rows.push(`- id: storage-json\n  config:\n    root: ${JSON.stringify(join(dir, 'store/storages'))}\n`)
  }
  writeFileSync(patch, rows.join(''))
  const file = join(dir, 'replay.json')
  writeFileSync(file, JSON.stringify(replay === undefined ? [] : compile(replay.items, replay.options), null, 1))
  // A `browser: 'opens'` scenario has a display and an opener that succeeds, so sign-in finds a browser; without it nothing opens (no display).
  let browserEnv = {}
  if (scenario.browser === 'opens') {
    const bin = join(dir, 'bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'xdg-open'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    browserEnv = { DISPLAY: ':99', PATH: `${bin}:${process.env.PATH ?? ''}` }
  }
  const log = join(dir, 'driver.log')
  const stub = await startStubModel({ balance: scenario.account?.balance })
  if (scenario.workspace !== undefined) workspaceFiles(cwd, scenario.workspace)
  // What a PTY lacks: a clipboard holding an image, an external editor (a scenario names them).
  const fixtures = {
    ...(scenario.clipboard?.image === undefined ? {} : clipboardImage(dir, scenario.clipboard.image, scenario.clipboard.delayMs)),
    ...(scenario.editor === undefined ? {} : externalEditor(dir, scenario.editor.append)),
  }
  return {
    cwd,
    patch,
    log,
    stub,
    env: {
      // A `firstRun` scenario has no key, so the first-run guide opens (its Language step needs the Host's `locale` namespace, which the bench profile lacks).
      DEEPSEEK_BASE_URL: `${stub.baseURL}/v1`, ...(scenario.firstRun === true ? {} : { DEEPSEEK_API_KEY: 'replay-key' }),
      ...(scenario.extensions === true ? { MAYFLY_SCENARIO_EXTENSIONS: '1' } : {}),
      MAYFLY_REPLAY_FILE: file, MAYFLY_REPLAY_SPEED: String(speed), MAYFLY_REPLAY_LOG: log,
      ...(scenario.source.sessionless === true ? { MAYFLY_REPLAY_SESSIONLESS: '1' } : {}),
      ...(control === undefined ? {} : { MAYFLY_REPLAY_CONTROL: control }),
      ...(scenario.account?.signed === undefined ? {} : { MAYFLY_FAKE_ACCOUNT: scenario.account.signed }),
      ...(isolate ? { HOME: tmp } : {}),
      ...browserEnv,
      ...market?.env,
      ...fixtures,
    },
    close: async () => {
      await market?.close()
      await stub.close()
      rmSync(tmp, { recursive: true, force: true })
    },
  }
}
