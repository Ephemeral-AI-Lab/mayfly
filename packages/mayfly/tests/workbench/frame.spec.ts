/**
 * Paint one workbench scenario through the real renderer and write its frame (text, ANSI, SVG) to
 * `.artifacts/frames/`. Inert under plain `pnpm test`; `script/frame.mjs` sets `MAYFLY_FRAME` to the run's JSON
 * (`{ scenario, cols?, rows?, keys? }`, keys already decoded to byte strings).
 *
 * @module @ephemeral-ai/mayfly/tests/workbench/frame
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForRender } from '../core/fake-terminal.ts'
import { VtTerminal, cwdNormalizer } from '../vt-terminal.ts'
import { setExitEpitaphWriter } from '../../src/app/exit-epitaph.ts'
import { bootAppShot, SHOT_CWD, type AppShotTree } from '../app-shots/boot.ts'
import { resetSceneSeq } from '../app-shots/scenes.ts'
import { WORKBENCH_SCENARIOS } from './scenarios.ts'

interface FrameRun {
  readonly scenario: string
  readonly cols?: number
  readonly rows?: number
  readonly keys?: readonly string[]
}

const raw = process.env.MAYFLY_FRAME
const run: FrameRun | undefined = raw === undefined || raw === '' ? undefined : JSON.parse(raw) as FrameRun
if (run !== undefined) setExitEpitaphWriter(() => {})

const outRoot = fileURLToPath(new URL('../../../../.artifacts/frames/', import.meta.url))
const { paintTerminalSvg } = await import('../../../../script/shots/svg.mjs') as {
  paintTerminalSvg(term: unknown, geometry: { cols: number, rows: number }): Promise<string>
}

const trees: AppShotTree[] = []
let cwdSpy: { mockRestore(): void } | undefined

afterEach(async () => {
  for (const tree of trees.splice(0).reverse()) await tree.dispose()
  cwdSpy?.mockRestore()
  cwdSpy = undefined
})

describe('workbench frame', () => {
  it('names a known scenario', () => {
    if (run === undefined) return
    expect(Object.keys(WORKBENCH_SCENARIOS), `unknown scenario "${run.scenario}"`).toContain(run.scenario)
  })

  it.skipIf(run === undefined || !(run.scenario in WORKBENCH_SCENARIOS))('paints the scenario', async () => {
    const { scenario: name, keys = [] } = run!
    const scenario = WORKBENCH_SCENARIOS[name]!
    const cols = run!.cols ?? scenario.cols
    const rows = run!.rows ?? scenario.rows
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(SHOT_CWD)
    resetSceneSeq()
    const terminal = new VtTerminal(cols, rows)
    const tree = await bootAppShot({ terminal })
    trees.push(tree)

    await scenario.run(tree)
    tree.ctx.mayflyScreen.requestRender(true)
    await waitForRender()
    await scenario.settle?.(tree, terminal)
    for (const key of keys) {
      terminal.sendInput(key)
      await waitForRender()
    }
    tree.ctx.mayflyScreen.requestRender(true)
    await waitForRender()
    await terminal.flush()

    const dir = `${outRoot}${name}-${String(cols)}x${String(rows)}/`
    mkdirSync(dir, { recursive: true })
    writeFileSync(`${dir}frame.txt`, `${await terminal.frame(cwdNormalizer())}\n`)
    writeFileSync(`${dir}frame.ansi`, terminal.written.join(''))
    writeFileSync(`${dir}frame.svg`, await paintTerminalSvg(terminal.painterTerminal, { cols, rows }))
    console.log(`→ .artifacts/frames/${name}-${String(cols)}x${String(rows)}/ (frame.txt, frame.ansi, frame.svg)`)
  }, 60_000)
})
