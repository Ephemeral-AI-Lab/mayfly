/** Real split case orchestration with immutable published references and a separate reconnect result. @module script/scenarios/split-suite */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { capturePublishedReference } from './split-baseline.mjs'
import { SPLIT_CASES } from './split-cases.mjs'
import { SPLIT_EXTENDED_CASES } from './split-extended.mjs'
import { runSplitScenario, SPLIT_SMOKE_STEPS } from './split-runner.mjs'

export const SPLIT_SCENARIOS = Object.freeze({ smoke: { steps: SPLIT_SMOKE_STEPS }, ...SPLIT_CASES, ...SPLIT_EXTENDED_CASES })

/** Keep reference capture failures visible and continue unrelated cases to maximize useful acceptance evidence. */
export async function runSplitSuite({ root, dshBin, artifacts, cols = 80, rows = 24, scenarios = ['smoke'], smokeOnly = false, captureReferenceOnly = false, referenceDir, resultsFile, log = console.log }) {
  mkdirSync(artifacts, { recursive: true })
  const results = []
  for (const scenario of scenarios) {
    const descriptor = SPLIT_SCENARIOS[scenario]
    if (descriptor === undefined) throw new Error(`Unknown split scenario: ${scenario}`)
    if (descriptor.splitOnly && (captureReferenceOnly || referenceDir !== undefined)) throw new Error(`${scenario} has no in-process rc.2 reference`)
    const caseArtifacts = scenarios.length === 1 ? artifacts : join(artifacts, scenario)
    let baseline = referenceDir
    try {
      if (!smokeOnly && !descriptor.splitOnly && baseline === undefined) {
        log(`Capturing published rc.2 reference: ${scenario}`)
        baseline = await capturePublishedReference({ root, dir: join(artifacts, 'published-reference'), cols, rows, ...descriptor, caseName: scenario })
      }
      if (captureReferenceOnly) continue
      log(`Running real split case: ${scenario}${descriptor.splitOnly ? ' (behavior only)' : ''}`)
      const result = await runSplitScenario({ root, dshBin, artifacts: caseArtifacts, cols, rows, ...descriptor, scenario, referenceDir: baseline })
      results.push(result)
      log(`${scenario}: ${result.status}; ${result.checkpoints.length} checkpoints; parityVerified=${result.parityVerified}`)
    } catch (error) {
      results.push({ scenario, status: 'failed', parityVerified: false, checkpoints: [], failures: [error instanceof Error ? error.stack ?? error.message : String(error)] })
    }
  }
  const report = { results, failures: results.flatMap(result => result.failures), parityVerified: !smokeOnly && results.some(result => result.parityVerified) && results.every(result => result.status !== 'failed') }
  const target = resultsFile ?? join(artifacts, 'suite.json')
  mkdirSync(join(target, '..'), { recursive: true })
  writeFileSync(target, JSON.stringify(report, null, 2) + '\n')
  return report
}
