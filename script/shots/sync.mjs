#!/usr/bin/env node
/**
 * Sync the component-shot SVG gallery into website/public/shots/.
 *
 * manifest.mjs 的组件场景（每个 ui-reference.md 小节一或多张状态图）是唯一
 * 数据源（单一来源）；生成的 SVG 一律由本脚本写入，勿手改。改动场景或渲染器后
 * 运行 `pnpm shots:sync` 重新生成。
 *
 * After the component loop, the app shots are painted from the accepted goldens
 * of their catalog scenarios (`app.mjs`): the real product, captured by the
 * scenario runner. Changing one means accepting a new golden first
 * (`pnpm run scenarios -- --update <scenario>`). Locale and timezone are pinned
 * so bytes never drift with the host environment.
 *
 * Usage:
 *   node script/shots/sync.mjs          # regenerate every shot
 *   node script/shots/sync.mjs --check  # exit 1 when any shot is stale (CI gate)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// The C locale keeps formatting deterministic; its UTF-8 charset keeps the
// design's glyphs (an ASCII charset selects the one-cell fallback glyphs).
process.env.LANG = 'C'
process.env.LC_ALL = 'C.UTF-8'
process.env.TZ = 'UTC'

const [{ SCENARIOS }, { renderScenario }, { paintTerminalSvg }, { APP_SHOTS, paintAppShot }] = await Promise.all([
  import('./manifest.mjs'),
  import('./render.mjs'),
  import('./svg.mjs'),
  import('./app.mjs'),
])

const uiLibUrl = new URL('../../packages/ui/lib/index.js', import.meta.url)
if (!existsSync(fileURLToPath(uiLibUrl))) {
  throw new Error('packages/ui/lib is missing — run `pnpm build` before the shots pipeline')
}
const { ui, defineMayflyComponent, patterns } = await import(uiLibUrl.href)

const check = process.argv.includes('--check')
const outDir = new URL('../../website/public/shots/', import.meta.url)
mkdirSync(outDir, { recursive: true })

let failures = 0
/** Write a shot, or count it stale. */
function settle(id, svg, size) {
  const file = new URL(`${id}.svg`, outDir)
  let current = null
  try {
    current = readFileSync(file, 'utf8')
  } catch {
    // 尚未生成：sync 写入，check 直接判 stale。
  }
  if (current === svg) return
  if (check) {
    console.error(`✗ ${id}: stale — run \`pnpm shots:sync\``)
    failures++
  } else {
    writeFileSync(file, svg)
    console.log(`→ website/public/shots/${id}.svg (${size}, ${svg.length} bytes)`)
  }
}

for (const scenario of SCENARIOS) {
  const { term, cols, rows } = await renderScenario(scenario, ui, defineMayflyComponent, patterns)
  settle(scenario.id, await paintTerminalSvg(term, { cols, rows }), `${cols}×${rows}`)
}
// App shots: the real product at its scenario checkpoints, painted from their goldens.
for (const shot of APP_SHOTS) settle(shot.id, await paintAppShot(shot), `${shot.cols}×${shot.rows} from ${shot.scenario}/${shot.checkpoint}`)

if (failures > 0) {
  process.exitCode = 1
} else if (check) {
  console.log(`✓ all ${SCENARIOS.length} component shots and ${APP_SHOTS.length} app shots are current`)
}
