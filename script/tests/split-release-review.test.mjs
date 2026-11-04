/** Release decisions must never hide an unknown screen change or a broken real workflow. @module script/tests/split-release-review */

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { builtSplitRuntime } from '../scenarios/split-evidence.mjs'
import { diffGrids, parseGrid, serializeGrid } from '../scenarios/grid.mjs'
import { releaseVersionRow, reviewSplitReleaseSuite } from '../scenarios/split-release-review.mjs'
import { SPLIT_REFERENCE } from '../scenarios/split-reference.mjs'
import { runSplitSuite } from '../scenarios/split-suite.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value))
const row = (text, end = text.length - 1) => ({ text, styles: [{ from: 1, to: end, style: 'fg:#aabbcc' }] })

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'mayfly-release-review-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const name of ['ui', 'mayfly', 'host', 'remote', 'cli']) {
    mkdirSync(join(root, 'packages', name, 'lib'), { recursive: true })
    writeJson(join(root, 'packages', name, 'package.json'), { version: '0.1.5', dependencies: { '@deepseek-ai/dsh': '0.2.2-alpha.3' } })
    writeFileSync(join(root, 'packages', name, 'lib/entry.js'), 'export const fixture = true\n')
  }
  const artifacts = join(root, 'artifacts')
  const referenceDirectory = join(artifacts, 'published-reference/captures/smoke')
  mkdirSync(referenceDirectory, { recursive: true })
  const before = row(' mayfly v0.1.4-rc.2')
  const after = row(' mayfly v0.1.5')
  const make = value => serializeGrid({ cols: 40, lines: [value.text, '  Esc close'], styles: [value.styles, []], cursor: null })
  const reference = make(before)
  let candidate = make(after)
  const filename = 'startup-40x2.grid'
  writeFileSync(join(referenceDirectory, filename), reference)
  const steps = [{ step: 'checkpoint', name: 'startup' }]
  writeJson(join(referenceDirectory, 'reference.json'), { ...SPLIT_REFERENCE, stepsSha256: hash(JSON.stringify(steps)), checkpoints: { [filename]: hash(reference) } })
  const runtime = builtSplitRuntime(root)
  const result = { scenario: 'smoke', status: 'failed', parityVerified: false, cols: 40, rows: 2, dsh: '0.2.2-alpha.3',
    builtRuntime: { before: runtime, after: runtime, stable: true }, checkpoints: ['startup'], checkpointDimensions: { startup: { cols: 40, rows: 2 } }, failures: [],
  }
  const suite = { results: [result], failures: [], parityVerified: false }
  const policy = { schemaVersion: 1, version: '0.1.5', harness: '0.2.2-alpha.3', reference: SPLIT_REFERENCE.integrity, sources: {}, nativeFacts: {}, decisions: [] }
  const sample = { root, artifacts, suite, policy, scenarios: { smoke: { steps } }, result, reference, referenceDirectory,
    update: transform => {
      candidate = serializeGrid(transform(parseGrid(candidate)))
      writeFileSync(join(artifacts, filename), candidate)
      result.failures = [`startup:\n${diffGrids(reference, candidate).join('\n')}`]
      suite.failures = [...result.failures]
    },
  }
  sample.update(grid => grid)
  return sample
}

const rejected = (sample, pattern) => {
  const result = reviewSplitReleaseSuite(sample)
  assert.equal(result.status, 'rejected')
  assert.match(result.failures.join('\n'), pattern)
}

test('a release version carries the frozen palette and preserves raw strict failures and bytes', t => {
  const sample = fixture(t)
  const before = readFileSync(join(sample.artifacts, 'startup-40x2.grid'))
  const result = reviewSplitReleaseSuite(sample)
  assert.equal(result.status, 'passed-with-reviewed-differences')
  assert.equal(result.strictParityVerified, false)
  assert.deepEqual(result.strictFailures, sample.suite.failures)
  assert.deepEqual(result.results[0].reviewedDifferences.map(item => item.rule), ['release-version'])
  assert.deepEqual(readFileSync(join(sample.artifacts, 'startup-40x2.grid')), before)
})

test('a version field cannot review arbitrary labels, shifted layout, colors or attributes', () => {
  const a = row(' mayfly v0.1.4-rc.2')
  assert.ok(releaseVersionRow(a, row(' mayfly v0.1.5'), 40, '0.1.5'))
  for (const b of [row(' mayfly v0.1.6'), row('  mayfly v0.1.5'), row(' other v0.1.5'), { ...row(' mayfly v0.1.5'), styles: [{ from: 1, to: 13, style: 'fg:#ff0000 b' }] }]) assert.equal(releaseVersionRow(a, b, 40, '0.1.5'), false)
})

test('an honestly regenerated raw diff still rejects unknown text, styles, cursor and dimensions', t => {
  for (const transform of [
    grid => ({ ...grid, lines: [grid.lines[0], '  Esc CLOSE'] }),
    grid => ({ ...grid, styles: [[{ from: 1, to: 13, style: 'fg:#ff0000' }], []] }),
    grid => ({ ...grid, cursor: [1, 2] }),
    grid => ({ ...grid, cols: 41 }),
  ]) {
    const sample = fixture(t)
    sample.update(transform)
    rejected(sample, /Unreviewed|Dimensions or cursor/u)
  }
})

test('missing checkpoints, capture errors, stale builds and a different Harness always block', t => {
  for (const mutate of [
    sample => { sample.result.checkpoints = [] },
    sample => { sample.result.checkpointDimensions = {} },
    sample => { sample.result.failures.push('Host crashed'); sample.suite.failures.push('Host crashed') },
    sample => { sample.result.builtRuntime.stable = false },
    sample => { sample.result.dsh = '0.2.2-alpha.4' },
    sample => { sample.suite.results.push(sample.result) },
    sample => { sample.suite.failures = [] },
    sample => { sample.result.status = 'passed' },
    sample => { writeFileSync(join(sample.root, 'packages/remote/lib/entry.js'), 'changed') },
  ]) {
    const sample = fixture(t)
    mutate(sample)
    rejected(sample, /Missing|runtime|Capture|Harness|scenarios|summary|verdict/u)
  }
})

test('content decisions bind an exact named row, its style, dimensions and owning source', t => {
  const sample = fixture(t)
  const path = join(sample.root, 'notes.ts')
  writeFileSync(path, 'export const notes = "new release notes"\n')
  sample.policy.sources['notes.ts'] = hash(readFileSync(path))
  sample.update(grid => ({ ...grid, lines: [grid.lines[0], '  New release notes'] }))
  sample.policy.decisions.push({ scenario: 'smoke', checkpoint: 'startup', cols: 40, rows: 2, row: 1, category: 'release-content', reason: 'Exact accepted release notes with unchanged panel framing.', reference: { text: '  Esc close', styles: [] }, candidate: { text: '  New release notes', styles: [] } })
  assert.equal(reviewSplitReleaseSuite(sample).status, 'passed-with-reviewed-differences')
  sample.update(grid => ({ ...grid, lines: [grid.lines[0], '  New release NOTES'] }))
  rejected(sample, /Unreviewed/u)
  writeFileSync(path, 'changed')
  rejected(sample, /Reviewed source changed/u)
})

test('a reference capture failure still runs the candidate and remains a raw suite failure', async t => {
  const sample = fixture(t)
  const events = []
  const report = await runSplitSuite({ root: sample.root, artifacts: sample.artifacts, scenarios: ['smoke'], log() {},
    captureReference: async () => { events.push('reference'); throw new Error('Reference exploded') },
    runScenario: async () => { events.push('candidate'); return { ...sample.result, status: 'smoke-only', failures: [] } },
  })
  assert.deepEqual(events, ['reference', 'candidate'])
  assert.equal(report.results[0].candidateStatus, 'smoke-only')
  assert.equal(report.results[0].status, 'failed')
  assert.equal(report.parityVerified, false)
  assert.match(report.failures[0], /Reference exploded/u)
  sample.suite = report
  rejected(sample, /Only the documented/u)
})

test('reference-only capture failures remain fatal and never run a candidate', async t => {
  const sample = fixture(t)
  const report = await runSplitSuite({ root: sample.root, artifacts: sample.artifacts, scenarios: ['smoke'], captureReferenceOnly: true, log() {},
    captureReference: async () => { throw new Error('Cannot acquire reference') },
    runScenario: async () => { assert.fail('Candidate ran during reference-only capture') },
  })
  assert.equal(report.results[0].status, 'failed')
  assert.match(report.failures[0], /Cannot acquire reference/u)
})

test('native reviews recheck persisted projections and actual request events on both sides', t => {
  const sample = fixture(t)
  const expected = { contextWindow: 1048576, systemTokens: '1.1k', selectionVersion: 3, lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' } }
  const cache = { record: { rows: { contextPressure: { val: { contextWindow: 1048576 } }, contextBreakdown: { val: { breakdown: { systemTokens: 1119 } } }, modelSelection: { ver: 3, val: { lastUsed: expected.lastUsed } } } } }
  const event = { type: 'request/header', seq: 12, data: { header: { config: { reasoningEffort: 'high' }, adapterDefaults: { reasoningEffort: true } } } }
  writeJson(join(sample.root, 'cache.json'), cache)
  const journal = join(sample.root, 'session.jsonl.zstd')
  writeFileSync(journal, execFileSync('zstd', ['-q', '-c'], { input: JSON.stringify(event) + '\n' }))
  const evidence = { runDirectory: sample.root, files: { 'cache.json': hash(readFileSync(join(sample.root, 'cache.json'))), 'session.jsonl.zstd': hash(readFileSync(journal)) }, referenceManifestSha256: hash(readFileSync(join(sample.referenceDirectory, 'reference.json'))) }
  sample.result.nativeEvidence = evidence
  sample.policy.nativeFacts.smoke = { reference: expected, candidate: expected }
  writeJson(join(sample.referenceDirectory, 'capture-evidence.json'), evidence)
  assert.equal(reviewSplitReleaseSuite(sample).status, 'passed-with-reviewed-differences')
  writeFileSync(journal, execFileSync('zstd', ['-q', '-c'], { input: JSON.stringify({ ...event, data: { header: { config: { reasoningEffort: 'low' }, adapterDefaults: { reasoningEffort: true } } } }) + '\n' }))
  rejected(sample, /checksum differs/u)
  evidence.files['session.jsonl.zstd'] = hash(readFileSync(journal))
  writeJson(join(sample.referenceDirectory, 'capture-evidence.json'), evidence)
  rejected(sample, /adapter-default effort/u)
})

test('only the exact evidenced immutable file-preview failure can yield behavior-only acceptance', t => {
  const sample = fixture(t)
  const referenceDirectory = join(sample.artifacts, 'published-reference/captures/files')
  renameSync(sample.referenceDirectory, referenceDirectory)
  sample.scenarios = { files: { ...sample.scenarios.smoke, fixture: 'native-files' } }
  sample.result.scenario = 'files'
  sample.result.candidateStatus = 'smoke-only'
  sample.result.referenceFailure = { message: 'Published reference capture failed', captureDirectory: referenceDirectory }
  sample.result.failures = [sample.result.referenceFailure.message]
  sample.suite.failures = [...sample.result.failures]
  const ansi = 'Description: Deterministic native delivery\nFile unavailable\nStatus: cannot get property "fs" without inject\n'
  writeFileSync(join(referenceDirectory, 'reference.ansi'), ansi)
  const evidence = { ...SPLIT_REFERENCE, interactionSha256: hash('immutable reference implementation'), failures: ['Error: Expected text did not disappear: Description:\n    at fixture'], checkpoints: ['files-delivered-detail'], ansiSha256: hash(ansi) }
  sample.policy.referenceFilePreview = { interactionSha256: evidence.interactionSha256 }
  writeJson(join(referenceDirectory, 'capture-evidence.json'), evidence)
  const result = reviewSplitReleaseSuite(sample)
  assert.equal(result.status, 'passed-with-reviewed-differences')
  assert.equal(result.results[0].status, 'behavior-passed-reference-defect')
  assert.equal(result.strictParityVerified, false)
  for (const field of ['interactionSha256', 'ansiSha256']) {
    writeJson(join(referenceDirectory, 'capture-evidence.json'), { ...evidence, [field]: hash('tampered') })
    rejected(sample, /immutable implementation|checksum/u)
  }
  writeJson(join(referenceDirectory, 'capture-evidence.json'), { ...evidence, failures: ['Error: unrelated timeout\n'] })
  rejected(sample, /Unexpected reference/u)
  writeJson(join(referenceDirectory, 'capture-evidence.json'), evidence)
  sample.result.failures.push('Candidate did not exit cleanly')
  sample.suite.failures.push('Candidate did not exit cleanly')
  rejected(sample, /Candidate runtime failure/u)
})
