/** Adjudicate a release against frozen rc.2 screens and explicit, source-bound row decisions. @module script/scenarios/split-release-review */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { RELEASE_PACKAGE_DIRS } from '../package-contract.mjs'
import { builtSplitRuntime } from './split-evidence.mjs'
import { diffGrids, parseGrid, serializeGrid } from './grid.mjs'
import { compareSplitReference, normalizeSplitGrid, SPLIT_REFERENCE } from './split-reference.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const requireFact = (condition, message) => { if (!condition) throw new Error(message) }
const same = (a, b) => isDeepStrictEqual(a, b)
const styles = (runs, cols) => Array.from({ length: cols }, (_, col) => runs.find(run => run.from <= col && run.to >= col)?.style ?? '')
const isVersionField = text => /^(?:    ▗▘   ▝▖     | | {20,})mayfly v0\.1\.4-rc\.2$/u.test(text)

/** A version replacement carries the reference's cell attributes; it cannot recolor a theme or move other content. */
export function releaseVersionRow(reference, candidate, cols, version) {
  const old = `mayfly v${SPLIT_REFERENCE.version}`
  const next = `mayfly v${version}`
  const start = reference.text.indexOf(old)
  if (start < 0 || !reference.text.endsWith(old)) return false
  const prefix = reference.text.slice(0, start)
  // Only the compact banner, one-column banner and centered splash are version fields.
  const centered = /^ {20,}$/u.test(prefix)
  if (!centered && !['    ▗▘   ▝▖     ', ' '].includes(prefix)) return false
  const shift = centered ? Math.floor((old.length - next.length) / 2) : 0
  const nextStart = start + shift
  if (candidate.text !== ' '.repeat(centered ? nextStart : 0) + (centered ? '' : prefix) + next) return false
  const before = styles(reference.styles, cols)
  const after = [...before]
  const blank = before[reference.text.length] ?? ''
  for (let col = start; col < Math.max(reference.text.length, nextStart + next.length); col += 1) after[col] = blank
  for (let col = 0; col < next.length; col += 1) after[nextStart + col] = before[start + Math.min(col, old.length - 1)]
  return same(after, styles(candidate.styles, cols))
}

/** Check a capture's saved native bytes, rather than accepting a summary supplied by a review decision. */
function nativeFacts(evidence, expected) {
  const caches = []
  const events = []
  requireFact(evidence !== undefined && Object.keys(evidence.files).length > 0, 'Native evidence is absent')
  for (const [file, digest] of Object.entries(evidence.files)) {
    const path = join(evidence.runDirectory, file)
    const bytes = readFileSync(path)
    requireFact(hash(bytes) === digest, `Native evidence checksum differs: ${file}`)
    if (file.endsWith('.json')) caches.push(JSON.parse(bytes))
    else if (file.endsWith('.jsonl.zstd')) events.push(...execFileSync('zstd', ['-d', '-c', '--', path], { maxBuffer: 32 * 1024 * 1024 }).toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line)))
  }
  const projections = caches.map(cache => cache.record?.rows).filter(rows => rows?.contextPressure !== undefined)
  requireFact(projections.length > 0 && projections.every(rows => rows.contextPressure.val.contextWindow === expected.contextWindow), 'Native context window differs from the release decision')
  if (expected.systemTokens !== undefined) requireFact(projections.every(rows => {
    const tokens = rows.contextBreakdown?.val.breakdown.systemTokens
    // The path-dependent native system prompt can vary inside the exact displayed 1024-base bucket.
    return expected.systemTokens === '1.1k' ? Number.isFinite(tokens) && (tokens / 1024).toFixed(1) === '1.1' : tokens === expected.systemTokens
  }), 'Native system token fact differs from the reviewed display')
  const headers = events.filter(event => event.type === 'request/header')
  requireFact(headers.length > 0 && headers.every(event => event.data.header.config.reasoningEffort === 'high' && event.data.header.adapterDefaults.reasoningEffort === true), 'Native request does not have the reviewed adapter-default effort')
  requireFact(projections.every(rows => rows.modelSelection?.ver === expected.selectionVersion && same(rows.modelSelection.val.lastUsed, expected.lastUsed)), 'Native model selection provenance differs')
}

function checkKnownReferenceFailure({ result, descriptor, referenceDirectory, policy }) {
  requireFact(result.scenario === 'files' && descriptor.fixture === 'native-files', 'Only the documented rc.2 file-preview defect has a release decision')
  requireFact(result.candidateStatus === 'smoke-only' && result.failures.length === 1 && result.failures[0] === result.referenceFailure.message, 'Candidate runtime failure cannot be reviewed as a reference defect')
  requireFact(result.referenceFailure.captureDirectory === referenceDirectory, 'Reference failure points at another capture')
  const evidence = json(join(referenceDirectory, 'capture-evidence.json'))
  for (const [key, value] of Object.entries(SPLIT_REFERENCE)) requireFact(evidence[key] === value, 'Failed reference provenance differs')
  requireFact(evidence.interactionSha256 === policy.referenceFilePreview.interactionSha256, 'Failed reference is not the reviewed immutable implementation')
  requireFact(evidence.failures.length === 1 && /^Error: Expected text did not disappear: Description:\n/u.test(evidence.failures[0]), 'Unexpected reference capture failure')
  requireFact(same(evidence.checkpoints, ['files-delivered-detail']), 'Reference failed at an unexpected workflow step')
  const ansi = readFileSync(join(referenceDirectory, 'reference.ansi'))
  requireFact(hash(ansi) === evidence.ansiSha256, 'Reference failure ANSI checksum differs')
  const plain = ansi.toString().replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, '')
  for (const text of ['Description: Deterministic native delivery', 'File unavailable', 'cannot get property "fs" without inject']) requireFact(plain.includes(text), `Reference defect evidence lacks ${text}`)
}

/** No goldens are produced. Raw strict reports and reference files are read only. */
export function reviewSplitReleaseSuite({ root, artifacts, suite, scenarios, policy = json(join(root, 'script/scenarios/split-release-policy.json')) }) {
  const output = { schemaVersion: 1, status: 'rejected', strictParityVerified: suite.parityVerified, strictFailures: suite.failures, results: [], failures: [] }
  try {
    requireFact(policy.schemaVersion === 1 && policy.reference === SPLIT_REFERENCE.integrity, 'Unknown release review policy/reference')
    const decisionKeys = policy.decisions.map(item => JSON.stringify([item.scenario, item.checkpoint, item.row]))
    requireFact(new Set(decisionKeys).size === decisionKeys.length, 'Duplicate release row decisions')
    for (const dir of RELEASE_PACKAGE_DIRS) requireFact(json(join(root, dir, 'package.json')).version === policy.version, `Release decision does not cover ${dir}`)
    requireFact(json(join(root, 'packages/cli/package.json')).dependencies['@deepseek-ai/dsh'] === policy.harness, 'Release decision covers another Harness')
    for (const [file, digest] of Object.entries(policy.sources)) requireFact(hash(readFileSync(join(root, file))) === digest, `Reviewed source changed: ${file}`)
    requireFact(Object.keys(scenarios).length > 0 && same(suite.results.map(result => result.scenario), Object.keys(scenarios)), 'Missing, duplicate, reordered or unknown split scenarios')
    requireFact(same(suite.failures, suite.results.flatMap(result => result.failures)), 'Raw suite failure summary is inconsistent')
    const runtime = builtSplitRuntime(root)
    for (const result of suite.results) {
      const name = result.scenario
      const descriptor = scenarios[name]
      const review = { scenario: name, status: 'rejected', exactCheckpoints: [], reviewedDifferences: [], failures: [] }
      output.results.push(review)
      try {
        requireFact(result.builtRuntime?.stable === true && same(result.builtRuntime.before, result.builtRuntime.after) && same(result.builtRuntime.after, runtime), 'Capture runtime changed or differs from the current build')
        requireFact(result.dsh === policy.harness, 'Captured Host uses another Harness')
        let cols = result.cols
        let rows = result.rows
        const expected = []
        const checkpoints = []
        const candidateDirectory = Object.keys(scenarios).length === 1 ? artifacts : join(artifacts, name)
        for (const step of descriptor.steps) {
          if (step.step === 'resize') { cols = step.cols; rows = step.rows }
          if (step.step !== 'checkpoint') continue
          expected.push(step.name)
          requireFact(same(result.checkpointDimensions?.[step.name], { cols, rows }), `Missing or changed checkpoint dimensions: ${step.name}`)
          checkpoints.push({ name: step.name, cols, rows, grid: readFileSync(join(candidateDirectory, `${step.name}-${cols}x${rows}.grid`), 'utf8') })
        }
        requireFact(same(result.checkpoints, expected) && expected.length > 0, 'Missing, duplicate or unexpected candidate checkpoints')
        for (const decision of policy.decisions.filter(item => item.scenario === name)) requireFact(expected.includes(decision.checkpoint), `Release decision names an absent checkpoint: ${decision.checkpoint}`)
        if (descriptor.splitOnly) {
          requireFact(result.status === 'smoke-only' && result.parityVerified === false && result.failures.length === 0, 'Split-only behavior failed')
          review.status = 'behavior-passed'
          continue
        }
        const referenceDirectory = join(artifacts, 'published-reference/captures', name)
        if (result.referenceFailure !== undefined) {
          checkKnownReferenceFailure({ result, descriptor, referenceDirectory, policy })
          review.status = 'behavior-passed-reference-defect'
          review.referenceDefect = 'rc.2-file-preview-missing-fs-injection'
          continue
        }
        const failures = compareSplitReference(referenceDirectory, checkpoints, { cols: result.cols, rows: result.rows, steps: descriptor.steps, startup: descriptor.startup })
        requireFact(same(failures, result.failures), 'Saved strict result differs from grids or contains a runtime failure')
        requireFact(result.status === (failures.length > 0 ? 'failed' : 'passed') && result.parityVerified === (failures.length === 0), 'Strict result verdict is inconsistent')
        const nativePolicy = policy.nativeFacts[name]
        if (nativePolicy !== undefined) {
          const referenceEvidence = json(join(referenceDirectory, 'capture-evidence.json'))
          requireFact(referenceEvidence.referenceManifestSha256 === hash(readFileSync(join(referenceDirectory, 'reference.json'))), 'Native reference evidence is not linked to this manifest')
          nativeFacts(referenceEvidence, nativePolicy.reference)
          nativeFacts(result.nativeEvidence, nativePolicy.candidate)
        }
        for (const checkpoint of checkpoints) {
          const file = `${checkpoint.name}-${checkpoint.cols}x${checkpoint.rows}.grid`
          const reference = normalizeSplitGrid(readFileSync(join(referenceDirectory, file), 'utf8'))
          const actual = normalizeSplitGrid(checkpoint.grid)
          const left = parseGrid(reference)
          const right = parseGrid(actual)
          requireFact(reference.split('\n')[0] === actual.split('\n')[0] && left.cols === checkpoint.cols && left.lines.length === checkpoint.rows && right.lines.length === checkpoint.rows && same(left.cursor, right.cursor), `Dimensions or cursor changed: ${checkpoint.name}`)
          for (const decision of policy.decisions.filter(item => item.scenario === name && item.checkpoint === checkpoint.name)) {
            requireFact(decision.cols === checkpoint.cols && decision.rows === checkpoint.rows && Number.isInteger(decision.row) && decision.row >= 0 && decision.row < checkpoint.rows, `Release decision has unexpected dimensions/row: ${checkpoint.name}`)
            requireFact(same(decision.reference, { text: left.lines[decision.row], styles: left.styles[decision.row] }) && same(decision.candidate, { text: right.lines[decision.row], styles: right.styles[decision.row] }), `Required reviewed change is absent or altered: ${checkpoint.name} row ${decision.row}`)
          }
          for (let row = 0; row < left.lines.length; row += 1) if (isVersionField(left.lines[row])) requireFact(releaseVersionRow({ text: left.lines[row], styles: left.styles[row] }, { text: right.lines[row], styles: right.styles[row] }, checkpoint.cols, policy.version), `Release version field is wrong: ${checkpoint.name} row ${row}`)
          if (diffGrids(reference, actual).length === 0) { review.exactCheckpoints.push(checkpoint.name); continue }
          for (let row = 0; row < left.lines.length; row += 1) {
            const before = { text: left.lines[row], styles: left.styles[row] }
            const after = { text: right.lines[row], styles: right.styles[row] }
            if (same(before, after)) continue
            let rule
            if (releaseVersionRow(before, after, checkpoint.cols, policy.version)) rule = 'release-version'
            else {
              const decision = policy.decisions.find(item => item.scenario === name && item.checkpoint === checkpoint.name && item.cols === checkpoint.cols && item.rows === checkpoint.rows && item.row === row)
              requireFact(decision !== undefined && same(decision.reference, before) && same(decision.candidate, after), `Unreviewed text/style difference: ${name}/${checkpoint.name} row ${row}`)
              requireFact(typeof decision.reason === 'string' && decision.reason.length >= 20 && ['release-content', 'native-fact', 'partial-api', 'command-catalog', 'owner-design'].includes(decision.category), 'Missing or unknown exact row decision')
              rule = decision.category
            }
            review.reviewedDifferences.push({ checkpoint: checkpoint.name, row, rule, referenceSha256: hash(JSON.stringify(before)), candidateSha256: hash(JSON.stringify(after)) })
            right.lines[row] = left.lines[row]
            right.styles[row] = left.styles[row]
          }
          requireFact(diffGrids(serializeGrid(left), serializeGrid(right)).length === 0, `Unreviewed grid difference: ${checkpoint.name}`)
        }
        review.status = review.reviewedDifferences.length > 0 ? 'reviewed-release-differences' : 'strict-exact'
      } catch (error) {
        review.failures.push(error instanceof Error ? error.message : String(error))
        output.failures.push(`${name}: ${review.failures[0]}`)
      }
    }
    if (output.failures.length === 0) output.status = 'passed-with-reviewed-differences'
  } catch (error) {
    output.failures.push(error instanceof Error ? error.message : String(error))
  }
  return output
}
