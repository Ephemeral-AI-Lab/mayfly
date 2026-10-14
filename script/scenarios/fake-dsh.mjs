/**
 * A stand-in for `dsh plugin --profile <name> add|remove <specs...>` in a market scenario: it waits a moment (so the
 * panel's progress shows), then edits the profile's `package.json` and `node_modules` the way the package manager
 * would, from the fixture index (which package a spec installs, at which version). A package named in
 * `FAKE_DSH_BROKEN` installs with an entry point that throws, so the compatibility check fails and the installer rolls
 * back. @module script/scenarios/fake-dsh
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const [, , verb, , , action, ...specs] = process.argv
if (verb !== 'plugin' || (action !== 'add' && action !== 'remove')) { console.error(`fake dsh: unsupported ${process.argv.slice(2).join(' ')}`); process.exit(2) }

const root = process.cwd()
const manifestPath = join(root, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const broken = (process.env.FAKE_DSH_BROKEN ?? '').split(',').filter(Boolean)
const rows = JSON.parse(readFileSync(process.env.FAKE_DSH_FIXTURE, 'utf8')).entries.flatMap(entry => entry.install.rows.map(row => ({ row, entry })))
const specOf = (row, source) => source === 'npm' ? row.npm?.spec : row.github === undefined ? undefined : `github:${row.github.repo}#${row.github.ref}${row.github.subdir === undefined ? '' : `&path:${row.github.subdir}`}`

await new Promise(resolve => setTimeout(resolve, Number(process.env.FAKE_DSH_DELAY_MS ?? 1500)))

manifest.dependencies ??= {}
for (const spec of specs) {
  if (action === 'remove') {
    delete manifest.dependencies[spec]
    rmSync(join(root, 'node_modules', spec), { recursive: true, force: true })
    continue
  }
  const found = rows.find(({ row }) => specOf(row, 'npm') === spec || specOf(row, 'github') === spec)
  if (found === undefined) { console.error(`fake dsh: no fixture row for ${spec}`); process.exit(1) }
  const { row, entry } = found
  const version = entry.npm?.[row.name]?.latestVersion ?? '1.0.0'
  manifest.dependencies[row.name] = spec
  const dir = join(root, 'node_modules', row.name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: row.name, version, main: 'index.js' })}\n`)
  writeFileSync(join(dir, 'index.js'), broken.includes(row.name) ? "throw new Error('incompatible with this Mayfly')\n" : 'module.exports = {}\n')
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
