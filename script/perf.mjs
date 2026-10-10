#!/usr/bin/env node
/**
 * Measure the perf scenarios of the catalog against the real product (roadmap Phase 2b).
 *
 *   pnpm run perf [-- <scenario>...] [--runs N] [--against <ref>] [--prof]   A/B against a baseline build
 *   pnpm run perf -- --assert [<scenario>...]                                 the current build against the ceilings
 *
 * The A/B interleaves runs of this checkout and of a baseline (the merge base with the comparison branch, or
 * `--against <ref>`; `--against HEAD` measures the noise of one build), each from a fresh boot, and judges every
 * metric of every span `regressed`, `same`, or `improved` (median, noise band, rank test). It reports and does not fail
 * on a verdict. `--assert` holds one run of each scenario to the catalog's ceilings, scaled by `MAYFLY_PERF_SLACK`, and
 * fails past them. `--prof` writes CPU profiles and lists the functions with the most self time. Results go to
 * `.artifacts/verify/perf.json` for `pnpm run check`. @module script/perf
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultBase } from './change-files.mjs'
import { CATALOG, PERF_SCENARIOS } from './scenarios/catalog.mjs'
import { commitOf, ensureBaseline, mergeBaseOf } from './scenarios/baseline.mjs'
import { selfTimes, topFunctions } from './scenarios/cpuprofile.mjs'
import { prepareProfiles, runScenario } from './scenarios/runner.mjs'
import { verdict } from './scenarios/stats.mjs'
import { assertDshVersion, resolveDshBin, root } from './smoke-lib.mjs'

export const RESULTS = '.artifacts/verify/perf.json'
/** The metrics judged per span; each is lower-is-better. `keyP50Ms` pools every key of every run. */
const METRICS = ['cpuPct', 'cpuPerKeyMs', 'keyP50Ms', 'frames', 'hwmKb']

/**
 * Parse the command line.
 * @param {string[]} argv
 */
export function parsePerfArgs(argv) {
  const options = { names: [], runs: 3, assert: false, prof: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') continue
    if (value === '--runs') options.runs = Number(argv[++index])
    else if (value === '--against') options.against = argv[++index]
    else if (value === '--assert') options.assert = true
    else if (value === '--prof') options.prof = true
    else if (value.startsWith('--')) return { error: `unknown option ${value}` }
    else if (!PERF_SCENARIOS.includes(value)) return { error: `"${value}" is not a perf scenario (one of ${PERF_SCENARIOS.join(', ')})` }
    else options.names.push(value)
  }
  if (!(Number.isInteger(options.runs) && options.runs > 0)) return { error: '--runs needs a positive integer' }
  return { options }
}

/**
 * The ceilings a run breaks: each span and metric past its ceiling times `slack`.
 * @param {Record<string, Record<string, number>>} ceilings - from the catalog; a trailing `*` matches a prefix.
 * @param {{ name: string }[]} spans
 * @returns {{ span: string, metric: string, value: number, ceiling: number }[]}
 */
export function breaches(ceilings, spans, slack = 1) {
  const out = []
  for (const span of spans) {
    for (const [pattern, limits] of Object.entries(ceilings)) {
      const matches = pattern.endsWith('*') ? span.name.startsWith(pattern.slice(0, -1)) : span.name === pattern
      if (!matches) continue
      for (const [metric, ceiling] of Object.entries(limits)) {
        const value = span[metric]
        if (value !== null && value !== undefined && value > ceiling * slack) out.push({ span: span.name, metric, value, ceiling: ceiling * slack })
      }
    }
  }
  return out
}

/**
 * Judge each span's metrics across runs of the two builds.
 * @param {{ metrics: object[] }[]} head - runs of this checkout.
 * @param {{ metrics: object[] }[]} base - runs of the baseline.
 */
export function compareRuns(head, base) {
  const spans = [...new Set(head.flatMap(run => run.metrics.map(span => span.name)))]
  return spans.map((name) => {
    const values = (runs, metric) => runs.flatMap((run) => {
      const span = run.metrics.find(entry => entry.name === name)
      if (span === undefined) return []
      if (metric === 'keyP50Ms') return span.keySamples ?? []
      return span[metric] === null || span[metric] === undefined ? [] : [span[metric]]
    })
    return { span: name, metrics: Object.fromEntries(METRICS.map(metric => [metric, verdict(values(head, metric), values(base, metric))]).filter(([, judged]) => judged.verdict !== 'unmeasured')) }
  })
}

const show = value => value === null || value === undefined ? 'n/a' : String(Number(value.toFixed(2)))

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parsePerfArgs(process.argv.slice(2))
  if ('error' in parsed) { console.error(parsed.error); process.exit(2) }
  const { options } = parsed
  const names = options.names.length > 0 ? options.names : PERF_SCENARIOS
  const dshBin = resolveDshBin()
  assertDshVersion(dshBin)
  const failures = []
  const report = { mode: options.assert ? 'assert' : 'ab', scenarios: [], failures }
  const profDir = side => join(root, '.artifacts/perf/prof', side)
  const measure = async (repo, name, side, run) => {
    const profileDir = options.prof ? join(profDir(side), `${name}-${String(run)}`) : undefined
    if (profileDir !== undefined) rmSync(profileDir, { recursive: true, force: true })
    const result = await runScenario(name, { root: repo, dshBin, profileDir })
    result.screen.dispose()
    for (const failure of result.failures) failures.push(`${name} (${side} run ${String(run)}): ${failure.split('\n')[0]}`)
    return result
  }

  if (options.assert) {
    prepareProfiles({ root, dshBin, names })
    const slack = Number(process.env.MAYFLY_PERF_SLACK ?? 1)
    for (const name of names) {
      const result = await measure(root, name, 'head', 1)
      const broken = breaches(CATALOG[name].perf.ceilings, result.metrics, slack)
      report.scenarios.push({ name, spans: result.metrics, breaches: broken })
      for (const span of result.metrics) console.log(`  ${name} ${span.name.padEnd(14)} ${show(span.cpuPct)}% CPU${span.keys === undefined ? '' : `, key p50 ${show(span.keyP50Ms)} ms, ${show(span.cpuPerKeyMs)} ms CPU per key`}`)
      for (const breach of broken) { console.log(`  ✗ ${name} ${breach.span} ${breach.metric}: ${show(breach.value)} (ceiling ${show(breach.ceiling)})`); failures.push(`${name} ${breach.span} ${breach.metric} ${show(breach.value)} is past its ceiling ${show(breach.ceiling)}`) }
    }
  } else {
    const headSha = commitOf(root, 'HEAD')
    const baseSha = options.against === undefined ? mergeBaseOf(root, defaultBase()) : commitOf(root, options.against)
    const sameBuild = baseSha === headSha && options.against === undefined
    // The baseline is always its own checkout and build, so the working tree's uncommitted changes stay on one side.
    const baseDir = sameBuild ? undefined : ensureBaseline(root, baseSha, { log: line => console.error(line) })
    report.baseline = { ref: options.against ?? `merge base with ${defaultBase()}`, sha: baseSha, dir: baseDir ?? null }
    if (sameBuild) console.log('perf: HEAD is the merge base, so there is no baseline to compare with; measuring HEAD only')
    prepareProfiles({ root, dshBin, names })
    if (baseDir !== undefined) prepareProfiles({ root: baseDir, dshBin, names })
    for (const name of names) {
      const head = []
      const base = []
      // Interleaved, so drift on the machine falls on both builds alike.
      for (let run = 1; run <= options.runs; run += 1) {
        const order = run % 2 === 1 ? ['head', 'base'] : ['base', 'head']
        for (const side of order) {
          if (side === 'head') head.push(await measure(root, name, 'head', run))
          else if (baseDir !== undefined) base.push(await measure(baseDir, name, 'base', run))
        }
      }
      const judged = baseDir === undefined ? [] : compareRuns(head, base)
      const prof = options.prof ? topFunctions(selfTimes(profDir('head')), baseDir === undefined ? undefined : selfTimes(profDir('base'))) : undefined
      report.scenarios.push({ name, runs: { head: head.map(run => run.metrics), base: base.map(run => run.metrics) }, judged, ...(prof === undefined ? {} : { prof }) })
      console.log(`\n${name}${baseDir === undefined ? '' : ` (head vs ${baseSha.slice(0, 10)}, ${String(options.runs)} runs each)`}`)
      for (const span of baseDir === undefined ? head[0]?.metrics ?? [] : []) console.log(`  ${span.name.padEnd(14)} ${show(span.cpuPct)}% CPU${span.keys === undefined ? '' : `, key p50 ${show(span.keyP50Ms)} ms, ${show(span.cpuPerKeyMs)} ms CPU per key`}`)
      for (const entry of judged) {
        for (const [metric, result] of Object.entries(entry.metrics)) {
          const mark = result.verdict === 'regressed' ? '✗' : result.verdict === 'improved' ? '↓' : result.verdict === 'inconclusive' ? '?' : ' '
          console.log(`  ${mark} ${entry.span.padEnd(14)} ${metric.padEnd(12)} ${show(result.head).padStart(9)} vs ${show(result.base).padStart(9)}  ${result.delta === null ? '' : `${result.delta > 0 ? '+' : ''}${String(result.delta)}%`}  ${result.verdict}`)
        }
      }
      if (prof !== undefined) { console.log('  most self time (head ms / base ms):'); for (const row of prof.slice(0, 10)) console.log(`    ${show(row.headMs).padStart(8)} ${row.baseMs === undefined ? '' : `/ ${show(row.baseMs).padStart(8)}`}  ${row.fn}`) }
    }
    report.regressions = report.scenarios.flatMap(scenario => scenario.judged.flatMap(entry => Object.entries(entry.metrics).filter(([, result]) => result.verdict === 'regressed').map(([metric, result]) => ({ scenario: scenario.name, span: entry.span, metric, head: result.head, base: result.base, delta: result.delta }))))
    report.improvements = report.scenarios.flatMap(scenario => scenario.judged.flatMap(entry => Object.entries(entry.metrics).filter(([, result]) => result.verdict === 'improved').map(([metric, result]) => ({ scenario: scenario.name, span: entry.span, metric, head: result.head, base: result.base, delta: result.delta }))))
    if (report.regressions.length > 0) console.log(`\nperf: ${String(report.regressions.length)} regressed; profile one with pnpm run perf -- ${report.regressions[0].scenario} --prof`)
    if (report.scenarios.some(scenario => scenario.judged.some(entry => Object.values(entry.metrics).some(result => result.verdict === 'inconclusive')))) console.log('perf: ? marks a change too few runs can confirm; --runs 5 or more decides it')
  }
  mkdirSync(dirname(join(root, RESULTS)), { recursive: true })
  writeFileSync(join(root, RESULTS), `${JSON.stringify(report, null, 2)}\n`)
  for (const failure of failures) console.error(`FAIL: ${failure}`)
  console.log(`perf: ${failures.length === 0 ? 'PASS' : 'FAIL'}`)
  process.exitCode = failures.length === 0 ? 0 : 1
}
