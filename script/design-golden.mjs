/**
 * @module script/design-golden
 *
 * Captures the prototype's scenes as golden frames, the oracle every UI slice is compared with. Each walk of
 * `design-golden-walks.mjs` replays its keys against `docs/design/prototypes/ui-preview.mjs` under the clock of
 * `design-golden-clock.mjs`, and the frame after every step is written to
 * `packages/mayfly/tests/design/golden/<nn>-<scene>/<walk>.txt` (visible text) and `.ansi` (raw).
 *
 * `node script/design-golden.mjs` writes the goldens, `--check` fails when the prototype's output differs from
 * them, and `--scene <n>` limits either to one scene.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { walks } from './design-golden-walks.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const GOLDEN_DIR = path.join(ROOT, 'packages/mayfly/tests/design/golden')
const PREVIEW = path.join(ROOT, 'docs/design/prototypes/ui-preview.mjs')
const CLOCK = path.join(ROOT, 'script/design-golden-clock.mjs')
const SGR = /\x1b\[[0-9;]*m/g

/** The text of a row with its colors and weights removed. */
export const stripSgr = text => text.replace(SGR, '')

/** The label a step carries in a golden file: `start`, a clock step, or the key as JSON. */
export const stepLabel = (step, index) => (typeof step === 'number' ? `+${step}ms` : index === 0 && step === '\0' ? 'start' : JSON.stringify(step))

/**
 * Cuts the prototype's non-TTY output into one body per step. The preload ends each step with `\x1e<index>\n`; a
 * paint is `\x1b[<n>A` (after the first), `\x1b[2K` before every row, and `\n\x1b[J` at the end, and its rows are
 * the nav line, a blank, the scene, a blank, the footer. Returns the scene rows (colors kept), or null when the step
 * painted nothing.
 */
export function parseFrames(output, count) {
  const chunks = output.split(/\x1e\d+\n/)
  if (chunks.length < count + 1) throw new Error(`expected ${count} steps in the output, found ${chunks.length - 1}`)
  return chunks.slice(0, count).map(chunk => {
    const paints = chunk.split('\x1b[J').filter(part => part.replace(/\x1b\[\?25l/g, '') !== '')
    const paint = paints.at(-1)
    if (paint === undefined) return null
    const rows = paint.replace(/\x1b\[\?25l/g, '').replace(/^\x1b\[\d+A/, '').split('\n').map(row => row.replace(/^\x1b\[2K/, ''))
    return rows.slice(2, rows.length - 3)
  })
}

/** Replays one walk and returns `{ txt, ansi }`, the file contents. */
export function captureWalk(walk) {
  const result = spawnSync(process.execPath, ['--import', CLOCK, PREVIEW, String(walk.scene)], {
    cwd: ROOT,
    env: { ...process.env, GOLDEN_SCRIPT: JSON.stringify(walk.steps) },
    input: '',
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  if (result.status !== 0) throw new Error(`scene ${walk.scene} ${walk.name} exited ${result.status}: ${result.stderr}`)
  const frames = parseFrames(result.stdout, walk.steps.length)
  const render = lines => walk.steps.map((step, index) => {
    const rows = frames[index]
    return `--- after ${stepLabel(step, index)} ---\n${rows === null ? '(no frame)' : lines(rows).join('\n')}\n`
  }).join('')
  return { txt: render(rows => rows.map(stripSgr)), ansi: render(rows => rows) }
}

/** The files a run produces, keyed by path relative to the golden directory. */
export function captureAll(scene) {
  const files = new Map()
  for (const walk of walks()) {
    if (scene !== undefined && walk.scene !== scene) continue
    const { txt, ansi } = captureWalk(walk)
    files.set(`${walk.dir}/${walk.name}.txt`, txt)
    files.set(`${walk.dir}/${walk.name}.ansi`, ansi)
  }
  return files
}

/** Compares captured files with the committed goldens; returns the paths that differ, are missing, or are stale. */
export function diffGoldens(files, scene, dir = GOLDEN_DIR) {
  const problems = []
  for (const [name, content] of files) {
    const file = path.join(dir, name)
    if (!fs.existsSync(file)) problems.push(`missing ${name}`)
    else if (fs.readFileSync(file, 'utf8') !== content) problems.push(`changed ${name}`)
  }
  if (fs.existsSync(dir)) {
    for (const sceneDir of fs.readdirSync(dir)) {
      if (scene !== undefined && Number(sceneDir.slice(0, 2)) !== scene) continue
      for (const file of fs.readdirSync(path.join(dir, sceneDir))) if (!files.has(`${sceneDir}/${file}`)) problems.push(`stale ${sceneDir}/${file}`)
    }
  }
  return problems
}

function writeGoldens(files, scene, dir = GOLDEN_DIR) {
  for (const stale of diffGoldens(files, scene, dir).filter(problem => problem.startsWith('stale '))) fs.rmSync(path.join(dir, stale.slice(6)))
  for (const [name, content] of files) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
}

function main(argv) {
  const sceneIndex = argv.indexOf('--scene')
  const scene = sceneIndex === -1 ? undefined : Number(argv[sceneIndex + 1])
  const files = captureAll(scene)
  if (argv.includes('--check')) {
    const problems = diffGoldens(files, scene)
    if (problems.length > 0) {
      console.error(`design goldens differ from the prototype (${problems.length}); run \`pnpm run design:golden\` after reviewing the change:\n${problems.slice(0, 20).join('\n')}`)
      process.exit(1)
    }
    console.log(`design goldens: ${files.size / 2} walks match the prototype`)
    return
  }
  writeGoldens(files, scene)
  console.log(`design goldens: wrote ${files.size / 2} walks`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
