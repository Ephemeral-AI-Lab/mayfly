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
import { openRemoteFeaturePanel, type RemoteMountedPanel, type RemotePanelModel } from './panel.ts'
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
  private readonly attempted = new WeakSet<HostClient>()

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
    if (this.attempted.has(client)) return
    this.attempted.add(client)
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
    let step: Step = 'preferences'
    let connection: Connection = 'pending'
    let keyEntry = false
    let flow: RemoteAccountSignInFlow | undefined
    let mounted: RemoteMountedPanel | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    let startup: string = REMOTE_STARTUPS[0]
    const mayfly = resolved.settings.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === 'mayfly')
    const storedStartup = mayfly === undefined ? undefined : remoteProperty(mayfly.value, 'startup')
    if (typeof storedStartup === 'string' && REMOTE_STARTUPS.includes(storedStartup as typeof REMOTE_STARTUPS[number])) startup = storedStartup
    let permission = resolved.permissionDefault
    let summary = ''
    const view = (): RemotePanelModel => {
      if (step === 'preferences') {
        return {
          title: this.context.t('Connect to DeepSeek'),
          subtitle: this.context.t('Preferences'),
          fields: [
            { id: 'language', label: this.context.t('Language'), kind: 'select', value: this.context.presentation.snapshot.locale, options: REMOTE_LANGUAGES.map(option => ({ id: option.id, label: option.label })) },
            { id: 'theme', label: this.context.t('Theme'), kind: 'select', value: this.context.presentation.snapshot.theme, options: this.context.presentation.themes.map(option => ({ id: option.key, label: option.name })) },
            { id: 'startup', label: this.context.t('On start'), kind: 'select', value: startup, options: REMOTE_STARTUPS.map(id => ({ id, label: this.context.t(id === 'splash' ? 'Splash' : 'Conversation') })) },
            { id: 'permission', label: this.context.t('Permissions'), kind: 'select', value: permission, options: resolved.permissionOptions },
          ],
          hint: 'Enter last field continue · Esc close',
        }
      }
      if (step === 'connect' && flow !== undefined) {
        const snapshot = flow.snapshot
        const manual = snapshot.manual || snapshot.browser === 'failed'
        return {
          title: this.context.t('DeepSeek Account'),
          subtitle: snapshot.error ?? this.context.t('Waiting for you to sign in in your browser'),
          rows: manual ? undefined : [
            { id: 'copy-link', text: this.context.t('Copy link') },
            { id: 'manual', text: this.context.t('Other machine') },
            { id: 'restart-sign-in', text: this.context.t('New link') },
            { id: 'cancel-sign-in', text: this.context.t('Cancel') },
          ],
          fields: manual ? [{ id: 'callback', label: this.context.t('Callback URL'), kind: 'input', placeholder: 'http://localhost:…/oauth/callback?…' }] : undefined,
          footer: snapshot.view.attempt?.authorizeUrl !== undefined && manual ? snapshot.view.attempt.authorizeUrl : undefined,
          hint: manual ? 'Enter callback · Ctrl+R deliver · Esc close (does not cancel sign-in)' : 'Esc close (does not cancel sign-in)',
        }
      }
      if (step === 'connect' && keyEntry) {
        return {
          title: this.context.t('Enter a DeepSeek API key'),
          subtitle: this.context.t('Your key is saved as a credential, not as a setting.'),
          fields: [{ id: 'key', label: 'DEEPSEEK_API_KEY', kind: 'secret', placeholder: this.context.t('paste your key') }],
          hint: 'Enter save · Esc close',
        }
      }
      if (step === 'connect') {
        return {
          title: this.context.t('Connect to DeepSeek'),
          subtitle: this.context.t('Mayfly needs a DeepSeek connection to start.'),
          rows: [
            { id: 'account', text: this.context.t('Sign in with a DeepSeek account'), detail: this.context.t('recommended') },
            { id: 'key', text: this.context.t('Enter a DeepSeek API key') },
            { id: 'skip', text: this.context.t('Skip for now') },
          ],
        }
      }
      return {
        title: this.context.t('Welcome'),
        subtitle: summary,
        rows: [{ id: 'start', text: this.context.t('Start chatting') }],
        footer: connection === 'pending' || connection === 'skipped' ? this.context.t('DeepSeek not connected · /provider to connect') : undefined,
      }
    }
    const repaint = (): void => { mounted?.panel.update(view()) }
    const finishConnection = (kind: Connection): void => {
      connection = kind
      summary = kind === 'account' ? this.context.t('Connected with a DeepSeek account') : this.context.t('Connected with an API key')
      step = 'ready'
      flow?.dispose()
      flow = undefined
      repaint()
      if (this.context.hosts.current()?.client === client) void this.models.open()
    }
    const startAccount = async (): Promise<void> => {
      flow = await this.accounts.createSignInFlow(client, repaint)
      if (flow === undefined) return
      flow.onDispose(() => { if (timer !== undefined) clearInterval(timer) })
      timer = setInterval(repaint, 1000)
      repaint()
      void flow.start().catch((error: unknown) => {
        if (flow !== undefined) this.context.notice.set(remoteErrorMessage(error))
        repaint()
      })
      void flow.connected.then(connected => { if (connected && flow !== undefined) finishConnection('account') })
    }
    const saveKey = async (value: string): Promise<void> => {
      if (value === '') throw new Error(this.context.t('A value is required'))
      await this.providers.setCredential(client, 'DEEPSEEK_API_KEY', value)
      if (operation.valid()) finishConnection('key')
    }
    const settlePreferences = async (values: Readonly<Record<string, string>>): Promise<void> => {
      const language = values.language ?? 'en'
      const theme = values.theme ?? 'dark'
      startup = values.startup ?? startup
      permission = values.permission ?? permission
      await this.preferences.applyLocale(client, language)
      await this.preferences.applyTheme(client, theme)
      await this.preferences.persistMayfly(client, [{ op: 'set', path: ['startup'], value: startup }])
      const settings = await remoteValue(client.remote.settings.describe())
      const descriptor = settings.namespaces.find((candidate: SettingsNamespaceView) => candidate.ns === 'permission')
      if (descriptor !== undefined && permission !== '') {
        const revision = this.settings.revision(descriptor, settings.writable)
        await this.settings.mutate(client, 'permission', [{ op: 'set', path: ['defaultPreset'], value: permission }], revision)
        const current = this.context.hosts.current()
        if (current?.client === client) await this.permissions.select(current.ref, permission)
      }
      if (!operation.valid()) return
      step = 'connect'
      repaint()
    }
    mounted = openRemoteFeaturePanel(this.context, view(), (action, id, values) => {
      if (!operation.valid()) { mounted?.lease.close(); return }
      if (step === 'preferences' && action === 'submit') void settlePreferences(values).catch((error: unknown) => { if (operation.valid()) this.context.notice.set(remoteErrorMessage(error, [values.key ?? ''])) })
      else if (step === 'connect' && flow !== undefined) {
        if (action === 'accept' && id === 'copy-link' || action === 'copy') void flow.copy().then(() => this.context.notice.set(this.context.t('Sign-in link copied'))).catch((error: unknown) => this.context.notice.set(remoteErrorMessage(error)))
        else if (action === 'accept' && id === 'manual' || action === 'manual') { flow.setManual(true); repaint() }
        else if (action === 'accept' && id === 'restart-sign-in') void flow.restart().catch((error: unknown) => this.context.notice.set(remoteErrorMessage(error)))
        else if (action === 'accept' && id === 'cancel-sign-in') void flow.cancel().catch((error: unknown) => this.context.notice.set(remoteErrorMessage(error)))
        else if (action === 'submit' || action === 'refresh') void flow.deliver(values.callback ?? '').then(result => {
          if (result !== 'delivered') throw new Error(this.context.t('The callback could not be delivered'))
        }).catch((error: unknown) => this.context.notice.set(remoteErrorMessage(error)))
      } else if (step === 'connect' && keyEntry && action === 'submit') void saveKey(values.key ?? '').catch((error: unknown) => {
        if (operation.valid()) this.context.notice.set(remoteErrorMessage(error, [values.key ?? '']))
      })
      else if (step === 'connect' && action === 'accept' && id === 'account') void startAccount()
      else if (step === 'connect' && action === 'accept' && id === 'key') { keyEntry = true; repaint() }
      else if (step === 'connect' && action === 'accept' && id === 'skip') { connection = 'skipped'; step = 'ready'; repaint() }
      else if (step === 'ready' && action === 'accept' && id === 'start') mounted?.lease.close()
    }, () => {
      if (timer !== undefined) clearInterval(timer)
      flow?.dispose()
      operation.dispose()
    })
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
