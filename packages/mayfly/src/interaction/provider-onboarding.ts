/** First-run connection guide owned by the frontend and triggered by app readiness.
 *
 * When no credential is configured and no DeepSeek account grant is stored,
 * the guide offers the two supported paths: signing in with a DeepSeek
 * account (browser PKCE through the account panel — no API key needed) or
 * pasting a DeepSeek API key.
 *
 * @module @ephemeral-ai/mayfly/interaction/provider-onboarding
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '../app/index.ts'
import { ui } from '@ephemeral-ai/mayfly-ui'
import { deriveKeyRef } from './provider-profile.ts'
import { ACCOUNT_SETTINGS_NS, openAccountPanel } from './provider-account.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { interactionTranslator } from './locale.ts'

export const DEEPSEEK_KEY = 'DEEPSEEK_API_KEY'
export const name = 'mayfly-provider-onboarding'
export const inject = ['credentials', 'mayflyOverlays']

function credentialRefs(ctx: Context): string[] {
  const refs = new Set([DEEPSEEK_KEY])
  for (const provider of ctx.get('llm')?.listProviders() ?? []) refs.add(deriveKeyRef(provider.id))
  const section = ctx.get('settings')?.describe().find(item => String(item.ns) === 'llm-pi-ai')?.value
  const providers = section !== null && typeof section === 'object' ? (section as { readonly providers?: unknown }).providers : undefined
  if (providers !== null && typeof providers === 'object') for (const profile of Object.values(providers)) {
    const ref = profile !== null && typeof profile === 'object' ? (profile as { readonly apiKeyEnv?: unknown }).apiKeyEnv : undefined
    if (typeof ref === 'string' && ref.length > 0) refs.add(ref)
  }
  return [...refs]
}

/** The account adapter's provider route, when the composition carries it. */
function accountRoute(ctx: Context): string | undefined {
  return ctx.get('llm')?.listConfigurableProviders().find(item => item.settingsNs === ACCOUNT_SETTINGS_NS)?.provider
}

/** Whether a stored account grant already connects the user. */
async function accountConnected(ctx: Context): Promise<boolean> {
  const service = ctx.get('deepseekAccount')
  if (service === undefined) return false
  try { return (await service.getState()).status === 'credential-stored' } catch { return false }
}

/** The choice view: sign in with a DeepSeek account or enter an API key. */
export function onboardingChoiceNode(t: (key: string) => string, canSignIn: boolean): ReturnType<typeof ui.stack.column> {
  return ui.stack.column([
    ui.text(t('Connect with a DeepSeek account — no API key needed — or paste a DeepSeek API key.'), { tone: 'muted' }),
    ui.actions({ id: 'onboarding-choice', items: [
      ...(canSignIn ? [{ id: 'sign-in', label: t('Sign in with a DeepSeek account'), intent: 'primary' as const }] : []),
      { id: 'use-key', label: t('Enter a DeepSeek API key'), ...(canSignIn ? {} : { intent: 'primary' as const }) },
      { id: 'close', label: t('Close'), dismiss: true },
    ] }),
  ])
}

/** The API key view with a way back to the choice. */
export function onboardingKeyNode(t: (key: string) => string): ReturnType<typeof ui.stack.column> {
  return ui.stack.column([
    ui.form({ id: 'onboarding', enterSubmits: 'save', fields: [{ kind: 'secret', id: 'key', label: DEEPSEEK_KEY, value: '', required: true }] }),
    ui.actions({ id: 'onboarding-actions', items: [
      { id: 'save', label: t('Save'), submit: [{ pagePath: [], formId: 'onboarding' }] },
      { id: 'back', label: t('Back') },
      { id: 'cancel', label: t('Cancel'), dismiss: true },
    ] }),
  ])
}

export function apply(ctx: Context): void {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  let attempted = false
  const check = async (): Promise<void> => {
    if (attempted) return
    attempted = true
    await ctx.get('loader')?.await()
    if (lifetime.signal.aborted) return
    const credentials = ctx.credentials
    const configured = await Promise.all(credentialRefs(ctx).map(async ref => {
      try { return (await credentials.describe(credentialRef(ref))).configured } catch { return false }
    }))
    if (lifetime.signal.aborted || configured.some(Boolean) || await accountConnected(ctx)) return
    const t = interactionTranslator(ctx)
    let observedConfigured = false
    const discoveredRoute = accountRoute(ctx)
    const signInRoute = discoveredRoute !== undefined && ctx.get('deepseekAccount') !== undefined ? discoveredRoute : undefined
    /** Stable snapshot stamp: view switches inside the guide confirm the same snapshot. */
    const stamp = [{ resourceId: 'provider-onboarding', revision: 0 }]
    const choiceNode = () => onboardingChoiceNode(t, signInRoute !== undefined)
    const keyNode = () => onboardingKeyNode(t)
    /** Open (or refocus) the guide on one view; account exits reopen it here. */
    const open = (view: 'choice' | 'key'): void => {
      openUiOverlay(ctx, {
        id: 'mayfly.provider.onboarding', title: t('Connect to DeepSeek'), presentation: 'editor', capturing: true,
        scope: { kind: 'app', targetId: DEEPSEEK_KEY }, source: stamp,
        onEvent: { action: async (event, context) => {
          if (event.kind === 'activate' && event.actionId === 'sign-in' && signInRoute !== undefined) {
            const opened = await openAccountPanel(ctx, signInRoute, lifetime.signal, { onBack: () => open('choice'), onUseKey: () => open('key') })
            /* v8 ignore next -- the guide only offers sign-in after the same service and route check */
            if (!opened) return { kind: 'failed', message: t('Account sign-in is unavailable') }
            return { kind: 'completed', dismiss: true }
          }
          if (event.kind === 'activate' && event.actionId === 'use-key') {
            return { kind: 'accepted', node: keyNode(), source: stamp }
          }
          if (event.kind === 'activate' && event.actionId === 'back') {
            return { kind: 'accepted', node: choiceNode(), source: stamp }
          }
          if (event.kind !== 'submit') return { kind: 'completed' }
          const value = event.submission.forms[0]?.fields.find(field => field.id === 'key')?.value
          if (typeof value !== 'string' || value.length === 0) return { kind: 'invalid', errors: [{ pagePath: [], formId: 'onboarding', fieldId: 'key', message: t('A value is required') }] }
          try {
            const info = await credentials.describe(credentialRef(DEEPSEEK_KEY))
            if (context.signal.aborted) return { kind: 'cancelled' }
            if (!info.writable) return { kind: 'failed', message: t('The credential source is read-only') }
            if (info.configured && !observedConfigured) {
              observedConfigured = true
              return { kind: 'conflict', node: keyNode(), source: [], message: t('A credential was configured elsewhere; review before replacing it') }
            }
            await credentials.set(credentialRef(DEEPSEEK_KEY), value)
            if (context.signal.aborted) return { kind: 'cancelled' }
            return { kind: 'accepted', node: keyNode(), source: [], dismiss: true, feedback: { severity: 'success', message: t('DeepSeek API key saved') } }
          } catch { return { kind: 'failed', message: t('The API key could not be saved') } }
        } },
      }, view === 'key' ? keyNode() : choiceNode(), { signal: lifetime.signal, reopen: 'focus' })
    }
    open('choice')
  }
  ctx.plugin({
    name: 'mayfly-onboarding-readiness', inject: ['mayflyCurrentAgent'],
    apply(reader: Context) {
      const off = reader.mayflyCurrentAgent.subscribe(agent => {
        if (agent === null) return
        void check().catch(() => {
          if (lifetime.signal.aborted || ctx.mayflyOverlays.focus('mayfly.provider.onboarding')) return
          const t = interactionTranslator(ctx)
          openUiOverlay(ctx, { id: 'mayfly.provider.onboarding', title: t('Provider setup'), presentation: 'editor', capturing: true, scope: { kind: 'app', targetId: DEEPSEEK_KEY } }, ui.empty({ title: t('Provider setup could not be checked'), actions: ui.actions({ id: 'setup-error-actions', items: [{ id: 'close', label: t('Close'), dismiss: true }] }) }), { signal: lifetime.signal, reopen: 'focus' })
        })
      })
      reader.effect(() => off)
    },
  })
}
