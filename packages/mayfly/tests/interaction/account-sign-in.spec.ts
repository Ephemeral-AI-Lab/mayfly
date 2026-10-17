/** Account sign-in failure vocabulary: `no-response` reads as a reachability
 * failure without disturbing the expired/network/storage distinctions.
 * @module @ephemeral-ai/mayfly/tests/interaction/account-sign-in
 */
import { Context } from '@deepseek-ai/cordis'
import type { AccountView, SignInAttemptView } from '@deepseek-ai/dsh-deepseek-account'
import { describe, expect, it, vi } from 'vitest'
import { accountPanelNode } from '../../src/interaction/provider-account.ts'
import { startSignIn, type SignInSnapshot } from '../../src/interaction/account-sign-in.ts'
import { flush } from '../helpers.ts'

const LINKS = { usageUrl: 'https://example/usage', topUpUrl: 'https://example/topup' }
const terminal = (errorCode: SignInAttemptView['errorCode']): AccountView => ({
  status: 'signed-out', links: LINKS,
  attempt: { id: 'attempt' as never, phase: 'failed', ...(errorCode === undefined ? {} : { errorCode }) },
})

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
