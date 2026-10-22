/** Direct Cordis composition and Fiber lifecycle tests for ecosystem examples.
 * @module @mayfly-example/user-kit/tests/ecosystem
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply as applyApi } from '../../../packages/ui/src/provider.ts'
import { apply as applyBundle } from '../../mayfly-ecosystem/src/index.ts'
import * as bottomLog from '../../bottom-log/src/index.ts'
import * as header from '../../header/src/index.ts'
import * as overlay from '../../overlay/src/index.ts'
import * as inspector from '../../right-inspector/src/index.ts'
import * as uiGallery from '../../ui-gallery/src/index.ts'
import { summaryMetric } from '../src/index.ts'

interface CommandProbeDefinition {
  readonly name: string
  readonly description: string
  readonly handler: (invocation: never) => unknown
}

class CommandProbe extends Service {
  private readonly entries = new Map<string, CommandProbeDefinition>()
  constructor(ctx: Context) { super(ctx, 'commands') }
  register(definition: CommandProbeDefinition): () => void {
    this.entries.set(definition.name, definition)
    return this.ctx.effect(() => () => { this.entries.delete(definition.name) })
  }
  find(name: string): CommandProbeDefinition | undefined { return this.entries.get(name) }
}

async function directContext(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin({ name: 'example-test-api', apply: applyApi })
  return ctx
}

describe('shared user kit', () => {
  it('builds deeply frozen standard nodes without plugin metadata', () => {
    const node = summaryMetric.render({ label: 'Context', value: '42%', detail: '12k / 28k' })
    expect(node).toMatchObject({ kind: 'surface', child: { kind: 'stack', direction: 'row' } })
    expect(Object.isFrozen(node)).toBe(true)
    expect(Object.isFrozen(node.child)).toBe(true)
    const packageRoot = join(import.meta.dirname, '..')
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as Record<string, unknown>
    expect(manifest.mayfly).toBeUndefined()
    expect(manifest.dsh).toBeUndefined()
  })
})

describe('direct plugin services and lifecycle', () => {
  it('registers four pane plugins as ordinary Cordis siblings and unloads each Fiber', async () => {
    const ctx = await directContext()
    try {
      const plugins = [header, inspector, bottomLog, uiGallery]
      const fibers = []
      for (const plugin of plugins) fibers.push(await ctx.plugin(plugin))
      expect(ctx.mayflyPanes.list().map(entry => [entry.id, entry.definition.placement])).toEqual([
        ['example.header.summary', 'header'],
        ['example.inspector.context', 'right'],
        ['example.log.recent', 'bottom'],
        ['example.ui-gallery.showcase', 'right'],
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

  it('uses the native dsh command registry to open a direct Mayfly overlay', async () => {
    const ctx = await directContext()
    try {
      await ctx.plugin(CommandProbe)
      const fiber = await ctx.plugin(overlay)
      const commands = ctx.commands as unknown as CommandProbe
      const command = commands.find('example-overlay')
      expect(command).toMatchObject({ name: 'example-overlay' })
      const result = await command!.handler({
        agent: {},
        commandId: 'example-command' as never,
        rawInput: '',
        attachments: [],
        signal: new AbortController().signal,
      } as never)
      expect(result).toEqual({ kind: 'success', text: 'opened the example overlay' })
      expect(ctx.mayflyOverlays.list().map(entry => entry.id)).toEqual([overlay.overlayRequest.id])
      expect(ctx.mayflyOverlays.list()[0]!.node).toMatchObject({ kind: 'stack' })

      await fiber.dispose()
      expect(commands.find('example-overlay')).toBeUndefined()
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

  it('ships five ordinary opt-in Cordis plugin rows', () => {
    const patch = readFileSync(join(import.meta.dirname, '..', '..', 'mayfly-ecosystem', 'cordis.patch.yml'), 'utf8')
    expect(patch.match(/^\s+- id: '@mayfly-example\//gmu)).toHaveLength(5)
    const ctx = new Context()
    applyBundle(ctx)
  })
})
