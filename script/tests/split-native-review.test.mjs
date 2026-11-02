import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { diffGrids, parseGrid, serializeGrid } from '../scenarios/grid.mjs'
import { builtSplitRuntime, persistedSplitEvidence } from '../scenarios/split-evidence.mjs'
import { reviewSplitNativeDifferences } from '../scenarios/split-native-review.mjs'
import { SPLIT_REFERENCE } from '../scenarios/split-reference.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const root = fileURLToPath(new URL('../..', import.meta.url))
const palette = 'fg:#9aa3b8'
const row = (text, style = palette) => ({ text, styles: [{ from: 2, to: Math.max(2, text.length - 1), style }] })

function fixture(t, { exact = false } = {}) {
  const dir = join(tmpdir(), `mayfly-native-review-${randomUUID()}`)
  mkdirSync(join(dir, 'reference'), { recursive: true })
  mkdirSync(join(dir, 'candidate'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const text = value => `  Context window: 32 / ${value} (1%)`
  const leftRow = row(text('977k'))
  const rightRow = exact ? leftRow : row(text('1M'))
  const makeGrid = (item, warning) => serializeGrid({ cols: 80, lines: [item.text, warning ?? '', '  Esc close'], styles: [item.styles, [], []], cursor: null })
  const left = makeGrid(leftRow)
  const right = makeGrid(rightRow)
  const file = 'context-80x3.grid'
  writeFileSync(join(dir, 'reference', file), left)
  writeFileSync(join(dir, 'candidate', file), right)
  const manifest = { ...SPLIT_REFERENCE, harness: '0.2.1-rc.2', checkpoints: { [file]: hash(left) } }
  writeFileSync(join(dir, 'reference/reference.json'), JSON.stringify(manifest))
  const report = { status: exact ? 'passed' : 'failed', parityVerified: exact, cols: 80, rows: 3, checkpoints: ['context'], failures: exact ? [] : [`context:\n${diffGrids(left, right).join('\n')}`] }
  writeFileSync(join(dir, 'candidate/report.json'), JSON.stringify(report))
  writeFileSync(join(dir, 'cache.json'), JSON.stringify({ record: { rows: { contextPressure: { val: { contextWindow: 1048576 } } } } }))
  writeFileSync(join(dir, 'consumer.ts'), "const faces = ['contextPressure', 'contextBreakdown']\n")
  const artifact = path => ({ path, sha256: hash(readFileSync(join(dir, path))) })
  const evidence = [
    { id: 'native-context', kind: 'native-data', source: artifact('cache.json'), assertions: [{ pointer: '/record/rows/contextPressure/val/contextWindow', equals: 1048576 }] },
    { id: 'direct-projection-consumer', kind: 'implementation-source', source: artifact('consumer.ts'), assertions: [{ includes: "'contextPressure'" }] },
  ]
  const plan = { schemaVersion: 1, rawReport: artifact('candidate/report.json'), referenceManifest: artifact('reference/reference.json'), candidateDirectory: 'candidate', evidence, decisions: exact ? [] : [{
    checkpoint: 'context', cols: 80, rows: 3, referenceSha256: hash(left), candidateSha256: hash(right), items: [{
      rule: 'context-window', category: 'native-fact', reason: 'The official native projection reports a binary one-megatoken window.', evidence: evidence.map(item => item.id),
      changes: [{ row: 0, reference: leftRow, candidate: rightRow, from: 23, to: 33, prefix: '  Context window: 32 / ', suffix: ' (1%)' }],
    }],
  }] }
  return { dir, plan, report, manifest, artifact, left, right }
}

const review = fixture => reviewSplitNativeDifferences(fixture.plan, { base: fixture.dir })
const reject = (fixture, pattern) => { const result = review(fixture); assert.equal(result.status, 'rejected'); assert.match(result.failures.join('\n'), pattern); return result }

test('exact native review keeps the original strict failed report and all grid bytes intact', t => {
  const sample = fixture(t)
  const before = readFileSync(join(sample.dir, 'candidate/report.json'))
  const result = review(sample)
  assert.equal(result.status, 'reviewed-native-differences')
  assert.equal(result.strictStatus, 'failed')
  assert.equal(result.strictParityVerified, false)
  assert.deepEqual(result.strictFailures, sample.report.failures)
  assert.deepEqual(result.reviewedDifferences.map(item => item.rule), ['context-window'])
  assert.deepEqual(readFileSync(join(sample.dir, 'candidate/report.json')), before)
  assert.equal(readFileSync(join(sample.dir, 'candidate/context-80x3.grid'), 'utf8'), sample.right)
})

test('already exact checkpoints are reported separately and cannot acquire an unnecessary waiver', t => {
  const sample = fixture(t, { exact: true })
  const result = review(sample)
  assert.equal(result.status, 'strict-exact')
  assert.deepEqual(result.exactCheckpoints, ['context'])
  sample.plan.decisions.push({ checkpoint: 'context' })
  reject(sample, /unnecessary review/u)
})

test('unreviewed checkpoints, unknown rules, missing sources and incorrect native facts fail closed', t => {
  for (const mutate of [
    sample => { sample.plan.decisions = [] },
    sample => { sample.plan.decisions[0].items[0].rule = 'ignore-all-numbers' },
    sample => { sample.plan.decisions[0].items[0].evidence = ['native-context'] },
    sample => { sample.plan.evidence[0].assertions[0].equals = 1000000 },
    sample => { sample.plan.evidence[0].assertions[0].pointer = '/record/absent' },
    sample => { sample.plan.decisions[0].items[0].evidence.push('missing-source') },
  ]) {
    const sample = fixture(t)
    mutate(sample)
    reject(sample, /Unreviewed|Unknown|requires|fact differs|Missing/u)
  }
})

test('every raw report, reference manifest, source and grid hash is checked before acceptance', t => {
  for (const file of ['candidate/report.json', 'reference/reference.json', 'cache.json', 'consumer.ts', 'candidate/context-80x3.grid', 'reference/context-80x3.grid']) {
    const sample = fixture(t)
    const path = join(sample.dir, file)
    writeFileSync(path, readFileSync(path, 'utf8') + '\n')
    reject(sample, /checksum mismatch|checksum|SHA/u)
  }
})

test('extra nonvisual failures cannot be approved by a native visual review', t => {
  const sample = fixture(t)
  sample.report.failures.push('Detaching Remote stopped the Host')
  writeFileSync(join(sample.dir, 'candidate/report.json'), JSON.stringify(sample.report))
  sample.plan.rawReport = sample.artifact('candidate/report.json')
  reject(sample, /nonvisual runtime failures/u)
})

test('a recapture cannot reuse a decision even if the raw report was honestly regenerated', t => {
  const sample = fixture(t)
  const next = sample.right.replace('Esc close', 'Esc CLOSE')
  writeFileSync(join(sample.dir, 'candidate/context-80x3.grid'), next)
  sample.report.failures = [`context:\n${diffGrids(sample.left, next).join('\n')}`]
  writeFileSync(join(sample.dir, 'candidate/report.json'), JSON.stringify(sample.report))
  sample.plan.rawReport = sample.artifact('candidate/report.json')
  reject(sample, /grid checksum mismatch/u)
  sample.plan.decisions[0].candidateSha256 = hash(next)
  reject(sample, /Unexpected cells/u)
})

test('cursor, dimensions and styles outside the reviewed native value remain strict', t => {
  for (const transform of [
    grid => ({ ...grid, cursor: [0, 2] }),
    grid => ({ ...grid, cols: 81 }),
    grid => ({ ...grid, styles: grid.styles.map((styles, at) => at === 0 ? [{ from: 0, to: 1, style: 'fg:#ff0000' }, ...styles] : styles) }),
    grid => ({ ...grid, styles: grid.styles.map((styles, at) => at === 0 ? styles.map(run => ({ ...run, style: 'fg:#ff0000' })) : styles) }),
  ]) {
    const sample = fixture(t)
    const next = serializeGrid(transform(parseGrid(sample.right)))
    writeFileSync(join(sample.dir, 'candidate/context-80x3.grid'), next)
    sample.report.failures = [`context:\n${diffGrids(sample.left, next).join('\n')}`]
    writeFileSync(join(sample.dir, 'candidate/report.json'), JSON.stringify(sample.report))
    sample.plan.rawReport = sample.artifact('candidate/report.json')
    sample.plan.decisions[0].candidateSha256 = hash(next)
    sample.plan.decisions[0].items[0].changes[0].candidate = { text: parseGrid(next).lines[0], styles: parseGrid(next).styles[0] }
    reject(sample, /dimensions or cursor|Style change outside|changed color\/style/u)
  }
})

test('a named numeric rule cannot approve changed content or arbitrary rows', t => {
  const sample = fixture(t)
  sample.plan.decisions[0].items[0].changes[0].candidate.text = '  Context window: everything is fine'
  reject(sample, /precise named rule/u)
  sample.plan.decisions[0].items[0].changes[0].candidate.text = '  Context window: 32 / 1M (1%)'
  sample.plan.decisions[0].items[0].changes[0].prefix = '  Context window: 31 / '
  reject(sample, /surrounding text/u)
})

test('model provenance changes require independent same-facts strict visual proof', t => {
  const sample = fixture(t)
  const item = sample.plan.decisions[0].items[0]
  item.rule = 'model-effort-provenance'
  sample.plan.evidence.push({ id: 'native-api', kind: 'native-api', source: sample.artifact('consumer.ts'), assertions: [{ includes: 'contextPressure' }] })
  item.evidence.push('native-api')
  reject(sample, /same-facts-visual/u)
})

test('same-facts visual evidence rechecks the frozen manifest and original strict grid comparison', t => {
  const sample = fixture(t)
  const proof = {
    id: 'same-facts', kind: 'same-facts-visual', checkpoint: 'context', cols: 80, rows: 3,
    manifest: sample.artifact('reference/reference.json'), reference: sample.artifact('reference/context-80x3.grid'), candidate: sample.artifact('candidate/context-80x3.grid'),
  }
  sample.plan.evidence.push(proof)
  reject(sample, /not strict exact/u)
  writeFileSync(join(sample.dir, 'same-facts.grid'), sample.left)
  proof.candidate = sample.artifact('same-facts.grid')
  assert.equal(review(sample).status, 'reviewed-native-differences')
})

test('journal evidence verifies the exact event identity and payload rather than a derived summary', t => {
  const sample = fixture(t)
  writeFileSync(join(sample.dir, 'native.jsonl'), [
    { type: 'session', id: 'session-native' },
    { type: 'request/header', seq: 12, data: { header: { config: { reasoningEffort: 'high' }, adapterDefaults: { reasoningEffort: true } } } },
    { type: 'model/selection', seq: 20, data: { provider: 'deepseek-official', model: 'deepseek-flash' } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n')
  const journal = { id: 'native-journal', kind: 'native-data', source: { ...sample.artifact('native.jsonl'), format: 'jsonl' }, assertions: [{ event: { type: 'request/header', seq: 12 }, pointer: '/data/header/adapterDefaults/reasoningEffort', equals: true }] }
  sample.plan.evidence.push(journal)
  assert.equal(review(sample).status, 'reviewed-native-differences')
  journal.assertions[0].equals = false
  reject(sample, /journal event fact differs/u)
  journal.assertions[0].equals = true
  journal.assertions[0].event.seq = 20
  reject(sample, /journal event fact differs/u)
})

test('partial API review requires the explicit limitation in the corresponding command grid', t => {
  const sample = fixture(t)
  const item = sample.plan.decisions[0].items[0]
  item.rule = 'remote-ui-hot-load'
  item.category = 'partial-api'
  sample.plan.evidence.push({ id: 'native-api', kind: 'native-api', source: sample.artifact('consumer.ts'), assertions: [{ includes: 'contextPressure' }] })
  item.evidence.push('native-api')
  item.changes[0].reference.text = '    Mayfly Cordis  Mayfly 终端 UI 的创造模式：上游 Cordis 能力'
  item.changes[0].candidate.text = '    Mayfly Cordis  TUI 热挂载 API 暂缺'
  reject(sample, /limitation is absent/u)
})

test('the precise preset limitation is reviewed as partial API behavior, with its raw failure retained', t => {
  const sample = fixture(t)
  const reference = row('    Mayfly Cordis  Mayfly 终端 UI 的创造模式：上游 Cordis 能力')
  const candidate = row('    Mayfly Cordis  TUI 热挂载 API 暂缺；前端扩展需源码集成并重启')
  const make = item => serializeGrid({ cols: 80, lines: [item.text, '', '  Esc close'], styles: [item.styles, [], []], cursor: null })
  const left = make(reference)
  const right = make(candidate)
  writeFileSync(join(sample.dir, 'reference/context-80x3.grid'), left)
  writeFileSync(join(sample.dir, 'candidate/context-80x3.grid'), right)
  sample.manifest.checkpoints['context-80x3.grid'] = hash(left)
  writeFileSync(join(sample.dir, 'reference/reference.json'), JSON.stringify(sample.manifest))
  sample.report.failures = [`context:\n${diffGrids(left, right).join('\n')}`]
  writeFileSync(join(sample.dir, 'candidate/report.json'), JSON.stringify(sample.report))
  sample.plan.rawReport = sample.artifact('candidate/report.json')
  sample.plan.referenceManifest = sample.artifact('reference/reference.json')
  const decision = sample.plan.decisions[0]
  decision.referenceSha256 = hash(left)
  decision.candidateSha256 = hash(right)
  const item = decision.items[0]
  item.rule = 'remote-ui-hot-load'
  item.category = 'partial-api'
  item.reason = 'The current native API has no independent frontend hot-load entry; the command roster labels that limitation.'
  item.changes = [{ row: 0, reference, candidate, from: 18, to: 79, prefix: '    Mayfly Cordis  ', suffix: '' }]
  sample.plan.evidence.push({ id: 'native-api', kind: 'native-api', source: sample.artifact('consumer.ts'), assertions: [{ includes: 'contextPressure' }] })
  item.evidence.push('native-api')
  const result = review(sample)
  assert.equal(result.status, 'reviewed-native-differences')
  assert.equal(result.strictParityVerified, false)
  assert.deepEqual(result.reviewedDifferences.map(item => item.category), ['partial-api'])
})

test('a forged header row count cannot become exact through parsing and reserialization', t => {
  const sample = fixture(t)
  const next = sample.right.replace('80x3', '80x2')
  writeFileSync(join(sample.dir, 'candidate/context-80x3.grid'), next)
  sample.report.failures = [`context:\n${diffGrids(sample.left, next).join('\n')}`]
  writeFileSync(join(sample.dir, 'candidate/report.json'), JSON.stringify(sample.report))
  sample.plan.rawReport = sample.artifact('candidate/report.json')
  sample.plan.decisions[0].candidateSha256 = hash(next)
  reject(sample, /dimensions or cursor/u)
})

test('the separate CLI writes a reviewed result and never relabels the raw strict result', t => {
  const sample = fixture(t)
  const planFile = join(sample.dir, 'review.json')
  const resultFile = join(sample.dir, 'review-result.json')
  writeFileSync(planFile, JSON.stringify(sample.plan))
  const output = execFileSync(process.execPath, ['script/split-native-review.mjs', '--review', planFile, '--results', resultFile], { cwd: root, encoding: 'utf8' })
  assert.match(output, /reviewed-native-differences; strictParityVerified=false/u)
  assert.equal(JSON.parse(readFileSync(resultFile, 'utf8')).status, 'reviewed-native-differences')
  assert.equal(JSON.parse(readFileSync(join(sample.dir, 'candidate/report.json'), 'utf8')).status, 'failed')
  assert.throws(() => execFileSync(process.execPath, ['script/split-native-review.mjs', '--review', planFile, '--results', join(sample.dir, 'candidate/report.json')], { cwd: root, stdio: 'pipe' }), /Command failed/u)
})

test('capture provenance hashes emitted runtime and settled native artifacts, independently of checkout HEAD', t => {
  const sample = fixture(t)
  assert.deepEqual(persistedSplitEvidence(undefined), undefined)
  assert.deepEqual(persistedSplitEvidence(sample.dir), { runDirectory: sample.dir, files: {} })
  for (const name of ['ui', 'mayfly', 'host', 'remote']) {
    const lib = join(sample.dir, 'packages', name, 'lib')
    mkdirSync(lib, { recursive: true })
    writeFileSync(join(lib, 'entry.js'), `export const owner = '${name}'\n`)
    writeFileSync(join(lib, 'entry.js.map'), '{}')
  }
  const first = builtSplitRuntime(sample.dir)
  assert.equal(Object.keys(first.files).length, 4)
  writeFileSync(join(sample.dir, 'packages/remote/lib/entry.js'), 'export const owner = "changed"\n')
  assert.notEqual(first.sha256, builtSplitRuntime(sample.dir).sha256)
  mkdirSync(join(sample.dir, 'sessions/session-a'), { recursive: true })
  mkdirSync(join(sample.dir, 'storages/session_projcache/sessions'), { recursive: true })
  writeFileSync(join(sample.dir, 'sessions/session-a/session.v4.jsonl.zstd'), 'settled journal bytes')
  writeFileSync(join(sample.dir, 'sessions/session-a/session.lock'), 'ignored')
  writeFileSync(join(sample.dir, 'storages/session_projcache/sessions/session-a.json'), '{"record":{}}')
  const native = persistedSplitEvidence(sample.dir)
  assert.equal(Object.keys(native.files).length, 2)
  assert.equal(native.files['sessions/session-a/session.v4.jsonl.zstd'], hash('settled journal bytes'))
  assert.equal(native.files['storages/session_projcache/sessions/session-a.json'], hash('{"record":{}}'))
})
