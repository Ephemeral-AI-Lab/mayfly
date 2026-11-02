/** CLI for strict reference comparison or explicitly separate real split smoke. @module script/split-parity */

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { referenceCommandInventory } from './scenarios/split-commands.mjs'
import { capturePublishedReference } from './scenarios/split-baseline.mjs'
import { runSplitScenario } from './scenarios/split-runner.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
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
let artifacts = resolve(root, '.artifacts/split-parity')
for (let at = 0; at < args.length; at += 1) {
  const arg = args[at]
  if (arg === '--smoke-only') smokeOnly = true
  else if (arg === '--capture-reference') captureReferenceOnly = true
  else if (['--reference', '--artifacts', '--cols', '--rows'].includes(arg)) {
    const value = args[++at]
    if (value === undefined || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    if (arg === '--reference') referenceDir = resolve(value)
    else if (arg === '--artifacts') artifacts = resolve(value)
    else if (arg === '--cols') cols = Number(value)
    else rows = Number(value)
  } else throw new Error(`Unknown argument: ${arg}`)
}
if (smokeOnly && referenceDir !== undefined) throw new Error('Choose either --smoke-only or --reference')
if (captureReferenceOnly && (smokeOnly || referenceDir !== undefined)) throw new Error('--capture-reference cannot be combined with --smoke-only or --reference')
if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 20 || rows < 10) throw new Error('Terminal dimensions must be integers with at least 20 columns and 10 rows')
if (!smokeOnly && referenceDir === undefined) {
  console.log('Capturing the verified published rc.2 reference with its own isolated Harness runtime')
  referenceDir = await capturePublishedReference({ root, dir: resolve(artifacts, 'published-reference'), cols, rows })
  console.log(`Frozen reference: ${referenceDir}`)
}
if (captureReferenceOnly) process.exit(0)
const report = await runSplitScenario({ root, dshBin: process.env.MAYFLY_DSH_BIN ?? process.env.DSH_BIN ?? 'dsh', artifacts, cols, rows, referenceDir })
console.log(`${report.status}: ${report.checkpoints.length} checkpoints; parityVerified=${report.parityVerified}`)
for (const failure of report.failures) console.error(failure)
console.log(`Report: ${resolve(artifacts, 'report.json')}`)
process.exitCode = report.failures.length === 0 ? 0 : 1
