/** Native split CLI, background lifecycle and PTY/ConPTY acceptance. @module script/smoke-platform-pty */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installedCli, installedManifests } from './installed-cli.mjs'
import { loadPty, sleep } from './smoke-lib.mjs'

const require = createRequire(import.meta.url)
const pty = loadPty()
const { Terminal } = require('@xterm/headless')
const artifactRoot = resolve(process.env.MAYFLY_SMOKE_ARTIFACTS ?? '.artifacts/platform-pty')
mkdirSync(artifactRoot, { recursive: true })
const fixture = mkdtempSync(join(tmpdir(), 'mayfly platform 中文 '))
const workspace = join(fixture, 'workspace with spaces')
mkdirSync(workspace)
writeFileSync(join(workspace, 'portable-中文.txt'), 'completion fixture\n')
const home = resolve(process.env.MAYFLY_HOME ?? join(fixture, 'mayfly home'))
const profile = process.env.MAYFLY_SMOKE_PROFILE ?? 'mayfly-release'
if (!profile.startsWith('mayfly-')) throw new Error('acceptance requires a dedicated mayfly-<tag> profile')
const entry = installedCli()
const env = { ...process.env, MAYFLY_HOME: home, DEEPSEEK_API_KEY: 'mayfly-platform-smoke-key', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
for (const key of ['COLUMNS', 'LINES', 'MAYFLY_DSH_STARTUP_URL']) delete env[key]
if (process.platform === 'win32') {
  for (const key of Object.keys(env).filter(key => key.toLowerCase() === 'path')) {
    env[key] = env[key].split(';').filter(path => !/[\\/]git[\\/](?:bin|usr[\\/]bin|mingw64[\\/]bin)[\\/]?$/i.test(path)).join(';')
  }
}
const recordFile = join(home, 'run', profile, 'connection.json')
const readRecord = () => JSON.parse(readFileSync(recordFile, 'utf8'))
let terminal
let screen
let output = ''
let exitCode
let passed = false
let startupUrl
const scenarios = []
const commands = []
const view = () => Array.from({ length: screen.rows }, (_, row) => screen.buffer.active.getLine(row)?.translateToString(true) ?? '').join('\n')
const redact = text => String(text).replace(/([?&]token=)[^\s"'<>]+/gu, '$1[REDACTED]')
async function cli(args, allowed = [0]) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [entry, 'server', ...args, '--profile', profile], { cwd: workspace, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error(`server ${args[0]} timed out`)) }, 1_200_000)
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      commands.push({ args, code, stdout: redact(stdout), stderr: redact(stderr) })
      if (!allowed.includes(code)) reject(new Error(`server ${args[0]} failed (${code}): ${redact(stderr)}`))
      else resolveRun(stdout)
    })
  })
}
async function waitFor(predicate, label, timeout = 60_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await predicate()) return
    if (exitCode !== undefined) throw new Error(`TUI exited (${exitCode}) while waiting for ${label}`)
    await sleep(100)
  }
  throw new Error(`timed out waiting for ${label}\n${screen ? view() : ''}`)
}
async function command(text) {
  terminal.write('\x1b')
  await sleep(150)
  terminal.write('\x15')
  terminal.write(`\x1b[200~${text}\x1b[201~`)
  await sleep(150)
  terminal.write('\r')
}
try {
  // Real OS service managers, not command mocks. Neither help nor version may materialize a profile.
  await cli(['stop'])
  await cli(['status'], [3])
  await cli(['start'])
  const first = readRecord()
  startupUrl = first.url
  const expected = JSON.parse(readFileSync(installedManifests(entry)[0], 'utf8')).version
  for (const file of installedManifests(entry)) assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, expected)
  assert.match(await cli(['status']), /running/u)
  const remote = createRequire(entry).resolve('@ephemeral-ai/mayfly-remote/client')
  const { smokeHostClient } = await import(pathToFileURL(remote).href)
  await smokeHostClient({ key: 'platform-smoke', startupUrl, cwd: workspace })
  scenarios.push('five-package-version', 'authenticated-http-websocket')
  await cli(['enable'])
  assert.equal(readRecord().generation, first.generation)
  await cli(['disable'])
  assert.equal(readRecord().generation, first.generation)
  scenarios.push('login-policy-preserves-running-host')
  // The PID comes from the exact child this isolated test just started.
  process.kill(first.hostPid, 'SIGKILL')
  await waitFor(() => {
    try { const record = readRecord(); return record.state === 'running' && record.hostPid !== first.hostPid } catch { return false }
  }, 'native crash recovery')
  await cli(['status'])
  scenarios.push('crash-recovery')
  await cli(['restart'])
  assert.notEqual(readRecord().url, startupUrl)
  startupUrl = readRecord().url
  scenarios.push('restart-rotates-credentials')

  screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
  terminal = pty.spawn(process.execPath, [entry, '--profile', profile, '--cwd', workspace], { name: 'xterm-256color', cols: 100, rows: 30, cwd: workspace, env })
  terminal.onData(data => { output += data; screen.write(data) })
  screen.onData(data => terminal.write(data))
  terminal.onExit(event => { exitCode = event.exitCode })
  await waitFor(() => output.includes('\x1b[?2004h') && view().includes('deepseek'), 'split TUI frame')
  terminal.write('\x1b[200~portable 输入\x1b[201~')
  await waitFor(() => view().includes('portable 输入'), 'Unicode bracketed paste')
  terminal.write('\x7f')
  await waitFor(() => view().includes('portable 输') && !view().includes('portable 输入'), 'editor backspace')
  terminal.resize(40, 24)
  screen.resize(40, 24)
  await waitFor(() => view().includes('portable 输'), 'narrow resize')
  terminal.resize(100, 30)
  screen.resize(100, 30)
  await sleep(300)
  scenarios.push('boot', 'unicode-paste', 'edit', 'resize-100-40-100')
  await command('/help')
  await waitFor(() => /Commands|命令|help/u.test(view()), 'command panel')
  terminal.write('\x1b')
  await sleep(300)
  await command('/quit')
  await waitFor(() => exitCode !== undefined, 'clean TUI exit')
  assert.equal(exitCode, 0)
  assert.ok(output.includes('\x1b[?2004l'), 'terminal restoration')
  assert.doesNotMatch(output, /exceeds terminal width|Uncaught|pi-crash\.log/u)
  await cli(['status'])
  scenarios.push('command-panel', 'exit-restore', 'tui-exit-keeps-host')
  const logs = await cli(['logs'])
  assert.ok(!logs.includes(new URL(startupUrl).searchParams.get('token')), 'logs omit credentials')
  await cli(['stop'])
  await sleep(4000)
  await cli(['status'], [3])
  scenarios.push('redacted-logs', 'explicit-stop-prevents-recovery')
  passed = true
  console.log(`PLATFORM_PTY_PASS ${process.platform}-${process.arch}: ${scenarios.join(', ')}`)
} finally {
  if (terminal && exitCode === undefined) {
    terminal.kill()
    for (let attempt = 0; attempt < 20 && exitCode === undefined; attempt += 1) await sleep(100)
  }
  screen?.dispose()
  await cli(['stop']).catch(() => {})
  await cli(['disable']).catch(() => {})
  writeFileSync(join(artifactRoot, 'terminal.log'), redact(output))
  writeFileSync(join(artifactRoot, 'commands.json'), JSON.stringify(commands, null, 2))
  writeFileSync(join(artifactRoot, 'result.json'), JSON.stringify({ platform: process.platform, arch: process.arch, passed, scenarios, exitCode }, null, 2))
  // Remove only the stopped test's own service registration; preserve externally supplied acceptance homes.
  if (!process.env.MAYFLY_HOME) {
    const id = `dev.mayfly.${createHash('sha256').update(join(home, 'run', profile)).digest('hex').slice(0, 20)}`
    if (process.platform === 'linux') rmSync(join(homedir(), '.config/systemd/user', `${id}.service`), { force: true })
    rmSync(fixture, { recursive: true, force: true })
  }
}
if (process.platform === 'win32') process.stdout.write('', () => process.exit(0))
