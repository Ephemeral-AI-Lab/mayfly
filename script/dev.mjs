#!/usr/bin/env node
/**
 * The review loop: watch the sources, rebuild incrementally, and restart the running `dsh --profile <name>` on the
 * same persisted session, so a change reaches the terminal in seconds. A failed build is not applied; its output is
 * in `.artifacts/dev/build.log`. With `--check`, each applied build is followed by the round tier of `pnpm run check`
 * in the background: its output goes to `.artifacts/dev/check.log` and its report to `.artifacts/verify/`, and the
 * terminal title shows the verdict (a failure also rings the bell). Never boots the production `mayfly` profile.
 *
 *   pnpm run dev --profile mayfly-<tag> [--check] [--replay <name>] [--speed N] [--width N] [--height N] [--no-color] [--ascii] [-- <dsh app args>]
 *
 * @module script/dev
 */

import { spawn } from 'node:child_process'
import { mkdirSync, watch, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertDshVersion, resolveDshBin, root } from './smoke-lib.mjs'
import { scenarioNamed } from './scenarios/catalog.mjs'
import { REPLAYS } from './scenarios/replays.mjs'
import { prepareSession } from './scenarios/session.mjs'
import { presentationEnv, superviseDsh } from './workbench/supervisor.mjs'

const SOURCE = /^(?:packages|examples)\/[^/]+\/src\/.+\.ts$/u

/**
 * Parse the command line.
 * @param argv - arguments after the script name.
 * @returns the options, or an error message.
 */
export function parseDevArgs(argv) {
  const options = { noColor: false, ascii: false, check: false, args: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') { options.args = argv.slice(index + 1); break }
    if (value === '--profile') options.profile = argv[++index]
    else if (value === '--width') options.cols = Number(argv[++index])
    else if (value === '--height') options.rows = Number(argv[++index])
    else if (value === '--no-color') options.noColor = true
    else if (value === '--ascii') options.ascii = true
    else if (value === '--check') options.check = true
    else if (value === '--replay') options.replay = argv[++index]
    else if (value === '--speed') options.speed = Number(argv[++index])
    else return { error: `unknown argument ${value}` }
  }
  options.profile ??= process.env.PROFILE
  if (options.profile === undefined || options.profile === '') return { error: 'usage: pnpm run dev --profile mayfly-<tag> (or PROFILE=mayfly-<tag>)' }
  if (options.profile === 'mayfly') return { error: 'refusing the production profile "mayfly": use mayfly-dev or mayfly-<tag>' }
  if (options.replay !== undefined && !Object.hasOwn(REPLAYS, options.replay)) return { error: `unknown replay "${options.replay}" (one of ${Object.keys(REPLAYS).join(', ')})` }
  for (const key of ['cols', 'rows']) if (options[key] !== undefined && !(Number.isInteger(options[key]) && options[key] > 0)) return { error: `--${key === 'cols' ? 'width' : 'height'} needs a positive integer` }
  return { options }
}

/**
 * Collect watch events into batches: `onBatch` runs once, `ms` after the last event, with the files seen.
 * @param ms - the quiet period.
 * @param onBatch - called with the sorted unique files of the batch.
 * @returns the function to call for each changed file.
 */
export function debounceFiles(ms, onBatch) {
  const files = new Set()
  let timer
  return (file) => {
    files.add(file)
    clearTimeout(timer)
    timer = setTimeout(() => {
      const batch = [...files].sort()
      files.clear()
      onBatch(batch)
    }, ms)
  }
}

/** Run the round tier of `pnpm run check` with its output in `log`; resolves true when it passed. */
function check(log) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'script/check.mjs'), '--tier', 'round'], { cwd: root, env: process.env })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.on('close', (code) => {
      writeFileSync(log, output)
      resolve(code === 0)
    })
  })
}

/** Run the incremental build for explicit files; resolves true when it succeeded. */
function build(files, log) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(root, 'script/build-changed.mjs'), '--files-json', JSON.stringify(files)], { cwd: root, env: process.env })
    let output = ''
    child.stdout.on('data', data => { output += data })
    child.stderr.on('data', data => { output += data })
    child.on('close', (code) => {
      writeFileSync(log, output)
      resolve(code === 0)
    })
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseDevArgs(process.argv.slice(2))
  if (parsed.error !== undefined) { console.error(parsed.error); process.exit(2) }
  const { options } = parsed
  const dshBin = resolveDshBin()
  assertDshVersion(dshBin)
  const logDir = join(root, '.artifacts/dev')
  mkdirSync(logDir, { recursive: true })
  const log = join(logDir, 'build.log')

  // With --replay the session runs on a scripted model in a throwaway workspace, so no real conversation is needed.
  const replay = options.replay === undefined ? undefined : await prepareSession({ scenario: scenarioNamed(options.replay), dir: join(root, '.artifacts/replay'), speed: options.speed })
  const session = superviseDsh({
    dshBin,
    profile: options.profile,
    cwd: replay?.cwd ?? process.cwd(),
    env: { ...process.env, ...replay?.env, ...presentationEnv(options) },
    args: options.args,
    patch: replay?.patch,
    cols: options.cols,
    rows: options.rows,
  })
  let building = Promise.resolve()
  // One check at a time; edits that land while one runs are covered by the next, which reads the whole change set.
  let checking
  let checkAgain = false
  const runCheck = () => {
    if (checking !== undefined) { checkAgain = true; return }
    process.stdout.write('\u001b]0;mayfly dev: checking…\u0007')
    checking = check(join(logDir, 'check.log')).then((passed) => {
      checking = undefined
      if (checkAgain) { checkAgain = false; runCheck(); return }
      process.stdout.write(passed ? '\u001b]0;mayfly dev: check passed\u0007' : '\u0007\u001b]0;mayfly dev: check failed (.artifacts/verify/summary.md)\u0007')
    })
  }
  const onFiles = debounceFiles(200, (files) => {
    building = building.then(async () => {
      const ok = await build(files, log)
      if (ok) {
        await session.restart()
        if (options.check) runCheck()
      } else {
        process.stdout.write(`\u0007\u001b]0;mayfly dev: build failed (${relative(root, log)})\u0007`)
      }
    })
  })
  const watchers = ['packages', 'examples'].map(dir => watch(join(root, dir), { recursive: true }, (_event, name) => {
    const file = name === null ? '' : `${dir}/${name}`
    if (SOURCE.test(file)) onFiles(file)
  }))
  const code = await session.done
  for (const watcher of watchers) watcher.close()
  await replay?.close()
  process.exit(code)
}
