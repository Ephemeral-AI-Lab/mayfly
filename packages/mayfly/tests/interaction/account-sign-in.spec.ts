/** Account sign-in flow states and failure vocabulary: the browser launch, the
 * attempt lifecycle, restart, copy, paste-back delivery, and cancellation.
 * @module @ephemeral-ai/mayfly/tests/interaction/account-sign-in
 */
import { Context } from '@deepseek-ai/cordis'
import type { AccountView, SignInAttemptView } from '@deepseek-ai/dsh-deepseek-account'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { accountInternals, accountPanelNode } from '../../src/interaction/provider-account.ts'
import { startSignIn, type SignInEnd, type SignInFlow, type SignInSnapshot } from '../../src/interaction/account-sign-in.ts'
import { setClipboardOsc52Emitter, setClipboardTextWriter } from '../../src/interaction/clipboard-write.ts'
import { flush } from '../helpers.ts'

const LINKS = { usageUrl: 'https://example/usage', topUpUrl: 'https://example/topup' }
const PORT = 45678
const terminal = (errorCode: SignInAttemptView['errorCode']): AccountView => ({
  status: 'signed-out', links: LINKS,
  attempt: { id: 'attempt' as never, phase: 'failed', ...(errorCode === undefined ? {} : { errorCode }) },
})

function attempt(over: {
  readonly id?: string
  readonly phase?: SignInAttemptView['phase']
  readonly authorizeUrl?: string | undefined
  readonly expiresAt?: number | undefined
  readonly errorCode?: SignInAttemptView['errorCode']
} = {}): SignInAttemptView {
  const { expiresAt, ...rest } = over
  return {
    id: 'a', phase: 'waiting-browser', authorizeUrl: 'https://example/auth',
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...rest,
  } as unknown as SignInAttemptView
}

function view(over: Partial<AccountView> & { readonly attempt?: AccountView['attempt'] } = {}): AccountView {
  return { status: 'signed-out', links: LINKS, attempt: attempt(), ...over } as AccountView
}

interface ScriptedAccount {
  readonly service: {
    getState: ReturnType<typeof vi.fn>
    startSignIn: ReturnType<typeof vi.fn>
    cancelSignIn: ReturnType<typeof vi.fn>
    watch(signal: AbortSignal): AsyncIterable<AccountView>
  }
  push(next: AccountView): void
}

/** A native account double whose watch queue a test pushes views into. */
function scripted(initial: AccountView): ScriptedAccount {
  const queue: AccountView[] = []
  const waiters: Array<() => void> = []
  const service = {
    getState: vi.fn(async () => initial),
    startSignIn: vi.fn(async () => initial),
    cancelSignIn: vi.fn(async () => initial),
    watch: vi.fn((signal: AbortSignal): AsyncIterable<AccountView> => {
      return {
        async *[Symbol.asyncIterator]() {
          while (!signal.aborted) {
            if (queue.length === 0) {
              await new Promise<void>(resolve => {
                waiters.push(resolve)
                signal.addEventListener('abort', () => { resolve() }, { once: true })
              })
            }
            if (signal.aborted) return
            const next = queue.shift()
            if (next !== undefined) yield next
          }
        },
      }
    }),
  }
  return {
    service,
    push(next) {
      queue.push(next)
      waiters.shift()?.()
    },
  }
}

const savedDisplay = process.env.DISPLAY
const savedWayland = process.env.WAYLAND_DISPLAY
const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  setClipboardTextWriter(undefined)
  setClipboardOsc52Emitter(undefined)
  if (savedDisplay === undefined) delete process.env.DISPLAY
  else process.env.DISPLAY = savedDisplay
  if (savedWayland === undefined) delete process.env.WAYLAND_DISPLAY
  else process.env.WAYLAND_DISPLAY = savedWayland
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

interface FlowRig {
  readonly ctx: Context
  readonly account: ScriptedAccount
  readonly lifetime: AbortController
  readonly snapshots: SignInSnapshot[]
  readonly flow: SignInFlow
}

async function mountFlow(initial: AccountView, configure?: (account: ScriptedAccount) => void): Promise<FlowRig> {
  const ctx = new Context()
  contexts.push(ctx)
  const account = scripted(initial)
  configure?.(account)
  ctx.provide('deepseekAccount', account.service as never)
  ctx.provide('webServer', { port: PORT } as never)
  const lifetime = new AbortController()
  const snapshots: SignInSnapshot[] = []
  const started = await startSignIn(ctx, { signal: lifetime.signal, onChange: snapshot => snapshots.push(snapshot) })
  if (!('snapshot' in started)) throw new Error(`sign-in unavailable: ${started.error}`)
  return { ctx, account, lifetime, snapshots, flow: started }
}

describe('account sign-in failures', () => {
  it('renders the reachability copy for a no-response attempt', () => {
    const node = accountPanelNode(terminal('no-response'), key => key, true)
    expect(JSON.stringify(node)).toContain('Could not reach DeepSeek — check the connection and try again')
  })

  it('keeps the expired, network, and storage copy distinct', () => {
    expect(JSON.stringify(accountPanelNode(terminal('expired'), key => key, true))).toContain('The sign-in link expired — try again')
    expect(JSON.stringify(accountPanelNode(terminal('network'), key => key, true))).toContain('Could not reach DeepSeek — check the connection and try again')
    expect(JSON.stringify(accountPanelNode(terminal('storage'), key => key, true))).toContain('The login could not be saved on this machine — try again')
  })

  it('ends a followed no-response attempt on the reachability story', async () => {
    const ctx = new Context()
    const view = terminal('no-response')
    ctx.provide('deepseekAccount', fakeAccount(view) as never)
    ctx.provide('webServer', { port: 45678 } as never)
    const snapshots: SignInSnapshot[] = []
    const flow = await startSignIn(ctx, { signal: new AbortController().signal, onChange: snapshot => snapshots.push(snapshot) })
    expect('snapshot' in flow).toBe(true)
    if (!('snapshot' in flow)) return
    await vi.waitFor(() => { expect(flow.snapshot().ended).toBe('network') })
    expect(flow.snapshot().stage).toBe('ended')
    expect(snapshots.some(snapshot => snapshot.ended === 'network')).toBe(true)
    await flush()
    await ctx.fiber.dispose()
  })
})

/** The original minimal account double, kept for the failure-vocabulary test. */
function fakeAccount(view: AccountView) {
  return {
    async getState() { return view },
    async startSignIn() { return view },
    async cancelSignIn() { return view },
    watch(signal: AbortSignal): AsyncIterable<AccountView> {
      return {
        async *[Symbol.asyncIterator]() {
          if (!signal.aborted) yield view
        },
      }
    },
  }
}

describe('account sign-in start', () => {
  it('reports unavailable without the native account service', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const started = await startSignIn(ctx, { signal: new AbortController().signal, onChange: () => {} })
    expect(started).toEqual({ error: 'unavailable' })
  })

  it('reports no-server without the local web server', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const account = scripted(view())
    ctx.provide('deepseekAccount', account.service as never)
    const started = await startSignIn(ctx, { signal: new AbortController().signal, onChange: () => {} })
    expect(started).toEqual({ error: 'no-server' })
  })

  it('reports failed when the native start rejects, without opening a watch', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    const account = scripted(view())
    account.service.startSignIn.mockRejectedValueOnce(new Error('platform down'))
    ctx.provide('deepseekAccount', account.service as never)
    ctx.provide('webServer', { port: PORT } as never)
    const started = await startSignIn(ctx, { signal: new AbortController().signal, onChange: () => {} })
    expect(started).toEqual({ error: 'failed' })
    expect(account.service.watch).not.toHaveBeenCalled()
  })

  it('starts on a pending browser and carries the loopback callback port', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const rig = await mountFlow(view({ attempt: attempt({ id: 'a' }) }))
    expect(rig.flow.snapshot()).toMatchObject({ stage: 'waiting', url: 'https://example/auth', callbackPort: PORT })
    await vi.waitFor(() => { expect(rig.flow.snapshot().browser).toBe('failed') })
    rig.lifetime.abort()
  })

  it('ignores a null attempt and resets the snapshot for a new attempt', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const rig = await mountFlow(view({ attempt: null }))
    expect(rig.flow.snapshot()).toEqual({ stage: 'starting', browser: 'pending', callbackPort: PORT })
    rig.account.push(view({ attempt: attempt({ id: 'a', expiresAt: Date.now() + 10_000 }) }))
    await vi.waitFor(() => { expect(rig.flow.snapshot().url).toBe('https://example/auth') })
    rig.account.push(view({ attempt: attempt({ id: 'b', authorizeUrl: 'https://example/second', expiresAt: Date.now() + 5_000 }) }))
    await vi.waitFor(() => { expect(rig.flow.snapshot().url).toBe('https://example/second') })
    expect(rig.flow.snapshot().totalMs).toBeLessThan(9_000)
    rig.lifetime.abort()
  })

  it('notes a link with no expiry as a zero total', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const rig = await mountFlow(view({ attempt: attempt({ expiresAt: undefined }) }))
    expect(rig.flow.snapshot().expiresAt).toBeUndefined()
    expect(rig.flow.snapshot().totalMs).toBe(0)
    rig.lifetime.abort()
  })

  it('shows finishing while the platform exchanges and commits', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const rig = await mountFlow(view({ attempt: attempt() }))
    rig.account.push(view({ attempt: attempt({ phase: 'exchanging' }) }))
    await vi.waitFor(() => { expect(rig.flow.snapshot().stage).toBe('finishing') })
    rig.account.push(view({ attempt: attempt({ phase: 'committing' }) }))
    await flush()
    expect(rig.flow.snapshot().stage).toBe('finishing')
    rig.lifetime.abort()
  })

  it('keeps starting while a waiting attempt has no authorize URL yet', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const rig = await mountFlow(view({ attempt: attempt({ id: 'a' }) }))
    rig.account.push(view({ attempt: attempt({ id: 'b', phase: 'initializing', authorizeUrl: undefined }) }))
    await vi.waitFor(() => { expect(rig.flow.snapshot().stage).toBe('starting') })
    expect(rig.flow.snapshot().url).toBeUndefined()
    rig.lifetime.abort()
  })
})

describe('account sign-in attempt endings', () => {
  it.each<[string, SignInAttemptView, SignInEnd]>([
    ['cancelled', { id: 'a', phase: 'cancelled' } as SignInAttemptView, 'cancelled'],
    ['expired phase', { id: 'a', phase: 'expired' } as SignInAttemptView, 'expired'],
    ['expired code', { id: 'a', phase: 'failed', errorCode: 'expired' } as SignInAttemptView, 'expired'],
    ['network', { id: 'a', phase: 'failed', errorCode: 'network' } as SignInAttemptView, 'network'],
    ['no-response', { id: 'a', phase: 'failed', errorCode: 'no-response' } as SignInAttemptView, 'network'],
    ['storage', { id: 'a', phase: 'failed', errorCode: 'storage' } as SignInAttemptView, 'storage'],
    ['other failure', { id: 'a', phase: 'failed' } as SignInAttemptView, 'failed'],
  ])('ends a followed attempt on %s', async (_name, ending, expected) => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const rig = await mountFlow(view({ attempt: attempt({ id: 'a' }) }))
    rig.account.push(view({ attempt: ending }))
    await vi.waitFor(() => { expect(rig.flow.snapshot()).toMatchObject({ stage: 'ended', ended: expected, callbackPort: PORT }) })
    expect(rig.snapshots.some(snapshot => snapshot.ended === expected)).toBe(true)
    rig.lifetime.abort()
  })

  it('connects a stored credential after a succeeded attempt and settles connected', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const rig = await mountFlow(view({ attempt: attempt({ id: 'a' }) }))
    rig.account.push({ status: 'credential-stored', links: LINKS, attempt: attempt({ phase: 'succeeded' }) })
    await expect(rig.flow.connected).resolves.toBe(true)
    await vi.waitFor(() => { expect(rig.flow.snapshot().stage).toBe('connected') })
    rig.lifetime.abort()
  })

  it('settles false when the owner lifetime aborts', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const rig = await mountFlow(view({ attempt: attempt() }))
    rig.lifetime.abort()
    await expect(rig.flow.connected).resolves.toBe(false)
    const count = rig.snapshots.length
    rig.account.push(view({ attempt: attempt({ phase: 'expired' }) }))
    await flush()
    expect(rig.snapshots.length).toBe(count)
  })
})

describe('account sign-in browser launch', () => {
  it('reports the opened browser once the opener resolves true', async () => {
    process.env.DISPLAY = ':spec'
    const opener = vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(true)
    const rig = await mountFlow(view({ attempt: attempt({ authorizeUrl: 'https://example/auth' }) }))
    await vi.waitFor(() => { expect(rig.flow.snapshot().browser).toBe('opened') })
    expect(opener).toHaveBeenCalledWith(expect.any(String), ['https://example/auth'])
    rig.lifetime.abort()
  })

  it('reports a failed browser when the opener resolves false', async () => {
    process.env.DISPLAY = ':spec'
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const rig = await mountFlow(view({ attempt: attempt({ authorizeUrl: 'https://example/auth' }) }))
    await vi.waitFor(() => { expect(rig.flow.snapshot().browser).toBe('failed') })
    rig.lifetime.abort()
  })

  it.runIf(process.platform === 'linux')('skips the opener when the session has no display', async () => {
    delete process.env.DISPLAY
    delete process.env.WAYLAND_DISPLAY
    const opener = vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(true)
    const rig = await mountFlow(view({ attempt: attempt() }))
    await vi.waitFor(() => { expect(rig.flow.snapshot().browser).toBe('failed') })
    expect(opener).not.toHaveBeenCalled()
    rig.lifetime.abort()
  })

  it('does not report a late launch for a link a newer attempt replaced', async () => {
    const firstGate = Promise.withResolvers<boolean>()
    const secondGate = Promise.withResolvers<boolean>()
    process.env.DISPLAY = ':spec'
    vi.spyOn(accountInternals, 'spawnOpener')
      .mockReturnValueOnce(firstGate.promise)
      .mockReturnValueOnce(secondGate.promise)
    const rig = await mountFlow(view({ attempt: attempt({ id: 'a', authorizeUrl: 'https://example/first' }) }))
    rig.account.push(view({ attempt: attempt({ id: 'b', authorizeUrl: 'https://example/second' }) }))
    await vi.waitFor(() => { expect(rig.flow.snapshot().url).toBe('https://example/second') })
    firstGate.resolve(true)
    await flush(2)
    expect(rig.flow.snapshot()).toMatchObject({ url: 'https://example/second', browser: 'pending' })
    secondGate.resolve(true)
    await vi.waitFor(() => { expect(rig.flow.snapshot()).toMatchObject({ url: 'https://example/second', browser: 'opened' }) })
    rig.lifetime.abort()
  })
})

describe('account sign-in restart', () => {
  it('cancels a live attempt, starts a fresh one, and does not report its old ending', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const gate = Promise.withResolvers<AccountView>()
    const rig = await mountFlow(view({ attempt: attempt({ id: 'a' }) }), account => {
      account.service.startSignIn.mockReturnValueOnce(Promise.resolve(view({ attempt: attempt({ id: 'a' }) }))).mockReturnValueOnce(gate.promise)
    })
    const restarting = rig.flow.restart()
    rig.account.push(view({ attempt: attempt({ id: 'a', phase: 'cancelled' }) }))
    await flush(2)
    expect(rig.snapshots.some(snapshot => snapshot.ended !== undefined)).toBe(false)
    gate.resolve(view({ attempt: attempt({ id: 'b', authorizeUrl: 'https://example/new' }) }))
    await restarting
    expect(rig.account.service.cancelSignIn).toHaveBeenCalledWith('a')
    expect(rig.account.service.startSignIn).toHaveBeenCalledTimes(2)
    await vi.waitFor(() => { expect(rig.flow.snapshot()).toMatchObject({ stage: 'waiting', url: 'https://example/new' }) })
    rig.lifetime.abort()
  })

  it('does not cancel an attempt that already ended', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const ended = view({ attempt: attempt({ id: 'a', phase: 'expired' }) })
    const rig = await mountFlow(view({ attempt: attempt({ id: 'a' }) }), account => {
      account.service.getState.mockResolvedValue(ended)
      account.service.startSignIn.mockResolvedValue(view({ attempt: attempt({ id: 'b' }) }))
    })
    await rig.flow.restart()
    expect(rig.account.service.cancelSignIn).not.toHaveBeenCalled()
    rig.lifetime.abort()
  })

  it('ends failed when the restart state read rejects', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const rig = await mountFlow(view({ attempt: attempt({ id: 'a' }) }), account => {
      account.service.getState.mockRejectedValue(new Error('store gone'))
    })
    await rig.flow.restart()
    expect(rig.flow.snapshot()).toMatchObject({ stage: 'ended', ended: 'failed', browser: 'pending' })
    rig.lifetime.abort()
  })
})

describe('account sign-in copy, delivery, and cancel', () => {
  it('copies the live link and reports a missing or failing copy', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const rig = await mountFlow(view({ attempt: attempt() }))
    setClipboardOsc52Emitter(() => true)
    setClipboardTextWriter(async () => {})
    await expect(rig.flow.copyLink()).resolves.toBe(true)
    setClipboardOsc52Emitter(() => false)
    setClipboardTextWriter(async () => { throw new Error('no tool') })
    await expect(rig.flow.copyLink()).resolves.toBe(false)
    const empty = await mountFlow(view({ attempt: null }))
    await expect(empty.flow.copyLink()).resolves.toBe(false)
    rig.lifetime.abort()
    empty.lifetime.abort()
  })

  it('classifies pasted callback delivery', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const fetchCallback = vi.spyOn(accountInternals, 'fetchCallback')
    const rig = await mountFlow(view({ attempt: attempt() }))
    await expect(rig.flow.deliver('https://example/not-loopback?code=x')).resolves.toBe('invalid')
    expect(fetchCallback).not.toHaveBeenCalled()

    fetchCallback.mockRejectedValueOnce(new Error('connection refused'))
    await expect(rig.flow.deliver(`http://localhost:${PORT}/oauth/callback?code=x`)).resolves.toBe('failed')

    fetchCallback.mockResolvedValueOnce({ status: 400 })
    await expect(rig.flow.deliver(`http://localhost:${PORT}/oauth/callback?code=x`)).resolves.toBe('rejected')

    fetchCallback.mockResolvedValueOnce({ status: 200 })
    await expect(rig.flow.deliver(`http://127.0.0.1:${PORT}/oauth/callback?code=y`)).resolves.toBe('delivered')
    expect(fetchCallback).toHaveBeenLastCalledWith(`http://127.0.0.1:${PORT}/oauth/callback?code=y`, expect.any(AbortSignal))
    rig.lifetime.abort()
  })

  it('cancels the current native attempt and settles connected false', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const rig = await mountFlow(view({ attempt: attempt({ id: 'live' }) }))
    rig.flow.cancel()
    await expect(rig.flow.connected).resolves.toBe(false)
    await vi.waitFor(() => { expect(rig.account.service.cancelSignIn).toHaveBeenCalledWith('live') })
    rig.lifetime.abort()
  })

  it('does not cancel after the sign-in already connected', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const rig = await mountFlow(view({ attempt: attempt({ id: 'a' }) }))
    rig.account.push({ status: 'credential-stored', links: LINKS, attempt: attempt({ phase: 'succeeded' }) })
    await rig.flow.connected
    rig.flow.cancel()
    await flush()
    expect(rig.account.service.getState).not.toHaveBeenCalled()
    expect(rig.account.service.cancelSignIn).not.toHaveBeenCalled()
    rig.lifetime.abort()
  })

  it('contains a state read failure during cancel', async () => {
    vi.spyOn(accountInternals, 'spawnOpener').mockResolvedValue(false)
    const rig = await mountFlow(view({ attempt: attempt({ id: 'a' }) }), account => {
      account.service.getState.mockRejectedValue(new Error('store gone'))
    })
    expect(() => { rig.flow.cancel() }).not.toThrow()
    await flush(2)
    expect(rig.account.service.cancelSignIn).not.toHaveBeenCalled()
    rig.lifetime.abort()
  })
})
