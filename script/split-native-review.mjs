/** Review an immutable explicit native-difference decision separately from strict parity. @module script/split-native-review */

import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { reviewSplitNativeDifferences } from './scenarios/split-native-review.mjs'

const args = process.argv.slice(2)
if (args.length !== 4 || args[0] !== '--review' || args[2] !== '--results') throw new Error('Usage: node script/split-native-review.mjs --review <exact-review-plan.json> --results <review-result.json>')
const path = resolve(args[1])
const plan = JSON.parse(readFileSync(path, 'utf8'))
const result = reviewSplitNativeDifferences(plan, { base: dirname(path) })
const target = resolve(args[3])
const canonical = file => existsSync(file) ? realpathSync(file) : resolve(file)
const protectedPaths = new Set([canonical(path)])
function protectArtifacts(value) {
  if (value === null || typeof value !== 'object') return
  if (typeof value.path === 'string') protectedPaths.add(canonical(resolve(dirname(path), value.path)))
  for (const nested of Object.values(value)) protectArtifacts(nested)
}
protectArtifacts(plan)
if (protectedPaths.has(canonical(target)) || extname(target) === '.grid' || extname(canonical(target)) === '.grid') throw new Error('Review results must not overwrite the plan, original strict artifacts or evidence')
writeFileSync(target, JSON.stringify(result, null, 2) + '\n')
console.log(`Native review: ${result.status}; strictParityVerified=${result.strictParityVerified}; ${result.exactCheckpoints.length} exact checkpoints; ${result.reviewedDifferences.length} reviewed differences`)
for (const failure of result.failures) console.error(failure)
console.log(`Review report: ${target}`)
process.exitCode = result.status === 'rejected' ? 1 : 0
