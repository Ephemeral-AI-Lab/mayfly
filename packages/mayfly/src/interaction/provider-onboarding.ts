/** First-run guide owned by the frontend and triggered by app readiness.
 *
 * When no credential is configured and no DeepSeek account grant is stored, the guide opens as a wizard
 * (`components/onboarding-wizard.ts`): Language (only while none is stored), Connect (a DeepSeek account through the
 * account panel, or a pasted API key), Permissions (the native presets) and Ready. Each step writes its answer as it is
 * given; connecting ends on the model list of the provider just connected once the guide closes.
 *
 * @module @ephemeral-ai/mayfly/interaction/provider-onboarding
 */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '../app/index.ts'
import { ui, type MayflyPagePath, type MayflySourceStamp, type MayflyUiActionReply, type MayflySubmission, type MayflyUiObservationEvent } from '@ephemeral-ai/mayfly-ui'
import {
  ONBOARDING_CONNECT, ONBOARDING_CONNECT_LIST, ONBOARDING_KEY_FIELD, ONBOARDING_KEY_FORM, ONBOARDING_PERMISSION_FIELD,
  ONBOARDING_PREFERENCES, ONBOARDING_PREFERENCES_FORM, ONBOARDING_READY, ONBOARDING_SIGN_IN, ONBOARDING_WIZARD, onboardingWizard,
  type OnboardingConnectChoice, type OnboardingFacts, type OnboardingLabels, type OnboardingPresetRow, type OnboardingStepId,
} from '../components/onboarding-wizard.ts'
import { deriveKeyRef } from './provider-profile.ts'
import { ACCOUNT_SETTINGS_NS } from './provider-account.ts'
import { startSignIn, type SignInEnd, type SignInFlow, type SignInSnapshot } from './account-sign-in.ts'
import { openModelPicker } from './model-commands.ts'
import { openUiOverlay } from './ui-overlay.ts'
import { LANGUAGES, THEMES, commitLanguage, initialChoice } from './onboarding-language.ts'
import { themeLabel, themeName } from './theme-names.ts'
import type { PermissionPresetsService } from './permission-panel.ts'
import { interactionTranslator } from './locale.ts'

export const DEEPSEEK_KEY = 'DEEPSEEK_API_KEY'
/** The provider route that reads `DEEPSEEK_API_KEY`. */
const DEEPSEEK_KEY_ROUTE = 'deepseek-official'
export const name = 'mayfly-provider-onboarding'
export const inject = ['credentials', 'mayflyOverlays', 'mayflyInteractionState']

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

const pathOf = (stepId: OnboardingStepId): MayflyPagePath => [{ controlId: ONBOARDING_WIZARD, itemId: stepId }]

/** The value a submission carries for one form field. */
function fieldValue(submission: MayflySubmission, formId: string, fieldId: string): unknown {
  return submission.forms.find(form => form.formId === formId)?.fields.find(field => field.id === fieldId)?.value
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
    const discoveredRoute = accountRoute(ctx)
    const signInRoute = discoveredRoute !== undefined && ctx.get('deepseekAccount') !== undefined ? discoveredRoute : undefined
    /** Stable snapshot stamp: the guide's republishes confirm the same snapshot. */
    const stamp: readonly MayflySourceStamp[] = [{ resourceId: 'provider-onboarding', revision: 0 }]
    const commands = ctx.get('commands')
    /* the permission field needs both the preset table and the command runtime; without them the first step has the language and theme only */
    const presets = commands === undefined ? undefined : ctx.get('permissionPresets') as PermissionPresetsService | undefined

    /* what the guide has done so far; it outlives each republished node */
    const state = {
      languageChosen: undefined as string | undefined,
      keyEntry: false,
      observedConfigured: false,
      connection: 'pending' as 'pending' | 'account' | 'key' | 'skipped',
      /** The provider route to show the model list of once the guide closes. */
      connectedRoute: undefined as string | undefined,
      preset: undefined as string | undefined,
      /** A sign-in under way: the Connect page is the sign-in's. */
      signIn: undefined as SignInFlow | undefined,
      signInSnap: undefined as SignInSnapshot | undefined,
      /** The reader asked for the other-machine view while a browser opened. */
      manual: false,
      /** The pasted address was handed over and its page loads. */
      delivering: false,
    }
    /** The step the guide is on as far as the guide itself has moved it: a republish names it, so a change moves the reader there. */
    let target: OnboardingStepId = ONBOARDING_PREFERENCES
    /** The language and theme as the reader switches them, starting from what is set now; the step applies each switch at once. */
    const current = { ...initialChoice(ctx) }
    /** What the form's fields were last acknowledged as: a republish keeps these, so the reader's draft is never a conflict. */
    const baseline = { ...current }
    const currentAgent = () => ctx.get('mayflyCurrentAgent')?.current() ?? null
    /* the guide opens only on a first install (nothing connected), so it always offers the language and theme, preselected with what is set */
    const order: readonly OnboardingStepId[] = [ONBOARDING_PREFERENCES, ONBOARDING_CONNECT, ONBOARDING_READY]
    const after = (step: OnboardingStepId): OnboardingStepId => order[order.indexOf(step) + 1] ?? ONBOARDING_READY

    const labels = (): OnboardingLabels => ({
      title: t('Connect to DeepSeek'),
      steps: { preferences: t('Preferences'), connect: t('Connect'), ready: t('Welcome') },
      preferencesIntro: t('Set up how Mayfly looks and what it may do. You can change all of it later in /settings.'),
      language: t('Language'),
      permissions: t('Permissions'),
      theme: t('Theme'),
      connectIntro: t('Mayfly needs a DeepSeek connection to start.'),
      signIn: {
        starting: t('Getting your sign-in link…'),
        opening: t('Opening your browser…'),
        waiting: t('Waiting for you to sign in in your browser'),
        noBrowser: t('Couldn’t open a browser. Copy the link below and open it yourself, then paste the address it ends on (the page may fail to load).'),
        otherMachine: t('Open the link below in a browser on another machine, then paste the address it ends on (the page may fail to load).'),
        finishing: t('Signing you in…'),
        connected: t('Signed in'),
        expires: (time: string) => t('expires in {time}', { time }),
        callbackLabel: t('Callback URL'),
        callbackPlaceholder: `http://localhost:${String(state.signInSnap?.callbackPort ?? '')}/oauth/callback?…`,
        retry: t('Try again'),
        copyLink: t('Copy link'),
        newLink: t('New link'),
        otherMachineKey: t('Other machine'),
        deliver: t('Deliver callback'),
      },
      account: t('Sign in with a DeepSeek account'),
      accountDetail: t('browser sign-in, no API key to manage'),
      key: t('Enter a DeepSeek API key'),
      keyDetail: t('paste a key from platform.deepseek.com'),
      keyNote: t('Your key is saved as a credential, not as a setting.'),
      keyField: DEEPSEEK_KEY,
      keyPlaceholder: t('paste your key'),
      skip: t('Skip for now'),
      skipDetail: t('connect later with /provider'),
      recommended: t('recommended'),
      readyIntro: t('Welcome to Mayfly — you are all set.'),
      tryHeading: t('Things to try'),
      tryItems: [
        { keys: '/', text: t('run a command, such as /model or /sessions') },
        { keys: '@', text: t('mention a file to attach it to your message') },
        { keys: '#', text: t('select a skill (a saved playbook) to guide the agent') },
        { keys: '!', text: t('run a shell command and share its output') },
        { keys: 'Shift+Tab', text: t('let the agent plan first; you approve before it acts') },
      ],
      start: t('Start chatting'),
    })

    const presetRows = (): readonly OnboardingPresetRow[] | undefined => {
      const agent = currentAgent()
      if (presets === undefined || agent === null) return undefined
      const current = presets.current(agent.session)
      return presets.names.map(preset => ({ id: preset, label: presets.optionOf(preset).name, current: preset === current }))
    }

    const summary = (): OnboardingFacts['summary'] => [
      ...state.languageChosen === undefined ? [] : [{ text: t('Language: {language} · Theme: {theme}', { language: state.languageChosen, theme: themeName(current.theme, t) }), done: true }],
      state.connection === 'account' ? { text: t('Connected with a DeepSeek account'), done: true }
        : state.connection === 'key' ? { text: t('Connected with an API key'), done: true }
        : { text: t('DeepSeek not connected · /provider to connect'), done: false },
      ...state.preset === undefined ? [] : [{ text: t('Permission preset: {preset}', { preset: state.preset }), done: true }],
    ]

    const endedText = (end: SignInEnd): string => end === 'cancelled' ? t('Sign-in cancelled')
      : end === 'expired' ? t('The sign-in link expired — try again')
        : end === 'network' ? t('Could not reach DeepSeek — check the connection and try again')
          : end === 'storage' ? t('The login could not be saved on this machine — try again')
            : t('Sign-in failed — try again')
    const signInFacts = (): OnboardingFacts['connect']['signIn'] => {
      const snap = state.signInSnap
      if (state.signIn === undefined || snap === undefined) return undefined
      return {
        stage: snap.stage, browser: snap.browser, manual: state.manual, delivering: state.delivering,
        ...snap.url === undefined ? {} : { url: snap.url },
        ...snap.expiresAt === undefined ? {} : { remainingMs: snap.expiresAt - Date.now() },
        ...snap.totalMs === undefined ? {} : { totalMs: snap.totalMs },
        ...snap.callbackPort === undefined ? {} : { callbackPort: snap.callbackPort },
        ...snap.ended === undefined ? {} : { endedText: endedText(snap.ended) },
      }
    }
    const view = (choice = baseline) => {
      const rows = presetRows()
      const signIn = signInFacts()
      const facts: OnboardingFacts = {
        activeId: target,
        preferences: {
          language: { value: choice.language, theme: choice.theme, languages: LANGUAGES, themes: THEMES.map(key => ({ id: key, label: themeLabel(key, t) })) },
          ...rows === undefined ? {} : { permissions: rows },
        },
        connect: { canSignIn: signInRoute !== undefined, keyEntry: state.keyEntry, ...state.connection === 'account' ? { connected: 'account' as const } : {}, ...signIn === undefined ? {} : { signIn } },
        summary: summary(),
      }
      return onboardingWizard(facts, labels())
    }
    /** Move on from a step: the next page of a republished guide. */
    const advance = (from: OnboardingStepId, feedback?: string): Extract<MayflyUiActionReply, { readonly kind: 'accepted' }> => ({
      kind: 'accepted', node: view(), source: stamp, navigate: pathOf(after(from)),
      ...feedback === undefined ? {} : { feedback: { severity: 'success' as const, message: feedback } },
    })

    /** A submission is always acknowledged with a snapshot: stay on the step with the guide as it is. */
    const stay = (): Extract<MayflyUiActionReply, { readonly kind: 'accepted' }> => ({ kind: 'accepted', node: view(), source: stamp })

    /** Republish the guide as it stands (the page behind a background step changed). */
    const republish = (): void => { if (handle?.closed === false && !lifetime.signal.aborted) handle.set(view()) }
    /** Move the reader to a step from the guide's own side: the republish names it, and the surface moves there. */
    const navigate = (step: OnboardingStepId): void => { target = step; republish() }

    /** The countdown moves each second while a link waits. */
    let ticker: ReturnType<typeof setInterval> | undefined
    ctx.effect(() => () => { if (ticker !== undefined) clearInterval(ticker) })
    const syncTicker = (): void => {
      const counting = state.signIn !== undefined && state.signInSnap?.stage === 'waiting' && state.signInSnap.expiresAt !== undefined
      if (counting && ticker === undefined) ticker = setInterval(republish, 1000)
      else if (!counting && ticker !== undefined) { clearInterval(ticker); ticker = undefined }
    }

    /**
     * Connecting ends on the model list of the provider just connected, so the session never starts on another route's default:
     * the list opens above the guide, and the guide goes on when it closes (a pick or a dismissal).
     */
    const pickModel = async (): Promise<void> => {
      if (state.connectedRoute === undefined || lifetime.signal.aborted) return
      let release = (): void => {}
      const closed = new Promise<void>(resolve => {
        const off = ctx.mayflyOverlays.subscribe(delta => { if (delta.kind === 'remove' && delta.id === 'mayfly.models') { off(); resolve() } })
        release = () => { off(); resolve() }
        lifetime.signal.addEventListener('abort', release, { once: true })
      })
      await openModelPicker(ctx, lifetime.signal, state.connectedRoute)
      /* a picker that did not open (no session yet, the provider never listed) leaves nothing to wait for */
      if (ctx.mayflyOverlays.list().some(entry => entry.id === 'mayfly.models')) await closed
      else release()
    }

    /** Follow a sign-in to its end: a login lands on the model list, then the welcome page. */
    const followSignIn = async (flow: SignInFlow): Promise<void> => {
      const connected = await flow.connected
      if (state.signIn !== flow || !connected || lifetime.signal.aborted) return
      state.connection = 'account'
      state.connectedRoute = signInRoute
      syncTicker()
      republish()
      await pickModel()
      if (state.signIn !== flow || lifetime.signal.aborted) return
      state.signIn = undefined
      state.signInSnap = undefined
      syncTicker()
      navigate(ONBOARDING_READY)
    }
    /** Step back from a sign-in to the choices: the attempt is cancelled. */
    const leaveSignIn = (): void => {
      state.signIn?.cancel()
      state.signIn = undefined
      state.signInSnap = undefined
      state.manual = false
      state.delivering = false
      syncTicker()
    }

    const saveKey = async (value: string, signal: AbortSignal): Promise<MayflyUiActionReply> => {
      try {
        const info = await credentials.describe(credentialRef(DEEPSEEK_KEY))
        if (signal.aborted) return { kind: 'cancelled' }
        if (!info.writable) return { kind: 'failed', message: t('The credential source is read-only') }
        if (info.configured && !state.observedConfigured) {
          state.observedConfigured = true
          return { kind: 'conflict', node: view(), source: stamp, message: t('A credential was configured elsewhere; review before replacing it') }
        }
        await credentials.set(credentialRef(DEEPSEEK_KEY), value)
        if (signal.aborted) return { kind: 'cancelled' }
        state.connection = 'key'
        state.connectedRoute = DEEPSEEK_KEY_ROUTE
        /* the acknowledged form stays on its page, now showing the saved key; Esc there steps back to the choices */
        await pickModel()
        if (signal.aborted) return { kind: 'cancelled' }
        return advance(ONBOARDING_CONNECT, t('DeepSeek API key saved'))
      } catch { return { kind: 'failed', message: t('The API key could not be saved') } }
    }

    /** Enter on the first step: the language and theme (already applied as they were switched) are confirmed, and the preset is written. */
    const settlePreferences = async (submission: MayflySubmission, signal: AbortSignal): Promise<MayflyUiActionReply> => {
      const chosenLanguage = LANGUAGES.find(item => item.id === fieldValue(submission, ONBOARDING_PREFERENCES_FORM, 'language'))
      const chosenTheme = THEMES.find(key => key === fieldValue(submission, ONBOARDING_PREFERENCES_FORM, 'theme'))
      /* the selects reject unknown options; this guards a forged submission */
      if (chosenLanguage === undefined || chosenTheme === undefined) return { kind: 'failed', message: t('Choose a language and a theme') }
      current.language = chosenLanguage.id
      current.theme = chosenTheme
      await commitLanguage(ctx, current.language, current.theme)
      state.languageChosen = chosenLanguage.label
      /* the submission acknowledges the form: its values are the baseline from here on */
      baseline.language = current.language
      baseline.theme = current.theme
      const chosen = fieldValue(submission, ONBOARDING_PREFERENCES_FORM, ONBOARDING_PERMISSION_FIELD)
      if (presets !== undefined && commands !== undefined && typeof chosen === 'string') {
        const agent = currentAgent()
        if (!presets.names.includes(chosen)) return { kind: 'failed', message: t('permission command is unavailable') }
        if (agent === null) return { kind: 'failed', message: t('permission target changed; action cancelled') }
        if (chosen !== presets.current(agent.session)) {
          try {
            const execution = await commands.execute(agent, `/permission ${chosen}`, [], signal)
            if (signal.aborted) return { kind: 'cancelled' }
            if (execution === undefined) return { kind: 'failed', message: t('permission command is unavailable') }
            if (execution.result.kind === 'error') return { kind: 'failed', message: execution.result.text ?? t('permission command is unavailable') }
          } catch (error) {
            return { kind: 'failed', message: t('permission dispatch failed: {error}', { error: error instanceof Error ? error.message : String(error) }) }
          }
        }
        state.preset = presets.optionOf(chosen).name
      }
      return advance(ONBOARDING_PREFERENCES)
    }

    const settleConnect = async (submission: MayflySubmission, signal: AbortSignal): Promise<MayflyUiActionReply> => {
      /* the key field takes the page, so its submission is the key */
      if (state.keyEntry) {
        const value = fieldValue(submission, ONBOARDING_KEY_FORM, ONBOARDING_KEY_FIELD)
        /* back on the saved key's page, Enter moves on */
        if ((value === undefined || value === '') && state.connection === 'key') return advance(ONBOARDING_CONNECT)
        if (typeof value !== 'string' || value.length === 0) return { kind: 'invalid', errors: [{ pagePath: pathOf(ONBOARDING_CONNECT), formId: ONBOARDING_KEY_FORM, fieldId: ONBOARDING_KEY_FIELD, message: t('A value is required') }] }
        return saveKey(value, signal)
      }
      const choice = submission.selections?.find(item => item.controlId === ONBOARDING_CONNECT_LIST)?.selectedIds[0] as OnboardingConnectChoice | undefined
      if (choice === 'skip') {
        state.connection = 'skipped'
        state.keyEntry = false
        return advance(ONBOARDING_CONNECT)
      }
      if (choice === 'account') {
        /* the guide only offers sign-in after the same service and route check */
        if (signInRoute === undefined) return { kind: 'failed', message: t('Account sign-in is unavailable') }
        state.keyEntry = false
        state.manual = false
        state.delivering = false
        state.signInSnap = { stage: 'starting', browser: 'pending' }
        const started = await startSignIn(ctx, {
          signal: lifetime.signal,
          onChange: snapshot => {
            state.signInSnap = snapshot
            if (snapshot.stage !== 'waiting') state.delivering = false
            syncTicker()
            if (state.signIn !== undefined) republish()
          },
        })
        if ('error' in started) {
          state.signInSnap = undefined
          return { kind: 'failed', message: started.error === 'no-server' ? t('Sign-in needs the local web server, which this setup does not run — use an API key instead') : t('Account sign-in is unavailable') }
        }
        state.signIn = started
        state.signInSnap = started.snapshot()
        syncTicker()
        void followSignIn(started)
        return stay()
      }
      if (choice === 'key') {
        state.keyEntry = true
        return stay()
      }
      return stay()
    }

    /** Switches apply as they are made, in order: the language and theme take hold, and the guide is relabelled. The preset is written on Enter. */
    let changes: Promise<void> = Promise.resolve()
    let handle: ReturnType<typeof openUiOverlay> | undefined
    const applyChange = (event: MayflyUiObservationEvent): void => {
      if (event.kind !== 'value-change' || event.formId !== ONBOARDING_PREFERENCES_FORM) return
      const language = event.controlId === 'language' ? LANGUAGES.find(item => item.id === event.value)?.id : undefined
      const theme = event.controlId === 'theme' ? THEMES.find(key => key === event.value) : undefined
      if (language === undefined && theme === undefined) return
      if (language !== undefined) current.language = language
      if (theme !== undefined) current.theme = theme
      changes = changes.then(async () => {
        if (lifetime.signal.aborted) return
        await commitLanguage(ctx, current.language, current.theme)
        /* the drafts stay in the surface; only the words change */
        if (language !== undefined && !lifetime.signal.aborted && handle?.closed === false) handle.set(view())
      }).catch(() => {})
    }

    /** Open (or refocus) the guide on its first step. */
    const open = (): void => {
      handle = openUiOverlay(ctx, {
        id: 'mayfly.provider.onboarding', presentation: 'editor', capturing: true, dismissal: 'discard',
        scope: { kind: 'app', targetId: DEEPSEEK_KEY }, source: stamp,
        onEvent: { observe: applyChange, action: async (event, context): Promise<MayflyUiActionReply> => {
          /* Esc on the key field or the sign-in steps back to the choices; any other dismissal closes the guide */
          if (event.kind === 'dismiss' && (state.keyEntry || state.signIn !== undefined)) {
            state.keyEntry = false
            leaveSignIn()
            return { ...stay(), dismiss: false }
          }
          if (event.kind === 'activate' && state.signIn !== undefined) {
            const flow = state.signIn
            switch (event.actionId) {
              case ONBOARDING_SIGN_IN.copy: return await flow.copyLink() ? { kind: 'completed', feedback: { severity: 'success', message: t('Sign-in link copied') } } : { kind: 'failed', message: t('The link could not be copied — select it in the panel instead') }
              case ONBOARDING_SIGN_IN.other: state.manual = true; republish(); return { kind: 'completed' }
              case ONBOARDING_SIGN_IN.restart:
              case ONBOARDING_SIGN_IN.retry:
                state.manual = false
                state.delivering = false
                await flow.restart()
                return { kind: 'completed' }
              default: return { kind: 'completed' }
            }
          }
          if (event.kind === 'submit' && event.submission.actionId === ONBOARDING_SIGN_IN.deliver && state.signIn !== undefined) {
            const pasted = fieldValue(event.submission, ONBOARDING_SIGN_IN.form, ONBOARDING_SIGN_IN.field)
            const field = { pagePath: ONBOARDING_SIGN_IN.pagePath, formId: ONBOARDING_SIGN_IN.form, fieldId: ONBOARDING_SIGN_IN.field }
            if (typeof pasted !== 'string' || pasted.trim() === '') return { kind: 'invalid', errors: [{ ...field, message: t('A value is required') }] }
            const result = await state.signIn.deliver(pasted)
            if (result === 'invalid') return { kind: 'invalid', errors: [{ ...field, message: t('Paste the full callback address from the browser address bar') }] }
            if (result === 'rejected') return { kind: 'failed', message: t('The pasted link was not accepted — copy the full address bar URL and try again') }
            if (result === 'failed') return { kind: 'failed', message: t('The callback could not be delivered') }
            /* the page loads: show it, and let the platform's answer move the sign-in on */
            state.delivering = true
            setTimeout(() => { if (state.delivering && !lifetime.signal.aborted) { state.delivering = false; republish() } }, 20_000)
            return stay()
          }
          if (event.kind !== 'submit') return { kind: 'completed' }
          switch (event.pagePath[0]?.itemId) {
            case ONBOARDING_PREFERENCES: return settlePreferences(event.submission, context.signal)
            case ONBOARDING_CONNECT: return settleConnect(event.submission, context.signal)
            /* Ready: the last step's Enter submits, and the guide is done */
            default: return { ...stay(), dismiss: true }
          }
        } },
      }, view(), { signal: lifetime.signal, reopen: 'focus' })
    }
    open()
  }
  ctx.plugin({
    name: 'mayfly-onboarding-readiness', inject: ['mayflyCurrentAgent'],
    apply(reader: Context) {
      const off = reader.mayflyCurrentAgent.subscribe(agent => {
        if (agent === null) return
        void check().catch((error: unknown) => {
          ctx.logger.warn(`provider onboarding could not open: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
          if (lifetime.signal.aborted || ctx.mayflyOverlays.focus('mayfly.provider.onboarding')) return
          const t = interactionTranslator(ctx)
          openUiOverlay(ctx, { id: 'mayfly.provider.onboarding', title: t('Provider setup'), presentation: 'editor', capturing: true, scope: { kind: 'app', targetId: DEEPSEEK_KEY } }, ui.empty({ title: t('Provider setup could not be checked') }), { signal: lifetime.signal, reopen: 'focus' })
        })
      })
      reader.effect(() => off)
    },
  })
}
