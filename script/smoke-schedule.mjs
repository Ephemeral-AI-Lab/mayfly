// Interactive PTY smoke for the preset-scoped Schedule surface (manual — not in
// CI): boots the real dsh CLI with Mayfly under a pseudo-terminal at 40 columns
// twice — once on the shipped default preset and once with the profile patch
// flipping the registry default to `minimal` — asserting that the reminder
// catalog renders, that schedule_* tools exist only under the preset that
// mounts `dsh-schedule`, and that the unavailable state degrades cleanly.
// Run: node script/smoke-schedule.mjs (self-contained: installs its own throwaway profile)

import { createRequire } from 'node:module'
import { existsSync, readdirSync, chmodSync, statSync, writeFileSync } from 'node:fs'
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
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) {
        chmodSync(helper, 0o755)
        console.log(`==> Restored spawn-helper execute bit under ${entry}`)
      }
    }
  }
} catch {
  // The smoke reports its own failures; permission probing stays silent.
}

const dshBin = resolveDshBin()
assertDshVersion(dshBin)
const profile = 'mayfly-smoke-schedule'
const { home, dshHome, envFor } = installIntoThrowawayProfile(dshBin, profile)
registerCleanup(home)

const { startMockLlmServer } = require('@deepseek-ai/dsh-llm-mock-server')
const server = await startMockLlmServer({
  port: 0,
  sequence: ['slow_success'],
  repeatLast: true,
  successText: 'schedule smoke reply',
  chunkSize: 6,
  chunkDelayMs: 50,
})

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const deadline = Date.now() + 120_000

async function boot(label) {
  console.log(`==> PTY boot ${label}: dsh --profile ${profile} at 40x24`)
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
  let exitCode = null
  term.onData(data => { out += data })
  term.onExit(({ exitCode: code }) => { exitCode = code })
  const clean = () => cleanOutput(out)
  const waitFor = async (predicate, waitLabel) => {
    while (Date.now() < deadline) {
      if (predicate()) return true
      await sleep(200)
    }
    console.error(`FAIL: timed out waiting for ${waitLabel}`)
    console.error(clean().slice(-2400))
    return false
  }
  const exit = async () => {
    term.write('\x1b')
    await sleep(250)
    for (let press = 0; press < 4 && exitCode === null; press++) {
      term.write('\x03')
      await sleep(700)
    }
    if (!(await waitFor(() => exitCode !== null, `${label} clean exit`))) throw new Error(`${label} exit`)
    return { output: clean(), exitCode }
  }
  return { term, clean, waitFor, exit }
}

try {
  // Minimal first: flip the registry default through the profile patch layer
  // so the fresh session composes minimal. Minimal's standing mount carries
  // no schedule row — the agent/created listener in standard's mount never
  // sees this agent, so no schedule_* tools exist for it and the catalog
  // reports the capability as unavailable.
  writeFileSync(join(dshHome, 'profiles', profile, 'cordis.patch.yml'), [
    '- id: agent-preset-registry',
    '  config:',
    '    default: minimal',
    '',
  ].join('\n'))
  const minimal = await boot('minimal')
  if (!(await minimal.waitFor(() => minimal.clean().includes('deepseek-flash'), 'the minimal boot frame'))) throw new Error('minimal boot')
  minimal.term.write('/tools\r')
  if (!(await minimal.waitFor(() => minimal.clean().includes('Refresh'), 'the minimal tools catalog'))) throw new Error('minimal tools open')
  minimal.term.write('sched')
  await sleep(600)
  if (minimal.clean().includes('schedule_create')) throw new Error('schedule_create leaked into minimal')
  minimal.term.write('\x15')
  await sleep(200)
  minimal.term.write('\x1b')
  await sleep(300)
  minimal.term.write('\x1b')
  await sleep(300)
  minimal.term.write('/schedule\r')
  if (!(await minimal.waitFor(() => minimal.clean().includes('Schedule unavailable'), 'the unavailable reminder catalog'))) throw new Error('unavailable state')
  const minimalResult = await minimal.exit()
  if (minimalResult.output.includes('exceeds terminal width') || minimalResult.output.includes('pi-crash.log')) throw new Error('minimal width guard')

  // Standard preset: the schedule capability mounts inside the preset's
  // standing scope, so its tools exist and the catalog reads empty.
  writeFileSync(join(dshHome, 'profiles', profile, 'cordis.patch.yml'), [
    '- id: agent-preset-registry',
    '  config:',
    '    default: standard',
    '',
  ].join('\n'))
  const standard = await boot('standard')
  if (!(await standard.waitFor(() => standard.clean().includes('deepseek-flash'), 'the statusline boot frame'))) throw new Error('boot')
  standard.term.write('/tools\r')
  if (!(await standard.waitFor(() => standard.clean().includes('Refresh'), 'the standard tools catalog'))) throw new Error('standard tools open')
  // The catalog is a scrollable list; typing filters it so schedule_* rows
  // render inside the 40-column viewport.
  standard.term.write('sched')
  if (!(await standard.waitFor(() => standard.clean().includes('schedule_create'), 'schedule_create on standard'))) throw new Error('standard tools')
  for (const name of ['schedule_list', 'schedule_delete']) {
    if (!standard.clean().includes(name)) throw new Error(`standard tools missing ${name}`)
  }
  standard.term.write('\x15')
  await sleep(200)
  standard.term.write('\x1b')
  await sleep(300)
  standard.term.write('\x1b')
  await sleep(300)
  standard.term.write('/schedule\r')
  if (!(await standard.waitFor(() => standard.clean().includes('No active reminders'), 'the empty reminder catalog'))) throw new Error('empty catalog')
  if (!standard.clean().includes('Reminders')) throw new Error('catalog title')
  standard.term.write('\x1b')
  await sleep(300)
  standard.term.write('/sessions\r')
  if (!(await standard.waitFor(() => standard.clean().includes('Sessions'), 'the sessions catalog'))) throw new Error('sessions')
  const standardResult = await standard.exit()
  if (standardResult.output.includes('exceeds terminal width') || standardResult.output.includes('pi-crash.log')) throw new Error('standard width guard')
} catch (error) {
  console.error(`FAIL: ${error.message}`)
  await server.close()
  process.exit(1)
}
await server.close()
console.log('PTY_SCHEDULE_SMOKE_PASS')
