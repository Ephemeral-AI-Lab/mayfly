#!/usr/bin/env node
/**
 * Exercise a packed CLI's first-run calibration without publishing packages.
 * A loopback registry serves the packed Mayfly artifacts and read-only proxies
 * all other package downloads to npm for the lifetime of this process.
 *
 * Run after `pnpm run check:pack`.
 * @module script/smoke-cli-local-registry
 */

import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ROOT } from './package-contract.mjs'

const packRoot = join(ROOT, '.artifacts', 'pack')
const indexPath = join(packRoot, 'index.json')
if (!existsSync(indexPath)) throw new Error('pack index is missing; run `pnpm run check:pack` first')

const index = JSON.parse(readFileSync(indexPath, 'utf8'))
const expectedNames = ['@ephemeral-ai/mayfly-ui', '@ephemeral-ai/mayfly', '@ephemeral-ai/mayfly-cli']
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

const version = releases.get('@ephemeral-ai/mayfly')?.manifest.version
if (typeof version !== 'string') throw new Error('packed Mayfly version is missing')

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

const cliTarball = releases.get('@ephemeral-ai/mayfly-cli')?.tarball
if (cliTarball === undefined) throw new Error('packed CLI tarball is missing')
const install = spawnSync('npm', [
  'install', '--prefix', cliRoot, '--ignore-scripts', '--no-audit', '--no-fund', cliTarball,
], { cwd: ROOT, encoding: 'utf8', timeout: 120_000 })
if (install.status !== 0) {
  throw new Error(`packed CLI install failed:\n${install.stderr || install.stdout}`)
}

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

/** Build the minimal npm packument pnpm needs for one local release. */
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
    const timer = setTimeout(() => child.kill('SIGKILL'), 300_000)
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout, stderr })
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
  delete env.NODE_AUTH_TOKEN
  delete env.NPM_TOKEN
  Object.assign(env, {
    HOME: userHome,
    XDG_CONFIG_HOME: join(userHome, '.config'),
    TMPDIR: fixtureTemp,
    DSH_HOME: dshHome,
    DEEPSEEK_API_KEY: 'mayfly-local-registry-smoke',
    NO_COLOR: '1',
    COREPACK_NPM_REGISTRY: registryUrl.slice(0, -1),
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_registry: registryUrl,
    NPM_CONFIG_REGISTRY: registryUrl,
    PNPM_CONFIG_MINIMUM_RELEASE_AGE: '0',
  })

  const cliBin = join(cliRoot, 'node_modules', '.bin', 'mayfly')
  const result = await run(cliBin, ['--dump-config'], env)
  if (result.code !== 0) {
    throw new Error(`first-run calibration failed (${result.signal ?? result.code}):\n${result.stderr}\n${result.stdout}`)
  }

  const expectedRequests = ['@ephemeral-ai/mayfly', '@ephemeral-ai/mayfly-ui']
  for (const name of expectedRequests) {
    if (!requested.has(name)) throw new Error(`first-run calibration never requested ${name}`)
    const manifest = JSON.parse(readFileSync(join(dshHome, 'profiles', 'mayfly', 'node_modules', ...name.split('/'), 'package.json'), 'utf8'))
    if (manifest.version !== version) throw new Error(`${name}: expected ${version}, got ${manifest.version}`)
  }
  const profile = JSON.parse(readFileSync(join(dshHome, 'profiles', 'mayfly', 'package.json'), 'utf8'))
  if (profile.dependencies?.['@ephemeral-ai/mayfly'] !== version) {
    throw new Error(`profile spec is not the exact Mayfly version ${version}`)
  }
  const cache = join(dshHome, 'cache', 'mayfly-cli-runtime', `${version}-0.1.2-alpha.5`)
  if (!existsSync(cache) || readdirSync(cache).length === 0) throw new Error('packed CLI did not materialize its runtime cache')

  console.log(`CLI_LOCAL_REGISTRY_SMOKE_PASS mayfly=${version} profile=mayfly packages=2`)
} finally {
  await new Promise(resolve => server.close(resolve))
  rmSync(fixtureRoot, { recursive: true, force: true })
}
