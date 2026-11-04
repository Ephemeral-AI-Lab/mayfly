/** Refuse publication when the pinned official Harness runtime is no longer current. @module script/check-harness-latest */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ROOT } from './package-contract.mjs'

/** Publication time decides the current line; npm's latest tag may point to an older RC. */
export function newestHarness(metadata) {
  const published = Object.keys(metadata.versions ?? {}).filter(version => Number.isFinite(Date.parse(metadata.time?.[version])))
  if (!published.length) throw new Error('Official Harness metadata has no published versions')
  return published.sort((left, right) => Date.parse(metadata.time[right]) - Date.parse(metadata.time[left]))[0]
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const response = await fetch('https://registry.npmjs.org/@deepseek-ai%2fdsh', { signal: AbortSignal.timeout(30_000) })
  if (!response.ok) throw new Error(`Official Harness version lookup failed (${response.status})`)
  const current = newestHarness(await response.json())
  const cli = JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8'))
  const pinned = cli.dependencies['@deepseek-ai/dsh']
  if (current !== pinned) throw new Error(`Harness ${current} is newer than the pinned ${pinned}; align and revalidate before publication`)
  console.log(`official Harness: ${pinned} is the newest published version`)
}
