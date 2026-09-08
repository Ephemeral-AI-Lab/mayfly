/** First-run credential setup owned by the frontend and triggered by app readiness.
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
import { openUiOverlay } from './ui-overlay.ts'
import { interactionTranslator } from './locale.ts'

export const DEEPSEEK_KEY = 'DEEPSEEK_API_KEY'
export const name = 'mayfly-provider-onboarding'
export const inject = ['credentials', 'mayflyOverlays']

function credentialRefs(ctx: Context): string[] {
  const refs = new Set([DEEPSEEK_KEY])
  for (const provider of ctx.get('llm')?.listProviders() ?? []) refs.add(deriveKeyRef(provider.id))
  const section = ctx.get('settings')?.get('llm-pi-ai')
  const providers = section !== null && typeof section === 'object' ? (section as { readonly providers?: unknown }).providers : undefined
  if (providers !== null && typeof providers === 'object') for (const profile of Object.values(providers)) {
    const ref = profile !== null && typeof profile === 'object' ? (profile as { readonly apiKeyEnv?: unknown }).apiKeyEnv : undefined
    if (typeof ref === 'string' && ref.length > 0) refs.add(ref)
  }
  return [...refs]
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
    if (lifetime.signal.aborted || configured.some(Boolean)) return
    const t = interactionTranslator(ctx)
    let observedConfigured = false
    const node = () => ui.stack.column([
      ui.form({ id: 'onboarding', fields: [{ kind: 'secret', id: 'key', label: DEEPSEEK_KEY, value: '', required: true }] }),
      ui.actions({ id: 'onboarding-actions', items: [
        { id: 'save', label: t('Save'), submit: [{ pagePath: [], formId: 'onboarding' }] },
        { id: 'cancel', label: t('Cancel'), dismiss: true },
      ] }),
    ])
    openUiOverlay(ctx, {
      id: 'mayfly.provider.onboarding', title: t('Connect to DeepSeek'), presentation: 'editor', capturing: true,
      scope: { kind: 'app', targetId: DEEPSEEK_KEY },
      onEvent: { action: async (event, context) => {
        if (event.kind !== 'submit') return { kind: 'completed' }
        const value = event.submission.forms[0]?.fields.find(field => field.id === 'key')?.value
        if (typeof value !== 'string' || value.length === 0) return { kind: 'invalid', errors: [{ pagePath: [], formId: 'onboarding', fieldId: 'key', message: t('A value is required') }] }
        try {
          const info = await credentials.describe(credentialRef(DEEPSEEK_KEY))
          if (context.signal.aborted) return { kind: 'cancelled' }
          if (!info.writable) return { kind: 'failed', message: t('The credential source is read-only') }
          if (info.configured && !observedConfigured) {
            observedConfigured = true
            return { kind: 'conflict', node: node(), source: [], message: t('A credential was configured elsewhere; review before replacing it') }
          }
          await credentials.set(credentialRef(DEEPSEEK_KEY), value)
          if (context.signal.aborted) return { kind: 'cancelled' }
          return { kind: 'accepted', node: node(), source: [], dismiss: true, feedback: { severity: 'success', message: t('DeepSeek API key saved') } }
        } catch { return { kind: 'failed', message: t('The API key could not be saved') } }
      } },
    }, node(), lifetime.signal)
  }
  ctx.plugin({
    name: 'mayfly-onboarding-readiness', inject: ['mayflyCurrentAgent'],
    apply(reader: Context) {
      const off = reader.mayflyCurrentAgent.subscribe(agent => {
        if (agent === null) return
        void check().catch(() => {
          if (lifetime.signal.aborted || ctx.mayflyOverlays.focus('mayfly.provider.onboarding')) return
          const t = interactionTranslator(ctx)
          openUiOverlay(ctx, { id: 'mayfly.provider.onboarding', title: t('Provider setup'), presentation: 'editor', capturing: true, scope: { kind: 'app', targetId: DEEPSEEK_KEY } }, ui.empty({ title: t('Provider setup could not be checked'), actions: ui.actions({ id: 'setup-error-actions', items: [{ id: 'close', label: t('Close'), dismiss: true }] }) }), lifetime.signal)
        })
      })
      reader.effect(() => off)
    },
  })
}
