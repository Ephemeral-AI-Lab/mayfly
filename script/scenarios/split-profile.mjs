/** Isolated official dsh Host profile for real split-process verification. @module script/scenarios/split-profile */

import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { redactSplitOutput } from './split-reference.mjs'

/** Keep each fixture's Git discovery inside its own home, even when artifacts live in a checkout. */
export function splitProfileEnvironment(homeDir) {
  return { ...process.env, HOME: homeDir, DSH_HOME: join(homeDir, '.dsh'), GIT_CEILING_DIRECTORIES: resolve(homeDir), CI: 'true', DEEPSEEK_API_KEY: 'split-scenario-key' }
}

/** Install only inside an artifacts home; never upgrade dsh or touch the user's profiles. */
export function prepareSplitProfile({ root, dshBin, artifacts }) {
  const required = JSON.parse(readFileSync(join(root, 'packages/host/package.json'), 'utf8')).peerDependencies['@deepseek-ai/dsh-session']
  const version = spawnSync(dshBin, ['--version'], { encoding: 'utf8' })
  if (version.status !== 0 || version.stdout.trim() !== required) throw new Error(`Split Host requires dsh ${required}; choose an already installed matching DSH_BIN`)
  const key = createHash('sha256').update(`${resolve(root)}\n${required}`).digest('hex').slice(0, 12)
  const homeDir = join(artifacts, 'homes', key)
  const dshHome = join(homeDir, '.dsh')
  const profileDir = join(dshHome, 'profiles', 'mayfly-split-test')
  const cwd = join(homeDir, 'workspace')
  mkdirSync(cwd, { recursive: true })
  const env = splitProfileEnvironment(homeDir)
  for (const name of ['MAYFLY_DSH_STARTUP_URL', 'MAYFLY_ENDPOINT', 'NODE_OPTIONS', 'DEEPSEEK_BASE_URL']) delete env[name]
  const run = (bin, args) => {
    const result = spawnSync(bin, args, { env, cwd, encoding: 'utf8', timeout: 600_000 })
    if (result.status !== 0) throw new Error(`Isolated split profile setup failed (${bin}, exit ${result.status}):\n${redactSplitOutput(`${result.stdout ?? ''}\n${result.stderr ?? ''}`).slice(-5000)}`)
  }
  const ready = join(profileDir, '.mayfly-split-ready')
  if (!existsSync(ready)) {
    run(dshBin, ['--profile', 'mayfly-split-test', '--from-default-profile', 'web', '--dump-config'])
    const workspace = join(profileDir, 'pnpm-workspace.yaml')
    const source = readFileSync(workspace, 'utf8')
    if (!/^allowBuilds:/mu.test(source)) writeFileSync(workspace, `${source}\nallowBuilds:\n  koffi: false\n  node-pty: false\n`)
    run(dshBin, ['plugin', '--profile', 'mayfly-split-test', 'add', `link:${join(root, 'packages/host')}`])
    run(process.execPath, [join(root, 'script/ensure-loader-entries.mjs'), join(root, 'packages/host'), profileDir, dshBin])
    writeFileSync(ready, `${required}\n`)
  }
  return { cwd, env, profileDir, version: required }
}

/** Wait for the actual Host's authenticated readiness URL; keep credentials in memory only. */
export async function launchSplitHost({ root, dshBin, artifacts, baseURL, probe = false, startup }) {
  const profile = prepareSplitProfile({ root, dshBin, artifacts })
  // Reuse installed dependencies, never reuse previous scenarios' sessions or settings.
  const runDir = join(artifacts, 'runs', randomUUID())
  mkdirSync(runDir, { recursive: true })
  const patch = join(runDir, 'overlay.yml')
  const clockRelease = join(runDir, 'release-clock')
  const auditLog = join(runDir, 'probe.jsonl')
  writeFileSync(patch, [
    `- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(join(runDir, 'sessions'))}`,
    `- id: storage-json\n  config:\n    root: ${JSON.stringify(join(runDir, 'storages'))}`,
    '- id: session-title-llm\n  disabled: true',
    `- id: mayfly\n  config:\n    reducedMotion: true\n    updateCheck: false${startup === undefined ? '' : `\n    startup: ${JSON.stringify(startup)}`}`,
    ...(probe ? [
      '- id: user-approval\n  config:\n    policy: ask',
      `- insert:\n    - id: mayfly-split-parity-probe\n      name: ${JSON.stringify(new URL('./split-probe.mjs', import.meta.url).href)}`,
    ] : []),
  ].join('\n') + '\n')
  const child = spawn(dshBin, ['--profile', 'mayfly-split-test', '--patch', patch, '--host', '127.0.0.1', '--port', '0', '--no-open'], {
    cwd: profile.cwd,
    env: { ...profile.env, DEEPSEEK_BASE_URL: `${baseURL}/v1`, MAYFLY_SPLIT_PROBE_LOG: auditLog, MAYFLY_SPLIT_CLOCK_RELEASE: clockRelease, NODE_OPTIONS: `--import=${new URL('./split-clock.mjs', import.meta.url).href}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  let spawnError
  child.on('error', error => { spawnError = error })
  const record = data => { output = (output + data.toString()).slice(-20_000) }
  child.stdout.on('data', record)
  child.stderr.on('data', record)
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    for (let count = 0; count < 100 && child.exitCode === null && child.signalCode === null; count += 1) await sleep(25)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  const started = performance.now()
  for (;;) {
    const url = /mayfly host: (https?:\/\/[^\s\u001b]+)/u.exec(output)?.[1]
    if (url !== undefined) return { ...profile, child, startupUrl: url, clockRelease, auditLog, stop, diagnostics: () => redactSplitOutput(output, url) }
    if (spawnError !== undefined || child.exitCode !== null || performance.now() - started > 90_000) {
      await stop()
      throw new Error(`Split Host did not become ready: ${spawnError?.message ?? ''}\n${redactSplitOutput(output)}`)
    }
    await sleep(25)
  }
}
