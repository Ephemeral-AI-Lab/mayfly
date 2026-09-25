// Regression smoke for preset-scoped Schedule on live preset switches (manual —
// not in CI): boots the real dsh CLI once and drives the terminal through the
// boundary cases of reminder-capable Agents and preset changes.
//
// Reminder tools register on the Agent's own scope layer at agent/created, so a
// `roster.select()` re-link can neither retract them (standard→minimal) nor
// grant them (minimal→standard). /preset therefore refuses selections that
// would flip schedule capability, and /new <preset> reaches the matching
// session.create(agentPreset) path — the only way a session's reminder
// capability can differ from what its Agent was created with.
//
// Asserts:
//   1. /preset minimal on a schedule-capable session is refused with a
//      /new minimal pointer — no stranded schedule_* tools.
//   2. /new bogus reports an unknown preset without creating a session.
//   3. /new minimal yields a session whose /tools has no schedule_* rows and
//      whose /schedule reports the capability as unavailable.
//   4. /preset standard on that minimal session is refused (the missing-grant
//      direction) with a /new standard pointer.
//   5. /new standard restores the schedule tools and the empty catalog.
// Run: node script/repro-preset-switch.mjs (self-contained: installs its own
// throwaway profile)

import { createRequire } from 'node:module'
import { existsSync, readdirSync, chmodSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  assertDshVersion,
  cleanOutput,
  installIntoThrowawayProfile,
  registerCleanup,
  resolveDshBin,
} from './smoke-lib.mjs'

const require = createRequire(import.meta.url)
const pty = require('node-pty')

// Restore node-pty's spawn-helper execute bit when the store dropped it (the
// kimi-code fix-node-pty-perms pattern; a no-op on Linux).
try {
  const store = join(import.meta.dirname, '..', 'node_modules', '.pnpm')
  if (existsSync(store)) {
    for (const entry of readdirSync(store)) {
      if (!entry.startsWith('node-pty@')) continue
      const helper = join(store, entry, 'node_modules', 'node-pty', 'spawn-helper')
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755)
    }
  }
} catch {
  // The smoke reports its own failures; permission probing stays silent.
}

const dshBin = resolveDshBin()
assertDshVersion(dshBin)
const profile = 'mayfly-smoke-preset'
const { home, envFor } = installIntoThrowawayProfile(dshBin, profile)
registerCleanup(home)

const { startMockLlmServer } = require('@deepseek-ai/dsh-llm-mock-server')
const server = await startMockLlmServer({
  port: 0,
  sequence: ['slow_success'],
  repeatLast: true,
  successText: 'preset smoke reply',
  chunkSize: 6,
  chunkDelayMs: 50,
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const term = pty.spawn(dshBin, ['--profile', profile], {
  name: 'xterm-256color',
  cols: 40,
  rows: 24,
  cwd: import.meta.dirname,
  env: envFor({
    DEEPSEEK_BASE_URL: `${server.baseURL}/v1`,
    DEEPSEEK_API_KEY: 'mayfly-smoke-key',
    COLUMNS: undefined,
    LINES: undefined,
  }),
})
let out = ''
let mark = 0
let exitCode = null
term.onData(data => { out += data })
term.onExit(({ exitCode: code }) => { exitCode = code })
const clean = () => cleanOutput(out)
// Output is cumulative across sessions; assertions about the CURRENT screen
// read only bytes emitted after mark so earlier tool listings cannot leak in.
const cleanSinceMark = () => cleanOutput(out.slice(mark))
const waitFor = async (predicate, label) => {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(200)
  }
  console.error(`FAIL: timed out waiting for ${label}`)
  console.error(clean().slice(-2400))
  return false
}

const openToolsFiltered = async (label) => {
  term.write('/tools\r')
  if (!(await waitFor(() => cleanSinceMark().includes('Refresh'), `${label} tools catalog`))) return false
  term.write('sched')
  await sleep(700)
  return true
}
const closeOverlay = async () => {
  term.write('\x15')
  await sleep(200)
  term.write('\x1b')
  await sleep(300)
  term.write('\x1b')
  await sleep(400)
}

try {
  console.log(`==> PTY boot: dsh --profile ${profile} at 40x24 (default preset: standard)`)
  if (!(await waitFor(() => clean().includes('deepseek-flash'), 'the standard boot frame'))) throw new Error('boot')

  // Direction one: an agent created with schedule tools keeps them for life;
  // the switch that would strand them is refused before reaching select().
  mark = out.length
  term.write('/preset minimal\r')
  if (!(await waitFor(() => cleanSinceMark().includes('/new minimal'), 'the stranded-tools refusal'))) throw new Error('refusal standard→minimal')
  if (!(await openToolsFiltered('post-refusal'))) throw new Error('tools after refusal')
  if (!cleanSinceMark().includes('schedule_create')) throw new Error('schedule tools missing after refused switch')
  await closeOverlay()

  // /new validates the preset against the roster before emitting.
  mark = out.length
  term.write('/new bogus\r')
  if (!(await waitFor(() => cleanSinceMark().includes('unknown agent preset bogus'), 'the unknown-preset refusal'))) throw new Error('/new bogus')

  // Direction two in reverse: a minimal session cannot gain the tools either.
  mark = out.length
  term.write('/new minimal\r')
  await sleep(2500)
  term.write('/preset standard\r')
  if (!(await waitFor(() => cleanSinceMark().includes('/new standard'), 'the missing-grant refusal'))) throw new Error('refusal minimal→standard')
  if (!(await openToolsFiltered('minimal'))) throw new Error('minimal tools open')
  if (cleanSinceMark().includes('schedule_create')) throw new Error('schedule_create leaked into the minimal session')
  await closeOverlay()
  term.write('/schedule\r')
  if (!(await waitFor(() => cleanSinceMark().includes('Schedule unavailable'), 'the unavailable reminder catalog'))) throw new Error('unavailable state')
  await closeOverlay()

  // And back: a fresh standard session composes the capability again.
  mark = out.length
  term.write('/new standard\r')
  await sleep(2500)
  if (!(await openToolsFiltered('restored standard'))) throw new Error('restored tools open')
  if (!cleanSinceMark().includes('schedule_create')) throw new Error('schedule tools missing on the new standard session')
  await closeOverlay()
  term.write('/schedule\r')
  if (!(await waitFor(() => cleanSinceMark().includes('No active reminders'), 'the empty reminder catalog'))) throw new Error('empty catalog')

  term.write('\x1b')
  await sleep(250)
  for (let press = 0; press < 4 && exitCode === null; press++) {
    term.write('\x03')
    await sleep(700)
  }
  if (!(await waitFor(() => exitCode !== null, 'clean exit'))) throw new Error('exit')
  if (clean().includes('exceeds terminal width') || clean().includes('pi-crash.log')) throw new Error('width guard')
} catch (error) {
  console.error(`FAIL: ${error.message}`)
  await server.close()
  process.exit(1)
}
await server.close()
console.log('PTY_PRESET_SWITCH_SMOKE_PASS')
