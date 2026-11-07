/** Link real split captures to exact built JavaScript and persisted native evidence. @module script/scenarios/split-evidence */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

const digest = bytes => createHash('sha256').update(bytes).digest('hex')

function filesUnder(dir, accept, result = []) {
  if (!existsSync(dir)) return result
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) filesUnder(path, accept, result)
    else if (entry.isFile() && accept(path)) result.push(path)
  }
  return result
}

/** A checkout revision is observational only; hash emitted runtime bytes before and after a real capture. */
export function builtSplitRuntime(root) {
  const files = Object.fromEntries(['ui', 'mayfly', 'host'].flatMap(name => filesUnder(join(root, 'packages', name, 'lib'), path => path.endsWith('.js'))).map(path => [relative(root, path), digest(readFileSync(path))]))
  return { sha256: digest(JSON.stringify(files)), files }
}

/** Read after Host exit so late projection persistence and all journal frames have settled. */
export function persistedSplitEvidence(runDir) {
  if (runDir === undefined) return undefined
  const files = filesUnder(join(runDir, 'sessions'), path => path.endsWith('.jsonl.zstd'))
  filesUnder(join(runDir, 'storages', 'session_projcache'), path => path.endsWith('.json'), files)
  return { runDirectory: runDir, files: Object.fromEntries(files.map(path => [relative(runDir, path), digest(readFileSync(path))])) }
}
