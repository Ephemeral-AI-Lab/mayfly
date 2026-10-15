/**
 * A stand-in for the Harness `deepseekAccount` service in a scenario with an `account` field: the platform service is
 * disabled and this plugin provides a service that answers from memory, signed in (a profile, a recharge wallet, a bonus
 * wallet) or signed out, so the Account tab of /stats can be seen without a DeepSeek login or a network.
 * `MAYFLY_FAKE_ACCOUNT` picks `in` or `out`. Loaded by `dsh --patch` like the replay driver. @module script/scenarios/fake-account
 */

export const name = 'mayfly-scenario-account'

const LINKS = { usageUrl: 'https://platform.example.test/usage', topUpUrl: 'https://platform.example.test/top_up' }

export function apply(ctx) {
  const signedIn = process.env.MAYFLY_FAKE_ACCOUNT === 'in'
  const view = () => ({ status: signedIn ? 'credential-stored' : 'signed-out', links: LINKS, attempt: null })
  const unsupported = async () => { throw new Error('the scenario account is read-only') }
  ctx.provide('deepseekAccount', {
    getState: async () => view(),
    getProfile: async () => ({ status: 'ready', value: { id: null, name: 'Li Wei', contact: 'l***@example.com' } }),
    getBalance: async () => ({ status: 'ready', value: [{ currency: 'CNY', balance: '100.00' }], bonusWallets: [{ currency: 'CNY', balance: '10.00' }] }),
    async * watch() { yield view() },
    getUnnotifiedBonuses: async () => null,
    ackBonusNotified: async () => false,
    startSignIn: unsupported, cancelSignIn: unsupported, signOut: unsupported,
    resolveToken: async () => undefined, rejectToken: async () => {},
    getPlatformSession: async () => null, getDeviceIdentity: async () => ({ osVersion: 'scenario' }),
  })
}
