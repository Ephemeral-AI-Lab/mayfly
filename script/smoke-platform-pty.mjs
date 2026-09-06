/**
 * Native PTY/ConPTY acceptance for a candidate launcher or a prepared profile.
 * No shell is used to boot the JavaScript entry or drive the TUI.
 * @module script/smoke-platform-pty
 */

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { c as createTar } from 'tar'

const require = createRequire(import.meta.url)
const pty = require('node-pty')
const { Terminal } = require('@xterm/headless')
const artifactRoot = resolve(process.env.MAYFLY_SMOKE_ARTIFACTS ?? '.artifacts/platform-pty')
mkdirSync(artifactRoot, { recursive: true })
const fixture = mkdtempSync(join(tmpdir(), 'mayfly-platform-'))
const workspace = join(fixture, 'workspace with spaces')
mkdirSync(workspace)
writeFileSync(join(workspace, 'portable-中文.txt'), 'completion fixture\n')
const home = process.env.DSH_HOME ?? join(fixture, 'dsh')
const profile = process.env.MAYFLY_SMOKE_PROFILE ?? 'mayfly'
const direct = process.env.MAYFLY_SMOKE_DSH_JS
if (direct !== undefined && (process.env.DSH_HOME === undefined || !profile.startsWith('mayfly-'))) {
  throw new Error('direct-host acceptance requires an explicit DSH_HOME and a mayfly-<tag> profile')
}

function globalLauncher() {
  const command = process.platform === 'win32' ? process.env.ComSpec ?? 'cmd.exe' : 'npm'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm root -g'] : ['root', '-g']
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true })
  if (result.status !== 0) throw new Error(`cannot locate installed launcher: ${result.stderr}`)
  return join(result.stdout.trim(), '@ephemeral-ai', 'mayfly-cli', 'lib', 'bin.js')
}

const entry = direct ?? process.env.MAYFLY_SMOKE_LAUNCHER ?? globalLauncher()
const env = { ...process.env, DSH_HOME: home, DEEPSEEK_API_KEY: 'mayfly-platform-smoke-key', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' }
if (direct !== undefined) env.MAYFLY_DSH_BIN = direct
delete env.COLUMNS
delete env.LINES
if (process.platform === 'win32') {
  // Hosted Windows runners carry Git Bash. Excluding its directories proves
  // application commands resolve through the native Windows command path.
  for (const key of Object.keys(env).filter(key => key.toLowerCase() === 'path')) {
    env[key] = env[key].split(';').filter(path => !/[\\/]git[\\/](?:bin|usr[\\/]bin|mingw64[\\/]bin)\/?$/i.test(path)).join(';')
  }
}

const fixtureName = 'mayfly-platform-fixture'
const packageRoot = join(fixture, 'package')
mkdirSync(packageRoot)
writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({
  name: fixtureName, version: '1.0.0', type: 'module', exports: './index.js',
  dsh: { bundle: { patch: './cordis.patch.yml' } },
}))
writeFileSync(join(packageRoot, 'index.js'), 'export const name = "mayfly-platform-fixture"\nexport function apply() {}\n')
writeFileSync(join(packageRoot, 'cordis.patch.yml'), '[]\n')
const tarball = join(fixture, 'fixture.tgz')
createTar({ cwd: fixture, file: tarball, gzip: true, sync: true }, ['package'])

const index = {
  schemaVersion: 1,
  entries: [{
    id: 'platform-fixture', source: 'community', displayName: 'Platform fixture',
    description: 'Local acceptance fixture', author: { name: 'Mayfly' }, category: 'testing',
    status: 'stable', surfaces: { tui: { contributions: [] } },
    install: { rows: [{ name: fixtureName, npm: { spec: `file:${tarball.replaceAll('\\', '/')}` } }] },
  }],
}

let terminal
let screen
let output = ''
let exitCode
let passed = false
const cachePath = join(home, 'storages', 'mayfly-plugin-market', 'cache.json')
let previousCache
let fixtureCache
const scenarios = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const view = () => Array.from({ length: screen.rows }, (_, row) => screen.buffer.active.getLine(row)?.translateToString(true) ?? '').join('\n')
async function waitFor(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (predicate()) return
    if (exitCode !== undefined) throw new Error(`exited (${exitCode}) while waiting for ${label}`)
    await delay(50)
  }
  throw new Error(`timed out waiting for ${label}\n${view()}`)
}
async function clearEditor() {
  terminal.write('\x1b')
  await delay(300)
  terminal.write('\x1b[F')
  await delay(100)
  terminal.write('\x15')
  await delay(200)
}
async function command(text) {
  await clearEditor()
  terminal.write(`\x1b[200~${text}\x1b[201~`)
  await delay(100)
  terminal.write('\r')
}
const manifestPath = join(home, 'profiles', profile, 'package.json')
const installed = () => JSON.parse(readFileSync(manifestPath, 'utf8')).dependencies?.[fixtureName] !== undefined

try {
  if (direct === undefined) {
    const prepared = spawnSync(process.execPath, [entry, '--dump-config'], {
      cwd: workspace, env, encoding: 'utf8', timeout: 1_200_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
    })
    writeFileSync(join(artifactRoot, 'calibration.log'), `${prepared.stdout ?? ''}${prepared.stderr ?? ''}`)
    if (prepared.status !== 0) throw new Error(`launcher calibration failed (${prepared.status})`)
  }
  const cache = join(home, 'storages', 'mayfly-plugin-market')
  mkdirSync(cache, { recursive: true })
  previousCache = existsSync(cachePath) ? readFileSync(cachePath) : undefined
  fixtureCache = JSON.stringify({
    fetchedAt: Date.now(), indexUrl: 'https://raw.githubusercontent.com/Ephemeral-AI-Lab/dsh-plugins/main/dist/index.json', text: JSON.stringify(index),
  })
  writeFileSync(cachePath, fixtureCache)
  screen = new Terminal({ cols: 100, rows: 30, allowProposedApi: true })
  terminal = pty.spawn(process.execPath, [entry, ...(direct === undefined ? [] : ['--profile', profile])], {
    name: 'xterm-256color', cols: 100, rows: 30, cwd: workspace, env,
  })
  terminal.onData(data => { output += data; screen.write(data) })
  screen.onData(data => terminal.write(data))
  terminal.onExit(event => { exitCode = event.exitCode })
  await waitFor(() => output.includes('\x1b[?2004h'), 'bracketed-paste activation')
  await waitFor(() => view().includes('deepseek'), 'initial application frame')
  scenarios.push('boot')

  terminal.write('\x1b[200~portable 输入\x1b[201~')
  await waitFor(() => view().includes('portable 输入'), 'Unicode bracketed paste')
  terminal.write('\x7f')
  await waitFor(() => view().includes('portable 输') && !view().includes('portable 输入'), 'editor backspace')
  terminal.resize(40, 16)
  screen.resize(40, 16)
  await delay(300)
  await waitFor(() => view().includes('portable 输'), 'narrow resize')
  terminal.resize(100, 30)
  screen.resize(100, 30)
  await delay(300)
  scenarios.push('paste', 'edit', 'resize')

  await clearEditor()
  terminal.write('@')
  await waitFor(() => view().includes('portable-中文.txt'), 'filesystem completion')
  scenarios.push('file-completion')

  await command('/provider add')
  await waitFor(() => view().includes('Custom endpoint'), 'provider source picker')
  terminal.write('\x1b[B')
  await delay(100)
  terminal.write('\r')
  await waitFor(() => view().includes('Endpoint protocol'), 'provider protocol picker')
  terminal.write('\r')
  await waitFor(() => view().includes('Custom endpoint') && view().includes('Base URL'), 'provider form')
  terminal.write('portable-form')
  await waitFor(() => view().includes('portable-form'), 'form editing')
  terminal.write('\x7f')
  await waitFor(() => view().includes('portable-for') && !view().includes('portable-form'), 'form backspace')
  for (let attempt = 0; attempt < 3 && view().includes('Provider Name'); attempt += 1) {
    terminal.write('\x1b')
    await delay(350)
  }
  await waitFor(() => !view().includes('Provider Name'), 'provider form cancellation')
  scenarios.push('form-edit-cancel')

  await command('/plugin install platform-fixture')
  await waitFor(() => installed() && /installed; restart|restart Mayfly/.test(view()), 'in-app plugin install', 120_000)
  await command('/plugin uninstall platform-fixture')
  await waitFor(() => !installed() && /removed|uninstalled|restart Mayfly/.test(view()), 'in-app plugin removal', 120_000)
  scenarios.push('plugin-install', 'plugin-uninstall')

  await command('/quit')
  await waitFor(() => exitCode !== undefined, 'clean exit')
  if (exitCode !== 0 || !output.includes('\x1b[?2004l')) throw new Error('terminal restore or exit code failed')
  if (/exceeds terminal width|Uncaught|pi-crash\.log/.test(output)) throw new Error('TUI failure appeared in output')
  scenarios.push('exit-restore')
  passed = true
  console.log(`PLATFORM_PTY_PASS ${process.platform}-${process.arch}: ${scenarios.join(', ')}`)
} finally {
  if (terminal !== undefined && exitCode === undefined) {
    terminal.kill()
    for (let attempt = 0; attempt < 20 && exitCode === undefined; attempt += 1) await delay(100)
  }
  screen?.dispose()
  writeFileSync(join(artifactRoot, 'terminal.log'), output)
  writeFileSync(join(artifactRoot, 'result.json'), JSON.stringify({ platform: process.platform, arch: process.arch, passed, scenarios, exitCode }, null, 2))
  // Restore only our own fixture value; a concurrent real catalog refresh
  // must not be overwritten by cleanup from this acceptance run.
  if (fixtureCache !== undefined && existsSync(cachePath) && readFileSync(cachePath, 'utf8') === fixtureCache) {
    if (previousCache === undefined) rmSync(cachePath)
    else writeFileSync(cachePath, previousCache)
  }
  rmSync(fixture, { recursive: true, force: true })
}

// Child exit and artifact cleanup are complete; ConPTY workers can keep Node alive.
if (process.platform === 'win32') process.stdout.write('', () => process.exit(0))
