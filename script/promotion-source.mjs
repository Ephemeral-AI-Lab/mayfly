#!/usr/bin/env node
/** Verify a promote-only source run completed the exact release matrix. @module script/promotion-source */

import { fileURLToPath } from 'node:url'

/** Reject any artifact source without a successful candidate and registry-install matrix. */
export function validatePromotionSource(run, sha) {
  const problems = []
  if (run?.workflowName !== 'release' || run?.headSha !== sha) problems.push('source run must be the release workflow on this commit')
  const jobs = run?.jobs ?? []
  if (!Array.isArray(jobs) || jobs.filter(job => job.name === 'gate + publish candidate' && job.conclusion === 'success').length !== 1) {
    problems.push('source run has no successful candidate job')
  }
  for (const os of ['ubuntu-latest', 'windows-latest', 'macos-latest']) {
    for (const node of ['22', '24']) {
      const name = `registry install (${os}, node ${node})`
      if (!Array.isArray(jobs) || jobs.filter(job => job.name === name && job.conclusion === 'success').length !== 1) {
        problems.push(`source run has no successful ${name}`)
      }
    }
  }
  return problems
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: promotion-source <source-commit> < run.json')
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const problems = validatePromotionSource(JSON.parse(input), process.argv[2])
  if (problems.length > 0) throw new Error(`promotion source is invalid: ${problems.join('; ')}`)
  console.log('promotion source: candidate and six registry installs succeeded')
}
