#!/usr/bin/env node
/**
 * Verify a change at a tier and report it (roadmap Phase 2b):
 *
 *   pnpm run check [-- --tier round|pr|full] [--base <ref>] [--files-json <json>] [--plan] [--why] [--verbose]
 *
 * The change set is `<base>...HEAD` plus staged, unstaged, and untracked files (default base `origin/main`, else
 * `main`). `round` is for every edit, `pr` (the default) for finalizing a component and PR CI, `full` for CI on `main`, a
 * release, and a phase end; a change to a global input runs the full tier whatever was asked. Each step prints one line
 * and logs its output under `.artifacts/verify/steps/`; `.artifacts/verify/report.json` and `summary.md` hold the
 * verdict, what ran and why, the first failure of each failing spec, and how to rerun. `--plan` prints the plan and the
 * steps without running them; `--verbose` streams each step's output (CI). @module script/check
 */

import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { collectChangedFiles, defaultBase } from './change-files.mjs'
import { changedLines, uncoveredChangedLines } from './verify/coverage-diff.mjs'
import { vitestFailures, writeReport } from './verify/report.mjs'
import { classifyChanges, promoteToFull, repositoryGraph } from './verify/select.mjs'
import { OUTPUT, SCENARIO_RESULTS, TIERS, VITEST_RESULTS, stepsFor } from './verify/steps.mjs'

/**
 * Parse the command line.
 * @param {string[]} argv - arguments after the script name.
 * @returns {{ options: { tier: string, base?: string, files?: string[], plan: boolean, why: boolean, verbose: boolean, coverageAdvice: boolean } } | { error: string }}
 */
export function parseCheckArgs(argv) {
  const options = { tier: 'pr', plan: false, why: false, verbose: false, coverageAdvice: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') continue
    if (value === '--tier') options.tier = argv[++index]
    else if (value === '--base') options.base = argv[++index]
    else if (value === '--files-json') options.files = JSON.parse(argv[++index] ?? '[]')
    else if (value === '--plan') options.plan = true
    else if (value === '--why') options.why = true
    else if (value === '--verbose') options.verbose = true
    else if (value === '--coverage-advice') options.coverageAdvice = true
    else return { error: `unknown argument ${value}` }
  }
  if (!TIERS.includes(options.tier)) return { error: `--tier needs one of ${TIERS.join(', ')}` }
  return { options }
}

const shell = step => [step.command, ...step.args].map(part => /^[\w@%+=:,./-]+$/u.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`).join(' ')
const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
const seconds = ms => `${(ms / 1000).toFixed(1)} s`

/** Run one step, its output to a log file (and the terminal when verbose); resolves with the exit code. */
function runStep(step, { root, log, verbose }) {
  return new Promise((resolve) => {
    const out = createWriteStream(log)
    const child = spawn(step.command, step.args, { cwd: root, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const forward = data => { out.write(data); if (verbose) process.stdout.write(data) }
    child.stdout.on('data', forward)
    child.stderr.on('data', forward)
    child.on('error', error => { out.write(`${String(error)}\n`) })
    child.on('close', code => out.end(() => resolve(code ?? 1)))
  })
}

/** The failures a scenario run reports: a checkpoint that differs (with its rows), is new, a broken run, an orphan. */
export function scenarioFailures(results) {
  const failures = []
  for (const result of results.results ?? []) {
    const file = `scenario ${result.name}`
    const size = `${String(result.cols)}x${String(result.rows)}`
    for (const entry of result.checkpoints) {
      if (entry.status === 'differs') failures.push({ kind: 'scenario', file, test: `${entry.checkpoint} at ${size} differs from its golden`, message: entry.diff.join('\n') })
      else if (entry.status === 'new') failures.push({ kind: 'scenario', file, test: `${entry.checkpoint} at ${size} has no golden`, message: 'accept it with the update command below' })
    }
    for (const failure of result.failures) failures.push({ kind: 'scenario', file, test: `the run at ${size}`, message: failure })
  }
  for (const orphan of results.orphans ?? []) failures.push({ kind: 'scenario', file: orphan, test: 'no checkpoint writes this golden', message: 'remove it with the update command below' })
  return failures
}

const tail = (file, lines = 30) => readFileSync(file, 'utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/gu, '').split('\n').slice(-lines).join('\n').trim()

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseCheckArgs(process.argv.slice(2))
  if ('error' in parsed) { console.error(parsed.error); process.exit(2) }
  const { options } = parsed
  const started = performance.now()
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
  const base = options.base ?? defaultBase()
  const comparable = ['HEAD', base].every(ref => { try { execFileSync('git', ['rev-parse', '--verify', ref], { cwd: root, stdio: 'ignore' }); return true } catch { return false } })
  // A full tier before the first commit checks everything; otherwise an unusable base fails instead of guessing.
  const files = options.files ?? (options.tier === 'full' && !comparable && options.base === undefined ? [] : collectChangedFiles(base))
  let plan = classifyChanges(files, { graph: repositoryGraph(root) })
  if (options.tier === 'full' && plan.mode !== 'full') plan = promoteToFull(plan, 'the full tier was asked for')
  const tier = plan.mode === 'full' ? 'full' : options.tier
  const steps = stepsFor(plan, tier, { root, coverageAdvice: options.coverageAdvice })

  if (options.plan) {
    const why = options.why ? Object.fromEntries(Object.entries(plan.tests.why).map(([test, chain]) => [test, chain.join(' → ')])) : `${String(Object.keys(plan.tests.why).length)} chains (--why prints them)`
    process.stdout.write(`${JSON.stringify({ base, tier, ...plan, tests: { ...plan.tests, why }, steps: steps.map(step => `${step.name}: ${shell(step)}`) }, null, 2)}\n`)
  } else {
    const output = join(root, OUTPUT)
    rmSync(join(output, 'steps'), { recursive: true, force: true })
    mkdirSync(join(output, 'steps'), { recursive: true })
    process.stdout.write(`check: ${tier} tier, ${String(plan.files.length)} changed files against ${base}${plan.reasons.length > 0 ? ` (${plan.reasons[0]})` : ''}\n`)
    const results = []
    const failures = []
    let stopped = false
    for (const [index, step] of steps.entries()) {
      if (stopped) { results.push({ name: step.name, status: 'skip', durationMs: 0, command: shell(step) }); continue }
      const log = join(output, 'steps', `${String(index + 1).padStart(2, '0')}-${slug(step.name)}.log`)
      const vitestResults = join(root, VITEST_RESULTS)
      const scenarioResults = join(root, SCENARIO_RESULTS)
      if (step.kind !== undefined) { rmSync(vitestResults, { force: true }); rmSync(scenarioResults, { force: true }) }
      const begin = performance.now()
      const code = await runStep(step, { root, log, verbose: options.verbose })
      const durationMs = Math.round(performance.now() - begin)
      const status = code === 0 ? 'pass' : 'fail'
      results.push({ name: step.name, status, durationMs, command: shell(step), log: relative(root, log) })
      process.stdout.write(`${status === 'pass' ? '✓' : '✗'} ${step.name} (${seconds(durationMs)})${status === 'fail' ? ` — ${relative(root, log)}` : ''}\n`)
      if (status === 'pass') continue
      const specFailures = step.kind === 'scenarios'
        ? existsSync(scenarioResults) ? scenarioFailures(JSON.parse(readFileSync(scenarioResults, 'utf8'))) : []
        : step.kind !== undefined && existsSync(vitestResults) ? vitestFailures(JSON.parse(readFileSync(vitestResults, 'utf8')), root).map(failure => ({ kind: 'spec', ...failure })) : []
      if (specFailures.length > 0) failures.push(...specFailures.map(failure => ({ step: step.name, ...failure })))
      else failures.push({ step: step.name, message: tail(log), log: relative(root, log) })
      if (step.blocking === true) stopped = true
    }
    const coverageFile = join(root, '.artifacts/coverage/coverage-final.json')
    const advised = tier === 'pr' && options.coverageAdvice && steps.some(step => step.kind === 'coverage') && existsSync(coverageFile)
    const uncovered = advised ? uncoveredChangedLines(JSON.parse(readFileSync(coverageFile, 'utf8')), changedLines(root, base, plan.files.filter(file => existsSync(join(root, file)))), root) : []
    const failedSpecs = [...new Set(failures.flatMap(failure => failure.kind === 'spec' ? [failure.file] : []))]
    const failedScenarios = [...new Set(failures.flatMap(failure => failure.kind === 'scenario' && failure.file.startsWith('scenario ') ? [failure.file.slice('scenario '.length)] : []))]
    const rerun = [
      ...failedSpecs.length > 0 ? [`pnpm exec vitest run ${failedSpecs.join(' ')}`] : [],
      ...failedScenarios.length > 0 ? [`pnpm run scenarios -- ${failedScenarios.join(' ')}`, `pnpm run frame <scenario>   # look at a checkpoint (.grid, .txt, .svg)`, `pnpm run scenarios -- --update ${failedScenarios.join(' ')}   # accept what the product paints now`] : [],
      ...failures.some(failure => failure.kind === 'scenario' && !failure.file.startsWith('scenario ')) ? ['pnpm run scenarios -- --update'] : [],
      ...results.filter(result => result.status === 'fail' && !failures.some(failure => failure.step === result.name && failure.file !== undefined)).map(result => result.command),
    ]
    const verdict = results.some(result => result.status === 'fail') ? 'fail' : 'pass'
    writeReport(output, {
      tier, base, verdict, durationMs: Math.round(performance.now() - started), files: plan.files, reasons: plan.reasons,
      manualAcceptance: plan.manualAcceptance, steps: results, tests: plan.tests, failures, uncovered, rerun,
    })
    for (const failure of failures.filter(entry => entry.file !== undefined).slice(0, 10)) process.stdout.write(`  ✗ ${failure.file} › ${failure.test}\n`)
    process.stdout.write(`check: ${verdict === 'pass' ? 'PASS' : 'FAIL'} (${tier}, ${seconds(performance.now() - started)}) — ${relative(root, join(output, 'summary.md'))}\n`)
    process.exitCode = verdict === 'pass' ? 0 : 1
  }
}
