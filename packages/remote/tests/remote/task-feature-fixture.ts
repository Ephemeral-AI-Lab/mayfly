/** Real UI/feature fixtures with native projection and Remote command boundaries. @module */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { apply as uiProvider } from '@ephemeral-ai/mayfly-ui/provider'
import * as frontend from '@ephemeral-ai/mayfly/frontend'
import { compileMayflyUiNode } from '@ephemeral-ai/mayfly/core'
import type { MayflyUiActionEvent, MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { vi } from 'vitest'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/remote/features.ts'
import { RemoteFeatureCommandRegistry } from '../../src/remote/features/commands.ts'
import { projection } from './approval-feature-fixture.ts'
import { fakeMayflyComponents, plain, plainColors } from './render-fixture.ts'

export const tick = async () => { await new Promise<void>(resolve => setImmediate(resolve)) }
export const translate = (key: string, values?: Readonly<Record<string, string | number>>) => key.replace(/\{(\w+)\}/gu, (_match, name: string) => String(values?.[name] ?? `{${name}}`))
export const activated = (actionId: string): Extract<MayflyUiActionEvent, { readonly kind: 'activate' }> => ({ kind: 'activate', actionId, controlId: 'actions', pagePath: [] })
export const good = <T>(value: T) => ({ ok: true as const, value })
export const bad = (message: string) => ({ ok: false as const, error: { code: 'denied', message } })

export async function taskFixture(selected = true) {
  const ctx = new Context()
  const ui = await ctx.plugin({ name: 'task-test-ui', apply: uiProvider })
  const front = await ctx.plugin(frontend)
  ctx.mayflyLocale.setPreference('en')
  const topology = new Set<() => void>()
  const connections = new Set<() => void>()
  const events = new Map<string, Set<(event: unknown) => void>>()
  const generation = { generation: 1 }
  const state = { goal: projection<unknown>(undefined), todos: projection<unknown>(undefined), mayflyConversation: projection<unknown>(undefined) }
  const goals = { get: vi.fn(async (): Promise<unknown> => good(undefined)), create: vi.fn(async (..._args: unknown[]) => good(undefined)), edit: vi.fn(async (..._args: unknown[]) => good(undefined)), pause: vi.fn(async (..._args: unknown[]) => good(undefined)), resume: vi.fn(async (..._args: unknown[]) => good(undefined)), complete: vi.fn(async (..._args: unknown[]) => good(undefined)), clear: vi.fn(async (..._args: unknown[]) => good(undefined)) }
  const schedule = { list: vi.fn(async (..._args: unknown[]): Promise<unknown> => good([])), catalog: vi.fn(async (): Promise<unknown> => good([])) }
  const client = { key: HostKey('tasks'), state: { getSnapshot: () => generation, subscribe: (fn: () => void) => { connections.add(fn); return () => { connections.delete(fn) } } }, remote: { goals, schedule, $on: vi.fn((name: string, listener: (event: unknown) => void) => { const rows = events.get(name) ?? new Set(); rows.add(listener); events.set(name, rows); return () => { rows.delete(listener) } }) } } as unknown as HostClient
  const original = { client, ref: { host: client.key, sessionId: SessionId('session') }, binding: { session: { projections: { faceOf: (key: keyof typeof state) => state[key] } } } } as unknown as RemoteFeatureSelection
  let current: RemoteFeatureSelection | undefined = selected ? original : undefined
  let attached = [client]
  const commands = new RemoteFeatureCommandRegistry()
  const options = { ctx, components: fakeMayflyComponents(), colors: plainColors(), commands, t: translate, subscribeLocale: (fn: () => void) => ctx.mayflyLocale.subscribe(fn), hosts: { list: () => attached, current: vi.fn(() => current), subscribe: (fn: () => void) => { topology.add(fn); return () => { topology.delete(fn) } } }, notice: { set: vi.fn() } } as unknown as RemoteFeatureContext
  const registration = vi.spyOn(ctx.mayflyPanes, 'register')
  const notify = () => { for (const fn of topology) fn() }
  const render = (node: MayflyUiNode | null, width = 80) => {
    if (node === null) return []
    const result = compileMayflyUiNode(node, { components: options.components, colors: options.colors, getViewport: () => ({ columns: width, rows: 24 }), screenMode: 'alternate', emit: () => {} })
    if (!result.ok) throw new Error(result.message)
    return plain(result.value.component.render(width))
  }
  return { ctx, options, state, client, goals, schedule, topology, connections, events, registration, render,
    pane: (id: string) => ctx.mayflyPanes.list().find(entry => entry.id === id),
    run: async (name: string, input = '', signal = new AbortController().signal) => await commands.execute(name, input, signal),
    dispatch: async (event: MayflyUiActionEvent) => await (registration.mock.calls.at(-1)![0].onEvent!.action as (event: MayflyUiActionEvent) => Promise<unknown>)(event),
    event: (name: string, event: unknown = {}) => { for (const callback of events.get(name) ?? []) callback(event) },
    select: (value: boolean) => { current = value ? original : undefined; notify() },
    silentlyDeselect: () => { current = undefined },
    detach: () => { current = undefined; attached = []; notify() },
    reconnect: () => { generation.generation += 1; for (const fn of connections) fn() },
    dispose: async () => { await front.dispose(); await ui.dispose(); await ctx.fiber.dispose() },
  }
}
