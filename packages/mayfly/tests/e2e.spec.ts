/** Whole-tree direct Cordis composition tests.
 * @module @ephemeral-ai/mayfly/tests/e2e
 */

import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { waitForRender } from './core/fake-terminal.ts'
import {
  bootDirectMayfly,
  currentAgent,
  executeDirectOverlay,
  resetDirectMayfly,
} from './e2e-boot.ts'

afterEach(async () => { await resetDirectMayfly() })

async function waitForSelections(count: number, tree: Awaited<ReturnType<typeof bootDirectMayfly>>): Promise<void> {
  for (let turn = 0; turn < 100; turn += 1) {
    if (tree.observations.selectedAgents.length >= count) return
    await Promise.resolve()
  }
  throw new Error(`expected ${String(count)} Agent selections`)
}

describe('Mayfly direct-service whole tree', () => {
  it('boots actual API, app, theme, and core rows through the real Loader', async () => {
    const tree = await bootDirectMayfly()
    const agent = await currentAgent(tree)
    expect(tree.exits).toEqual([])
    expect(tree.ctx.get('mayflyPanes')).toBeDefined()
    expect(tree.ctx.get('mayflyStatus')).toBeDefined()
    expect(tree.ctx.get('mayflyOverlays')).toBeDefined()
    expect(tree.ctx.get('mayflyEditorExtensions')).toBeDefined()
    expect(tree.ctx.get('mayflyCurrentAgent')).toBeDefined()
    expect(tree.observations.selectedAgents).toEqual([agent])
  })

  it('gives an ordinary sibling native dsh services and Mayfly UI seams directly', async () => {
    const tree = await bootDirectMayfly()
    const agent = await currentAgent(tree)
    expect(tree.observations.serviceVisibility).toMatchObject({
      commands: true,
      sessionProjections: true,
      tools: true,
      jobs: true,
      subagents: true,
      sessions: true,
      mayflyCurrentAgent: true,
      mayflyPanes: true,
      mayflyStatus: true,
      mayflyOverlays: true,
      mayflyEditorExtensions: true,
    })
    expect(tree.projections.calls.at(-1)).toEqual({ session: agent.session, keys: ['mayflyConversation'] })
    expect(tree.tools.scopes.at(-1)).toBe(agent)
  })

  it('renders a direct canonical pane and exposes direct status/editor state', async () => {
    const tree = await bootDirectMayfly()
    await currentAgent(tree)
    expect(tree.ctx.mayflyPanes.list().map(entry => entry.id)).toEqual(['e2e.direct-pane'])
    expect(tree.ctx.mayflyStatus.list().map(entry => entry.id)).toEqual(['e2e.direct-status'])
    expect(tree.ctx.mayflyEditorExtensions.list().map(entry => entry.id)).toEqual(['e2e.direct-editor'])
    tree.ctx.mayflyScreen.requestRender(true)
    await waitForRender()
    expect(tree.terminal.output).toContain('native dsh + Mayfly seam')
  })

  it('opens a capturing overlay from a native command without a gesture token', async () => {
    const tree = await bootDirectMayfly()
    await currentAgent(tree)
    await expect(executeDirectOverlay(tree)).resolves.toEqual({ kind: 'success' })
    expect(tree.ctx.mayflyOverlays.list().map(entry => entry.id)).toEqual(['e2e.direct-overlay'])
    tree.ctx.mayflyScreen.requestRender(true)
    await waitForRender()
    expect(tree.terminal.output).toContain('Direct overlay')
    expect(tree.terminal.output).toContain('opened through the direct Mayfly service')
  })

  it('removes every direct contribution when the sibling Fiber unloads', async () => {
    const tree = await bootDirectMayfly()
    await currentAgent(tree)
    await executeDirectOverlay(tree)
    const entry = [...tree.ctx.loader.entries()].find(candidate => candidate.options.id === 'direct-sibling')
    expect(entry).toBeDefined()
    await tree.ctx.loader.update(entry!.id, { disabled: true })
    await tree.ctx.loader.await()
    expect(tree.ctx.mayflyPanes.list()).toEqual([])
    expect(tree.ctx.mayflyStatus.list()).toEqual([])
    expect(tree.ctx.mayflyOverlays.list()).toEqual([])
    expect(tree.ctx.mayflyEditorExtensions.list()).toEqual([])
    expect(tree.commands.find('direct-overlay')).toBeUndefined()
  })

  it('replays registry state after a core renderer gap without a host buffer', async () => {
    const tree = await bootDirectMayfly()
    await currentAgent(tree)
    tree.ctx.mayflyPanes.register({
      id: 'e2e.renderer-independent',
      placement: 'bottom',
    }, { kind: 'text', content: 'registry survives renderer gaps' })
    const entry = [...tree.ctx.loader.entries()].find(candidate => candidate.options.id === 'mayfly-core')
    expect(entry).toBeDefined()
    await tree.ctx.loader.update(entry!.id, { disabled: true })
    await tree.ctx.loader.await()
    expect(tree.ctx.get('mayflyScreen')).toBeUndefined()
    expect(tree.ctx.mayflyPanes.list().map(pane => pane.id)).toEqual(['e2e.renderer-independent'])
    await tree.ctx.loader.update(entry!.id, { disabled: false })
    await tree.ctx.loader.await()
    tree.ctx.mayflyScreen.requestRender(true)
    await waitForRender()
    expect(tree.ctx.mayflyPanes.list().map(pane => pane.id)).toContain('e2e.renderer-independent')
    expect(tree.terminal.output).toContain('registry survives renderer gaps')
  })

  it('passes every newly selected exact Agent to native scoped services', async () => {
    const tree = await bootDirectMayfly()
    const initial = await currentAgent(tree)
    tree.ctx.emit('mayfly/request-new')
    await waitForSelections(2, tree)
    const fresh = tree.observations.selectedAgents.at(-1)!
    expect(fresh).not.toBe(initial)
    expect(tree.tools.scopes.at(-1)).toBe(fresh)
    expect(tree.projections.calls.at(-1)?.session).toBe(fresh.session)

    tree.ctx.emit('mayfly/request-fork')
    await waitForSelections(3, tree)
    const forked = tree.observations.selectedAgents.at(-1)!
    expect(tree.controller.forks.at(-1)).toEqual({ sessionId: fresh.id })
    expect(tree.tools.scopes.at(-1)).toBe(forked)

    tree.ctx.emit('mayfly/request-rewind', String(forked.id), 7)
    await waitForSelections(4, tree)
    expect(tree.controller.forks.at(-1)).toEqual({ sessionId: forked.id, atSeq: 7 })
    expect(tree.projections.calls.at(-1)?.session).toBe(tree.observations.selectedAgents.at(-1)!.session)
  })

  it('keeps the shipped bundle flat with direct service owners', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    expect(patch).not.toMatch(/group:\s*true|isolate:/u)
    expect(patch).toContain('- id: mayfly-ui-provider')
    expect(patch).toContain('- id: mayfly-core')
    expect(patch).toContain('- id: mayfly-app')
    expect(patch).toContain('- id: mayfly-interaction')
  })
})
