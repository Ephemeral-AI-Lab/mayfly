#!/usr/bin/env node
/**
 * Check the catalog scenarios against their goldens: each scenario runs against the real product at its sizes (four at
 * a time), and every checkpoint is compared with `script/scenarios/golden/`. `--update` accepts what the product paints
 * now (and removes goldens no checkpoint writes when every scenario runs at every size). The results, with the rows of
 * each difference, go to `.artifacts/verify/scenarios.json` for `pnpm run check`.
 *
 *   pnpm run scenarios [-- <scenario>...] [--sizes all|first] [--update] [--parallel N]
 *
 * @module script/scenarios
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CATALOG, scenarioNamed } from './scenarios/catalog.mjs'
import { compareGolden, goldenPath, orphanGoldens, removeGoldens, writeGolden } from './scenarios/golden.mjs'
import { prepareProfiles, runScenario } from './scenarios/runner.mjs'
import { assertDshVersion, resolveDshBin, root } from './smoke-lib.mjs'

/** Where the results go for the check report. */
export const RESULTS = '.artifacts/verify/scenarios.json'

/**
 * Parse the command line.
 * @param {string[]} argv
 * @returns {{ options: { names: string[], sizes: 'all' | 'first', update: boolean, parallel: number } } | { error: string }}
 */
export function parseScenariosArgs(argv) {
  const options = { names: [], sizes: 'all', update: false, parallel: 4 }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') continue
    if (value === '--update') options.update = true
    else if (value === '--sizes') options.sizes = argv[++index]
    else if (value === '--parallel') options.parallel = Number(argv[++index])
    else if (value.startsWith('--')) return { error: `unknown option ${value}` }
    else if (scenarioNamed(value) === undefined) return { error: `unknown scenario "${value}"` }
    else options.names.push(value)
  }
  if (!['all', 'first'].includes(options.sizes)) return { error: '--sizes needs all or first' }
  if (!(Number.isInteger(options.parallel) && options.parallel > 0)) return { error: '--parallel needs a positive integer' }
  return { options }
}

/** Run `work` over `items`, `count` at a time, keeping their order. */
async function pool(items, count, work) {
  const results = []
  let next = 0
  await Promise.all(Array.from({ length: Math.min(count, items.length) }, async () => {
    while (next < items.length) { const index = next++; results[index] = await work(items[index]) }
  }))
  return results
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseScenariosArgs(process.argv.slice(2))
  if ('error' in parsed) { console.error(parsed.error); process.exit(2) }
  const { options } = parsed
  const names = options.names.length > 0 ? options.names : Object.keys(CATALOG)
  const everything = options.names.length === 0 && options.sizes === 'all'
  const dshBin = resolveDshBin()
  assertDshVersion(dshBin)
  prepareProfiles({ root, dshBin, names })
  const runs = names.flatMap(name => (options.sizes === 'first' ? CATALOG[name].sizes.slice(0, 1) : CATALOG[name].sizes).map(([cols, rows]) => ({ name, cols, rows })))
  const started = performance.now()
  const results = await pool(runs, options.parallel, async ({ name, cols, rows }) => {
    const run = await runScenario(name, { root, dshBin, cols, rows })
    run.screen.dispose()
    const checkpoints = run.checkpoints.map(({ name: checkpoint, grid }) => {
      if (options.update) { writeGolden(name, checkpoint, cols, rows, grid); return { checkpoint, status: 'updated', diff: [] } }
      return { checkpoint, ...compareGolden(name, checkpoint, cols, rows, grid) }
    })
    const ok = run.failures.length === 0 && checkpoints.every(entry => entry.status === 'same' || entry.status === 'updated')
    const label = `${name} ${String(cols)}x${String(rows)}`
    process.stdout.write(`${ok ? '✓' : '✗'} ${label} (${String(checkpoints.length)} checkpoints, ${(run.durationMs / 1000).toFixed(1)} s)${checkpoints.filter(entry => entry.status !== 'same' && entry.status !== 'updated').map(entry => ` — ${entry.checkpoint} ${entry.status}`).join('')}\n`)
    for (const failure of run.failures) process.stdout.write(`    ${failure.split('\n')[0]}\n`)
    return { name, cols, rows, checkpoints, failures: run.failures, durationMs: run.durationMs, frames: run.frames }
  })
  const expected = new Set(results.flatMap(result => result.checkpoints.map(entry => goldenPath(result.name, entry.checkpoint, result.cols, result.rows))))
  let orphans = everything ? orphanGoldens(expected, root) : []
  if (options.update && orphans.length > 0) { removeGoldens(orphans, root); process.stdout.write(`removed ${String(orphans.length)} goldens no checkpoint writes\n`); orphans = [] }
  for (const orphan of orphans) process.stdout.write(`✗ ${orphan}: no checkpoint writes it (pnpm run scenarios -- --update removes it)\n`)
  const passed = orphans.length === 0 && results.every(result => result.failures.length === 0 && result.checkpoints.every(entry => entry.status === 'same' || entry.status === 'updated'))
  mkdirSync(dirname(join(root, RESULTS)), { recursive: true })
  writeFileSync(join(root, RESULTS), `${JSON.stringify({ passed, updated: options.update, orphans, results }, null, 2)}\n`)
  process.stdout.write(`scenarios: ${passed ? 'PASS' : 'FAIL'} (${String(runs.length)} runs, ${((performance.now() - started) / 1000).toFixed(1)} s)${options.update ? ', goldens updated' : ''}\n`)
  process.exitCode = passed ? 0 : 1
}
