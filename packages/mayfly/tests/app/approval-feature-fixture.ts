/** Real frontend/UI ownership with external native approval and projection boundaries. @module */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionBinding, SessionEventLikeEntry } from '@deepseek-ai/dsh-api-session-controller/client'
import { apply as uiProvider } from '@ephemeral-ai/mayfly-ui/provider'
import * as frontend from '../../src/frontend.ts'
import type { MayflyDecisionRequest, MayflyDecisionWait } from '../../src/editor-presentation.ts'
import { vi } from 'vitest'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/app/features.ts'
import { mountApprovalInteractions } from '../../src/app/interactions/approval.ts'
import type { ApprovalListener, ApprovalOutcome, ApprovalRequest } from '../../src/app/interactions/official.ts'
import { fakeMayflyComponents, plainColors } from './render-fixture.ts'

export function projection<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: (next: T): void => { value = next; for (const listener of listeners) listener() },
    listeners,
  }
}

/** One selected native Session with no retained Agent or session-event fold. */
export async function approvalFixture() {
  const ctx = new Context()
  const provider = await ctx.plugin({ name: 'approval-test-ui', apply: uiProvider })
  const front = await ctx.plugin(frontend)
  ctx.mayflyLocale.setPreference('en')
  const listeners = new Set<() => void>()
  const stateListeners = new Set<() => void>()
  const localeListeners = new Set<() => void>()
  const rosters: Array<readonly MayflyDecisionRequest[]> = []
  const waits: Array<MayflyDecisionWait | undefined> = []
  ctx.on('mayfly/decision-requests-changed', (source, value) => { if (source === 'approval') rosters.push(value) })
  ctx.on('mayfly/decision-wait-changed', value => { waits.push(value) })
  let listener!: ApprovalListener
  let scopeId: SessionId | undefined = SessionId('same-session')
  const state = { generation: 1 }
  const offRequest = vi.fn()
  const client = {
    key: HostKey('one'),
    remote: { $on: vi.fn((_event: string, fn: ApprovalListener) => { listener = fn; return offRequest }) },
    state: {
      getSnapshot: () => ({ generation: state.generation }),
      subscribe: (fn: () => void) => { stateListeners.add(fn); return () => { stateListeners.delete(fn) } },
    },
    sessions: { scopeOf: () => scopeId },
  } as unknown as HostClient
  const facts = projection<unknown>(undefined)
  const conversation = projection<unknown>(undefined)
  const questions = projection<unknown>(undefined)
  const pressure = projection<unknown>(undefined)
  const session = projection({ running: false })
  const prompt = vi.fn(async (..._args: unknown[]) => ({ ok: true as const, value: { accepted: true as const } }))
  const projections: Readonly<Record<string, ReturnType<typeof projection<unknown>>>> = { mayflyConversationFacts: facts, mayflyConversation: conversation, userQuestions: questions, contextPressure: pressure }
  let events: readonly SessionEventLikeEntry[] = []
  const binding = {
    eventSource: { getSnapshot: () => ({ entries: events }) },
    session: { ...session, prompt, projections: { faceOf: (name: string) => projections[name] } },
  } as unknown as SessionBinding
  let attached: readonly HostClient[] = [client]
  let selection: RemoteFeatureSelection | undefined = { ref: { host: client.key, sessionId: scopeId }, client, binding }
  const screen = { suspend: vi.fn(async <T>(run: () => Promise<T>) => await run()) }
  const options = {
    ctx, screen, components: fakeMayflyComponents(), colors: plainColors(),
    hosts: {
      list: () => attached, current: () => selection,
      subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    },
    t: (key: string, values?: Readonly<Record<string, string | number>>) => key.replace(/\{(\w+)\}/gu, (_match, name: string) => String(values?.[name] ?? `{${name}}`)),
    notice: { set: vi.fn() },
    subscribeLocale: (fn: () => void) => { localeListeners.add(fn); return () => { localeListeners.delete(fn) } },
  } as unknown as RemoteFeatureContext
  const dispose = mountApprovalInteractions(options)
  const next = vi.fn(async (): Promise<ApprovalOutcome> => 'unavailable')
  const request = (extra: Partial<ApprovalRequest> = {}, fallback = next) => listener.call(ctx, { toolName: 'ParityProbe', ...extra }, fallback)
  const model = () => {
    const id = ctx.mayflyOverlays.list()[0]?.id
    if (id === undefined) throw new Error('No approval overlay')
    const value = ctx.mayflyUiInteraction.get('overlay', id)!
    if (value.node === null) throw new Error(JSON.stringify(value.feedbackSnapshot()))
    return value
  }
  const notify = (): void => { for (const fn of listeners) fn() }
  return {
    ctx, options, client, binding, facts, conversation, questions, pressure, session, screen, prompt,
    state, stateListeners, localeListeners, topologyListeners: listeners, offRequest, next, request, model, rosters, waits, dispose,
    setEvents: (next: readonly SessionEventLikeEntry[]) => { events = next },
    scope: (id: SessionId | undefined) => { scopeId = id },
    selectSession: (id: SessionId) => { scopeId = id; selection = { ref: { host: client.key, sessionId: id }, client, binding }; notify() },
    notify,
    stopFrontend: () => front.dispose(),
    locale: (locale: 'zh' | 'en') => { ctx.mayflyLocale.setPreference(locale); for (const fn of localeListeners) fn() },
    reconnect: () => { state.generation += 1; for (const fn of stateListeners) fn() },
    rebind: () => { selection = { ...selection!, binding: { ...binding } }; notify() },
    switchHost: () => { selection = { ...selection!, ref: { ...selection!.ref, host: HostKey('two') }, client: { ...client, key: HostKey('two') } }; notify() },
    deselect: () => { selection = undefined; notify() },
    detach: () => { attached = []; selection = undefined; notify() },
    cleanup: async () => { dispose(); await front.dispose(); await provider.dispose(); await ctx.fiber.dispose() },
  }
}

export const flushApproval = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)) }
