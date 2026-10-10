/**
 * The verification report: `report.json` for tools and `summary.md` for the reader (an agent or a person), with the
 * verdict, what ran and why, the first failure of each failing spec, and how to rerun. @module script/verify/report
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const MESSAGE_LINES = 12

/** The first lines of a failure message, without ANSI and without the test runner's own stack frames. */
const excerpt = text => String(text ?? '').replace(/\x1b\[[0-9;]*m/gu, '').split('\n')
  .filter(line => !/^\s+at .*\/node_modules\//u.test(line) && !/^\s+at new Promise \(<anonymous>\)$/u.test(line))
  .slice(0, MESSAGE_LINES).join('\n').trimEnd()

/**
 * The first failure of each failing spec file in a vitest JSON result (`--reporter=json`).
 * @param {{ testResults?: { name: string, status: string, message?: string, assertionResults?: { fullName: string, status: string, failureMessages?: string[] }[] }[] }} results
 * @param {string} root - paths are reported relative to it.
 * @returns {{ file: string, test: string, message: string }[]}
 */
export function vitestFailures(results, root) {
  const failures = []
  for (const file of results.testResults ?? []) {
    if (file.status !== 'failed') continue
    const failed = (file.assertionResults ?? []).find(assertion => assertion.status === 'failed')
    failures.push({
      file: relative(root, file.name),
      test: failed?.fullName ?? '(the file failed before its tests ran)',
      message: excerpt(failed?.failureMessages?.[0] ?? file.message),
    })
  }
  return failures
}

const seconds = ms => `${(ms / 1000).toFixed(1)} s`

/**
 * The summary a reader acts on.
 * @param {object} report - see {@link writeReport}.
 * @returns {string}
 */
export function renderSummary(report) {
  const lines = [`# check: ${report.verdict === 'pass' ? 'PASS' : 'FAIL'} (${report.tier}, ${seconds(report.durationMs)})`, '']
  const scope = [`${String(report.files.length)} changed ${report.files.length === 1 ? 'file' : 'files'} against ${report.base}`]
  if (report.tier !== 'full') scope.push(`${String(report.tests.specs.length)} specs`, `${String(report.tests.nodeTests.length)} workflow tests`)
  lines.push(scope.join(' · '))
  if (report.reasons.length > 0) lines.push('', `Full gate: ${report.reasons.join('; ')}`)
  if (report.manualAcceptance.length > 0) lines.push('', `Manual acceptance still owed: ${report.manualAcceptance.join(', ')}`)
  if (report.steps.length > 0) {
    lines.push('', '| Step | Result | Time |', '| --- | --- | --- |')
    for (const step of report.steps) lines.push(`| ${step.name} | ${step.status === 'pass' ? '✓' : step.status === 'fail' ? '✗' : 'skipped'} | ${step.status === 'skip' ? '' : seconds(step.durationMs)} |`)
  } else {
    lines.push('', 'Nothing to check.')
  }
  if (report.failures.length > 0) {
    lines.push('', '## Failures')
    for (const failure of report.failures) {
      lines.push('', `### ${failure.step}${failure.file === undefined ? '' : `: ${failure.file}`}`)
      if (failure.test !== undefined) lines.push(`> ${failure.test}`)
      const chain = failure.file === undefined ? undefined : report.tests.why[failure.file]
      if (chain !== undefined && chain.length > 1) lines.push(`Selected by: ${chain.join(' → ')}`)
      lines.push('```', failure.message, '```')
      if (failure.log !== undefined) lines.push(`Full output: ${failure.log}`)
    }
  }
  if (report.uncovered.length > 0) {
    lines.push('', '## Changed lines no selected spec ran (advice)')
    for (const { file, lines: missed } of report.uncovered) lines.push(`- ${file}: ${missed.join(', ')}`)
  }
  if (report.rerun.length > 0) lines.push('', '## Rerun', '```', ...report.rerun, '```')
  return `${lines.join('\n')}\n`
}

/**
 * Write `report.json` and `summary.md` under `dir`.
 * @param {string} dir
 * @param {{ tier: string, base: string, verdict: 'pass' | 'fail', durationMs: number, files: string[], reasons: string[],
 *   manualAcceptance: string[], steps: { name: string, status: 'pass' | 'fail' | 'skip', durationMs: number, command: string, log?: string }[],
 *   tests: { specs: string[], nodeTests: string[], why: Record<string, string[]> },
 *   failures: { step: string, file?: string, test?: string, message: string, log?: string }[],
 *   uncovered: { file: string, lines: number[] }[], rerun: string[] }} report
 * @returns {string} the summary.
 */
export function writeReport(dir, report) {
  mkdirSync(dir, { recursive: true })
  const summary = renderSummary(report)
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(join(dir, 'summary.md'), summary)
  return summary
}
