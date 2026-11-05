/** Native question DTO boundaries with the real shared UI provider and acknowledgement path. @module */
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { SessionBinding } from '@deepseek-ai/dsh-api-session-controller/client'
import { apply as uiProvider } from '@ephemeral-ai/mayfly-ui/provider'
import * as frontend from '../../src/frontend.ts'
import type { MayflyDecisionRequest, MayflyDecisionWait } from '../../src/editor-presentation.ts'
import { vi } from 'vitest'
import { HostKey, type HostClient } from '../../src/client/types.ts'
import type { RemoteFeatureContext, RemoteFeatureSelection } from '../../src/app/features.ts'
import type { QuestionAnswer, QuestionRequest, OfficialQuestionWait } from '../../src/app/interactions/official.ts'
import { mountQuestionInteractions } from '../../src/app/interactions/questions.ts'
import { fakeMayflyComponents, plainColors } from './render-fixture.ts'
import { projection } from './approval-feature-fixture.ts'

type QuestionListener = (this: Context, request: QuestionRequest, next: () => Promise<QuestionAnswer>) => Promise<QuestionAnswer>
export const sampleQuestion = { id: 'choice', question: 'Choose one route', options: [{ label: 'First' }, { label: 'Second' }] }
export const callId = ToolCallId('question-call')

/** Keeps native Host ownership outside the controller while exercising its actual renderer-neutral UI. */
export async function questionFixture() {
  const ctx = new Context()
  const provider = await ctx.plugin({ name: 'question-test-ui', apply: uiProvider })
  const front = await ctx.plugin(frontend)
  ctx.mayflyLocale.setPreference('en')
  const topology = new Set<() => void>(), states = new Set<() => void>(), locales = new Set<() => void>()
  let listener!: QuestionListener
  let scope: SessionId | undefined = SessionId('same-session')
  let generation = 1
  const offRequest = vi.fn()
  const waits: Array<{
    readonly opening: ReturnType<typeof Promise.withResolvers<IteratorResult<{ remainingMs: number }>>>
    readonly ending: ReturnType<typeof Promise.withResolvers<IteratorResult<{ remainingMs: number }>>>
    readonly iterator: { next: ReturnType<typeof vi.fn<() => Promise<IteratorResult<{ remainingMs: number }>>>> }
    readonly dispose: ReturnType<typeof vi.fn<() => void>>
  }> = []
  const attachWait = vi.fn((_session: SessionId, _call: ToolCallId, signal: AbortSignal): OfficialQuestionWait => {
    const opening = Promise.withResolvers<IteratorResult<{ remainingMs: number }>>()
    const ending = Promise.withResolvers<IteratorResult<{ remainingMs: number }>>()
    const iterator = { next: vi.fn<() => Promise<IteratorResult<{ remainingMs: number }>>>().mockReturnValueOnce(opening.promise).mockReturnValue(ending.promise) }
    const aborted = () => { opening.reject(new Error('native claim aborted')); ending.resolve({ done: true, value: undefined }) }
    signal.addEventListener('abort', aborted, { once: true })
    const dispose = vi.fn(() => { signal.removeEventListener('abort', aborted); ending.resolve({ done: true, value: undefined }) })
    waits.push({ opening, ending, iterator, dispose })
    return { [Symbol.asyncIterator]: () => iterator, dispose }
  })
  const answer = vi.fn(async (_session: SessionId, _call: ToolCallId, _answer: QuestionAnswer) => ({ ok: true as const, value: true }))
  const client = {
    key: HostKey('one'),
    remote: { $on: vi.fn((_event: string, callback: QuestionListener) => { listener = callback; return offRequest }), userQuestions: { attachWait, answer } },
    state: { getSnapshot: () => ({ status: 'connected', generation }), subscribe: (callback: () => void) => { states.add(callback); return () => { states.delete(callback) } } },
    sessions: { scopeOf: () => scope },
  } as unknown as HostClient
  const questions = projection<unknown>(undefined), inbox = projection<unknown>(undefined)
  const session = projection({ running: false })
  const binding = {
    sessionId: scope,
    session: { ...session, projections: { faceOf: (key: string) => key === 'userQuestions' ? questions : inbox } },
  } as unknown as SessionBinding
  let attached: readonly HostClient[] = [client]
  let selection: RemoteFeatureSelection | undefined = { client, binding, ref: { host: client.key, sessionId: scope } }
  const options = {
    ctx, screen: {}, components: fakeMayflyComponents(), colors: plainColors(),
    hosts: { list: () => attached, current: () => selection, subscribe: (callback: () => void) => { topology.add(callback); return () => { topology.delete(callback) } } },
    t: (key: string, values?: Readonly<Record<string, string | number>>) => key.replace(/\{(\w+)\}/gu, (_match, name: string) => String(values?.[name] ?? `{${name}}`)),
    notice: { set: vi.fn() }, subscribeLocale: (callback: () => void) => { locales.add(callback); return () => { locales.delete(callback) } },
  } as unknown as RemoteFeatureContext
  const decisionWaits: Array<MayflyDecisionWait | undefined> = []
  const plans: Array<readonly MayflyDecisionRequest[]> = []
  ctx.on('mayfly/decision-wait-changed', wait => { decisionWaits.push(wait) })
  ctx.on('mayfly/decision-requests-changed', (source, requests) => { if (source === 'plan') plans.push(requests) })
  const dispose = mountQuestionInteractions(options)
  const next = vi.fn(async (): Promise<QuestionAnswer> => ({ answers: [] }))
  const request = (extra: Partial<QuestionRequest> = {}, fallback = next) => listener.call(ctx, { questions: [sampleQuestion], ...extra }, fallback)
  const model = () => {
    const id = ctx.mayflyOverlays.list()[0]?.id
    if (id === undefined) throw new Error('No question overlay')
    return ctx.mayflyUiInteraction.get('overlay', id)!
  }
  const submit = (index = '0') => {
    const value = model()
    value.emit({ kind: 'selection-accept', pagePath: [], controlId: 'options', selectedIds: [index] })
  }
  const notify = () => { for (const callback of [...topology]) callback() }
  return {
    ctx, options, client, binding, questions, inbox, session, topology, states, locales, offRequest, waits, decisionWaits, plans, attachWait, answer, next, request, model, submit, dispose, notify,
    scope: (next: SessionId | undefined) => { scope = next },
    setSelection: (value: RemoteFeatureSelection | undefined) => { selection = value; notify() },
    deselect: () => { selection = undefined; notify() },
    rebind: () => { selection = { ...selection!, binding: { ...binding } }; notify() },
    switchHost: () => { selection = { ...selection!, client: { ...client, key: HostKey('two') }, ref: { host: HostKey('two'), sessionId: SessionId('same-session') } }; notify() },
    detach: () => { attached = []; selection = undefined; notify() },
    reconnect: () => { generation += 1; for (const callback of [...states]) callback() },
    locale: (locale: 'zh' | 'en') => { ctx.mayflyLocale.setPreference(locale); for (const callback of [...locales]) callback() },
    cleanup: async () => { dispose(); for (const wait of waits) wait.dispose(); await front.dispose(); await provider.dispose(); await ctx.fiber.dispose() },
  }
}

export const flushQuestions = async (): Promise<void> => { await new Promise<void>(resolve => setImmediate(resolve)) }
