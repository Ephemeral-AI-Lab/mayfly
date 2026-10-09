// PTY benchmark (manual, and the coarse ceilings of `verify:full`): boots the real dsh CLI with a Mayfly checkout
// linked into a cached throwaway profile, drives one scripted session against a local mock LLM under a real
// pseudo-terminal, and reports per-phase wall time, process CPU, output bytes, and key-to-paint latency. It measures the
// path the work budgets cannot: the lane measure, pi-tui's native layout, and the animation clock, end to end.
// Run after `pnpm run build`:
//   node script/bench-pty.mjs [--scenario=product|gallery|focus] [--repo=<checkout>] [--label=<name>]
//                             [--gallery-repo=<checkout>] [--cols=120] [--rows=40] [--turns=<n>] [--prof]
// Results land in .artifacts/bench/<label>-<scenario>.json; CPU columns need /proc (Linux).

import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { assertDshVersion, resolveDshBin, root } from './smoke-lib.mjs'

const require = createRequire(import.meta.url)
const pty = require('node-pty')
const { startMockLlmServer } = require('@deepseek-ai/dsh-llm-mock-server')

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...value] = arg.replace(/^--/, '').split('=')
  return [key, value.length === 0 ? 'true' : value.join('=')]
}))
const SCENARIOS = ['product', 'gallery', 'focus']
const scenario = args.scenario ?? 'product'
if (!SCENARIOS.includes(scenario)) {
  console.error(`FAIL: unknown scenario "${scenario}" (one of ${SCENARIOS.join(', ')})`)
  process.exit(1)
}
const repo = resolve(args.repo ?? root)
const galleryRepo = resolve(args['gallery-repo'] ?? repo)
const gallery = scenario === 'gallery'
const label = args.label ?? 'head'
const cols = Number(args.cols ?? 120)
const rows = Number(args.rows ?? 40)
const turns = Number(args.turns ?? (gallery ? 1 : 3))
const chunkSize = 16
const chunkDelayMs = 10

const dshBin = resolveDshBin()
assertDshVersion(dshBin)
if (!existsSync(join(repo, 'packages/mayfly/lib/index.js'))) {
  console.error(`FAIL: ${repo}/packages/mayfly/lib/index.js missing: run pnpm run build there first`)
  process.exit(1)
}

// The profile is cached per linked checkout: a second run boots at once. The links follow the checkout's `lib/`.
const artifacts = join(root, '.artifacts/bench')
const profileKey = createHash('sha256').update([repo, gallery ? galleryRepo : ''].join('\n')).digest('hex').slice(0, 12)
const dshHome = join(artifacts, 'homes', profileKey, '.dsh')
const profileDir = join(dshHome, 'profiles', 'bench')
const work = join(artifacts, 'work', profileKey)
mkdirSync(work, { recursive: true })
const baseEnv = { ...process.env, DSH_HOME: dshHome, PI_CODING_AGENT_DIR: join(artifacts, 'homes', profileKey, 'pi-agent'), TERM: 'xterm-256color', COLORTERM: 'truecolor', LANG: 'en_US.UTF-8' }
// A PTY provides its own size, and the bench measures the default presentation.
for (const name of ['COLUMNS', 'LINES', 'NO_COLOR', 'CI', 'FORCE_COLOR', 'LC_ALL', 'LC_CTYPE', 'NODE_OPTIONS']) delete baseEnv[name]

function run(command, argv, env = baseEnv) {
  const result = spawnSync(command, argv, { encoding: 'utf8', env, timeout: 600_000 })
  if (result.status !== 0) {
    console.error(`FAIL: ${command} ${argv.join(' ')}\n${(result.stdout ?? '').slice(-2000)}\n${(result.stderr ?? '').slice(-2000)}`)
    process.exit(1)
  }
}

if (!existsSync(join(profileDir, 'node_modules'))) {
  console.error(`==> Linking ${repo} into a bench profile`)
  run(dshBin, ['plugin', '--profile', 'bench', 'add', `link:${repo}/packages/mayfly`, `link:${repo}/packages/ui`, ...(gallery ? [`link:${galleryRepo}/examples/ui-gallery`] : [])])
  run('node', [join(repo, 'script/ensure-loader-entries.mjs'), join(repo, 'packages/mayfly'), profileDir, dshBin])
  run('pnpm', ['--dir', profileDir, 'install', '--no-frozen-lockfile'], { ...baseEnv, CI: 'true' })
}

/** A reply shaped like a real answer: prose, lists, a table, and fenced code in two languages. */
function reply() {
  const parts = []
  for (let section = 1; section <= 8; section += 1) {
    parts.push(`## Section ${section}: rendering pipeline notes`)
    parts.push(`The **renderer** walks the tree once per frame and only repaints rows whose content changed since the last frame. This paragraph is long enough to wrap at ordinary widths, with \`inline code\`, *emphasis*, and a [link](https://example.com/${section}) to exercise the inline painter.`)
    parts.push(['- first point about caches and identity', '- second point about `width` ladders', '- third point, with a nested list:', '  - nested one', '  - nested two'].join('\n'))
    parts.push(['```ts', `export function section${section}(input: readonly string[], width: number): string[] {`, '  const rows: string[] = []', '  for (const line of input) {', "    if (line.length === 0) { rows.push(''); continue }", '    for (let at = 0; at < line.length; at += width) rows.push(line.slice(at, at + width))', '  }', "  return rows.map(row => row.padEnd(width, ' '))", '}', '```'].join('\n'))
    if (section % 2 === 0) {
      parts.push(['| workload | validated | compiled | rows |', '| --- | ---: | ---: | ---: |', '| W1 | 2 | 2 | 2 |', '| W2 | 0 | 0 | 1 |', '| W3 | 0 | 0 | 2 |'].join('\n'))
      parts.push(['```python', 'def wrap(lines, width):', '    rows = []', '    for line in lines:', '        if not line:', "            rows.append('')", '            continue', '        rows.extend(line[i:i + width] for i in range(0, len(line), width))', '    return rows', '```'].join('\n'))
    }
  }
  parts.push('BENCH-END-MARKER')
  return parts.join('\n\n')
}
const successText = reply()
const server = await startMockLlmServer({ port: 0, sequence: ['slow_success'], repeatLast: true, successText, chunkSize, chunkDelayMs })

const env = { ...baseEnv, DEEPSEEK_BASE_URL: `${server.baseURL}/v1`, DEEPSEEK_API_KEY: 'bench-key' }
if (args.prof === 'true') {
  const profiles = join(artifacts, 'prof', `${label}-${scenario}`)
  mkdirSync(profiles, { recursive: true })
  env.NODE_OPTIONS = `--cpu-prof --cpu-prof-dir=${profiles}`
  console.error(`==> CPU profile: ${profiles}`)
}
console.error(`==> ${label}: ${scenario} at ${cols}x${rows} (${repo})`)
const term = pty.spawn(dshBin, ['--profile', 'bench'], { name: 'xterm-256color', cols, rows, cwd: work, env })
let out = ''
let bytes = 0
let chunks = 0
let lastData = performance.now()
let firstAt
let exited = null
term.onData((data) => {
  out += data
  bytes += data.length
  chunks += 1
  lastData = performance.now()
  firstAt ??= lastData
})
term.onExit(({ exitCode }) => { exited = exitCode })

const sleep = ms => new Promise(done => setTimeout(done, ms))
const clean = value => value.replace(/\x1b\[[0-9;?:]*[A-Za-z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\r/g, '')

/** utime + stime of the dsh process in milliseconds (10 ms ticks), or null without /proc. */
function cpu() {
  try {
    const stat = readFileSync(`/proc/${term.pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    return (Number(fields[11]) + Number(fields[12])) * 10
  } catch { return null }
}
const hasProc = existsSync('/proc') && readdirSync('/proc').includes(String(term.pid))

async function waitFor(predicate, what, timeout = 60_000) {
  const start = performance.now()
  while (performance.now() - start < timeout) {
    if (predicate()) return performance.now() - start
    await sleep(10)
  }
  throw new Error(`timed out waiting for ${what}\n--- tail ---\n${clean(out.slice(-3000))}`)
}
/** Wait until the terminal has been silent for `quiet` ms; an animating screen runs into the timeout. */
async function settle(quiet = 400, timeout = 20_000) {
  const start = performance.now()
  while (performance.now() - start < timeout && performance.now() - lastData < quiet) await sleep(5)
}

/** Send one key and time the first and the last output bytes that follow it. */
async function key(data, quiet = 25, max = 3000) {
  const start = performance.now()
  const before = bytes
  firstAt = undefined
  term.write(data)
  while (performance.now() - start < max) {
    await sleep(1)
    if (firstAt !== undefined && performance.now() - lastData >= quiet) break
  }
  return { first: firstAt === undefined ? null : firstAt - start, last: firstAt === undefined ? null : lastData - start, bytes: bytes - before }
}
const percentile = (values, p) => values.length === 0 ? null : Number(values.toSorted((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))].toFixed(2))

const phases = []
async function phase(name, body) {
  await settle(150, 3000)
  const cpuBefore = cpu()
  const bytesBefore = bytes
  const chunksBefore = chunks
  const start = performance.now()
  const samples = []
  const extra = await body(samples) ?? {}
  const wall = performance.now() - start
  const cpuMs = cpuBefore === null ? null : cpu() - cpuBefore
  const firsts = samples.map(sample => sample.first).filter(value => value !== null)
  const lasts = samples.map(sample => sample.last).filter(value => value !== null)
  const row = {
    name, wallMs: Math.round(wall), cpuMs, cpuPct: cpuMs === null ? null : Number((cpuMs / wall * 100).toFixed(1)), bytes: bytes - bytesBefore, frames: chunks - chunksBefore,
    ...(samples.length === 0 ? {} : {
      keys: samples.length, silent: samples.length - firsts.length, cpuPerKeyMs: cpuMs === null ? null : Number((cpuMs / samples.length).toFixed(2)),
      bytesPerKey: Math.round(samples.reduce((sum, sample) => sum + sample.bytes, 0) / samples.length),
      keyP50: percentile(firsts, 0.5), keyP95: percentile(firsts, 0.95), paintP50: percentile(lasts, 0.5), paintP95: percentile(lasts, 0.95),
    }),
    ...extra,
  }
  phases.push(row)
  console.error(JSON.stringify(row))
}
const SENTENCE = 'the quick brown fox jumps over the lazy dog and keeps typing until the prompt wraps onto a second row of the editor'
const typeText = async (samples, text, gap = 20) => { for (const char of text) { samples.push(await key(char)); await sleep(gap) } }
const typing = async (name, text = SENTENCE, gap = 20) => { await phase(name, samples => typeText(samples, text, gap)); await key('\x03') }
const presses = (name, count, data, gap = 15, quiet = 25) => phase(name, async (samples) => { for (let n = 0; n < count; n += 1) { samples.push(await key(typeof data === 'function' ? data(n) : data, quiet)); await sleep(gap) } })
const open = command => phase(`open ${command}`, async () => { term.write(`${command}\r`); await sleep(120); await settle(350, 6000) })
const close = async (command) => {
  await phase(`close ${command}`, async (samples) => { samples.push(await key('\x1b')); await sleep(200); samples.push(await key('\x1b')); await sleep(200) })
  await key('\x03')
}
const stream = turn => phase(`stream ${turn}`, async () => {
  const from = out.length
  term.write(`turn ${turn}\r`)
  await waitFor(() => out.indexOf('BENCH-END-MARKER', from) >= 0, `the end of turn ${turn}`, 120_000)
  await settle(700, 20_000)
  return { nominalMs: Math.round(successText.length / chunkSize * chunkDelayMs) }
})

let failure
try {
  const bootStart = performance.now()
  await waitFor(() => clean(out).includes('deepseek'), 'the boot frame', 90_000)
  phases.push({ name: 'boot', wallMs: Math.round(performance.now() - bootStart), cpuMs: cpu(), bytes, frames: chunks })
  console.error(JSON.stringify(phases.at(-1)))
  await sleep(1500)

  await phase('idle', async () => { await sleep(4000) })
  await typing('type')
  if (scenario === 'focus') {
    for (let round = 1; round <= 4; round += 1) await typing(`type round ${round}`, SENTENCE, 8)
    for (const command of ['/settings', '/model', '/theme', '/help']) {
      await open(command)
      await presses(`nav ${command}`, 200, n => n % 20 < 10 ? '\x1b[B' : '\x1b[A', 4, 12)
      await close(command)
    }
  } else {
    for (let turn = 1; turn <= turns; turn += 1) await stream(turn)
    await phase('idle after turns', async () => { await sleep(4000) })
    await typing('type after turns')
    await presses('scroll up', 20, '\x1b[5~')
    await presses('scroll down', 20, '\x1b[6~')
    await phase('slash palette', async (samples) => { await typeText(samples, '/se'); for (let n = 0; n < 12; n += 1) samples.push(await key('\x1b[B')) })
    await key('\x1b')
    await key('\x03')
    for (const [command, downs] of gallery ? [['/settings', 30]] : [['/theme', 12], ['/settings', 30], ['/status', 6], ['/model', 20], ['/help', 20]]) {
      await open(command)
      await presses(`nav ${command}`, downs, '\x1b[B')
      await close(command)
    }
    await phase('resize', async () => {
      for (const [columns, lines] of [[80, 30], [140, 45], [60, 24], [cols, rows]]) { term.resize(columns, lines); await sleep(120); await settle(300, 6000) }
    })
    await typing('type at the end', SENTENCE.slice(0, 60))
  }
} catch (error) {
  failure = String(error?.stack ?? error)
  console.error(failure)
}

term.write('\x03')
await sleep(200)
term.write('\x03')
for (let n = 0; n < 100 && exited === null; n += 1) await sleep(100)
if (exited === null) term.kill()
await server.close?.()

const find = name => phases.find(row => row.name === name)
const streams = phases.filter(row => row.name.startsWith('stream '))
const average = values => values.length === 0 || values.includes(null) ? null : Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
/** The figures a reader compares between two builds. */
const summary = {
  idleCpuPct: find('idle')?.cpuPct ?? null,
  idleFrames: find('idle')?.frames ?? null,
  keyP50Ms: find('type')?.keyP50 ?? null,
  keyP95Ms: find('type')?.keyP95 ?? null,
  typeCpuPerKeyMs: (scenario === 'focus' ? average(phases.filter(row => row.name.startsWith('type round')).slice(1).map(row => row.cpuPerKeyMs === null ? null : row.cpuPerKeyMs * 100)) : null) ?? (find('type')?.cpuPerKeyMs == null ? null : find('type').cpuPerKeyMs * 100),
  streamCpuMs: average(streams.map(row => row.cpuMs)),
  nav: Object.fromEntries(phases.filter(row => row.name.startsWith('nav ')).map(row => [row.name.slice(4), { cpuPerKeyMs: row.cpuPerKeyMs, keyP50Ms: row.keyP50 }])),
}
if (summary.typeCpuPerKeyMs !== null) summary.typeCpuPerKeyMs = Number((summary.typeCpuPerKeyMs / 100).toFixed(2))

mkdirSync(artifacts, { recursive: true })
const file = join(artifacts, `${label}-${scenario}.json`)
writeFileSync(file, `${JSON.stringify({ label, scenario, repo, cols, rows, cpu: hasProc, failure, exited, summary, phases }, null, 2)}\n`)

const cell = value => value === null || value === undefined ? 'n/a' : String(value)
console.log(`\n${label} · ${scenario} · ${cols}x${rows}`)
console.log(`  idle            ${cell(summary.idleCpuPct)}% CPU, ${cell(summary.idleFrames)} frames in 4 s`)
console.log(`  typing          key p50 ${cell(summary.keyP50Ms)} ms, p95 ${cell(summary.keyP95Ms)} ms, ${cell(summary.typeCpuPerKeyMs)} ms CPU per key`)
if (streams.length > 0) console.log(`  streaming       ${cell(summary.streamCpuMs)} ms CPU per turn (${cell(streams[0].nominalMs)} ms of stream)`)
for (const [name, row] of Object.entries(summary.nav)) console.log(`  ${name.padEnd(15)} key p50 ${cell(row.keyP50Ms)} ms, ${cell(row.cpuPerKeyMs)} ms CPU per key`)
console.log(`  ${file}`)
if (failure !== undefined || exited !== 0) {
  console.error(`FAIL: ${failure === undefined ? `dsh exited with ${String(exited)}` : 'the scripted session did not finish'}`)
  process.exit(1)
}
process.exit(0)
