/** Native authorization lifecycle, persistent instructions, and prompt withdrawal evidence.
 * @module @ephemeral-ai/mayfly/tests/interaction/authorization-ui
 */
import { Context } from '@deepseek-ai/cordis'
import AuthorizationService, { AuthorizationDeclinedError, type AuthorizationSession } from '@deepseek-ai/dsh-authorization'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openAuthorization } from '../../src/interaction/authorization-ui.ts'
import { setClipboardOsc52Emitter, setClipboardTextWriter } from '../../src/interaction/clipboard-write.ts'
import { providerFixture } from './provider-fixture.ts'

const contexts: Context[] = []
afterEach(async () => { vi.useRealTimers(); setClipboardTextWriter(undefined); setClipboardOsc52Emitter(undefined); for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const flush = () => new Promise<void>(resolve => { setImmediate(resolve) })
const key = credentialKey('llm-pi-ai', 'test')

async function setup(run: (session: AuthorizationSession, commit: () => Promise<void>) => Promise<void>, completed = vi.fn(async () => {})) {
  const ctx = new Context()
  contexts.push(ctx)
  const bench = await providerFixture(ctx)
  await ctx.plugin(AuthorizationService)
  ctx.authorization.registerFlow({ key, label: 'Test authorization', methods: [{ id: 'oauth', label: 'Sign in' }], run: session => run(session, async () => { await bench.credentials.modifyRecord(key, async () => ({ kind: 'api-key', key: 'stored-token' })) }) })
  const handle = openAuthorization(ctx, 'test', completed)
  const parent = ctx.mayflyUiInteraction.get('overlay', ctx.mayflyOverlays.list()[0]!.id)!
  parent.invoke('start')
  await flush()
  const child = () => ctx.mayflyUiInteraction.list('overlay').find(model => model.id.includes('.prompt.'))
  return { ...bench, handle, parent, child, completed }
}

describe('authorization interaction', () => {
  it('requires the native authorization service', () => {
    const ctx = new Context()
    contexts.push(ctx)
    expect(() => openAuthorization(ctx, 'missing', async () => {})).toThrow('Authorization is unavailable')
  })

  it('retries provider setup without repeating a successfully completed authorization', async () => {
    const completed = vi.fn(async () => {}).mockRejectedValueOnce(new Error('settings unavailable'))
    const run = vi.fn(async (_session: AuthorizationSession, commit: () => Promise<void>) => { await commit() })
    const bench = await setup(run, completed)
    expect(run).toHaveBeenCalledOnce()
    expect(bench.parent.feedbackSnapshot().at(-1)?.message).toContain('Signed in')
    expect(JSON.stringify(bench.parent.node)).toContain('Finish setup')
    bench.parent.invoke('start')
    await flush()
    expect(run).toHaveBeenCalledOnce()
    expect(completed).toHaveBeenCalledTimes(2)
    expect(bench.parent.feedbackSnapshot().at(-1)?.message).toBe('Authorization completed')
    expect(bench.parent.feedbackSnapshot().every(item => item.severity !== 'error')).toBe(true)
  })

  it('keeps complete URL/code instructions visible during select prompts and returns the option id', async () => {
    let chosen = ''
    const url = `https://auth.example/authorize?request=${'long-'.repeat(100)}`
    const bench = await setup(async (session, commit) => {
      session.notify({ message: 'Continue in the browser', url, code: 'CODE-42' })
      chosen = await session.prompt({ kind: 'select', message: 'Account', options: [{ id: 'account-a', label: 'Personal' }, { id: 'account-b', label: 'Work' }] })
      await commit()
    })
    const child = bench.child()!
    expect(JSON.stringify(child.node)).toContain(url)
    expect(JSON.stringify(child.node)).toContain('CODE-42')
    expect(JSON.stringify(child.inspect())).not.toContain('CODE-42')
    child.emit({ kind: 'selection-accept', pagePath: [], controlId: 'authorization-options', selectedIds: ['account-b'] })
    await flush()
    expect(chosen).toBe('account-b')
    expect(bench.completed).toHaveBeenCalledOnce()
    expect(bench.child()).toBeUndefined()
    expect(JSON.stringify(bench.parent.node)).not.toContain('CODE-42')
    expect(JSON.stringify(bench.parent.node)).not.toContain(url)
    expect(bench.parent.feedbackSnapshot().at(-1)?.message).toBe('Authorization completed')
  })

  it('withdraws a losing prompt without declining or cancelling the whole attempt', async () => {
    const withdrawn = new AbortController()
    const browser = Promise.withResolvers<void>()
    let rejected: unknown
    const bench = await setup(async (session, commit) => {
      session.notify({ message: 'Browser sign-in', url: 'https://auth.example', code: '1234' })
      try { await session.prompt({ kind: 'text', message: 'Code', signal: withdrawn.signal }) }
      catch (error) { rejected = error }
      await browser.promise
      await commit()
    })
    expect(bench.child()).toBeDefined()
    withdrawn.abort()
    await flush()
    expect(bench.child()).toBeUndefined()
    expect(rejected).toBeInstanceOf(Error)
    expect(rejected).not.toBeInstanceOf(AuthorizationDeclinedError)
    expect(bench.ctx.authorization.describe(key)?.inFlight).toBe(true)
    expect(JSON.stringify(bench.parent.node)).toContain('1234')
    browser.resolve()
    await flush()
    expect(bench.completed).toHaveBeenCalledOnce()
  })

  it('maps a human cancellation to native decline instead of reporting an authorization failure', async () => {
    const bench = await setup(async session => { await session.prompt({ kind: 'secret', message: 'Secret' }) })
    const child = bench.child()!
    child.edit({ pagePath: [], formId: 'authorization-answer', fieldId: 'answer' }, 'secret-draft')
    child.requestClose()
    child.answerDecision(true)
    await flush()
    expect(bench.child()).toBeUndefined()
    expect(bench.completed).not.toHaveBeenCalled()
    expect(bench.parent.feedbackSnapshot().at(-1)?.message).toBe('Authorization cancelled')
    expect(JSON.stringify(bench.parent.inspect())).not.toContain('secret-draft')
  })

  it('keeps authorization instructions beyond generic toast and former event timeouts', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const browser = Promise.withResolvers<void>()
    const bench = await setup(async (session, commit) => {
      session.notify({ message: 'Browser sign-in', url: 'https://auth.example', code: 'KEEP-ME' })
      await browser.promise
      await commit()
    })
    await vi.advanceTimersByTimeAsync(31000)
    expect(bench.ctx.authorization.describe(key)?.inFlight).toBe(true)
    expect(JSON.stringify(bench.parent.node)).toContain('KEEP-ME')
    browser.resolve()
    await flush()
    expect(bench.completed).toHaveBeenCalledOnce()
  })

  it('cancels a whole attempt on parent close and contains late notifications', async () => {
    let session!: AuthorizationSession
    const bench = await setup(async current => {
      session = current
      current.notify({ message: 'Waiting', url: 'https://auth.example', code: 'OLD-CODE' })
      await new Promise<void>((_resolve, reject) => current.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }))
    })
    bench.handle.close()
    await flush()
    session.notify({ message: 'Late', url: 'https://late.example', code: 'LATE-CODE' })
    expect(bench.ctx.mayflyOverlays.list()).toEqual([])
    expect(bench.parent.registration.node).toBeNull()
    expect(bench.completed).not.toHaveBeenCalled()
  })

  it('copies parent and prompt instructions and rejects missing or cancelled copies', async () => {
    const copied: string[] = []
    setClipboardOsc52Emitter(() => false)
    setClipboardTextWriter(async text => { copied.push(text) })
    const gate = Promise.withResolvers<void>()
    let session!: AuthorizationSession
    const bench = await setup(async (current, commit) => {
      session = current
      current.notify({ message: 'Waiting' })
      await gate.promise
      await commit()
    })
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === bench.parent.id)!
    const action = entry.definition.onEvent!.action!
    const event = (actionId: string) => ({ kind: 'activate' as const, pagePath: [], controlId: 'authorization-copy', actionId })
    const request = (signal = new AbortController().signal) => ({ surfaceId: entry.id, operationId: 'copy', source: entry.source, revision: entry.revision, signal, report: vi.fn() })
    expect(await action(event('copy-url'), request())).toMatchObject({ kind: 'failed' })

    session.notify({ message: 'Open', url: 'https://auth.example', code: 'CODE' })
    await flush()
    expect(await action(event('copy-url'), request())).toEqual({ kind: 'completed' })
    expect(await action(event('copy-code'), request())).toEqual({ kind: 'completed' })
    const aborted = new AbortController()
    aborted.abort()
    await expect(action(event('copy-url'), request(aborted.signal))).rejects.toThrow()
    expect(copied).toEqual(['https://auth.example', 'CODE'])

    const prompt = session.prompt({ kind: 'select', message: 'Choose', options: [{ id: 'one', label: 'One', description: 'First option' }] })
    await flush()
    const child = bench.child()!
    const childEntry = bench.ctx.mayflyOverlays.list().find(item => item.id === child.id)!
    expect(JSON.stringify(child.node)).toContain('First option')
    expect(await childEntry.definition.onEvent!.action!(event('copy-url'), { ...request(), surfaceId: child.id })).toEqual({ kind: 'completed' })
    expect(await childEntry.definition.onEvent!.action!(event('copy-code'), { ...request(), surfaceId: child.id })).toEqual({ kind: 'completed' })
    child.emit({ kind: 'selection-accept', pagePath: [], controlId: 'authorization-options', selectedIds: ['one'] })
    await expect(prompt).resolves.toBe('one')
    gate.resolve()
    await flush()
  })

  it('submits text prompts with placeholders and ignores unrelated prompt actions', async () => {
    let answer = ''
    const bench = await setup(async (session, commit) => {
      answer = await session.prompt({ kind: 'text', message: 'Paste code', placeholder: 'code-123' })
      await commit()
    })
    const child = bench.child()!
    expect(JSON.stringify(child.node)).toContain('code-123')
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === child.id)!
    const context = { surfaceId: entry.id, operationId: 'noop', source: entry.source, revision: entry.revision, signal: new AbortController().signal, report: vi.fn() }
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, context)).toEqual({ kind: 'completed' })
    child.edit({ pagePath: [], formId: 'authorization-answer', fieldId: 'answer' }, 'entered-code')
    child.invoke('submit-answer')
    await flush()
    expect(answer).toBe('entered-code')
    expect(bench.completed).toHaveBeenCalledOnce()
  })

  it('rejects a prompt whose own signal is already withdrawn', async () => {
    const withdrawn = new AbortController()
    withdrawn.abort()
    const bench = await setup(async session => { await session.prompt({ kind: 'secret', message: 'Secret', signal: withdrawn.signal }) })
    await flush()
    expect(bench.child()).toBeUndefined()
    expect(bench.parent.feedbackSnapshot().at(-1)?.message).toBe('Authorization could not be completed')
  })

  it('merges partial notices and clears a code when the URL changes', async () => {
    const gate = Promise.withResolvers<void>()
    let session!: AuthorizationSession
    const bench = await setup(async (current, commit) => {
      session = current
      current.notify({ message: 'First', url: 'https://one.example', code: 'KEEP' })
      await gate.promise
      await commit()
    })
    session.notify({ message: 'Same URL', url: 'https://one.example' })
    await flush()
    expect(JSON.stringify(bench.parent.node)).toContain('KEEP')
    session.notify({ message: 'No fields' })
    await flush()
    expect(JSON.stringify(bench.parent.node)).toContain('https://one.example')
    session.notify({ message: 'New URL', url: 'https://two.example' })
    await flush()
    expect(JSON.stringify(bench.parent.node)).not.toContain('KEEP')
    session.notify({ message: 'Code only', code: 'NEW' })
    await flush()
    expect(JSON.stringify(bench.parent.node)).toContain('NEW')
    gate.resolve()
    await flush()
  })

  it('contains native authorization failures while the parent stays usable', async () => {
    const bench = await setup(async () => { throw new Error('provider failed') })
    await flush()
    expect(bench.parent.feedbackSnapshot().at(-1)?.message).toBe('Authorization could not be completed')
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === bench.parent.id)!
    const context = { surfaceId: entry.id, operationId: 'noop', source: entry.source, revision: entry.revision, signal: new AbortController().signal, report: vi.fn() }
    expect(await entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'noop', actionId: 'noop' }, context)).toEqual({ kind: 'completed' })
  })

  it('keeps a newer concurrent prompt when an older prompt settles', async () => {
    let answers: string[] = []
    const bench = await setup(async (session, commit) => {
      answers = await Promise.all([
        session.prompt({ kind: 'select', message: 'First', options: [{ id: 'first', label: 'First' }] }),
        session.prompt({ kind: 'select', message: 'Second', options: [{ id: 'second', label: 'Second' }] }),
      ])
      await commit()
    })
    const prompts = bench.ctx.mayflyUiInteraction.list('overlay').filter(model => model.id.includes('.prompt.'))
    expect(prompts).toHaveLength(2)
    prompts[0]!.emit({ kind: 'selection-accept', pagePath: [], controlId: 'authorization-options', selectedIds: ['first'] })
    await flush()
    expect(bench.ctx.mayflyUiInteraction.get('overlay', prompts[1]!.id)).toBeDefined()
    prompts[1]!.emit({ kind: 'selection-accept', pagePath: [], controlId: 'authorization-options', selectedIds: ['second'] })
    await flush()
    expect(answers).toEqual(['first', 'second'])
  })

  it('dismisses an older concurrent prompt idempotently without clearing the newer child', async () => {
    const bench = await setup(async session => {
      await Promise.all([
        session.prompt({ kind: 'select', message: 'First', options: [{ id: 'first', label: 'First' }] }),
        session.prompt({ kind: 'select', message: 'Second', options: [{ id: 'second', label: 'Second' }] }),
      ])
    })
    const prompts = bench.ctx.mayflyUiInteraction.list('overlay').filter(model => model.id.includes('.prompt.'))
    const first = bench.ctx.mayflyOverlays.list().find(entry => entry.id === prompts[0]!.id)!
    const dismiss = { kind: 'dismiss' as const, pagePath: [] }
    const context = { surfaceId: first.id, operationId: 'dismiss', source: first.source, revision: first.revision, signal: new AbortController().signal, report: vi.fn() }
    expect(await first.definition.onEvent!.action!(dismiss, context)).toEqual({ kind: 'cancelled' })
    expect(bench.ctx.mayflyUiInteraction.get('overlay', prompts[1]!.id)).toBeDefined()
    expect(await first.definition.onEvent!.action!(dismiss, context)).toEqual({ kind: 'cancelled' })
    await flush()
  })

  it('contains cancellation and failure while retrying provider setup after sign-in', async () => {
    const retry = Promise.withResolvers<void>()
    const completed = vi.fn(async () => {}).mockRejectedValueOnce(new Error('initial setup failed')).mockImplementationOnce(() => retry.promise)
    const bench = await setup(async (_session, commit) => { await commit() }, completed)
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === bench.parent.id)!
    const action = entry.definition.onEvent!.action!
    const controller = new AbortController()
    const context = { surfaceId: entry.id, operationId: 'retry', source: entry.source, revision: entry.revision, signal: controller.signal, report: vi.fn() }
    const pending = action({ kind: 'activate', pagePath: [], controlId: 'authorization-actions', actionId: 'start' }, context)
    await vi.waitFor(() => expect(completed).toHaveBeenCalledTimes(2))
    controller.abort()
    retry.resolve()
    expect(await pending).toEqual({ kind: 'cancelled' })

    completed.mockRejectedValueOnce(new Error('retry failed'))
    expect(await action({ kind: 'activate', pagePath: [], controlId: 'authorization-actions', actionId: 'start' }, { ...context, signal: new AbortController().signal })).toMatchObject({ kind: 'failed' })
  })

  it('settles a rejected native attempt as cancelled after its action aborts', async () => {
    const failure = Promise.withResolvers<never>()
    const bench = await setup(async () => failure.promise)
    const entry = bench.ctx.mayflyOverlays.list().find(item => item.id === bench.parent.id)!
    const controller = new AbortController()
    const context = { surfaceId: entry.id, operationId: 'attempt', source: entry.source, revision: entry.revision, signal: controller.signal, report: vi.fn() }
    const pending = entry.definition.onEvent!.action!({ kind: 'activate', pagePath: [], controlId: 'authorization-actions', actionId: 'start' }, context)
    controller.abort()
    failure.reject(new Error('aborted'))
    expect(await pending).toEqual({ kind: 'cancelled' })
  })
})
