// Real-process regression for Host stdout/stderr bypassing the alternate-
// screen renderer. A child preload logs a large JSON value after the turn has
// settled; Mayfly must repaint the editor/footer cells, and Herdr's enhanced Up
// sequence must recover the user's prompt rather than the out-of-band JSON.

import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  assertDshVersion,
  cleanOutput,
  installIntoThrowawayProfile,
  loadPty,
  registerCleanup,
  resolveDshBin,
  sleep,
  waiter,
} from './smoke-lib.mjs'

const require = createRequire(import.meta.url)
const pty = loadPty()
const { Terminal: HeadlessTerminal } = require('@xterm/headless')
const { startMockLlmServer } = require('@deepseek-ai/dsh-llm-mock-server')

const dshBin = resolveDshBin()
assertDshVersion(dshBin)
const { home, envFor } = installIntoThrowawayProfile(dshBin, 'mayfly-smoke-pty-output')
registerCleanup(home)
const preload = join(import.meta.dirname, 'fixtures', 'output-bleed.mjs')

const server = await startMockLlmServer({
  port: 0,
  sequence: ['success'],
  repeatLast: true,
  successText: 'turn-finished',
  chunkDelayMs: 0,
})

const term = pty.spawn(dshBin, ['--profile', 'mayfly-smoke-pty-output'], {
  name: 'xterm-256color',
  cols: 56,
  rows: 24,
  cwd: '/tmp',
  env: envFor({
    DEEPSEEK_BASE_URL: `${server.baseURL}/v1`,
    DEEPSEEK_API_KEY: 'mayfly-smoke-key',
    NODE_OPTIONS: `--import=${preload}`,
    COLUMNS: undefined,
    LINES: undefined,
  }),
})
const vt = new HeadlessTerminal({ cols: 56, rows: 24, scrollback: 1000, allowProposedApi: true })
let out = ''
let exitCode = null
term.onData(data => {
  out += data
  vt.write(data)
})
term.onExit(({ exitCode: code }) => { exitCode = code })

const waitFor = waiter(Date.now() + 120_000, 100)

async function screen() {
  await new Promise(resolve => vt.write('', resolve))
  const buffer = vt.buffer.active
  return Array.from({ length: vt.rows }, (_, row) => buffer.getLine(row)?.translateToString(true) ?? '')
}

const clean = () => cleanOutput(out)
try {
  if (!(await waitFor(() => clean().includes('deepseek-flash'), 'statusline'))) throw new Error('statusline')
  term.write('history prompt\r')
  if (!(await waitFor(() => clean().includes('turn-finished'), 'settled turn'))) throw new Error('settled turn')
  await sleep(300)

  if (!(await waitFor(() => clean().includes('[cordis:bleed-fixture]'), 'delayed Host console output'))) throw new Error('Host console output')
  // The fixture writes its JSON in chunks: wait for the last line rather than the marker that opens it.
  if (!(await waitFor(() => clean().includes('host-bleed-35'), 'large Host JSON'))) throw new Error('large Host JSON did not reach the raw PTY stream')

  await sleep(250)
  const recovered = (await screen()).join('\n')
  if (recovered.includes('[cordis:bleed-fixture]') || recovered.includes('host-bleed-')) {
    throw new Error('Host JSON remained in the renderer frame')
  }
  if (!recovered.includes('deepseek-flash')) throw new Error('footer was not restored')

  term.write('\x1b[57419;1:1u')
  await sleep(250)
  const history = (await screen()).join('\n')
  if (!history.includes('history prompt')) throw new Error('enhanced Up did not restore the user prompt')
  if (history.includes('host-bleed-')) throw new Error('Host JSON entered editor history')

  term.write('\x03')
  await sleep(400)
  term.write('\x03')
  await sleep(400)
  term.write('\x03')
  if (!(await waitFor(() => exitCode !== null, 'clean exit'))) throw new Error('clean exit')
} catch (error) {
  console.error(`FAIL: ${error instanceof Error ? error.message : String(error)}`)
  console.error((await screen()).join('\n'))
  console.error(clean().slice(-3000))
  term.kill()
  vt.dispose()
  await server.close()
  process.exit(1)
}

await server.close()
vt.dispose()
const final = clean()
if (exitCode !== 0 || final.includes('exceeds terminal width') || final.includes('Uncaught')) {
  console.error(`FAIL: exit=${String(exitCode)}`)
  console.error(final.slice(-3000))
  process.exit(1)
}
console.log(`PTY_OUTPUT_RECOVERY_PASS exit=${String(exitCode)}`)
