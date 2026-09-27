// Interactive PTY smoke for the Host-scoped Schedule surface (manual — not in
// CI): boots the real dsh CLI with Mayfly under a pseudo-terminal at 40 columns
// three times — once on the shipped default preset, once with the profile
// patch flipping the registry default to `minimal`, and once with the profile
// patch re-enabling the base layer's disabled `schedule` row — asserting that
// the reminder catalog degrades cleanly while the service stays disabled,
// that schedule_* tools stay absent from every preset, and that an explicit
// `disabled: false` overlay mounts the Host service with its catalog and
// Agent-scoped tools.
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

const writeProfilePatch = lines =>
  writeFileSync(join(dshHome, 'profiles', profile, 'cordis.patch.yml'), [...lines, ''].join('\n'))

// A boot whose Schedule row is disabled: no schedule_* tools on any preset,
// and `/schedule` reports the unavailable state instead of hanging on a
// missing service.
async function checkDisabled(label) {
  const session = await boot(label)
  if (!(await session.waitFor(() => session.clean().includes('deepseek-flash'), `${label} boot frame`))) throw new Error(`${label} boot`)
  session.term.write('/tools\r')
  if (!(await session.waitFor(() => session.clean().includes('Refresh'), `${label} tools catalog`))) throw new Error(`${label} tools open`)
  session.term.write('sched')
  await sleep(600)
  if (session.clean().includes('schedule_create')) throw new Error(`schedule_create leaked into ${label}`)
  session.term.write('\x15')
  await sleep(200)
  session.term.write('\x1b')
  await sleep(300)
  session.term.write('\x1b')
  await sleep(300)
  session.term.write('/schedule\r')
  if (!(await session.waitFor(() => session.clean().includes('Schedule unavailable'), `${label} unavailable reminder catalog`))) throw new Error(`${label} unavailable state`)
  const result = await session.exit()
  if (result.output.includes('exceeds terminal width') || result.output.includes('pi-crash.log')) throw new Error(`${label} width guard`)
}

try {
  // Standard preset first: the Host Schedule row ships disabled, so the
  // catalog stays unavailable and no Agent gains schedule_* tools.
  writeProfilePatch([
    '- id: agent-preset-registry',
    '  config:',
    '    default: standard',
  ])
  await checkDisabled('standard')

  // Minimal preset: same unavailable behavior — the capability no longer
  // depends on which preset mounted a schedule row.
  writeProfilePatch([
    '- id: agent-preset-registry',
    '  config:',
    '    default: minimal',
  ])
  await checkDisabled('minimal')

  // Explicitly re-enabled through the profile patch layer: the Host service
  // mounts once, exposes its catalog, and attaches schedule_* tools to the
  // root Agent.
  writeProfilePatch([
    '- id: agent-preset-registry',
    '  config:',
    '    default: standard',
    '- id: schedule',
    '  disabled: false',
  ])
  const enabled = await boot('enabled')
  if (!(await enabled.waitFor(() => enabled.clean().includes('deepseek-flash'), 'the enabled boot frame'))) throw new Error('enabled boot')
  enabled.term.write('/tools\r')
  if (!(await enabled.waitFor(() => enabled.clean().includes('Refresh'), 'the enabled tools catalog'))) throw new Error('enabled tools open')
  // The catalog is a scrollable list; typing filters it so schedule_* rows
  // render inside the 40-column viewport.
  enabled.term.write('sched')
  if (!(await enabled.waitFor(() => enabled.clean().includes('schedule_create'), 'schedule_create when enabled'))) throw new Error('enabled tools')
  for (const name of ['schedule_list', 'schedule_delete']) {
    if (!enabled.clean().includes(name)) throw new Error(`enabled tools missing ${name}`)
  }
  enabled.term.write('\x15')
  await sleep(200)
  enabled.term.write('\x1b')
  await sleep(300)
  enabled.term.write('\x1b')
  await sleep(300)
  enabled.term.write('/schedule\r')
  if (!(await enabled.waitFor(() => enabled.clean().includes('No active reminders'), 'the empty reminder catalog'))) throw new Error('empty catalog')
  if (!enabled.clean().includes('Reminders')) throw new Error('catalog title')
  enabled.term.write('\x1b')
  await sleep(300)
  enabled.term.write('/sessions\r')
  if (!(await enabled.waitFor(() => enabled.clean().includes('Sessions'), 'the sessions catalog'))) throw new Error('sessions')
  const enabledResult = await enabled.exit()
  if (enabledResult.output.includes('exceeds terminal width') || enabledResult.output.includes('pi-crash.log')) throw new Error('enabled width guard')
} catch (error) {
  console.error(`FAIL: ${error.message}`)
  await server.close()
  process.exit(1)
}
await server.close()
console.log('PTY_SCHEDULE_SMOKE_PASS')
