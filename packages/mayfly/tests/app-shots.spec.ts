/**
 * App-level SVG shots: real-service boot (`tests/app-shots/boot.ts`) +
 * scripted session events (`tests/app-shots/scenes.ts`), painted to SVG by
 * the same `paintTerminalSvg` the component shots use. This spec is inert
 * under plain `pnpm test` — it runs only when the shots pipeline sets
 * `MAYFLY_SHOTS=sync` (write the SVGs) or `MAYFLY_SHOTS=check` (byte-compare
 * them as the staleness gate), driven from `script/shots/sync.mjs`.
 *
 * @module @ephemeral-ai/mayfly/tests/app-shots
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForRender } from './core/fake-terminal.ts'
import { VtTerminal } from './vt-terminal.ts'
import { setExitEpitaphWriter } from '../src/app/exit-epitaph.ts'
import { bootAppShot, SHOT_CWD, type AppShotTree } from './app-shots/boot.ts'
import { APP_SCENE_RUNNERS, resetSceneSeq, sceneAgentsAdvanceClock } from './app-shots/scenes.ts'

// The pipeline entry (`script/shots/sync.mjs`) selects the mode; any other
// invocation — including plain `pnpm test` — skips the suite.
const MODE = process.env.MAYFLY_SHOTS
const runSuite = MODE === 'sync' || MODE === 'check'
if (runSuite) {
  // The app arms its farewell on tree dispose; keep pipeline output clean.
  setExitEpitaphWriter(() => {})
}

const outDir = fileURLToPath(new URL('../../../website/public/shots/', import.meta.url))
const { APP_SCENARIOS } = await import('../../../script/shots/app-manifest.mjs') as {
  APP_SCENARIOS: readonly { id: string, cols: 80, rows: 24 }[]
}
const { paintTerminalSvg } = await import('../../../script/shots/svg.mjs') as {
  paintTerminalSvg(term: unknown, geometry: { cols: number, rows: number }): Promise<string>
}

const trees: AppShotTree[] = []
let cwdSpy: { mockRestore(): void } | undefined

afterEach(async () => {
  for (const tree of trees.splice(0).reverse()) await tree.dispose()
  cwdSpy?.mockRestore()
  cwdSpy = undefined
})

describe('app-level SVG shots', () => {
  it.skipIf(!runSuite)('scene ids match the runners', () => {
    for (const scenario of APP_SCENARIOS) {
      expect(APP_SCENE_RUNNERS[scenario.id], `missing scene runner for ${scenario.id}`).toBeDefined()
    }
  })

  for (const scenario of APP_SCENARIOS) {
    it.skipIf(!runSuite)(scenario.id, async () => {
      cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(SHOT_CWD)
      resetSceneSeq()
      const terminal = new VtTerminal(scenario.cols, scenario.rows)
      const tree = await bootAppShot({ terminal })
      trees.push(tree)

      await APP_SCENE_RUNNERS[scenario.id]!(tree)
      tree.ctx.mayflyScreen.requestRender(true)
      await waitForRender()
      if (scenario.id === 'app-agents') {
        // The first render armed the waiting-hold window. Step the pinned
        // pane clock past it, then let the pane's own 1s refresh timer
        // repaint: every elapsed label and the `waiting` phase land on their
        // scripted values.
        sceneAgentsAdvanceClock()
        await vi.waitFor(async () => {
          expect(await terminal.frame()).toContain('waiting')
        }, { timeout: 5_000, interval: 50 })
        tree.ctx.mayflyScreen.requestRender(true)
        await waitForRender()
      }
      await terminal.flush()
      const svg = await paintTerminalSvg(terminal.painterTerminal, { cols: scenario.cols, rows: scenario.rows })

      const file = `${outDir}${scenario.id}.svg`
      if (MODE === 'sync') {
        mkdirSync(outDir, { recursive: true })
        if (!existsSync(file) || readFileSync(file, 'utf8') !== svg) {
          writeFileSync(file, svg)
          console.log(`→ website/public/shots/${scenario.id}.svg (${String(scenario.cols)}×${String(scenario.rows)}, ${String(svg.length)} bytes)`)
        }
        return
      }
      expect(existsSync(file), `${scenario.id}: shot missing — run \`pnpm shots:sync\``).toBe(true)
      expect(readFileSync(file, 'utf8'), `${scenario.id}: stale — run \`pnpm shots:sync\``).toBe(svg)
    }, 60_000)
  }
})
