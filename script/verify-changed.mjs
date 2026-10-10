#!/usr/bin/env node
/** Execute the smallest fail-closed repository gate justified by a change set. @module script/verify-changed */

import { execFileSync, spawnSync } from 'node:child_process'
import { collectChangedFiles, defaultBase } from './change-files.mjs'
import { commandsForPlan } from './verification-commands.mjs'
import { classifyChanges, promoteToFull, repositoryGraph } from './verify/select.mjs'

function parseArgs(argv) {
  const options = { base: undefined, execute: true, forceFull: false, files: undefined, smoke: false, why: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') continue
    if (value === '--base') options.base = argv[++index]
    else if (value === '--files-json') options.files = JSON.parse(argv[++index] ?? '[]')
    else if (value === '--plan') options.execute = false
    else if (value === '--full') options.forceFull = true
    else if (value === '--smoke') options.smoke = true
    else if (value === '--why') options.why = true
    else throw new Error(`unknown argument: ${value}`)
  }
  return options
}

function run(command, args) {
  process.stdout.write(`\n> ${command} ${args.join(' ')}\n`)
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const options = parseArgs(process.argv.slice(2))
const base = options.base ?? defaultBase()
const comparable = ['HEAD', base].every(ref => spawnSync('git', ['rev-parse', '--verify', ref], { stdio: 'ignore' }).status === 0)
const files = options.files ?? (options.forceFull && !comparable && options.base === undefined ? [] : collectChangedFiles(base))
// The graph of the repository being verified: the working directory's checkout.
const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim()
let plan = classifyChanges(files, { graph: repositoryGraph(root) })
if (options.forceFull) plan = promoteToFull(plan, '--full requested')
const commands = commandsForPlan(plan, { smoke: options.smoke })
// Each selected test's chain from a changed path is long; `--why` prints it.
const why = options.why ? Object.fromEntries(Object.entries(plan.tests.why).map(([test, chain]) => [test, chain.join(' → ')])) : `${String(Object.keys(plan.tests.why).length)} chains (--why prints them)`
process.stdout.write(`${JSON.stringify({ base, ...plan, tests: { ...plan.tests, why }, commands: commands.map(([command, args]) => [command, ...args]) }, null, 2)}\n`)
// Leave by returning, not process.exit: a plan written to a pipe is flushed asynchronously.
if (options.execute && plan.mode !== 'none') for (const [command, args] of commands) run(command, args)
