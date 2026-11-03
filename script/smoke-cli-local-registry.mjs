#!/usr/bin/env node
/**
 * Install the packed pure-TUI CLI through a loopback registry and exercise its
 * Host-free help/version and credential-rejection surfaces. Other package
 * downloads proxy to npm; no Host or legacy profile is started.
 *
 * Run after `pnpm run check:pack`.
 * @module script/smoke-cli-local-registry
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { RELEASE_PACKAGE_DIRS, ROOT, readManifest } from './package-contract.mjs'

const packRoot = join(ROOT, '.artifacts', 'pack')
const indexPath = join(packRoot, 'index.json')
if (!existsSync(indexPath)) throw new Error('pack index is missing; run `pnpm run check:pack` first')

const index = JSON.parse(readFileSync(indexPath, 'utf8'))
const expectedNames = RELEASE_PACKAGE_DIRS.map(directory => readManifest(directory).name)
if (JSON.stringify(index.packages?.map(pkg => pkg.name)) !== JSON.stringify(expectedNames)) {
  throw new Error(`pack index must contain exactly ${expectedNames.join(', ')}`)
}

const releases = new Map(index.packages.map((record) => {
  const tarball = join(packRoot, record.filename)
  const unpacked = join(packRoot, 'unpacked', record.name.replace(/[^a-z0-9]+/giu, '-'))
  const manifest = JSON.parse(readFileSync(join(unpacked, 'package.json'), 'utf8'))
  const bytes = readFileSync(tarball)
  return [record.name, {
    manifest,
    tarball,
    filename: record.filename,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    shasum: createHash('sha1').update(bytes).digest('hex'),
  }]
}))

const version = releases.get('@ephemeral-ai/mayfly-cli')?.manifest.version
if (typeof version !== 'string') throw new Error('packed CLI version is missing')
const cliTarball = releases.get('@ephemeral-ai/mayfly-cli')?.tarball
if (cliTarball === undefined) throw new Error('packed CLI tarball is missing')

const fixtureParent = join(ROOT, '.artifacts', 'tmp')
mkdirSync(fixtureParent, { recursive: true })
const fixtureRoot = mkdtempSync(join(fixtureParent, 'mayfly-cli-registry-'))
const cliRoot = join(fixtureRoot, 'cli')
const userHome = join(fixtureRoot, 'home')
const dshHome = join(fixtureRoot, 'dsh')
const fixtureTemp = join(fixtureRoot, 'tmp')
mkdirSync(cliRoot)
mkdirSync(userHome)
mkdirSync(fixtureTemp)

const requested = new Set()
let registryUrl

/** Send one JSON response. */
function json(response, status, value) {
  const body = `${JSON.stringify(value)}\n`
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

/** Build the minimal npm packument for one local release. */
function packument(name, release) {
  const manifest = {
    ...release.manifest,
    dist: {
      integrity: release.integrity,
      shasum: release.shasum,
      tarball: `${registryUrl}tarballs/${release.filename}`,
    },
  }
  return {
    _id: name,
    name,
    'dist-tags': { alpha: manifest.version, latest: manifest.version },
    versions: { [manifest.version]: manifest },
  }
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', registryUrl)
    const decodedPath = decodeURIComponent(url.pathname).replace(/\/+$/u, '')
    if (decodedPath.startsWith('/tarballs/')) {
      const filename = decodedPath.slice('/tarballs/'.length)
      const release = [...releases.values()].find(candidate => candidate.filename === filename)
      if (release === undefined) return json(response, 404, { error: 'not found' })
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': statSync(release.tarball).size,
      })
      if (request.method === 'HEAD') return response.end()
      createReadStream(release.tarball).pipe(response)
      return
    }

    const name = decodedPath.slice(1)
    const release = releases.get(name)
    if (release !== undefined && name !== '@ephemeral-ai/mayfly-cli') {
      requested.add(name)
      if (request.method === 'HEAD') {
        response.writeHead(200, { 'content-type': 'application/json' })
        return response.end()
      }
      return json(response, 200, packument(name, release))
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 200, {})
    const upstream = await fetch(new URL(request.url ?? '/', 'https://registry.npmjs.org'), {
      method: request.method,
      headers: request.headers.accept === undefined ? {} : { accept: request.headers.accept },
      signal: AbortSignal.timeout(30_000),
    })
    const headers = {}
    for (const name of ['content-type', 'content-length', 'cache-control', 'etag']) {
      const value = upstream.headers.get(name)
      if (value !== null) headers[name] = value
    }
    response.writeHead(upstream.status, headers)
    if (request.method === 'HEAD' || upstream.body === null) return response.end()
    Readable.fromWeb(upstream.body).pipe(response)
  } catch (error) {
    if (!response.headersSent) json(response, 500, { error: error instanceof Error ? error.message : String(error) })
    else response.destroy(error instanceof Error ? error : undefined)
  }
})

/** Spawn one command without blocking the loopback registry. */
function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 300_000)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, timedOut, stdout, stderr })
    })
  })
}

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('loopback registry did not bind a TCP port')
  registryUrl = `http://127.0.0.1:${address.port}/`
  const userConfig = join(userHome, '.npmrc')
  writeFileSync(userConfig, `registry=${registryUrl}\n`)

  const env = { ...process.env }
  for (const name of ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'MAYFLY_DSH_STARTUP_URL', 'MAYFLY_ENDPOINT', 'MAYFLY_SESSION_ID', 'MAYFLY_CWD', 'MAYFLY_TASK']) delete env[name]
  Object.assign(env, {
    HOME: userHome,
    XDG_CONFIG_HOME: join(userHome, '.config'),
    TMPDIR: fixtureTemp,
    DSH_HOME: dshHome,
    NO_COLOR: '1',
    COREPACK_NPM_REGISTRY: registryUrl.slice(0, -1),
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_registry: registryUrl,
    NPM_CONFIG_REGISTRY: registryUrl,
    PNPM_CONFIG_MINIMUM_RELEASE_AGE: '0',
  })

  const install = await run('npm', [
    'install', '--prefix', cliRoot, '--ignore-scripts', '--no-audit', '--no-fund', cliTarball,
  ], env)
  if (install.code !== 0) throw new Error(`packed CLI install failed${install.timedOut ? ' (300s timeout)' : ''}:\n${install.stderr.slice(-20_000)}\n${install.stdout.slice(-5000)}`)

  for (const name of ['@ephemeral-ai/mayfly-remote', '@ephemeral-ai/mayfly', '@ephemeral-ai/mayfly-ui']) {
    if (!requested.has(name)) throw new Error(`packed CLI install never requested ${name}`)
    const manifest = JSON.parse(readFileSync(join(cliRoot, 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
    if (manifest.version !== version) throw new Error(`${name}: expected ${version}, got ${manifest.version}`)
  }

  const cliBin = join(cliRoot, 'node_modules', '.bin', 'mayfly')
  const reportedVersion = await run(cliBin, ['--version'], env)
  if (reportedVersion.code !== 0 || reportedVersion.stdout !== `mayfly ${version}\n`) {
    throw new Error(`packed CLI --version failed:\n${reportedVersion.stderr}\n${reportedVersion.stdout}`)
  }
  const help = await run(cliBin, ['--help'], env)
  if (help.code !== 0 || !help.stdout.includes('Usage: mayfly') || !help.stdout.includes('MAYFLY_DSH_STARTUP_URL')) {
    throw new Error(`packed CLI --help failed:\n${help.stderr}\n${help.stdout}`)
  }

  const secret = 'mayfly-pack-smoke-secret'
  const rejected = await run(cliBin, [`--host=http://127.0.0.1:3080/?token=${secret}`], env)
  if (rejected.code !== 1 || !rejected.stderr.includes('MAYFLY_DSH_STARTUP_URL') || rejected.stderr.includes(secret) || rejected.stdout.includes(secret)) {
    throw new Error('packed CLI did not reject and redact a token-bearing argument')
  }
  if (existsSync(join(dshHome, 'cache', 'mayfly-cli-runtime')) || existsSync(join(dshHome, 'profiles', 'mayfly'))) {
    throw new Error('packed CLI created a legacy runtime cache or profile')
  }

  console.log(`CLI_LOCAL_REGISTRY_SMOKE_PASS mayfly=${version} remote=${version} hostProcesses=0`)
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  rmSync(fixtureRoot, { recursive: true, force: true })
}
