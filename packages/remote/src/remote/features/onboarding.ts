/**
 * Once-per-Host-generation first-run onboarding after official capability,
 * settings, credential, and account readiness.
 * @module @ephemeral-ai/mayfly/remote/features/onboarding
 */

import type { RemoteResult, SettingsDescribeValue, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostClient } from '../../client/types.ts'
import type { RemoteAccountSignInFlow } from './account.ts'
import type { RemoteFeatureContext } from './contracts.ts'
import type { RemoteModelsController } from './models.ts'
import {
  RemoteFeatureController,
  RemoteFeatureOperation,
  remoteErrorMessage,
  remoteProperty,
  remoteValue,
} from './official.ts'
import type { MayflySubmission, MayflyUiActionReply } from '@ephemeral-ai/mayfly-ui'
import {
  onboardingLabels, onboardingWizard, ONBOARDING_WIZARD, ONBOARDING_PREFERENCES,
  ONBOARDING_CONNECT, ONBOARDING_READY, ONBOARDING_PREFERENCES_FORM,
  ONBOARDING_PERMISSION_FIELD, ONBOARDING_STARTUP_FIELD, ONBOARDING_CONNECT_LIST,
  ONBOARDING_KEY_FORM, ONBOARDING_KEY_FIELD, ONBOARDING_SIGN_IN,
  type OnboardingFacts,
} from '@ephemeral-ai/mayfly/configuration-panels'
import { openRemoteBrowser, type RemoteBrowserPanel } from '../panels/browser.ts'
import type { RemotePermissionsController } from './permissions.ts'
import type { RemotePreferencesController } from './preferences.ts'
import { remoteProviderCredentialRefs, type RemoteProvidersController } from './providers.ts'
import { REMOTE_LANGUAGES, REMOTE_STARTUPS } from './presentation.ts'
import type { RemoteSettingsController } from './settings.ts'

type AccountView = Awaited<ReturnType<HostClient['remote']['account']['getState']>> extends RemoteResult<infer Value> ? Value : never

type Step = 'preferences' | 'connect' | 'ready'
type Connection = 'pending' | 'account' | 'key' | 'skipped'

interface RemoteOnboardingReadiness {
  readonly settings: SettingsDescribeValue
  readonly account: AccountView
  readonly permissionDefault: string
  readonly permissionOptions: readonly { readonly id: string, readonly label: string }[]
}

/** First-run controller; one attempt is made for each exact HostClient generation. */
export class RemoteOnboardingController extends RemoteFeatureController {
  private readonly attempted = new WeakMap<HostClient, number>()

  constructor(
    context: RemoteFeatureContext,
    private readonly providers: RemoteProvidersController,
    private readonly accounts: {
      createSignInFlow(client: HostClient, changed: () => void): Promise<RemoteAccountSignInFlow | undefined>
    },
    private readonly settings: RemoteSettingsController,
    private readonly permissions: RemotePermissionsController,
    private readonly preferences: RemotePreferencesController,
    private readonly models: RemoteModelsController,
  ) {
    super(context)
  }

  /** Run readiness once after attach; never wait on the legacy loader. */
  async onReady(client: HostClient): Promise<void> {
    const generation = client.state.getSnapshot().generation
    if (this.attempted.get(client) === generation) return
    this.attempted.set(client, generation)
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    try {
      const [live, configurable, settings, account, permission] = await Promise.all([
        remoteValue(client.remote.llm.listProviders()),
        remoteValue(client.remote.llm.listConfigurableProviders()),
        remoteValue(client.remote.settings.describe()),
        remoteValue(client.remote.account.getState()),
        remoteValue(client.remote.permissionPresets.catalog()),
      ])
      if (!operation.valid()) return
      await this.preferences.applyHostPreferences(client)
      if (!operation.valid()) return
      const refs = remoteProviderCredentialRefs({ live, configurable, settings })
      const configured = await this.anyCredentialConfigured(client, refs)
      if (!operation.valid() || configured || account.status === 'credential-stored') return
      this.open(client, {
        settings,
        account,
        permissionDefault: permission.defaultPreset,
        permissionOptions: permission.defaultOptions.map((option: import('./permissions.ts').RemotePermissionCatalog['defaultOptions'][number]) => ({ id: option.value, label: option.name })),
      })
    } catch {
      // A later Host generation gets its own single readiness attempt.
    } finally { operation.dispose() }
  }

  /** Open the guide explicitly, or from the completed readiness gate. */
  open(
    client: HostClient,
    readiness?: RemoteOnboardingReadiness,
  ): void {
    const operation = this.hostOperation(client)
    if (operation === undefined) return
    void this.mount(operation, client, readiness).catch((error: unknown) => {
      if (operation.valid()) this.context.notice.set(remoteErrorMessage(error))
      operation.dispose()
    })
  }

  private async mount(
    operation: RemoteFeatureOperation,
    client: HostClient,
    readiness?: RemoteOnboardingReadiness,
  ): Promise<void> {
    const resolved = readiness ?? await (async () => {
      const [settings, account, permission] = await Promise.all([
        remoteValue(client.remote.settings.describe()),
        remoteValue(client.remote.account.getState()),
        remoteValue(client.remote.permissionPresets.catalog()),
      ])
      return {
        settings,
        account,
        permissionDefault: permission.defaultPreset,
        permissionOptions: permission.defaultOptions.map((option: import('./permissions.ts').RemotePermissionCatalog['defaultOptions'][number]) => ({ id: option.value, label: option.name })),
      }
    })()
    if (!operation.valid()) return
    let step: Step = ONBOARDING_PREFERENCES
    let connection: Connection = 'pending'
    let keyEntry = false
    let flow: RemoteAccountSignInFlow | undefined
    let panel: RemoteBrowserPanel | undefined
    let expiryAttempt: string | undefined
    let expiryTotalMs: number | undefined
    let configuredElsewhere = false
    let languageChosen = false
    let startupChosen = false
    let permissionChosen = false
    const mayfly = resolved.settings.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === 'mayfly')
    const storedStartup = mayfly === undefined ? undefined : remoteProperty(mayfly.value, 'startup')
    const choice = {
      language: this.context.presentation.snapshot.locale,
      theme: this.context.presentation.snapshot.theme,
      startup: typeof storedStartup === 'string' && REMOTE_STARTUPS.includes(storedStartup as typeof REMOTE_STARTUPS[number]) ? storedStartup : REMOTE_STARTUPS[0],
      permission: resolved.permissionDefault,
    }
    const baseline = { ...choice }
    const id = 'mayfly.provider.onboarding'
    const source = [{ resourceId: id, revision: 1 }]
    const pathOf = (itemId: Step) => [{ controlId: ONBOARDING_WIZARD, itemId }]
    const valueOf = (submission: MayflySubmission, formId: string, fieldId: string): unknown =>
      submission.forms.find(form => form.formId === formId)?.fields.find(field => field.id === fieldId)?.value
    const t = this.context.t
    const view = () => {
      const snapshot = flow?.snapshot
      const attempt = snapshot?.view.attempt
      if (attempt?.expiresAt !== undefined && attempt.id !== expiryAttempt) {
        expiryAttempt = attempt.id
        expiryTotalMs = Math.max(0, attempt.expiresAt - Date.now())
      }
      const facts: OnboardingFacts = {
        activeId: step,
        preferences: {
          language: {
            value: baseline.language, theme: baseline.theme, languages: REMOTE_LANGUAGES,
            themes: this.context.presentation.themes.map(theme => ({ id: theme.key, label: theme.name })),
          },
          startup: { value: baseline.startup, options: REMOTE_STARTUPS.map(id => ({ id, label: t(id === 'splash' ? 'Splash' : 'Conversation') })) },
          permissions: resolved.permissionOptions.map(option => ({ ...option, current: option.id === baseline.permission })),
        },
        connect: {
          canSignIn: true, keyEntry,
          ...connection === 'account' ? { connected: 'account' as const } : {},
          ...snapshot === undefined ? {} : { signIn: {
            stage: snapshot.stage === 'idle' ? 'starting' as const : snapshot.stage,
            browser: snapshot.browser, manual: snapshot.manual, delivering: snapshot.delivering,
            ...attempt?.authorizeUrl === undefined ? {} : { url: attempt.authorizeUrl },
            ...attempt?.expiresAt === undefined ? {} : { remainingMs: attempt.expiresAt - Date.now() },
            ...expiryTotalMs === undefined ? {} : { totalMs: expiryTotalMs },
            ...snapshot.callbackPort === undefined ? {} : { callbackPort: snapshot.callbackPort },
            ...snapshot.error === undefined ? {} : { endedText: snapshot.error },
          } },
        },
        summary: [
          ...languageChosen ? [{ text: t('Language: {language} · Theme: {theme}', { language: REMOTE_LANGUAGES.find(item => item.id === choice.language)?.label ?? choice.language, theme: this.context.presentation.themes.find(theme => theme.key === choice.theme)?.name ?? choice.theme }), done: true }] : [],
          ...startupChosen ? [{ text: t('On start: {startup}', { startup: t(choice.startup === 'splash' ? 'Splash' : 'Conversation') }), done: true }] : [],
          connection === 'account' ? { text: t('Connected with a DeepSeek account'), done: true }
            : connection === 'key' ? { text: t('Connected with an API key'), done: true }
              : { text: t('DeepSeek not connected · /provider to connect'), done: false },
          ...permissionChosen ? [{ text: t('Permission preset: {preset}', { preset: resolved.permissionOptions.find(option => option.id === choice.permission)?.label ?? choice.permission }), done: true }] : [],
        ],
      }
      return onboardingWizard(facts, onboardingLabels(t, snapshot?.callbackPort))
    }
    const stay = (): MayflyUiActionReply => ({ kind: 'accepted', node: view(), source })
    const advance = (next: Step): MayflyUiActionReply => {
      step = next
      return { kind: 'accepted', node: view(), source, navigate: pathOf(next) }
    }
    const pickModel = async (provider: string): Promise<void> => {
      if (!operation.valid()) return
      const overlays = this.context.ctx.mayflyOverlays
      let finish = (): void => {}
      const closed = new Promise<void>(resolve => { finish = resolve })
      const off = overlays.subscribe(delta => { if (delta.kind === 'remove' && delta.id === 'mayfly.models') finish() })
      operation.onDispose(finish)
      try {
        await this.models.open('', provider)
        if (operation.valid() && overlays.list().some(entry => entry.id === 'mayfly.models')) await closed
      } finally { off() }
    }
    const finishAccount = async (current: RemoteAccountSignInFlow): Promise<void> => {
      if (!await current.connected || !operation.valid() || flow !== current) return
      connection = 'account'
      panel?.refresh()
      await pickModel('deepseek-account')
      if (!operation.valid() || flow !== current) return
      flow = undefined
      current.dispose()
      step = ONBOARDING_READY
      panel?.refresh()
    }
    const startAccount = async (): Promise<MayflyUiActionReply> => {
      const current = await this.accounts.createSignInFlow(client, () => { panel?.refresh() })
      if (current === undefined || !operation.valid()) { current?.dispose(); return { kind: 'cancelled' } }
      flow = current
      void finishAccount(current)
      void current.start().catch((error: unknown) => {
        if (operation.valid() && flow === current) this.context.notice.set(remoteErrorMessage(error))
      })
      return stay()
    }
    const settlePreferences = async (submission: MayflySubmission): Promise<MayflyUiActionReply> => {
      const language = valueOf(submission, ONBOARDING_PREFERENCES_FORM, 'language')
      const theme = valueOf(submission, ONBOARDING_PREFERENCES_FORM, 'theme')
      const startup = valueOf(submission, ONBOARDING_PREFERENCES_FORM, ONBOARDING_STARTUP_FIELD)
      const permission = valueOf(submission, ONBOARDING_PREFERENCES_FORM, ONBOARDING_PERMISSION_FIELD)
      if (typeof language !== 'string' || !REMOTE_LANGUAGES.some(option => option.id === language)
        || typeof theme !== 'string' || !this.context.presentation.themes.some(option => option.key === theme)) return { kind: 'failed', message: t('Choose a language and a theme') }
      if (typeof startup !== 'string' || !REMOTE_STARTUPS.some(option => option === startup)) return { kind: 'failed', message: t('Choose what to show on start') }
      if (typeof permission !== 'string' || !resolved.permissionOptions.some(option => option.id === permission)) return { kind: 'failed', message: t('permission command is unavailable') }
      choice.language = language
      choice.theme = theme
      choice.startup = startup
      choice.permission = permission
      await this.preferences.applyLocale(client, language, operation.signal)
      if (!operation.valid()) return { kind: 'cancelled' }
      await this.preferences.applyTheme(client, theme, operation.signal)
      if (!operation.valid()) return { kind: 'cancelled' }
      await this.preferences.persistMayfly(client, [{ op: 'set', path: ['theme'], value: theme }], operation.signal)
      if (!operation.valid()) return { kind: 'cancelled' }
      await this.preferences.persistMayfly(client, [{ op: 'set', path: ['startup'], value: startup }], operation.signal)
      if (!operation.valid()) return { kind: 'cancelled' }
      const descriptor = resolved.settings.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === 'permission')
      if (descriptor !== undefined && permission !== resolved.permissionDefault) {
        const revision = this.settings.revision(descriptor, resolved.settings.writable)
        await this.settings.mutate(client, 'permission', [{ op: 'set', path: ['defaultPreset'], value: permission }], revision)
      }
      if (!operation.valid()) return { kind: 'cancelled' }
      const current = this.context.hosts.current()
      if (current?.client === client) await this.permissions.select(current.ref, permission)
      if (!operation.valid()) return { kind: 'cancelled' }
      Object.assign(baseline, choice)
      languageChosen = startupChosen = permissionChosen = true
      return advance(ONBOARDING_CONNECT)
    }
    const settleConnect = async (submission: MayflySubmission): Promise<MayflyUiActionReply> => {
      if (keyEntry) {
        const key = valueOf(submission, ONBOARDING_KEY_FORM, ONBOARDING_KEY_FIELD)
        if ((key === '' || key === undefined) && connection === 'key') return advance(ONBOARDING_READY)
        if (typeof key !== 'string' || key.length === 0) return { kind: 'invalid', errors: [{ pagePath: pathOf(ONBOARDING_CONNECT), formId: ONBOARDING_KEY_FORM, fieldId: ONBOARDING_KEY_FIELD, message: t('A value is required') }] }
        const credentials = await remoteValue(client.remote.credentials.describe(['DEEPSEEK_API_KEY']))
        if (!operation.valid()) return { kind: 'cancelled' }
        if (credentials.DEEPSEEK_API_KEY?.configured === true && !configuredElsewhere) {
          configuredElsewhere = true
          return { kind: 'conflict', node: view(), source, message: t('A credential was configured elsewhere; review before replacing it') }
        }
        await this.providers.setCredential(client, 'DEEPSEEK_API_KEY', key, configuredElsewhere)
        if (!operation.valid()) return { kind: 'cancelled' }
        connection = 'key'
        await pickModel('deepseek-official')
        return operation.valid() ? advance(ONBOARDING_READY) : { kind: 'cancelled' }
      }
      const answer = submission.selections?.find(item => item.controlId === ONBOARDING_CONNECT_LIST)?.selectedIds[0]
      if (answer === 'key') { keyEntry = true; return stay() }
      if (answer === 'account') return await startAccount()
      if (answer === 'skip') { connection = 'skipped'; return advance(ONBOARDING_READY) }
      return stay()
    }
    let changes: Promise<void> = Promise.resolve()
    panel = openRemoteBrowser(this.context, {
      id, scope: { kind: 'app', targetId: 'DEEPSEEK_API_KEY' }, signal: operation.signal,
      isCurrent: () => operation.valid(), view,
      observe: event => {
        if (event.kind !== 'value-change' || event.formId !== ONBOARDING_PREFERENCES_FORM) return
        if (event.controlId === 'language' && REMOTE_LANGUAGES.some(option => option.id === event.value)) choice.language = String(event.value)
        else if (event.controlId === 'theme' && this.context.presentation.themes.some(option => option.key === event.value)) choice.theme = String(event.value)
        else return
        const next = { ...choice }
        changes = changes.then(async () => {
          if (!operation.valid()) return
          await this.preferences.applyLocale(client, next.language, operation.signal)
          if (!operation.valid()) return
          await this.preferences.applyTheme(client, next.theme, operation.signal)
          if (!operation.valid()) return
          await this.preferences.persistMayfly(client, [{ op: 'set', path: ['theme'], value: next.theme }], operation.signal)
          if (operation.valid()) panel?.refresh()
        }).catch((error: unknown) => { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error)) })
      },
      back: () => {
        if (!keyEntry && flow === undefined) return false
        keyEntry = false
        const current = flow
        flow = undefined
        if (current !== undefined) void current.cancel().catch(() => {}).finally(() => current.dispose())
        panel?.refresh()
        return true
      },
      action: async (event, context): Promise<MayflyUiActionReply> => {
        if (context.signal.aborted) return { kind: 'cancelled' }
        try {
          if (event.kind === 'activate' && flow !== undefined) {
            if (event.actionId === ONBOARDING_SIGN_IN.copy) {
              await flow.copy()
              return operation.valid() ? { kind: 'completed', feedback: { severity: 'success', message: t('Sign-in link copied') } } : { kind: 'cancelled' }
            }
            if (event.actionId === ONBOARDING_SIGN_IN.other) flow.setManual(true)
            else if (event.actionId === ONBOARDING_SIGN_IN.restart || event.actionId === ONBOARDING_SIGN_IN.retry) await flow.restart()
            return { kind: 'completed' }
          }
          if (event.kind !== 'submit') return { kind: 'completed' }
          if (event.submission.actionId === ONBOARDING_SIGN_IN.deliver && flow !== undefined) {
            const raw = valueOf(event.submission, ONBOARDING_SIGN_IN.form, ONBOARDING_SIGN_IN.field)
            const result = await flow.deliver(typeof raw === 'string' ? raw : '')
            if (!operation.valid()) return { kind: 'cancelled' }
            if (result === 'invalid') return { kind: 'invalid', errors: [{ pagePath: ONBOARDING_SIGN_IN.pagePath, formId: ONBOARDING_SIGN_IN.form, fieldId: ONBOARDING_SIGN_IN.field, message: t('Paste the full callback address from the browser address bar') }] }
            if (result === 'rejected') return { kind: 'failed', message: t('The pasted link was not accepted — copy the full address bar URL and try again') }
            return stay()
          }
          await changes
          if (!operation.valid()) return { kind: 'cancelled' }
          const stepId = event.pagePath[0]?.itemId
          if (stepId === ONBOARDING_PREFERENCES) return await settlePreferences(event.submission)
          if (stepId === ONBOARDING_CONNECT) return await settleConnect(event.submission)
          return { kind: 'accepted', node: view(), source, dismiss: true }
        } catch (error) {
          return operation.valid() ? { kind: 'failed', message: remoteErrorMessage(error, event.kind === 'submit' ? event.submission.forms.flatMap(form => form.fields.filter(field => field.id === ONBOARDING_KEY_FIELD).map(field => typeof field.value === 'string' ? field.value : '')) : []) } : { kind: 'cancelled' }
        }
      },
      onClosed: () => operation.dispose(),
    })
    const timer = setInterval(() => { if (operation.valid() && flow?.snapshot.stage === 'waiting') panel?.refresh() }, 1000)
    operation.onDispose(() => { clearInterval(timer); flow?.dispose(); panel?.close() })
  }

  private async anyCredentialConfigured(client: HostClient, refs: readonly string[]): Promise<boolean> {
    for (let offset = 0; offset < refs.length; offset += 64) {
      const batch = refs.slice(offset, offset + 64)
      const views = await remoteValue(client.remote.credentials.describe(batch))
      if (batch.some(ref => views[ref]?.configured === true)) return true
    }
    return false
  }
}
