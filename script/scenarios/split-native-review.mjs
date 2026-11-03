/** Validate exact, evidence-linked review decisions without changing strict parity results. @module script/scenarios/split-native-review */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { diffGrids, parseGrid, serializeGrid } from './grid.mjs'
import { compareSplitReference, normalizeSplitGrid } from './split-reference.mjs'

const RULES = Object.freeze({
  'harness-version': { category: 'native-fact', markers: ['  Harness: '], evidence: ['native-data'] },
  'context-window': { category: 'native-fact', markers: ['Context window:'], evidence: ['native-data', 'implementation-source'] },
  'context-system-tokens': { category: 'native-fact', markers: ['System prompt:'], evidence: ['native-data', 'implementation-source'] },
  'model-context-window': { category: 'native-fact', markers: [' context'], evidence: ['native-data', 'implementation-source', 'same-facts-visual'] },
  'model-effort-provenance': { category: 'native-fact', markers: ['Thinking:', 'Enter choose'], evidence: ['native-data', 'native-api', 'implementation-source', 'same-facts-visual'] },
  'stats-context-window': { category: 'native-fact', markers: ['  Context:'], evidence: ['native-data', 'implementation-source'] },
  'stats-harness-version': { category: 'native-fact', markers: ['  Version:'], evidence: ['native-data'] },
  'frontend-local-command-journal': { category: 'native-fact', evidence: ['native-data', 'implementation-source', 'same-facts-visual'] },
  'remote-ui-hot-load': { category: 'partial-api', warning: 'TUI 热挂载 API 暂缺', markers: ['Mayfly Cordis'], evidence: ['native-api', 'implementation-source'] },
})

const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const unique = values => new Set(values).size === values.length
const fail = message => { throw new Error(message) }

function checkedFile(base, file) {
  if (typeof file?.path !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256 ?? '')) fail('Every review artifact needs a path and exact SHA-256')
  const path = resolve(base, file.path)
  const bytes = readFileSync(path)
  if (digest(bytes) !== file.sha256) fail(`Review artifact checksum mismatch: ${file.path}`)
  return { path, bytes }
}

function pointerValue(value, pointer) {
  if (pointer === '') return value
  if (typeof pointer !== 'string' || !pointer.startsWith('/')) fail('Evidence JSON pointers must use RFC 6901 syntax')
  for (const raw of pointer.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) fail(`Missing evidence fact: ${pointer}`)
    value = value[key]
  }
  return value
}

function checkEvidence(base, item) {
  if (!['native-data', 'native-api', 'implementation-source', 'same-facts-visual'].includes(item.kind)) fail(`Unknown evidence kind: ${item.kind}`)
  if (item.kind === 'same-facts-visual') {
    const manifest = checkedFile(base, item.manifest)
    const actual = checkedFile(base, item.candidate)
    const reference = checkedFile(base, item.reference)
    const frozen = readJson(manifest.path)
    const file = `${item.checkpoint}-${item.cols}x${item.rows}.grid`
    if (frozen.checkpoints?.[file] !== digest(reference.bytes) || resolve(dirname(manifest.path), file) !== reference.path) fail('Same-facts proof does not identify its immutable reference checkpoint')
    const differences = compareSplitReference(dirname(manifest.path), [{ name: item.checkpoint, grid: actual.bytes.toString(), cols: item.cols, rows: item.rows }], { cols: item.cols, rows: item.rows, startup: frozen.startup })
    if (differences.length !== 0) fail(`Same-facts visual proof is not strict exact: ${item.id}`)
    return
  }
  const source = checkedFile(base, item.source)
  if (!Array.isArray(item.assertions) || item.assertions.length === 0) fail(`Evidence has no asserted facts: ${item.id}`)
  let events
  if (item.source.format !== undefined) {
    if (!['jsonl', 'jsonl-zstd'].includes(item.source.format) || item.kind !== 'native-data') fail(`Unknown native evidence format: ${item.source.format}`)
    // zstd's CLI reads every concatenated journal frame, including later turns.
    const bytes = item.source.format === 'jsonl-zstd' ? execFileSync('zstd', ['-d', '-c', '--', source.path], { maxBuffer: 32 * 1024 * 1024 }) : source.bytes
    events = bytes.toString().trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  }
  for (const assertion of item.assertions) {
    if (Object.hasOwn(assertion, 'event')) {
      if (events === undefined || !Number.isSafeInteger(assertion.event.seq) || typeof assertion.event.type !== 'string') fail(`Native event assertions require a journal: ${item.id}`)
      const matching = events.filter(event => event.seq === assertion.event.seq && event.type === assertion.event.type)
      if (matching.length !== 1 || !Object.hasOwn(assertion, 'equals') || !isDeepStrictEqual(pointerValue(matching[0], assertion.pointer), assertion.equals)) fail(`Native journal event fact differs: ${item.id} ${assertion.event.seq}`)
    } else if (Object.hasOwn(assertion, 'pointer')) {
      if (!Object.hasOwn(assertion, 'equals') || !isDeepStrictEqual(pointerValue(JSON.parse(source.bytes.toString()), assertion.pointer), assertion.equals)) fail(`Evidence JSON fact differs: ${item.id} ${assertion.pointer}`)
    } else if (typeof assertion.includes === 'string' && assertion.includes.length > 0) {
      if (!source.bytes.toString().includes(assertion.includes)) fail(`Evidence source assertion differs: ${item.id}`)
    } else fail(`Unknown evidence assertion: ${item.id}`)
  }
}

function checkChange(rule, change, left, right) {
  const row = change.row
  if (!Number.isInteger(row) || row < 0 || row >= left.lines.length) fail('Review row is outside the captured terminal')
  const expected = { text: left.lines[row], styles: left.styles[row] }
  const actual = { text: right.lines[row], styles: right.styles[row] }
  if (!isDeepStrictEqual(change.reference, expected) || !isDeepStrictEqual(change.candidate, actual)) fail(`Reviewed row bytes/styles differ at row ${row}`)
  if (isDeepStrictEqual(expected, actual)) fail(`Review includes an unchanged row ${row}`)
  if (rule.markers !== undefined && !rule.markers.some(marker => expected.text.includes(marker) && actual.text.includes(marker))) fail(`Reviewed row is outside the named native field: ${row}`)
  // A review lists the exact native value span, including any style-length change.
  // Other cells' colors, spacing and content still compare without normalization.
  if (!Number.isInteger(change.from) || !Number.isInteger(change.to) || change.from < 0 || change.to < change.from || change.to >= left.cols) fail(`Review needs a bounded native field span at row ${row}`)
  const styleAt = (runs, col) => runs.find(run => run.from <= col && run.to >= col)?.style ?? ''
  for (let col = 0; col < left.cols; col += 1) {
    if (col >= change.from && col <= change.to) continue
    if (styleAt(expected.styles, col) !== styleAt(actual.styles, col)) fail(`Style change outside reviewed field at ${row},${col}`)
  }
  if (typeof change.prefix !== 'string' || typeof change.suffix !== 'string' || !expected.text.startsWith(change.prefix) || !actual.text.startsWith(change.prefix) || !expected.text.endsWith(change.suffix) || !actual.text.endsWith(change.suffix)) fail(`Review must retain exact surrounding text at row ${row}`)
}

function checkRuleScope(name, changes) {
  const pairs = changes.map(change => [change.reference.text, change.candidate.text])
  const single = predicate => pairs.length === 1 && predicate(...pairs[0])
  const replaceValue = (left, right, pattern) => {
    const a = pattern.exec(left)
    const b = pattern.exec(right)
    return a !== null && b !== null && a[1] === b[1] && a[3] === b[3] && a[2] !== b[2]
  }
  let allowed = false
  if (name === 'harness-version') allowed = single((a, b) => /^  Harness: \d+\.\d+\.\d+(?:[-.a-z0-9]+)?$/u.test(a) && /^  Harness: \d+\.\d+\.\d+(?:[-.a-z0-9]+)?$/u.test(b))
  else if (name === 'context-window') allowed = single((a, b) => replaceValue(a, b, /^(  Context window: [\d.kM]+ \/ )([\d.kM]+)( \(\d+%\))$/u))
  else if (name === 'context-system-tokens') allowed = single((a, b) => replaceValue(a, b, /^(.*System prompt: +█ )([\d.kM]+)( \([\d.]+%\))$/u))
  else if (name === 'model-context-window') allowed = pairs.length <= 2 && pairs.every(([a, b]) => replaceValue(a, b, /^( +[→ ]? ?\d+\. .+ +)([\d.kmM]+)( context)$/u))
  else if (name === 'model-effort-provenance') allowed = pairs.length === 2
    && pairs.some(([a, b]) => /^    ● Thinking: [a-z]+$/u.test(a) && b === a.replace('●', '○') + ' (default)')
    && pairs.some(([a, b]) => a === '  Enter choose · Delete use default · Esc close' && b === '  ←/→ thinking · Enter choose · Esc close')
  else if (name === 'remote-ui-hot-load') allowed = single((a, b) => /^ +Mayfly Cordis +Mayfly 终端 UI 的创造模式：/u.test(a) && /^ +Mayfly Cordis +TUI 热挂载 API 暂缺/u.test(b))
  else if (name === 'stats-context-window') allowed = single((a, b) => replaceValue(a, b, /^(  Context: +\d+% · [\d.kM]+ \/ )([\d.kM]+)()$/u))
  else if (name === 'stats-harness-version') allowed = single((a, b) => replaceValue(a, b, /^(  Version: +Mayfly 0\.1\.4-rc\.2 · Harness )([\d.a-z-]+)()$/u))
  else if (name === 'frontend-local-command-journal') allowed = single((a, b) => replaceValue(a, b, /^( +\(1\/)(\d+)(\))$/u) || replaceValue(a, b, /^( +copied )(\d+)( trace events via terminal escape sequence \(unverified\))$/u))
  if (!allowed) fail(`Changes do not match the precise named rule: ${name}`)
  if (['harness-version', 'context-window', 'context-system-tokens', 'model-context-window', 'stats-context-window', 'stats-harness-version', 'frontend-local-command-journal'].includes(name)) {
    for (const change of changes) checkFactStyles(change)
  }
}

function checkFactStyles(change) {
  const left = change.reference.text
  const right = change.candidate.text
  // These named English/numeric fact rows use one terminal cell per character.
  // Refuse a new wide/combining label instead of guessing terminal width here.
  if (!/^[\x20-\x7e→✓░█▱·]*$/u.test(left + right)) fail('Native numeric review needs a separately reviewed wide-label rule')
  let prefix = 0
  while (prefix < Math.min(left.length, right.length) && left[prefix] === right[prefix]) prefix += 1
  let suffix = 0
  while (suffix < Math.min(left.length - prefix, right.length - prefix) && left.at(-suffix - 1) === right.at(-suffix - 1)) suffix += 1
  const at = (runs, col) => runs.find(run => run.from <= col && run.to >= col)?.style ?? ''
  const before = Array.from({ length: change.to + 1 }, (_, col) => at(change.reference.styles, col))
  const expected = [...before.slice(0, prefix), ...Array.from({ length: right.length - prefix - suffix }, () => at(change.reference.styles, prefix)), ...before.slice(left.length - suffix)]
  const limit = Math.max(left.length, right.length, change.to + 1)
  for (let col = 0; col < limit; col += 1) {
    if ((expected[col] ?? '') !== at(change.candidate.styles, col)) fail(`Native fact changed color/style rather than only value length at ${change.row},${col}`)
  }
}

/**
 * A review is an explicit recorded decision tied to immutable bytes and source facts.
 * It is never a wildcard ignore list: recaptures need a fresh reviewed plan. Raw
 * failures, grids, style runs, cursor and dimensions are never rewritten.
 */
export function reviewSplitNativeDifferences(plan, { base = process.cwd() } = {}) {
  const output = { schemaVersion: 1, status: 'rejected', strictParityVerified: false, strictFailures: [], exactCheckpoints: [], reviewedDifferences: [], failures: [] }
  try {
    if (plan.schemaVersion !== 1) fail('Unsupported native review schema')
    const raw = checkedFile(base, plan.rawReport)
    const report = JSON.parse(raw.bytes.toString())
    output.rawReport = raw.path
    output.rawReportSha256 = plan.rawReport.sha256
    output.strictStatus = report.status
    output.strictParityVerified = report.parityVerified
    output.strictFailures = report.failures
    if (!['passed', 'failed'].includes(report.status) || !Array.isArray(report.failures) || !Array.isArray(report.checkpoints) || report.checkpoints.length === 0 || !unique(report.checkpoints)) fail('Review requires a complete strict visual report')
    if ((report.status === 'passed') !== (report.failures.length === 0) || report.parityVerified !== (report.status === 'passed')) fail('Strict report verdict is inconsistent')
    const manifestFile = checkedFile(base, plan.referenceManifest)
    const manifest = JSON.parse(manifestFile.bytes.toString())
    const referenceDir = dirname(manifestFile.path)
    const candidateDir = resolve(base, plan.candidateDirectory)
    const evidence = new Map()
    for (const item of plan.evidence ?? []) {
      if (typeof item.id !== 'string' || item.id.length === 0 || evidence.has(item.id)) fail('Review evidence ids must be unique')
      checkEvidence(base, item)
      evidence.set(item.id, item)
    }
    const checkpoints = report.checkpoints.map(name => {
      const decision = plan.decisions?.find(item => item.checkpoint === name)
      const dimensions = report.checkpointDimensions?.[name] ?? plan.checkpointDimensions?.[name] ?? decision
      const cols = dimensions?.cols ?? report.cols
      const rows = dimensions?.rows ?? report.rows
      const file = `${name}-${cols}x${rows}.grid`
      return { name, cols, rows, grid: readFileSync(join(candidateDir, file), 'utf8') }
    })
    const rawFailures = compareSplitReference(referenceDir, checkpoints, { cols: report.cols, rows: report.rows, startup: manifest.startup })
    if (!isDeepStrictEqual(rawFailures, report.failures)) fail('Strict report failures do not match the saved grids (including nonvisual runtime failures)')
    const decisions = plan.decisions ?? []
    if (!unique(decisions.map(item => item.checkpoint))) fail('Checkpoint review decisions must be unique')
    for (const decision of decisions) if (!report.checkpoints.includes(decision.checkpoint)) fail(`Review names an uncaptured checkpoint: ${decision.checkpoint}`)
    for (const checkpoint of checkpoints) {
      const file = `${checkpoint.name}-${checkpoint.cols}x${checkpoint.rows}.grid`
      const expected = readFileSync(join(referenceDir, file), 'utf8')
      const left = parseGrid(normalizeSplitGrid(expected))
      const right = parseGrid(normalizeSplitGrid(checkpoint.grid))
      const decision = decisions.find(item => item.checkpoint === checkpoint.name)
      if (diffGrids(normalizeSplitGrid(expected), normalizeSplitGrid(checkpoint.grid)).length === 0) {
        if (decision !== undefined) fail(`Exact checkpoint has an unnecessary review decision: ${checkpoint.name}`)
        output.exactCheckpoints.push(checkpoint.name)
        continue
      }
      if (decision === undefined) fail(`Unreviewed strict difference: ${checkpoint.name}`)
      if (decision.referenceSha256 !== digest(expected) || decision.candidateSha256 !== digest(checkpoint.grid)) fail(`Reviewed grid checksum mismatch: ${checkpoint.name}`)
      if (expected.split('\n')[0] !== checkpoint.grid.split('\n')[0] || left.cols !== right.cols || left.lines.length !== right.lines.length || !isDeepStrictEqual(left.cursor, right.cursor)) fail(`Native review cannot waive dimensions or cursor: ${checkpoint.name}`)
      const coveredRows = new Set()
      if (!Array.isArray(decision.items) || decision.items.length === 0) fail(`Missing native review items: ${checkpoint.name}`)
      for (const item of decision.items) {
        const rule = RULES[item.rule]
        if (rule === undefined || item.category !== rule.category || typeof item.reason !== 'string' || item.reason.trim().length < 20) fail(`Unknown or unexplained native review rule: ${item.rule}`)
        const sources = (item.evidence ?? []).map(id => evidence.get(id) ?? fail(`Missing evidence ${id}`))
        for (const kind of rule.evidence) if (!sources.some(source => source.kind === kind)) fail(`Rule ${item.rule} requires ${kind} evidence`)
        if (!Array.isArray(item.changes) || item.changes.length === 0) fail(`Native review has no exact changes: ${item.rule}`)
        checkRuleScope(item.rule, item.changes)
        if (rule.warning !== undefined && !right.lines.some(line => line.includes(rule.warning))) fail(`Partial API limitation is absent from its command UI: ${item.rule}`)
        for (const change of item.changes) {
          if (coveredRows.has(change.row)) fail(`Overlapping native review row: ${checkpoint.name} ${change.row}`)
          checkChange(rule, change, left, right)
          coveredRows.add(change.row)
          right.lines[change.row] = left.lines[change.row]
          right.styles[change.row] = left.styles[change.row]
        }
        output.reviewedDifferences.push({ checkpoint: checkpoint.name, rule: item.rule, category: item.category, reason: item.reason, evidence: item.evidence, rows: item.changes.map(change => change.row) })
      }
      const unexpected = diffGrids(serializeGrid(left), serializeGrid(right))
      if (unexpected.length > 0) fail(`Unexpected cells/styles remain at ${checkpoint.name}:\n${unexpected.join('\n')}`)
    }
    output.status = output.reviewedDifferences.length === 0 ? 'strict-exact' : 'reviewed-native-differences'
  } catch (error) {
    output.failures.push(error instanceof Error ? error.message : String(error))
  }
  return output
}
