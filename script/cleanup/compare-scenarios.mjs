#!/usr/bin/env node
/**
 * Temporary differential oracle for the cleanup branch: compare two
 * `.artifacts/verify/scenarios.json` captures checkpoint by checkpoint. The
 * committed goldens can differ from a fresh bench profile (the `/model` scenes
 * share profile settings), so the cleanup gate compares the integration tip
 * with the frozen W0 capture instead of trusting `status` alone.
 *
 *   node script/cleanup/compare-scenarios.mjs <baseline.json> <head.json>
 */

import { readFileSync } from 'node:fs'

const [baselinePath, headPath] = process.argv.slice(2)
if (baselinePath === undefined || headPath === undefined) {
  console.error('usage: node script/cleanup/compare-scenarios.mjs <baseline.json> <head.json>')
  process.exit(2)
}

const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'))
const head = JSON.parse(readFileSync(headPath, 'utf8'))
const keyOf = (result, checkpoint) => `${result.name}@${String(result.cols)}x${String(result.rows)}#${checkpoint.checkpoint}`
const flatten = capture => new Map(capture.results.flatMap(result => result.checkpoints.map(checkpoint => [keyOf(result, checkpoint), checkpoint.grid])))

const before = flatten(baseline)
const after = flatten(head)
const problems = []

for (const [key, grid] of before) {
  const next = after.get(key)
  if (next === undefined) problems.push(`${key}: missing from the head capture`)
  else if (next !== grid) problems.push(`${key}: grid differs from the W0 baseline`)
}
for (const key of after.keys()) if (!before.has(key)) problems.push(`${key}: new checkpoint not in the W0 baseline`)

const failures = [...(baseline.results ?? []), ...(head.results ?? [])].flatMap(result => result.failures ?? [])
for (const failure of failures) problems.push(`run failure: ${failure}`)

if (problems.length > 0) {
  for (const problem of problems) console.error(`✗ ${problem}`)
  console.error(`scenario differential: FAIL (${String(problems.length)} differences)`)
  process.exit(1)
}
console.log(`scenario differential: PASS (${String(before.size)} checkpoints identical to the W0 baseline)`)
