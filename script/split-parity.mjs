/** CLI for immutable reference comparisons and explicitly separate real split behavior cases. @module script/split-parity */

import { createRequire } from 'node:module'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { referenceCommandInventory } from './scenarios/split-commands.mjs'
import { runSplitSuite, SPLIT_SCENARIOS } from './scenarios/split-suite.mjs'
import { reviewSplitReleaseSuite } from './scenarios/split-release-review.mjs'

let root = fileURLToPath(new URL('..', import.meta.url))
const args = process.argv.slice(2)
if (args.length === 1 && args[0] === '--inventory') {
  console.log(JSON.stringify(referenceCommandInventory(root), null, 2))
  process.exit(0)
}
let referenceDir
let smokeOnly = false
let captureReferenceOnly = false
let cols = 80
let rows = 24
let artifacts
let resultsFile
let reviewResults
let reviewRelease = false
let scenario = 'smoke'
for (let at = 0; at < args.length; at += 1) {
  const arg = args[at]
  if (arg === '--smoke-only') smokeOnly = true
  else if (arg === '--review-release') reviewRelease = true
  else if (arg === '--capture-reference') captureReferenceOnly = true
  else if (['--root', '--reference', '--artifacts', '--results', '--review-results', '--cols', '--rows', '--scenario'].includes(arg)) {
    const value = args[++at]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    if (arg === '--root') root = resolve(value)
    else if (arg === '--reference') referenceDir = resolve(value)
    else if (arg === '--artifacts') artifacts = resolve(value)
    else if (arg === '--results') resultsFile = resolve(value)
    else if (arg === '--review-results') reviewResults = resolve(value)
    else if (arg === '--scenario') scenario = value
    else if (arg === '--cols') cols = Number(value)
    else rows = Number(value)
  } else throw new Error(`Unknown argument: ${arg}`)
}
if (smokeOnly && referenceDir !== undefined) throw new Error('Choose either --smoke-only or --reference')
if (captureReferenceOnly && (smokeOnly || referenceDir !== undefined)) throw new Error('--capture-reference cannot be combined with --smoke-only or --reference')
if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || rows < 10) throw new Error('Terminal dimensions must be integers with at least 20 columns and 10 rows')
if (scenario !== 'all' && !Object.hasOwn(SPLIT_SCENARIOS, scenario)) throw new Error(`--scenario requires all or ${Object.keys(SPLIT_SCENARIOS).join(', ')}`)
if (scenario === 'all' && referenceDir !== undefined) throw new Error('--reference selects one scenario only')
if (reviewRelease && (smokeOnly || captureReferenceOnly || referenceDir !== undefined)) throw new Error('Release review requires actual published-reference captures')
if (reviewResults !== undefined && !reviewRelease) throw new Error('--review-results requires --review-release')
artifacts ??= resolve(root, '.artifacts/split-parity', scenario)
reviewResults ??= resolve(artifacts, 'release-review.json')
const canonical = path => existsSync(path) ? realpathSync(path) : existsSync(dirname(path)) ? resolve(realpathSync(dirname(path)), path.slice(dirname(path).length + 1)) : path
if (reviewRelease && (canonical(reviewResults) === canonical(resultsFile ?? resolve(artifacts, 'suite.json')) || canonical(reviewResults).startsWith(canonical(artifacts) + '/') && canonical(reviewResults) !== resolve(canonical(artifacts), 'release-review.json') || !reviewResults.endsWith('.json'))) throw new Error('Release review must not overwrite raw reference/candidate artifacts')
const scenarios = scenario === 'all' ? Object.keys(SPLIT_SCENARIOS).filter(name => !captureReferenceOnly || !SPLIT_SCENARIOS[name].splitOnly) : [scenario]
const report = await runSplitSuite({ root, dshBin: process.env.MAYFLY_DSH_BIN ?? process.env.DSH_BIN ?? createRequire(resolve(root, 'packages/cli/package.json')).resolve('@deepseek-ai/dsh/lib/bin.js'), artifacts, resultsFile, cols, rows, scenarios, smokeOnly, captureReferenceOnly, referenceDir })
console.log(`Report: ${resultsFile ?? resolve(artifacts, 'suite.json')}`)
if (reviewRelease) {
  const review = reviewSplitReleaseSuite({ root, artifacts, suite: report, scenarios: Object.fromEntries(scenarios.map(name => [name, SPLIT_SCENARIOS[name]])) })
  mkdirSync(dirname(reviewResults), { recursive: true })
  writeFileSync(reviewResults, JSON.stringify(review, null, 2) + '\n')
  console.log(`Release review: ${review.status}; raw strict failures=${report.failures.length}; strictParityVerified=${report.parityVerified}`)
  for (const failure of review.failures) console.error(failure)
  console.log(`Release review report: ${reviewResults}`)
  process.exitCode = review.failures.length === 0 ? 0 : 1
} else {
  for (const failure of report.failures) console.error(failure)
  process.exitCode = report.failures.length === 0 ? 0 : 1
}
