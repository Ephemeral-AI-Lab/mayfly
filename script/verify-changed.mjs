#!/usr/bin/env node
/** Execute the smallest fail-closed repository gate justified by a change set. @module script/verify-changed */

import { spawnSync } from 'node:child_process'
import { collectChangedFiles, collectDeletedFiles, defaultBase } from './change-files.mjs'
import { classifyChanges, promoteToFull } from './test-impact.mjs'
import { commandsForPlan } from './verification-commands.mjs'

function parseArgs(argv) {
  const options = { base: undefined, execute: true, forceFull: false, files: undefined, smoke: false }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--') continue
    if (value === '--base') options.base = argv[++index]
    else if (value === '--files-json') options.files = JSON.parse(argv[++index] ?? '[]')
    else if (value === '--plan') options.execute = false
    else if (value === '--full') options.forceFull = true
    else if (value === '--smoke') options.smoke = true
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
let plan = classifyChanges(files)
if (!options.forceFull && options.files === undefined && collectDeletedFiles(base).some(file => /\.(?:[cm]?ts|tsx)$/u.test(file))) {
  plan = promoteToFull(plan, 'deleted TypeScript requires the full gate')
}
if (options.forceFull) plan = promoteToFull(plan, '--full requested')
const commands = commandsForPlan(plan, { smoke: options.smoke })
process.stdout.write(`${JSON.stringify({ base, ...plan, commands: commands.map(([command, args]) => [command, ...args]) }, null, 2)}\n`)
if (!options.execute || plan.mode === 'none') process.exit(0)
for (const [command, args] of commands) run(command, args)
