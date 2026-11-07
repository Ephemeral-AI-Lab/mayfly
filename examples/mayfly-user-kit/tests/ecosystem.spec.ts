/** Direct Cordis composition and Fiber lifecycle tests for ecosystem examples.
 * @module @mayfly-example/user-kit/tests/ecosystem
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { MayflyListNode, MayflyStackNode, MayflySurfaceNode } from '@ephemeral-ai/mayfly-ui'
import { describe, expect, it, vi } from 'vitest'
import { apply as applyApi } from '../../../packages/ui/src/provider.ts'
import { plugins as composed, start } from '../../mayfly-ecosystem/src/index.ts'
import * as bottomLog from '../../bottom-log/src/index.ts'
import * as header from '../../header/src/index.ts'
import * as overlay from '../../overlay/src/index.ts'
import * as inspector from '../../right-inspector/src/index.ts'
import * as uiGallery from '../../ui-gallery/src/index.ts'
import { APPROVAL_ARM_MS, approvalCard, summaryMetric } from '../src/index.ts'

const bin = vi.hoisted(() => ({ run: vi.fn(async () => {}) }))
vi.mock('@ephemeral-ai/mayfly/bin', () => bin)

async function directContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin({ name: 'example-test-api', apply: applyApi })
  return ctx
}

describe('shared user kit', () => {
  it('keeps the node of an unchanged metric and renders a changed one anew', () => {
    const props = { label: 'Context', value: '42%', detail: '12k / 28k' }
    const node = summaryMetric.render(props)
    expect(summaryMetric.render({ ...props })).toBe(node)
    expect(summaryMetric.render({ ...props, value: '43%' })).not.toBe(node)
  })

  it('builds deeply frozen standard nodes without plugin metadata', () => {
    const node = summaryMetric.render({ label: 'Context', value: '42%', detail: '12k / 28k' })
    expect(node).toMatchObject({ kind: 'surface', child: { kind: 'stack', direction: 'row' } })
    expect(Object.isFrozen(node)).toBe(true)
    expect(Object.isFrozen((node as { readonly child: unknown }).child)).toBe(true)
    const packageRoot = join(import.meta.dirname, '..')
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.mayfly).toBeUndefined()
    expect(manifest.dsh).toBeUndefined()
  })
})

describe('shared user kit approval card', () => {
  it('is the decision lane with the kit\'s options, a frozen standard tree, and the shared arm delay', () => {
    const node = approvalCard.render({ title: 'Run command?', command: 'pnpm build', detail: 'in ~/work/mayfly' })
    expect(node).toMatchObject({ kind: 'surface', chrome: 'lane', escapeLabel: 'cancel', title: 'Run command?' })
    const body = ((node as MayflySurfaceNode).child as MayflyStackNode).children[0]!.node as MayflyStackNode
    const list = body.children.map(child => child.node).find((child): child is MayflyListNode => child.kind === 'list')!
    expect(list).toMatchObject({ id: 'approval-options', items: [{ id: 'once' }, { id: 'session' }, { id: 'reject' }] })
    expect(Object.isFrozen(node)).toBe(true)
    expect(APPROVAL_ARM_MS).toBe(300)
  })
})

describe('direct plugin services and lifecycle', () => {
  it('registers four pane plugins (six panes) as ordinary Cordis siblings and unloads each Fiber', async () => {
    const ctx = await directContext()
    try {
      const plugins = [header, inspector, bottomLog, uiGallery]
      const fibers = []
      for (const plugin of plugins) fibers.push(await ctx.plugin(plugin))
      expect(ctx.mayflyPanes.list().map(entry => [entry.id, entry.definition.placement])).toEqual([
        ['example.header.summary', 'header'],
        ['example.inspector.context', 'right'],
        ['example.log.recent', 'bottom'],
        ['example.ui-gallery.prompt', 'bottom'],
        ['example.ui-gallery.showcase', 'right'],
        ['example.ui-gallery.view', 'views'],
      ])
      for (const pane of ctx.mayflyPanes.list()) expect(pane.node).not.toBeNull()

      await fibers[1]!.dispose()
      expect(ctx.mayflyPanes.list().map(entry => entry.id)).not.toContain('example.inspector.context')
      for (const fiber of fibers.toReversed()) await fiber.dispose()
      expect(ctx.mayflyPanes.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('opens a direct Mayfly overlay from its editor action', async () => {
    const ctx = await directContext()
    try {
      const fiber = await ctx.plugin(overlay)
      const entry = ctx.mayflyEditorExtensions.list().find(extension => extension.id === 'example.overlay.open')!
      expect(entry.decoration.actions).toEqual([{ id: 'open', label: 'Example settings', key: overlay.OPEN_KEY }])
      await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'open', actionId: 'open' }, {
        surfaceId: entry.id, operationId: 'example-open', source: [], revision: entry.revision, signal: new AbortController().signal, report: vi.fn(),
      })
      expect(ctx.mayflyOverlays.list().map(overlayEntry => overlayEntry.id)).toEqual([overlay.overlayRequest.id])
      expect(ctx.mayflyOverlays.list()[0]!.node).toMatchObject({ kind: 'stack' })

      await fiber.dispose()
      expect(ctx.mayflyEditorExtensions.list()).toEqual([])
      expect(ctx.mayflyOverlays.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('binds status and editor extension registrations directly to a consumer Fiber', async () => {
    const ctx = await directContext()
    try {
      const consumer = await ctx.plugin({
        name: 'direct-ui-contributions',
        inject: ['mayflyStatus', 'mayflyEditorExtensions'],
        apply(pluginCtx: Context) {
          pluginCtx.mayflyStatus.register({ id: 'example.status' }, { kind: 'text', content: 'ready' })
          pluginCtx.mayflyEditorExtensions.register({ id: 'example.editor' }, { hint: 'direct extension' })
        },
      })
      expect(ctx.mayflyStatus.list().map(entry => entry.id)).toEqual(['example.status'])
      expect(ctx.mayflyEditorExtensions.list().map(entry => entry.id)).toEqual(['example.editor'])
      await consumer.dispose()
      expect(ctx.mayflyStatus.list()).toEqual([])
      expect(ctx.mayflyEditorExtensions.list()).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('composes the five plugins into the ordinary TUI startup', async () => {
    // The composition imports the published packages; the spec reads their sources, so plugins compare by name.
    expect(composed.map(plugin => (plugin as { readonly name: string }).name)).toEqual([header, inspector, bottomLog, overlay, uiGallery].map(plugin => plugin.name))
    await start(['--resume', 'example-session'])
    expect(bin.run).toHaveBeenCalledWith(['--resume', 'example-session'], { plugins: composed })
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', '..', 'mayfly-ecosystem', 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.dsh).toBeUndefined()
    expect(manifest.bin).toEqual({ 'mayfly-ecosystem': 'lib/bin.js' })
  })
})

it('starts the installed ecosystem executable with the process arguments', async () => {
  await import('../../mayfly-ecosystem/src/bin.ts')
  expect(bin.run).toHaveBeenLastCalledWith(process.argv.slice(2), { plugins: composed })
})
