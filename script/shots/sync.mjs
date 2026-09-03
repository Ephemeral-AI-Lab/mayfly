#!/usr/bin/env node
/**
 * Sync the component-shot SVG gallery into website/public/shots/.
 *
 * manifest.mjs 的组件场景（每个 ui-reference.md 小节一或多张状态图）是唯一
 * 数据源（单一来源）；生成的 SVG 一律由本脚本写入，勿手改。改动场景或渲染器后
 * 运行 `pnpm shots:sync` 重新生成。
 *
 * After the component loop, the app-level scenarios of app-manifest.mjs are
 * rendered by `packages/mayfly/tests/app-shots.spec.ts` (real-service boots,
 * viewport-only painting); this script forwards MAYFLY_SHOTS=sync|check to a
 * vitest child process and propagates its failure. Locale and timezone are
 * pinned on both processes so bytes never drift with the host environment.
 *
 * Usage:
 *   node script/shots/sync.mjs          # regenerate every shot
 *   node script/shots/sync.mjs --check  # exit 1 when any shot is stale (CI gate)
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

process.env.LANG = 'C'
process.env.LC_ALL = 'C'
process.env.TZ = 'UTC'

const [{ SCENARIOS }, { renderScenario }, { paintTerminalSvg }] = await Promise.all([
  import('./manifest.mjs'),
  import('./render.mjs'),
  import('./svg.mjs'),
])

const uiLibUrl = new URL('../../packages/ui/lib/index.js', import.meta.url)
if (!existsSync(fileURLToPath(uiLibUrl))) {
  throw new Error('packages/ui/lib is missing — run `pnpm build` before the shots pipeline')
}
const { ui, defineMayflyComponent } = await import(uiLibUrl.href)

const check = process.argv.includes('--check')
const outDir = new URL('../../website/public/shots/', import.meta.url)
mkdirSync(outDir, { recursive: true })

let failures = 0
for (const scenario of SCENARIOS) {
  const { term, cols, rows } = await renderScenario(scenario, ui, defineMayflyComponent)
  const svg = await paintTerminalSvg(term, { cols, rows })
  const file = new URL(`${scenario.id}.svg`, outDir)
  const label = `website/public/shots/${scenario.id}.svg`

  let current = null
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    // 尚未生成：sync 写入，check 直接判 stale。
  }
  if (current === svg) continue
  if (check) {
    console.error(`✗ ${scenario.id}: stale — run \`pnpm shots:sync\``)
    failures++
  } else {
    writeFileSync(file, svg)
    console.log(`→ ${label} (${cols}×${rows}, ${svg.length} bytes)`)
  }
}

if (failures > 0) {
  process.exitCode = 1
} else if (check) {
  console.log(`✓ all ${SCENARIOS.length} component shots are current`)
}

// App-level shots: the spec paints through the real plugin tree and writes
// or byte-compares website/public/shots/app-*.svg itself.
const vitestEntry = new URL('../../node_modules/vitest/vitest.mjs', import.meta.url)
const appSpec = fileURLToPath(new URL('../../packages/mayfly/tests/app-shots.spec.ts', import.meta.url))
const appResult = spawnSync(process.execPath, [fileURLToPath(vitestEntry), 'run', appSpec], {
  cwd: fileURLToPath(new URL('../..', import.meta.url)),
  env: {
    ...process.env,
    MAYFLY_SHOTS: check ? 'check' : 'sync',
    LANG: 'C',
    LC_ALL: 'C',
    TZ: 'UTC',
  },
  stdio: 'inherit',
})
if (appResult.status !== 0) process.exitCode = 1
