/** Acquire and drive the actual immutable npm rc.2 runtime, independent of candidate renderer sources. @module script/scenarios/split-baseline */

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { t as listTar } from 'tar'
import { SPLIT_SMOKE_STEPS } from './split-runner.mjs'
import { SPLIT_REFERENCE, redactSplitOutput, verifyReferenceTarball } from './split-reference.mjs'
import { captureSplitTerminal } from './split-terminal.mjs'
import { startStubModel } from './stub-model.mjs'
import { awaitProbeAudit } from './split-audit.mjs'
import { splitProfileEnvironment } from './split-profile.mjs'
import { persistedSplitEvidence } from './split-evidence.mjs'
import { seedSplitNativeWorkspace } from './split-native-fixture.mjs'

const HARNESS_REFERENCE_VERSION = '0.2.1-rc.2'

async function setup(command, args, cwd, env) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', data => { output = (output + data.toString()).slice(-20_000) })
  child.stderr.on('data', data => { output = (output + data.toString()).slice(-20_000) })
  const timer = setTimeout(() => child.kill('SIGTERM'), 600_000)
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Published reference setup failed (${command}, exit ${code}):\n${redactSplitOutput(output)}`)))
    })
  } finally { clearTimeout(timer) }
}

/** Verify registry metadata and tarball bytes, then install one reproducible, separately locked reference graph. */
export async function acquirePublishedReference({ root, dir }) {
  mkdirSync(dir, { recursive: true })
  const tarball = join(dir, 'mayfly-0.1.4-rc.2.tgz')
  if (!existsSync(tarball)) {
    const metadataResponse = await fetch('https://registry.npmjs.org/@ephemeral-ai%2fmayfly/0.1.4-rc.2')
    if (!metadataResponse.ok) throw new Error(`Cannot fetch frozen reference metadata: ${metadataResponse.status}`)
    const metadata = await metadataResponse.json()
    if (metadata.dist?.integrity !== SPLIT_REFERENCE.integrity) throw new Error('Registry reference integrity differs from frozen rc.2')
    const response = await fetch(metadata.dist.tarball)
    if (!response.ok) throw new Error(`Cannot fetch frozen reference tarball: ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    verifyReferenceTarball(bytes)
    writeFileSync(tarball, bytes, { flag: 'wx' })
  }
  verifyReferenceTarball(readFileSync(tarball))
  let packageJson = ''
  await listTar({ file: tarball, onReadEntry: entry => { if (entry.path === 'package/package.json') entry.on('data', data => { packageJson += data.toString() }) } })
  const metadata = JSON.parse(packageJson)
  const install = join(dir, 'install')
  mkdirSync(install, { recursive: true })
  const manifest = join(install, 'package.json')
  // The published bundle declares optional peers. A full reference profile supplies
  // them at its own declared development pins, rather than silently omitting views.
  const peers = Object.fromEntries(Object.keys(metadata.peerDependencies ?? {}).map(name => [name, metadata.devDependencies?.[name] ?? metadata.peerDependencies[name]]))
  const packageText = JSON.stringify({ name: 'mayfly-frozen-reference', private: true, type: 'module', dependencies: { ...peers, '@deepseek-ai/dsh': HARNESS_REFERENCE_VERSION, '@ephemeral-ai/mayfly': `file:${tarball}`, '@ephemeral-ai/mayfly-ui': SPLIT_REFERENCE.version } }, null, 2) + '\n'
  const changed = !existsSync(manifest) || readFileSync(manifest, 'utf8') !== packageText
  if (changed) {
    writeFileSync(manifest, packageText)
    writeFileSync(join(install, 'pnpm-workspace.yaml'), 'packages: []\nallowBuilds:\n  koffi: false\n  node-pty: false\n  esbuild: false\n  protobufjs: false\n  "@google/genai": false\n  "@deepseek-ai/dsh-subprocess-local": false\n')
  }
  const env = { ...process.env, CI: 'true' }
  delete env.NODE_OPTIONS
  const lock = join(install, 'pnpm-lock.yaml')
  const stamp = createHash('sha256').update(packageText).digest('hex')
  const installedStamp = join(install, '.installed')
  if (changed || !existsSync(installedStamp) || readFileSync(installedStamp, 'utf8') !== stamp) {
    await setup('pnpm', ['install', '--ignore-scripts', '--no-frozen-lockfile'], install, env)
    writeFileSync(installedStamp, stamp)
  }
  const dsh = realpathSync(join(install, 'node_modules/@deepseek-ai/dsh'))
  const installed = JSON.parse(readFileSync(join(install, 'node_modules/@ephemeral-ai/mayfly/package.json'), 'utf8'))
  if (installed.version !== SPLIT_REFERENCE.version) throw new Error('Installed reference package has an unexpected version')
  if (!isDeepStrictEqual(installed.peerDependencies, metadata.peerDependencies) || !isDeepStrictEqual(installed.devDependencies, metadata.devDependencies)) throw new Error('Installed dependency metadata differs from the verified package manifest')
  return { dshBin: join(dsh, 'lib/bin.js'), install, lockHash: createHash('sha256').update(readFileSync(lock)).digest('hex') }
}

/** Generate reference frames exclusively from the verified published runtime, never the candidate. */
export async function capturePublishedReference({ root, dir, cols = 80, rows = 24, steps = SPLIT_SMOKE_STEPS, probe = false, startup, fixture, workspace, profileTag, caseName }) {
  const acquired = await acquirePublishedReference({ root, dir })
  const profileHome = join(dir, profileTag === undefined ? 'profile-home' : `profile-home-${profileTag}`)
  const profile = join(profileHome, '.dsh/profiles/mayfly-rc2-test')
  const work = workspace ?? join(profileHome, 'workspace')
  mkdirSync(work, { recursive: true })
  seedSplitNativeWorkspace(work, fixture)
  const env = splitProfileEnvironment(profileHome)
  for (const name of ['NODE_OPTIONS', 'MAYFLY_DSH_STARTUP_URL', 'MAYFLY_ENDPOINT', 'MAYFLY_SESSION_ID', 'MAYFLY_TASK']) delete env[name]
  const ready = join(profile, '.published-reference-ready')
  if (!existsSync(ready)) {
    mkdirSync(profile, { recursive: true })
    const workspace = join(profile, 'pnpm-workspace.yaml')
    const source = existsSync(workspace) ? readFileSync(workspace, 'utf8') : ''
    if (!/^allowBuilds:/mu.test(source)) writeFileSync(workspace, `${source}\nallowBuilds:\n  koffi: false\n  node-pty: false\n`)
    const bundle = join(acquired.install, 'node_modules/@ephemeral-ai/mayfly')
    const ui = join(acquired.install, 'node_modules/@ephemeral-ai/mayfly-ui')
    await setup(acquired.dshBin, ['plugin', '--profile', 'mayfly-rc2-test', 'add', `link:${bundle}`, `link:${ui}`], work, env)
    await setup(process.execPath, [join(root, 'script/ensure-loader-entries.mjs'), bundle, profile, acquired.dshBin], work, env)
    await setup('pnpm', ['install', '--no-frozen-lockfile', '--ignore-scripts'], profile, env)
    writeFileSync(ready, SPLIT_REFERENCE.integrity)
  }
  const run = join(dir, 'runs', randomUUID())
  mkdirSync(run, { recursive: true })
  const patch = join(run, 'overlay.yml')
  const release = join(run, 'release-clock')
  const auditLog = join(run, 'probe.jsonl')
  writeFileSync(patch, [
    `- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(join(run, 'sessions'))}`,
    `- id: storage-json\n  config:\n    root: ${JSON.stringify(join(run, 'storages'))}`,
    `- id: mayfly\n  config:\n    reducedMotion: true\n    updateCheck: false${startup === undefined ? '' : `\n    startup: ${JSON.stringify(startup)}`}`,
    '- id: session-title-llm\n  disabled: true',
    ...(probe ? [
      '- id: user-approval\n  config:\n    policy: ask',
      `- insert:\n    - id: mayfly-split-parity-probe\n      name: ${JSON.stringify(new URL('./split-probe.mjs', import.meta.url).href)}`,
    ] : []),
  ].join('\n') + '\n')
  const stub = await startStubModel({ probe })
  const childEnv = { ...env, TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8', TZ: 'UTC', DEEPSEEK_BASE_URL: `${stub.baseURL}/v1`, MAYFLY_SPLIT_PROBE_LOG: auditLog, MAYFLY_SPLIT_CLOCK_RELEASE: release, NODE_OPTIONS: `--import=${new URL('./split-clock.mjs', import.meta.url).href}` }
  for (const name of ['CI', 'COLUMNS', 'LINES', 'NO_COLOR', 'FORCE_COLOR']) delete childEnv[name]
  let captured
  try {
    captured = await captureSplitTerminal({ bin: acquired.dshBin, args: ['--profile', 'mayfly-rc2-test', '--patch', patch], cwd: work, env: childEnv, cols, rows, steps, stub, audit: step => awaitProbeAudit(auditLog, step), beforeExit: async () => { writeFileSync(release, 'release'); await sleep(30) } })
  } finally { await stub.close() }
  const captureDir = join(dir, 'captures', caseName ?? '')
  mkdirSync(captureDir, { recursive: true })
  writeFileSync(join(captureDir, 'reference.ansi'), captured.output)
  if (captured.failures.length > 0) throw new Error(`Published reference capture failed:\n${captured.failures.join('\n')}`)
  const file = join(captureDir, 'reference.json')
  const provenance = { ...SPLIT_REFERENCE, harness: HARNESS_REFERENCE_VERSION, dependencyLockSha256: acquired.lockHash, profileLockSha256: createHash('sha256').update(readFileSync(join(profile, 'pnpm-lock.yaml'))).digest('hex'), stepsSha256: createHash('sha256').update(JSON.stringify(steps)).digest('hex'), ...startup === undefined ? {} : { startup }, ...fixture === undefined ? {} : { fixture }, ...workspace === undefined ? {} : { workspace }, ...profileTag === undefined ? {} : { profileTag } }
  const manifest = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { ...provenance, checkpoints: {} }
  for (const [key, value] of Object.entries(provenance)) if (manifest[key] !== value) throw new Error(`Published reference provenance changed (${key}); use a separate artifacts directory and review the difference`)
  for (const checkpoint of captured.checkpoints) {
    const name = `${checkpoint.name}-${checkpoint.cols}x${checkpoint.rows}.grid`
    const hash = createHash('sha256').update(checkpoint.grid).digest('hex')
    if (manifest.checkpoints[name] !== undefined && manifest.checkpoints[name] !== hash) throw new Error(`Published reference is not deterministic: ${name}; retain existing reference and inspect reference.ansi`)
    const target = join(captureDir, name)
    if (!existsSync(target)) writeFileSync(target, checkpoint.grid, { flag: 'wx' })
    manifest.checkpoints[name] = hash
  }
  writeFileSync(file, JSON.stringify(manifest, null, 2) + '\n')
  // Keep capture/run linkage outside the immutable screen/provenance manifest.
  const evidence = persistedSplitEvidence(run)
  writeFileSync(join(captureDir, `native-evidence-${run.slice(run.lastIndexOf('/') + 1)}.json`), JSON.stringify({ referenceManifestSha256: createHash('sha256').update(readFileSync(file)).digest('hex'), ...evidence }, null, 2) + '\n')
  return captureDir
}
