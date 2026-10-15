/**
 * A stand-in for the Harness `deepseekAccount` service in a scenario with an `account` field: the platform service is
 * disabled and this plugin provides a service that answers from memory, signed in (a profile, a recharge wallet, a bonus
 * wallet) or signed out, so the Account tab of /stats can be seen without a DeepSeek login or a network.
 * `MAYFLY_FAKE_ACCOUNT` picks `in`, `out`, or `flow` (signed out, then one sign-in walks its phases on timers). Loaded by `dsh --patch` like the replay driver. @module script/scenarios/fake-account
 */

export const name = 'mayfly-scenario-account'

const LINKS = { usageUrl: 'https://platform.example.test/usage', topUpUrl: 'https://platform.example.test/top_up' }

export function apply(ctx) {
  const mode = process.env.MAYFLY_FAKE_ACCOUNT
  /* `flow` starts signed out and walks one sign-in through its phases on timers; `in` and `out` are fixed */
  const flow = mode === 'flow'
  let signedIn = mode === 'in'
  let attempt = null
  const listeners = new Set()
  const view = () => ({ status: signedIn ? 'credential-stored' : 'signed-out', links: LINKS, attempt })
  const publish = () => { for (const listener of listeners) listener(view()) }
  const phase = (next, extra = {}) => { attempt = { ...attempt, phase: next, ...extra }; if (next === 'succeeded') signedIn = true; publish() }
  const step = Number(process.env.MAYFLY_FAKE_ACCOUNT_STEP_MS ?? 1500)
  const unsupported = async () => { throw new Error('the scenario account is read-only') }
  const startSignIn = async () => {
    /* like the platform service: the attempt comes back initializing, and the link follows a moment later */
    attempt = { id: 'attempt-1', phase: 'initializing' }
    publish()
    setTimeout(() => phase('waiting-browser', { authorizeUrl: 'https://platform.example.test/oauth/authorize?client_id=mayfly&state=7f3a9c', expiresAt: Date.now() + 5 * 60_000 }), step / 3)
    setTimeout(() => phase('exchanging'), step * 4)
    setTimeout(() => phase('committing'), step * 5)
    setTimeout(() => phase('succeeded'), step * 6)
    return view()
  }
  ctx.provide('deepseekAccount', {
    getState: async () => view(),
    getProfile: async () => ({ status: 'ready', value: { id: null, name: 'Li Wei', contact: 'l***@example.com' } }),
    getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '100.00' }], bonusWallets: [{ currency: 'CNY', balance: '10.00' }] }),
    async * watch() {
      yield view()
      let wake
      const listener = () => wake?.()
      listeners.add(listener)
      try { for (;;) { await new Promise(resolve => { wake = resolve }); yield view() } } finally { listeners.delete(listener) }
    },
    getUnnotifiedBonuses: async () => null,
    ackBonusNotified: async () => false,
    startSignIn: flow ? startSignIn : unsupported,
    cancelSignIn: flow ? async () => { phase('cancelled') } : unsupported,
    signOut: unsupported,
    resolveToken: async () => undefined, rejectToken: async () => {},
    getPlatformSession: async () => null, getDeviceIdentity: async () => ({ osVersion: 'scenario' }),
  })
}
